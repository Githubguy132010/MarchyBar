import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

// Avoid loading the real native renderer; diagnose() only needs fs checks.
const load = Module._load;
const nativePath = process.env.MARCHYBAR_NATIVE_PATH;
process.env.MARCHYBAR_NATIVE_PATH = 'fixture:kernel-compatibility';
mock.method(Module, '_load', function(id, ...args) {
  if (id === 'fixture:kernel-compatibility') {
    class Display {
      setup() { return { width: 2170, height: 60 }; }
      render() {}
      close() {}
    }
    return { DrmDisplay: Display, PreviewDisplay: Display, TouchReader: class {}, KeyboardReader: class {} };
  }
  return load.call(this, id, ...args);
});
const { diagnose } = await import('../backend/hardware.mjs');
const { MarchyBar } = await import('../backend/server.mjs');
mock.restoreAll();
if (nativePath === undefined) delete process.env.MARCHYBAR_NATIVE_PATH;
else process.env.MARCHYBAR_NATIVE_PATH = nativePath;

function mockHardware(t, { model, kernel, broker = true, driverModule = true }) {
  const read = fs.readFileSync.bind(fs), exists = fs.existsSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (file, ...args) =>
    file === '/sys/devices/virtual/dmi/id/product_name' ? model
    : file === '/proc/sys/kernel/osrelease' ? kernel
    : read(file, ...args));
  t.mock.method(fs, 'existsSync', file => {
    if (file === '/run/marchybar/device.sock') return broker;
    if (file === '/sys/module/appletbdrm') return driverModule;
    if (String(file).startsWith(`/usr/lib/modules/${kernel}/`)) return driverModule;
    return exists(file);
  });
}

test('T2 model on the T2 kernel stays available (Omarchy 4.0.4 keeps linux-t2)', async t => {
  mockHardware(t, { model: 'MacBookPro15,1', kernel: '7.2.5-arch1-T2' });
  const h = diagnose();
  assert.equal(h.supported, true);
  assert.equal(h.t2Kernel, true);
  assert.equal(h.expectedKernel, 'linux-t2');
  assert.equal(h.kernelNote, '');
  assert.equal(h.status, 'available');
});

test('T2 model without the device helper still reports setup-required on the T2 kernel', async t => {
  mockHardware(t, { model: 'MacBookPro16,1', kernel: '7.2.5-arch1-t2', broker: false });
  const h = diagnose();
  assert.equal(h.t2Kernel, true);
  assert.equal(h.status, 'setup-required');
});

test('T2 model booted into linux-omarchy reports wrong-kernel with an actionable note', async t => {
  mockHardware(t, { model: 'MacBookPro15,1', kernel: '7.2.5-arch1-1-omarchy', driverModule: false });
  const h = diagnose();
  assert.equal(h.supported, true);
  assert.equal(h.t2Kernel, false);
  assert.equal(h.driver, false);
  assert.equal(h.status, 'wrong-kernel');
  assert.match(h.kernelNote, /linux-t2/);
  assert.match(h.kernelNote, /4\.0\.4/);
  assert.match(h.kernelNote, /BOOT_ORDER/);
});

test('T2 model on a generic Arch kernel also reports wrong-kernel', async t => {
  mockHardware(t, { model: 'MacBookPro15,3', kernel: '6.15.0-arch1-1', driverModule: false });
  const h = diagnose();
  assert.equal(h.t2Kernel, false);
  assert.equal(h.status, 'wrong-kernel');
  assert.match(h.kernelNote, /linux-t2/);
});

test('unsupported models stay preview-only regardless of kernel', async t => {
  for (const kernel of ['7.2.5-arch1-T2', '7.2.5-arch1-1-omarchy']) {
    await t.test(`kernel ${kernel}`, async st => {
      mockHardware(st, { model: 'MacBookPro14,1', kernel });
      const h = diagnose();
      assert.equal(h.supported, false);
      assert.equal(h.status, 'preview-only');
      assert.equal(h.kernelNote, '');
    });
  }
});

test('hardware.enable refuses with a linux-t2 recovery hint on the wrong kernel', async t => {
  const os = await import('node:os');
  const path = await import('node:path');
  mockHardware(t, { model: 'MacBookPro15,1', kernel: '7.2.5-arch1-1-omarchy', broker: true, driverModule: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-kernel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = new MarchyBar({
    socketPath: path.join(dir, 'control.sock'),
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), live: false,
  });
  t.after(async () => { try { await app.stop(); } catch {} try { app.previewDisplay.close(); } catch {} });
  t.mock.method(app, 'savePreview', () => {});
  app.locked = false;
  await assert.rejects(app.enableHardware(), /linux-t2/);
  assert.equal(app.device, undefined);
});

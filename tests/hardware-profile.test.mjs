import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

const load = Module._load;
const nativePath = process.env.MARCHYBAR_NATIVE_PATH;
process.env.MARCHYBAR_NATIVE_PATH = 'fixture:hardware-profile';
mock.method(Module, '_load', function(id, ...args) {
  return id === 'fixture:hardware-profile' ? {} : load.call(this, id, ...args);
});
const { diagnose, MODELS } = await import('../backend/hardware.mjs');
mock.restoreAll();
if (nativePath === undefined) delete process.env.MARCHYBAR_NATIVE_PATH;
else process.env.MARCHYBAR_NATIVE_PATH = nativePath;

function fixture({ model = '', compatible = null, paths = [], entries = [], kernel = 'fixture-kernel' } = {}) {
  const files = {
    '/sys/devices/virtual/dmi/id/product_name': model,
    '/sys/firmware/devicetree/base/compatible': compatible,
    '/proc/sys/kernel/osrelease': kernel
  };
  return diagnose({
    read: file => { assert.ok(Object.hasOwn(files, file)); return files[file]; },
    exists: file => paths.includes(file),
    list: dir => { assert.equal(dir, '/sys/bus/platform/drivers/adp'); return entries; }
  });
}

for (const model of MODELS) {
  test(`DMI ${model} retains the T2 profile and driver check`, () => {
    const result = fixture({ model: model + '\n', kernel: '7.2.5-arch1-T2', paths: ['/sys/module/appletbdrm', '/run/marchybar/device.sock'] });
    assert.deepEqual(result, { model, profile: 't2', experimental: false, kernel: '7.2.5-arch1-T2', supported: true, driver: true, broker: true, t2Kernel: true, expectedKernel: 'linux-t2', kernelNote: '', status: 'available' });
  });
}

for (const [compatible, model] of [['apple,j293', 'MacBookPro17,1'], ['apple,j493', 'Mac14,7']]) {
  test(`${compatible} requires a recognized first entry and takes precedence over T2 DMI`, () => {
    for (const value of [`${compatible}\0apple,t8103\0apple,arm-platform\0`, `${compatible}\0`]) {
      const result = fixture({ model: MODELS[0], compatible: value });
      assert.deepEqual(result, { model, profile: 'asahi', experimental: true, kernel: 'fixture-kernel', supported: true, driver: false, broker: false, t2Kernel: false, expectedKernel: 'linux-t2', kernelNote: '', status: 'setup-required' });
    }
  });
}

test('unknown and malformed DT properties reject even recognized T2 DMI', () => {
  for (const compatible of [
    '', '\0', ' ', 'apple,j293', 'apple,j493', 'apple,j293\0apple,t8103',
    'apple,j313\0apple,t8103\0', 'apple,j293-extra\0', 'not-apple,j493\0',
    'apple,j293\napple,t8103', 'apple,arm-platform\0apple,j293\0',
    'apple,t8112\0apple,j493\0', 'apple,j313\0apple,j293\0', '\0apple,j293\0',
    'apple,j293\0apple,j493\0', 'apple,j493\0apple,j293\0',
    'apple,j293\0apple,j293\0', 'apple,j493\0apple,j493\0',
    ' apple,j293\0', 'apple,j293 \0', 'apple,j293\0\n',
    'apple,j293\0apple,\u00e9\0'
  ]) {
    for (const model of ['Other', MODELS[0]]) {
      const result = fixture({ model, compatible, paths: ['/run/marchybar/device.sock', '/sys/module/adpdrm'] });
      assert.equal(result.profile, null, JSON.stringify(compatible));
      assert.equal(result.supported, false);
      assert.equal(result.experimental, false);
      assert.equal(result.status, 'preview-only');
    }
  }
});

test('missing DT only recognizes existing T2 DMI models', () => {
  assert.equal(fixture().supported, false);
  for (const model of ['MacBookPro17,1', 'Mac14,7']) assert.equal(fixture({ model }).supported, false, 'Asahi requires a recognized DT compatible');
});

test('sysfs reader preserves DT bytes and distinguishes missing, empty and unreadable properties', t => {
  let compatible = null;
  t.mock.method(fs, 'readFileSync', file => {
    if (file === '/sys/devices/virtual/dmi/id/product_name') return MODELS[0] + '\n';
    if (file === '/proc/sys/kernel/osrelease') return 'fixture-kernel\n';
    assert.equal(file, '/sys/firmware/devicetree/base/compatible');
    if (compatible === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (compatible instanceof Error) throw compatible;
    return compatible;
  });
  const check = () => diagnose({ exists: () => false, list: () => [] });
  assert.equal(check().profile, 't2');
  assert.equal(check().kernel, 'fixture-kernel');
  for (const value of ['', ' apple,j293\0', 'apple,j293\0\n', Object.assign(new Error('denied'), { code: 'EACCES' })]) {
    compatible = value;
    assert.equal(check().supported, false);
  }
  compatible = 'apple,j293\0apple,t8103\0';
  assert.equal(check().profile, 'asahi');
});

test('T2 installed module detection is unchanged', () => {
  assert.equal(fixture({ model: MODELS[0], paths: ['/usr/lib/modules/fixture-kernel/kernel/drivers/gpu/drm/tiny/appletbdrm.ko.zst'] }).driver, true);
});

test('Asahi detects adpdrm without claiming Z2 or Summit have been verified', () => {
  const result = fixture({ compatible: 'apple,j293\0', paths: ['/sys/module/adpdrm', '/run/marchybar/device.sock'] });
  assert.equal(result.driver, true);
  assert.equal(result.status, 'available');
  assert.equal(result.experimental, true);
  assert.equal(fixture({ compatible: 'apple,j293\0', paths: ['/sys/module/appletbdrm'] }).driver, false);
});

test('Asahi detects a bound built-in adp device, not an empty registered driver', () => {
  const options = { compatible: 'apple,j493\0', entries: ['bind', 'unbind', 'uevent', 'module', '204000000.display-pipe'] };
  assert.equal(fixture({ ...options, paths: ['/sys/bus/platform/drivers/adp/204000000.display-pipe/driver'] }).driver, true);
  assert.equal(fixture(options).driver, false);
  assert.equal(fixture({ ...options, entries: [], paths: ['/sys/bus/platform/drivers/adp'] }).driver, false);
});

test('missing platform driver directory does not prevent Asahi recognition', () => {
  const result = diagnose({ read: file => file.endsWith('/compatible') ? 'apple,j293\0' : '', exists: () => false, list: () => { throw new Error('ENOENT'); } });
  assert.equal(result.profile, 'asahi');
  assert.equal(result.supported, true);
  assert.equal(result.driver, false);
});

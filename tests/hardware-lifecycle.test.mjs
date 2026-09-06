import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

class Display {
  constructor(width = 2170, height = 60) { this.width = typeof width === 'number' ? width : 2170; this.height = height; }
  setup() { return { width: this.width, height: this.height }; }
  render() {}
  close() { this.closed = true; }
}
class Reader {
  ranges() { return { minX: 0, maxX: 2170, minY: 0, maxY: 60 }; }
  start(callback) { this.callback = callback; }
  stop() { this.stopped = true; }
}
const load = Module._load;
const nativePath = process.env.MARCHYBAR_NATIVE_PATH;
process.env.MARCHYBAR_NATIVE_PATH = 'fixture:hardware-lifecycle';
mock.method(Module, '_load', function(id, ...args) {
  return id === 'fixture:hardware-lifecycle'
    ? { DrmDisplay: Display, PreviewDisplay: Display, TouchReader: Reader, KeyboardReader: Reader }
    : load.call(this, id, ...args);
});
const { MarchyBar } = await import('../backend/server.mjs');
const { Gesture } = await import('../backend/scene.mjs');
const { Device } = await import('../backend/hardware.mjs');
mock.restoreAll();
if (nativePath === undefined) delete process.env.MARCHYBAR_NATIVE_PATH;
else process.env.MARCHYBAR_NATIVE_PATH = nativePath;

function fixture(t, { failBrightness = false, failPersistence = false, wakeDuringOpen = false, runtime = false, persisted = false } = {}) {
  const requests = [], inputs = [], actions = [], sliders = [], opened = [], statuses = [];
  let brightnessRequests = 0, saves = 0;
  const open = Device.prototype.open;
  t.mock.method(Device.prototype, 'open', async function() {
    const geometry = await open.call(this);
    opened.push({ device: this, touch: this.touch, keyboard: this.keyboard, display: this.display, socket: this.socket });
    if (wakeDuringOpen && opened.length === 1) {
      app.off = true;
      this.touch.callback(0, 100, 30);
      assert.equal(app.wakeOnly, true);
    }
    return geometry;
  });
  const read = fs.readFileSync.bind(fs), exists = fs.existsSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/sys/devices/virtual/dmi/id/product_name' ? 'MacBookPro15,1' : file === '/proc/sys/kernel/osrelease' ? 'fixture-kernel' : read(file, ...args));
  t.mock.method(fs, 'existsSync', file => file === '/run/marchybar/device.sock' || file === '/sys/module/appletbdrm' ? true : file === 'fixture:control' || String(file).startsWith('/usr/lib/modules/fixture-kernel/') ? false : exists(file));
  class Socket extends EventEmitter {
    destroyed = false;
    constructor() { super(); queueMicrotask(() => this.emit('connect')); }
    write(line) {
      const request = JSON.parse(line); requests.push(request);
      const fail = request.action === 'brightness' && ++brightnessRequests === 1 && failBrightness;
      const data = request.action === 'acquire' ? { drm: 'fixture:drm', touch: 'fixture:touch', keyboard: 'fixture:keyboard' } : {};
      queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: !fail, data, error: 'initial brightness failed' }) + '\n')));
      return true;
    }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } }
  }
  t.mock.method(net, 'createConnection', address => { assert.equal(address, '/run/marchybar/device.sock'); return new Socket(); });
  if (persisted) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-hardware-')), apps = [];
    t.after(async () => {
      try { for (const app of apps) await app.stop(); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    const createApp = () => {
      const app = new MarchyBar({ socketPath: path.join(dir, 'control.sock'),
        configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), live: false });
      apps.push(app);
      // The native fixture renders without producing preview PNGs.
      t.mock.method(app, 'savePreview', () => {});
      return app;
    };
    return { app: createApp(), createApp, requests, opened };
  }
  const preset = { id: 'fixture', defaultPage: 'main', fnPage: 'function', pages: [{ id: 'main' }, { id: 'function' }] };
  const settings = { hardwareEnabled: true, brightness: 128, defaultPreset: 'fixture', pinnedPreset: null, automatic: false };
  const store = { settings, revision: 'fixture', saveSettings(update) {
    if (++saves === 1 && failPersistence) throw new Error('initial persistence failed');
    Object.assign(settings, update);
  }, snapshot() { return { presets: [preset], rules: [], settings }; }, get() { return preset; } };
  const app = Object.assign(Object.create(MarchyBar.prototype), {
    store, live: { data: {}, stop() {} }, liveEnabled: false, previewOnly: false, locked: false, fn: false, clients: new Set(),
    previewDisplay: new Display(), sceneRevision: 1, socketPath: 'fixture:control',
    gesture: new Gesture({ action: a => actions.push(a), slider: (...args) => sliders.push(args) }),
    input(...args) { inputs.push(args); MarchyBar.prototype.input.apply(this, args); },
    refresh() { statuses.push(this.status); }, draw() {}, broadcastState() { statuses.push(this.status); }, fail(error) { this.error = String(error); }
  });
  if (runtime) {
    app.runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-hardware-'));
    app.socketPath = path.join(app.runtimeDir, 'control.sock');
  }
  t.after(async () => {
    try { if (app.server) await app.stop(); else await app.disableHardware(false); }
    finally { if (runtime) fs.rmSync(app.runtimeDir, { recursive: true, force: true }); }
  });
  return { app, requests, inputs, actions, sliders, opened, statuses };
}

for (const hardwareEnabled of [true, false]) {
  test(`shutdown/restart preserves hardwareEnabled=${hardwareEnabled} and gates acquisition on an unlocked heartbeat`, async t => {
    const { app, createApp, requests, opened } = fixture(t, { persisted: true });
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 });
    await app.start();
    await app.handle({ method: 'heartbeat', params: { locked: false } });
    await app.handle({ method: 'hardware.enable' });
    assert.equal(app.status, 'ready');
    assert.equal(requests.filter(r => r.action === 'acquire').length, 1);
    const old = opened[0];
    if (!hardwareEnabled) await app.handle({ method: 'hardware.disable' });
    assert.equal(app.store.settings.hardwareEnabled, hardwareEnabled);
    const settingsFile = path.join(app.store.configDir, 'settings.json');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(saved.hardwareEnabled, hardwareEnabled);

    await app.stop();
    assert.equal(app.store.settings.hardwareEnabled, hardwareEnabled);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), saved);
    assert.equal(app.device, null);
    assert.equal(old.device.closed, true);
    assert.equal(old.touch.stopped, true);
    assert.equal(old.keyboard.stopped, true);
    assert.equal(old.display.closed, true);
    assert.equal(old.socket.destroyed, true);
    assert.equal(requests.filter(r => r.action === 'release').length, 1);

    const restarted = createApp();
    assert.notEqual(restarted, app);
    assert.notEqual(restarted.store, app.store);
    assert.deepEqual(restarted.store.errors, []);
    assert.deepEqual(restarted.store.settings, saved);
    assert.equal(restarted.locked, true);
    await restarted.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!restarted.device);
    assert.equal(requests.filter(r => r.action === 'acquire').length, 1, 'startup must not acquire hardware');

    t.mock.timers.tick(15000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!restarted.device);
    assert.equal(requests.filter(r => r.action === 'acquire').length, 1, 'timers must not acquire before a heartbeat');
    await restarted.handle({ method: 'heartbeat', params: { locked: true } });
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted.locked, true);
    assert.ok(!restarted.device);
    assert.equal(requests.filter(r => r.action === 'acquire').length, 1, 'a locked heartbeat must not acquire hardware');

    await restarted.handle({ method: 'heartbeat', params: { locked: false } });
    assert.equal(restarted.locked, false);
    assert.equal(Boolean(restarted.device), hardwareEnabled);
    if (hardwareEnabled) {
      assert.equal(restarted.status, 'ready');
      assert.notEqual(restarted.device, old.device);
      assert.equal(restarted.device.closed, false);
    }
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.filter(r => r.action === 'acquire').length, hardwareEnabled ? 2 : 1);
    assert.equal(Boolean(restarted.device), hardwareEnabled);
    assert.equal(restarted.store.settings.hardwareEnabled, hardwareEnabled);
    await restarted.stop();
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), saved);
    assert.equal(requests.filter(r => r.action === 'release').length, hardwareEnabled ? 2 : 1);
  });
}

for (const kind of ['button', 'slider', 'hold']) {
  for (const idle of ['off', 'dimmed']) {
    test(`${idle} ${kind} gesture respects wake-only gating and the next awake gesture works (#5)`, async t => {
      const { app, actions, sliders } = fixture(t);
      await app.enableHardware();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const target = { widgetId: 'control', x: 0, y: 0, w: 200, h: 60,
        kind: kind === 'slider' ? 'slider' : 'button', channel: 'volume', trackX: 0, trackW: 200,
        action: { type: 'key', key: 'Escape' }, ...(kind === 'hold' ? { holdAction: { type: 'key', key: 'F1' } } : {}) };
      app.currentScene = { targets: [target] };
      await app.setIdle(idle === 'dimmed', idle === 'off');
      const gesture = (wakeOnly = false) => {
        app.device.touch.callback(0, 100, 30);
        assert.equal(app.off, false);
        assert.equal(app.dimmed, false);
        if (kind === 'slider') app.device.touch.callback(1, 200, 30);
        if (kind === 'hold') t.mock.timers.tick(551);
        if (wakeOnly) {
          assert.deepEqual(actions, []);
          assert.deepEqual(sliders, []);
          assert.equal(app.gesture.capture, null);
          assert.equal(app.gesture.timer, null);
        }
        app.device.touch.callback(2, kind === 'slider' ? 200 : 100, 30);
      };
      gesture(idle === 'off');
      const expectedActions = kind === 'slider' ? [] : [kind === 'hold' ? target.holdAction : target.action];
      const expectedSliders = kind === 'slider' ? [['volume', 50, false], ['volume', 100, false], ['volume', 100, true]] : [];
      assert.deepEqual(actions, idle === 'off' ? [] : expectedActions);
      assert.deepEqual(sliders, idle === 'off' ? [] : expectedSliders);
      assert.equal(app.gesture.capture, null);
      assert.equal(app.gesture.timer, null);
      actions.length = 0; sliders.length = 0;
      gesture();
      assert.deepEqual(actions, expectedActions);
      assert.deepEqual(sliders, expectedSliders);
    });
  }
}

for (const failure of ['brightness', 'persistence']) {
  for (const retry of ['manual', 'timer']) {
    test(`initial ${failure} failure releases hardware and ${retry} retry recovers (#27)`, async t => {
      const { app, requests, opened, statuses, actions } = fixture(t, { failBrightness: failure === 'brightness', failPersistence: failure === 'persistence', runtime: retry === 'timer' });
      if (retry === 'timer') {
        t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 });
        app.lastHeartbeat = Date.now();
        await app.start();
        await new Promise(resolve => setImmediate(resolve));
      } else {
        await assert.rejects(app.enableHardware(), new RegExp(`initial ${failure} failed`));
      }
      const old = opened[0];
      assert.equal(app.device, null);
      assert.equal(app.status, 'recovering');
      assert.match(app.error, new RegExp(`initial ${failure} failed`));
      assert.equal(app.store.settings.hardwareEnabled, true);
      assert.equal(old.device.closed, true);
      assert.equal(old.touch.stopped, true);
      assert.equal(old.keyboard.stopped, true);
      assert.equal(old.display.closed, true);
      assert.equal(old.socket.destroyed, true);
      assert.equal(requests.filter(r => r.action === 'release').length, 1);
      assert.equal(statuses.includes('ready'), false);
      if (retry === 'timer') {
        for (let i = 0; i < 3; i++) {
          app.lastHeartbeat = Date.now();
          t.mock.timers.tick(5000);
          await new Promise(resolve => setImmediate(resolve));
          if (i < 2) assert.equal(opened.length, 1, 'wait for the retry deadline');
        }
      } else await app.enableHardware();
      assert.equal(requests.filter(r => r.action === 'acquire').length, 2);
      assert.equal(requests.filter(r => r.action === 'ping').length, 0);
      assert.notEqual(app.device, old.device);
      assert.equal(app.status, 'ready');
      assert.equal(app.error, '');
      app.off = true;
      app.device.keyboard.callback(464, 1);
      assert.equal(app.active.page, 'function');
      assert.equal(app.off, false);
      const action = { type: 'key', key: 'F1' };
      app.currentScene = { targets: [{ x: 0, y: 0, w: 200, h: 60, kind: 'button', action }] };
      app.device.touch.callback(0, 100, 30);
      app.device.touch.callback(2, 100, 30);
      assert.deepEqual(actions, [action]);
      assert.equal(app.device.closed, false);
    });
  }
}

for (const interruption of ['disable', 'keyboard disconnect', 'touch disconnect / SYN_DROPPED']) {
  test(`interrupted wake gesture does not swallow the first recovered touch: ${interruption} (#5, #18, #24)`, async t => {
    const { app, actions } = fixture(t);
    await app.enableHardware();
    const action = { type: 'key', key: 'F1' };
    app.currentScene = { targets: [{ x: 0, y: 0, w: 200, h: 60, kind: 'button', action }] };
    await app.setIdle(false, true);
    const old = app.device;
    old.touch.callback(0, 100, 30);
    assert.equal(app.wakeOnly, true);
    assert.equal(app.off, false);
    assert.deepEqual(actions, []);
    if (interruption === 'disable') await app.disableHardware(false);
    else {
      old[interruption.startsWith('keyboard') ? 'keyboard' : 'touch'].callback(-1, -1, 0);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(old.closed, true);
    await app.enableHardware();
    app.device.touch.callback(0, 100, 30);
    app.device.touch.callback(2, 100, 30);
    assert.deepEqual(actions, [action]);
    assert.equal(app.wakeOnly, false);
  });
}

for (const failure of ['brightness', 'persistence']) {
  test(`initial ${failure} rollback clears an interrupted wake gesture (#5, #27)`, async t => {
    const { app, actions } = fixture(t, { failBrightness: failure === 'brightness', failPersistence: failure === 'persistence', wakeDuringOpen: true });
    const action = { type: 'key', key: 'F1' };
    app.currentScene = { targets: [{ x: 0, y: 0, w: 200, h: 60, kind: 'button', action }] };
    await assert.rejects(app.enableHardware(), new RegExp(`initial ${failure} failed`));
    assert.equal(app.off, false);
    assert.deepEqual(actions, []);
    await app.enableHardware();
    app.device.touch.callback(0, 100, 30);
    app.device.touch.callback(2, 100, 30);
    assert.deepEqual(actions, [action]);
    assert.equal(app.wakeOnly, false);
  });
}

test('closed Device ignores queued Fn, touch, activity and disconnect callbacks (#12)', async t => {
  const { app, inputs } = fixture(t);
  await app.enableHardware();
  const { keyboard, touch } = app.device;
  keyboard.callback(464, 1);
  assert.equal(app.active.page, 'function');
  const queued = new Promise(resolve => setImmediate(() => {
    keyboard.callback(464, 1);
    touch.callback(0, 100, 30);
    resolve();
  }));
  await app.disableHardware(false);
  app.off = true;
  await queued;
  assert.equal(app.fn, false);
  assert.equal(app.off, true);
  assert.deepEqual(inputs, []);
  assert.equal(keyboard.stopped, true);
  assert.equal(touch.stopped, true);
  await app.enableHardware();
  assert.notEqual(app.device.keyboard, keyboard);
  assert.equal(app.active.page, 'main');
  const replacement = app.device;
  replacement.keyboard.callback(464, 1);
  keyboard.callback(-1, -1);
  touch.callback(-1, 0, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.device, replacement);
  assert.equal(app.fn, true);
  assert.equal(app.status, 'ready');
});

for (const reader of ['keyboard', 'touch']) {
  test(`${reader} failure cancels capture and allows Fn and wake after reacquisition (#18, #24)`, async t => {
    const { app, requests } = fixture(t);
    await app.enableHardware();
    const old = app.device, keyboard = old.keyboard, touch = old.touch;
    keyboard.callback(464, 1);
    app.gesture.capture = { widgetId: 'old' };
    old[reader].callback(-1, -1, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.fn, false);
    assert.equal(app.status, 'recovering');
    assert.equal(app.device, null);
    assert.equal(app.gesture.capture, null);
    assert.equal(keyboard.stopped, true);
    assert.equal(touch.stopped, true);
    assert.equal(requests.filter(r => r.action === 'release').length, 1);
    await app.enableHardware();
    assert.notEqual(app.device, old);
    assert.equal(requests.filter(r => r.action === 'acquire').length, 2);
    app.off = true;
    app.device.keyboard.callback(464, 1);
    assert.equal(app.fn, true);
    assert.equal(app.off, false);
    assert.equal(app.active.page, 'function');
    app.device.keyboard.callback(464, 0);
    assert.equal(app.active.page, 'main');
    assert.equal(app.status, 'ready');
  });
}

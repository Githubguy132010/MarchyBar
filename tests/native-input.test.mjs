import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Gesture } from '../backend/scene.mjs';

const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);
const native = supported ? createRequire(import.meta.url)(process.env.MARCHYBAR_NATIVE_PATH || '../build/Release/drm_backend.node') : null;

async function replay(t, Reader, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-native-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.bin');
  // Linux 64-bit input_event: timeval, uint16 type/code, int32 value.
  const bytes = Buffer.alloc(events.length * 24);
  for (const [i, [type, code, value]] of events.entries()) {
    bytes.writeUInt16LE(type, i * 24 + 16);
    bytes.writeUInt16LE(code, i * 24 + 18);
    bytes.writeInt32LE(value, i * 24 + 20);
  }
  fs.writeFileSync(file, bytes);
  const reader = new Reader(file), calls = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native reader did not terminate')), 3000);
      t.after(() => clearTimeout(timer));
      reader.start((...args) => {
        calls.push(args);
        if (args[0] < 0) { clearTimeout(timer); resolve(); }
      });
    });
  } finally { reader.stop(); }
  return calls;
}

test('native keyboard reports Fn transitions and read failure without a device', { skip: !supported }, async t => {
  assert.deepEqual(await replay(t, native.KeyboardReader, [[1, 464, 1], [1, 464, 0]]), [[464, 1], [464, 0], [-1, -1]]);
});

test('SYN_DROPPED disconnects before stale slider movement and recovery starts fresh (#24)', { skip: !supported }, async t => {
  const calls = await replay(t, native.TouchReader, [
    [3, 0x39, 10], [3, 0x35, 100], [3, 0x36, 30], [0, 0, 0],
    [0, 3, 0], [3, 0x35, 150], [0, 0, 0],
    [3, 0x39, 11], [3, 0x35, 900], [0, 0, 0], [3, 0x39, -1], [0, 0, 0]
  ]);
  assert.deepEqual(calls, [[0, 100, 30], [-1, 0, 0]]);
  const sliders = [], actions = [];
  const targets = [
    { widgetId: 'volume', x: 0, y: 0, w: 200, h: 60, kind: 'slider', channel: 'volume', trackX: 0, trackW: 200 },
    { widgetId: 'button', x: 800, y: 0, w: 200, h: 60, kind: 'button', action: { type: 'key', key: 'F1', modifiers: [] } }
  ];
  const gesture = new Gesture({ slider: (...args) => sliders.push(args), action: a => actions.push(a) });
  t.after(() => gesture.cancel());
  const input = events => { for (const [type, x, y] of events) type < 0 ? gesture.cancel() : gesture.input(['start', 'move', 'end'][type], x, y, targets, 1); };
  input(calls);
  assert.equal(gesture.capture, null);
  assert.deepEqual(sliders, [['volume', 50, false]]);
  const recovered = await replay(t, native.TouchReader, [
    [3, 0x39, 12], [3, 0x35, 900], [3, 0x36, 30], [0, 0, 0],
    [3, 0x35, 905], [0, 0, 0], [3, 0x39, -1], [0, 0, 0]
  ]);
  assert.deepEqual(recovered, [[0, 900, 30], [1, 905, 30], [2, 905, 30], [-1, 0, 0]]);
  input(recovered);
  assert.deepEqual(actions, [targets[1].action]);
  assert.deepEqual(sliders, [['volume', 50, false]]);
});

test('SYN_DROPPED cancels a pending hold without activating it (#24)', { skip: !supported }, async t => {
  const calls = await replay(t, native.TouchReader, [
    [3, 0x39, 10], [3, 0x35, 100], [3, 0x36, 30], [0, 0, 0], [0, 3, 0],
    // An untrustworthy release must not become a normal button activation.
    [3, 0x39, -1], [0, 0, 0]
  ]);
  assert.deepEqual(calls, [[0, 100, 30], [-1, 0, 0]]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const actions = [], target = { x: 0, y: 0, w: 200, h: 60, kind: 'button', action: { type: 'key', key: 'F1' }, holdAction: { type: 'key', key: 'F2' } };
  const gesture = new Gesture({ action: a => actions.push(a) });
  for (const [type, x, y] of calls) type < 0 ? gesture.cancel() : gesture.input(['start', 'move', 'end'][type], x, y, [target], 1);
  t.mock.timers.tick(551);
  assert.equal(gesture.capture, null);
  assert.deepEqual(actions, []);
});

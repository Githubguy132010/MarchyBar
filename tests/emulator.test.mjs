import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarchyBar } from '../backend/server.mjs';
import { startEmulator } from '../emulator/server.mjs';

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('preview touch updates sliders, pages and geometry without leaving preview', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-emulator-'));
  const app = new MarchyBar({
    socketPath: path.join(dir, 'control.sock'),
    configDir: path.join(dir, 'config'),
    stateDir: path.join(dir, 'state'),
    previewOnly: true,
    live: false,
  });
  t.after(async () => { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await app.start();
  await app.handle({ id: 1, method: 'simulate', params: { data: { volume: 10, brightness: 20, battery: 80, workspace: 1, workspaces: [1, 2, 3, 4, 5].map(id => ({ id })) } } });
  assert.equal(app.active.id, 'everyday');
  assert.equal(app.error, '');

  const volume = app.currentScene.targets.find(target => target.channel === 'volume');
  const x = volume.trackX + volume.trackW * 0.8;
  await app.handle({ id: 2, method: 'simulate', params: { input: { phase: 'start', x, y: 30 } } });
  assert.ok(Math.abs(app.live.data.volume - 80) < 1.5);
  await app.handle({ id: 3, method: 'simulate', params: { input: { phase: 'move', x: volume.trackX + volume.trackW * 0.25, y: 30 } } });
  assert.ok(Math.abs(app.live.data.volume - 25) < 1.5);
  await app.handle({ id: 4, method: 'simulate', params: { input: { phase: 'end', x: volume.trackX + volume.trackW * 0.25, y: 30 } } });
  assert.equal(app.previewAction.channel, 'volume');

  const workspace = app.currentScene.targets.find(target => target.action?.workspace === 4);
  const hit = { x: workspace.x + workspace.w / 2, y: 30 };
  await app.handle({ id: 5, method: 'simulate', params: { input: { phase: 'start', ...hit } } });
  await app.handle({ id: 6, method: 'simulate', params: { input: { phase: 'end', ...hit } } });
  assert.equal(app.live.data.workspace, 4);

  await app.handle({ id: 7, method: 'simulate', params: { fn: true } });
  assert.equal(app.active.page, 'function');
  const f5 = app.currentScene.targets.find(target => target.action?.key === 'F5');
  const key = { x: f5.x + f5.w / 2, y: 30 };
  await app.handle({ id: 8, method: 'simulate', params: { input: { phase: 'start', ...key } } });
  await app.handle({ id: 9, method: 'simulate', params: { input: { phase: 'end', ...key } } });
  assert.equal(app.previewAction.key, 'F5');
  assert.equal(app.error, '');

  await app.handle({ id: 10, method: 'simulate', params: { width: 2008, fn: false } });
  assert.equal(app.geometry.width, 2008);
  assert.equal(app.currentScene.targets.some(target => target.widgetId === '__escape'), false);
  const frame = path.join(dir, 'frame.png');
  app.capturePreview(frame);
  assert.deepEqual(pngSize(fs.readFileSync(frame)), { width: 2008, height: 60 });
});

test('emulator serves the reference strip and accepts a touch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-emulator-http-'));
  const emulator = await startEmulator({ port: 0, open: false, runtimeDir: dir });
  t.after(async () => { await emulator.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await fetch(emulator.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MarchyBar/);
  const frame = Buffer.from(await (await fetch(emulator.url + 'frame.png')).arrayBuffer());
  assert.deepEqual(pngSize(frame), { width: 2170, height: 60 });
  const moved = await fetch(emulator.url + 'api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'simulate', params: { input: { phase: 'start', x: 400, y: 30 } } }),
  });
  const body = await moved.json();
  assert.equal(body.ok, true);
  assert.equal(body.state.activePreset, 'everyday');
  assert.equal(body.state.status, 'preview');
});

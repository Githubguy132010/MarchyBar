import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MarchyBar } from '../backend/server.mjs';

function fixture(t, socketBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-server-'));
  const socketPath = socketBytes ? path.join(dir, 'x'.repeat(socketBytes - Buffer.byteLength(`${dir}//control.sock`)), 'control.sock') : path.join(dir, 'control.sock');
  const app = new MarchyBar({ socketPath, configDir: path.join(dir, 'config'),
    stateDir: path.join(dir, 'state'), previewOnly: true, live: false });
  t.after(async () => { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, dir };
}

async function connect(t, app) {
  const accepted = app.server && once(app.server, 'connection', { signal: AbortSignal.timeout(5000) });
  const socket = net.createConnection(app.socketPath), events = new EventEmitter(), messages = [];
  t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = '', next = 0;
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      messages.push(message); events.emit(String(message.id), message);
    }
  });
  await once(socket, 'connect');
  const peer = accepted && (await accepted)[0];
  const request = async (method, params = {}, { split, revision = app.store.revision } = {}) => {
    const id = ++next, reply = once(events, String(id), { signal: AbortSignal.timeout(5000) });
    const bytes = Buffer.from(JSON.stringify({ id, method, params, revision }) + '\n');
    if (split) {
      const offset = bytes.indexOf(Buffer.from(split.character)) + split.offset;
      const target = peer.bytesRead + offset, signal = AbortSignal.timeout(5000);
      let received = once(peer, 'data', { signal });
      socket.write(bytes.subarray(0, offset));
      // Wait for the entire first fragment at the server before sending the rest.
      for (;;) {
        await received;
        if (peer.bytesRead >= target) break;
        received = once(peer, 'data', { signal });
      }
      socket.write(bytes.subarray(offset));
    } else socket.write(bytes);
    return (await reply)[0];
  };
  const ok = async (...args) => { const reply = await request(...args); assert.equal(reply.ok, true, reply.error); return reply.data; };
  return { socket, messages, request, ok };
}

for (const character of ['\u00e9', '\u20ac', '\ud83d\ude80']) {
  for (let offset = 1; offset < Buffer.byteLength(character); offset++) {
    test(`#7 persists ${Buffer.byteLength(character)}-byte UTF-8 split at byte ${offset}`, async t => {
      const { app } = fixture(t); await app.start();
      const { ok } = await connect(t, app), name = `Split ${character} text`;
      const preset = await ok('preset.create', { name }, { split: { character, offset } });
      const saved = JSON.parse(fs.readFileSync(path.join(app.store.presetDir, preset.id + '.json'), 'utf8'));
      assert.equal(saved.name, name);
      assert.equal(preset.name, name);
    });
  }
}

test('#7 rejects a non-ASCII request over the byte limit before executing it', async t => {
  const { app } = fixture(t); await app.start();
  const { socket, messages } = await connect(t, app);
  const bytes = Buffer.from(JSON.stringify({ id: 99, method: 'preset.create', revision: app.store.revision,
    params: { name: 'Must not persist', padding: '\u20ac'.repeat(400000) } }) + '\n');
  assert.ok(bytes.length > 1024 * 1024);
  assert.ok(bytes.toString().length < 1024 * 1024);
  const closed = new Promise(resolve => socket.once('close', resolve));
  // Keep chunk boundaries on characters so the original decoder does not inflate the size.
  const first = bytes.indexOf(Buffer.from('\u20ac'));
  socket.write(bytes.subarray(0, first));
  for (let start = first; start < bytes.length && !socket.destroyed; start += 30000) {
    socket.write(bytes.subarray(start, start + 30000)); await delay(2);
  }
  const disconnected = await Promise.race([closed.then(() => true), delay(1000).then(() => false)]);
  assert.equal(app.store.presets.some(p => p.name === 'Must not persist'), false);
  assert.equal(messages.some(m => m.id === 99), false);
  assert.equal(disconnected, true, 'the server must close an oversized request');
});

test('#7 accepts exactly the byte limit and resets framing for subsequent messages', async t => {
  const { app } = fixture(t); await app.start(); const { ok } = await connect(t, app);
  const params = { name: 'At the limit', padding: '' };
  const overhead = Buffer.byteLength(JSON.stringify({ id: 1, method: 'preset.create', params, revision: app.store.revision }) + '\n');
  const remaining = 1024 * 1024 - overhead;
  params.padding = '\u20ac'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  assert.equal((await ok('preset.create', params)).name, params.name);
  assert.equal((await ok('get')).status, 'preview');
});

async function staleSocket(t, socketPath) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import net from "node:net"; net.createServer().listen(process.argv[1], () => process.send("ready"));', socketPath],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
  const exited = once(child, 'exit', { signal });
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal }),
      exited.then(([code, signal]) => { throw new Error(`Socket child exited before ready: ${code ?? signal}\n${stderr}`); }),
    ]);
    assert.equal(message, 'ready');
    child.kill('SIGKILL'); await exited;
  } finally { controller.abort(); }
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
}

for (const kind of ['file', 'directory', 'symlink', 'dangling symlink']) {
  test(`#8 refuses and preserves an existing ${kind}, including after stop`, async t => {
    const { app, dir } = fixture(t), target = path.join(dir, 'target');
    if (kind === 'file') fs.writeFileSync(app.socketPath, 'preserve me');
    else if (kind === 'directory') fs.mkdirSync(app.socketPath);
    else {
      if (kind === 'symlink') fs.writeFileSync(target, 'preserve target');
      fs.symlinkSync(target, app.socketPath);
    }
    const before = fs.lstatSync(app.socketPath);
    await assert.rejects(app.start(), /socket|symbolic.link/i);
    await app.stop();
    assert.equal(fs.lstatSync(app.socketPath).ino, before.ino);
    if (kind === 'file') assert.equal(fs.readFileSync(app.socketPath, 'utf8'), 'preserve me');
    if (kind.includes('symlink')) assert.equal(fs.readlinkSync(app.socketPath), target);
    if (kind === 'symlink') assert.equal(fs.readFileSync(target, 'utf8'), 'preserve target');
    if (kind === 'dangling symlink') assert.equal(fs.existsSync(target), false);
  });
}

test('#8 refuses a live socket and stop leaves its listener reachable', async t => {
  const { app } = fixture(t), listener = net.createServer(c => c.end());
  await new Promise(resolve => listener.listen(app.socketPath, resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const before = fs.lstatSync(app.socketPath);
  await assert.rejects(app.start(), /already running/);
  await app.stop();
  assert.equal(fs.lstatSync(app.socketPath).ino, before.ino);
  const socket = net.createConnection(app.socketPath); await once(socket, 'connect'); socket.destroy();
});

test('#8 recovers a genuinely stale socket and removes its own socket on stop', async t => {
  const { app } = fixture(t); await staleSocket(t, app.socketPath);
  await app.start();
  assert.equal(fs.lstatSync(app.socketPath).mode & 0o777, 0o600);
  const { ok } = await connect(t, app); assert.equal((await ok('get')).status, 'preview');
  await app.stop(); assert.equal(fs.existsSync(app.socketPath), false);
});

test('#8 accepts a 107-byte public socket path without lengthening the bind path', async t => {
  const { app } = fixture(t, 107);
  assert.equal(Buffer.byteLength(app.socketPath), 107);
  await app.start();
  const { ok } = await connect(t, app); assert.equal((await ok('get')).status, 'preview');
  await app.stop();
  assert.equal(fs.existsSync(app.socketPath), false);
  assert.equal(fs.readdirSync(app.runtimeDir).some(name => name.startsWith('.socket-')), false);
});

test('#8 retains the private directory fd until server.close has completed', async t => {
  const { app, dir } = fixture(t), listen = net.Server.prototype.listen;
  let boundPath;
  t.mock.method(net.Server.prototype, 'listen', function(file, ...args) {
    boundPath = file; return listen.call(this, file, ...args);
  });
  await app.start();
  assert.match(boundPath, /^\/proc\/self\/fd\/\d+\/s$/);
  const fd = Number(boundPath.split('/')[4]);
  assert.equal(fs.fstatSync(fd).isDirectory(), true);
  assert.equal(fs.existsSync(boundPath), false);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.socket-')), false);
  const close = app.server.close;
  let finishClose, callbackSawOpenFd = false;
  t.mock.method(app.server, 'close', function(callback) {
    finishClose = () => close.call(this, (...args) => {
      callbackSawOpenFd = fs.fstatSync(fd).isDirectory(); callback(...args);
    });
    return this;
  });
  const stopping = app.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.fstatSync(fd).isDirectory(), true);
  const other = path.join(dir, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 's'), 'preserve');
  const otherFd = fs.openSync(other, 'r');
  try {
    assert.notEqual(otherFd, fd);
    finishClose(); await stopping;
    assert.equal(callbackSawOpenFd, true);
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.equal(fs.readFileSync(path.join(other, 's'), 'utf8'), 'preserve');
  } finally { fs.closeSync(otherFd); }
});

test('#8 does not treat other probe errors as stale sockets', async t => {
  const { app } = fixture(t); await staleSocket(t, app.socketPath);
  const before = fs.lstatSync(app.socketPath);
  t.mock.method(net, 'createConnection', () => {
    const probe = new net.Socket();
    process.nextTick(() => probe.destroy(Object.assign(new Error('injected EACCES'), { code: 'EACCES' })));
    return probe;
  });
  await assert.rejects(app.start(), { code: 'EACCES' });
  t.mock.restoreAll(); await app.stop();
  assert.equal(fs.lstatSync(app.socketPath).ino, before.ino);
});

for (const replacement of ['file', 'socket']) {
  test(`#8 preserves a replacement ${replacement} installed during stale probing`, async t => {
    const { app, dir } = fixture(t); await staleSocket(t, app.socketPath);
    const moved = path.join(dir, 'original.sock'), createConnection = net.createConnection;
    const replacementPath = path.join(dir, 'replacement.sock');
    if (replacement === 'socket') await staleSocket(t, replacementPath);
    let before;
    t.mock.method(net, 'createConnection', (...args) => {
      const probe = createConnection(...args);
      probe.once('error', () => {
        fs.renameSync(app.socketPath, moved);
        if (replacement === 'file') fs.writeFileSync(app.socketPath, 'replacement');
        else fs.renameSync(replacementPath, app.socketPath);
        before = fs.lstatSync(app.socketPath);
      });
      return probe;
    });
    await assert.rejects(app.start(), /changed|replaced/i);
    t.mock.restoreAll(); await app.stop();
    assert.equal(fs.lstatSync(app.socketPath).ino, before.ino);
    if (replacement === 'file') assert.equal(fs.readFileSync(app.socketPath, 'utf8'), 'replacement');
  });
}

test('#8 a concurrent publication preserves the winner and closes the failed server', async t => {
  const { app } = fixture(t), link = fs.linkSync;
  let fd;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === app.socketPath) {
      fd = Number(from.split('/')[4]);
      fs.writeFileSync(to, 'concurrent winner');
    }
    return link(from, to);
  });
  await assert.rejects(app.start(), { code: 'EEXIST' });
  t.mock.restoreAll();
  assert.equal(app.server.listening, false);
  assert.equal(fs.readFileSync(app.socketPath, 'utf8'), 'concurrent winner');
  assert.equal(fs.existsSync(app.socketDir), false);
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

for (const replacement of ['file', 'socket']) {
  test(`#8 stop preserves a replacement ${replacement} at its former socket path`, async t => {
    const { app, dir } = fixture(t); await app.start();
    fs.renameSync(app.socketPath, path.join(dir, 'owned.sock'));
    if (replacement === 'file') fs.writeFileSync(app.socketPath, 'replacement');
    else await staleSocket(t, app.socketPath);
    const before = fs.lstatSync(app.socketPath);
    await app.stop();
    assert.equal(fs.lstatSync(app.socketPath).ino, before.ino);
    if (replacement === 'file') assert.equal(fs.readFileSync(app.socketPath, 'utf8'), 'replacement');
  });
}

for (const presetId of ['everyday', 'browser']) {
  for (const exit of ['revert', 'timeout', 'replacement']) {
    test(`#30 ${presetId} trial selects its page and restores manual selection on ${exit}`, async t => {
      const { app } = fixture(t); await app.start();
      const { ok } = await connect(t, app);
      await ok('preset.apply', { id: 'everyday' }); await ok('page', { id: 'controls' });
      if (exit === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
      await ok('try', { preset: app.store.get(presetId), page: 'function' });
      assert.equal((await ok('get')).activePage, 'function');
      await ok('page', { id: 'main' });
      assert.equal((await ok('get')).activePage, 'main');
      if (exit === 'replacement') {
        await ok('try', { preset: app.store.get('developer'), page: 'controls' });
        assert.equal((await ok('get')).activePage, 'controls');
      }
      if (exit === 'timeout') { t.mock.timers.tick(20000); t.mock.timers.reset(); }
      else await ok('revert');
      const state = await ok('get');
      assert.equal(state.activePreset, 'everyday'); assert.equal(state.activePage, 'controls'); assert.equal(state.trialEnds, null);
      assert.equal(app.currentScenePage, 'controls');
    });
  }
}

test('#30 Fn overrides trial pages without changing either saved page selection', async t => {
  const { app } = fixture(t); await app.start(); const { ok } = await connect(t, app);
  await ok('preset.apply', { id: 'everyday' }); await ok('page', { id: 'controls' });
  app.fn = true; app.refresh();
  await ok('try', { preset: app.store.get('browser'), page: 'controls' });
  assert.equal((await ok('get')).activePage, 'function');
  app.fn = false; app.refresh(); assert.equal((await ok('get')).activePage, 'controls');
  await ok('page', { id: 'main' }); app.fn = true; app.refresh();
  await ok('revert'); assert.equal((await ok('get')).activePage, 'function');
  app.fn = false; app.refresh(); assert.equal((await ok('get')).activePage, 'controls');
});

test('#30 page button actions change only the trial page', async t => {
  const { app } = fixture(t); await app.start(); const { ok } = await connect(t, app);
  await ok('preset.apply', { id: 'everyday' }); await ok('page', { id: 'controls' });
  await ok('try', { preset: app.store.get('browser'), page: 'controls' });
  await app.actions.invoke({ type: 'page', page: 'main' });
  assert.equal((await ok('get')).activePage, 'main');
  await ok('revert'); assert.equal((await ok('get')).activePage, 'controls');
});

async function previewProcess(t, dir) {
  const socketPath = path.join(dir, 'control.sock');
  const child = spawn(process.execPath, ['backend/server.mjs', '--preview', '--no-live', '--socket', socketPath,
    '--config', path.join(dir, 'config'), '--state', path.join(dir, 'state')],
  { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    }
  });
  const deadline = Date.now() + 5000;
  while (!stderr.includes('MarchyBar ready:') && Date.now() < deadline && child.exitCode === null) await delay(10);
  assert.match(stderr, /MarchyBar ready:/);
  return { child, socketPath, store: {} };
}

test('#8 abrupt termination after startup leaves no private sockets and restart recovers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await previewProcess(t, dir);
  assert.equal((await (await connect(t, first)).ok('get')).status, 'preview');
  const closed = once(first.child, 'close'); first.child.kill('SIGKILL'); await closed;
  assert.equal(fs.lstatSync(first.socketPath).isSocket(), true);
  const leaked = fs.readdirSync(dir).filter(name => name.startsWith('.socket-'));
  const restarted = await previewProcess(t, dir);
  assert.equal((await (await connect(t, restarted)).ok('get')).status, 'preview');
  assert.deepEqual(leaked, [], 'SIGKILL after ready must not leave private bind artifacts');
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.socket-')), false);
});

test('real --preview --no-live process serves an isolated socket and native PNG', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { socketPath } = await previewProcess(t, dir);
  const { ok } = await connect(t, { socketPath, store: {} });
  const state = await ok('get'); assert.equal(state.status, 'preview');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(state.previewPath) && Date.now() < deadline) await delay(10);
  assert.equal(fs.readFileSync(state.previewPath).subarray(1, 4).toString(), 'PNG');
});

test('#30 automatic context changes during trials reset only the underlying manual page', async t => {
  const { app } = fixture(t); await app.start(); const { ok } = await connect(t, app);
  await ok('automatic'); await ok('simulate', { data: { app: 'chromium' } });
  await ok('page', { id: 'controls' });
  await ok('try', { preset: app.store.get('everyday'), page: 'controls' });
  await ok('simulate', { data: { app: 'no-matching-app' } });
  assert.equal((await ok('get')).activePage, 'controls');
  await ok('revert');
  let state = await ok('get'); assert.equal(state.activePreset, 'everyday'); assert.equal(state.activePage, 'main');
  await ok('page', { id: 'controls' }); await ok('simulate', { data: { app: 'chromium' } });
  state = await ok('get'); assert.equal(state.activePreset, 'browser'); assert.equal(state.activePage, 'main');
});

test('#13 failed preset.delete broadcasts the reconciled partial writes and revision', async t => {
  const { app } = fixture(t); await app.start(); const { ok, request } = await connect(t, app);
  const target = await ok('preset.create', { name: 'Delete target' });
  await ok('rules.save', { rules: [{ id: 'target', name: 'Target', enabled: true, app: '*', title: '', preset: target.id }] });
  await ok('settings.save', { settings: { pinnedPreset: target.id } });
  const observer = await connect(t, app); await observer.ok('get'); observer.messages.length = 0;
  const revision = app.store.revision, rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(app.store.configDir, 'settings.json')) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  const result = await request('preset.delete', { id: target.id, replacement: 'everyday' });
  t.mock.restoreAll();
  assert.equal(result.ok, false); assert.match(result.error, /ENOSPC/);
  await observer.ok('get');
  const state = observer.messages.find(m => m.event === 'state')?.state;
  assert.ok(state, 'a failed deletion must broadcast reconciled state');
  assert.notEqual(state.revision, revision); assert.equal(state.revision, app.store.revision);
  assert.equal(state.settings.pinnedPreset, target.id); assert.equal(state.rules[0].preset, 'everyday');
  assert.equal((await request('settings.save', { settings: { brightness: 42 } }, { revision })).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));

function child(t, command, args, env) {
  const process = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let closed = false;
  const stop = () => {
    if (closed || !process.pid) return;
    try { globalThis.process.kill(-process.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const done = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => {
      closed = true;
      t.signal.removeEventListener('abort', stop);
      resolve({ code, signal, stdout, stderr });
    });
  });
  t.signal.addEventListener('abort', stop, { once: true });
  if (t.signal.aborted) stop();
  t.after(async () => {
    stop();
    await done;
  });
  return { process, done, stop };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-cache-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'native/src'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'bin/marchybar'), path.join(plugin, 'bin/marchybar'));
  for (const file of ['package.json', 'package-lock.json', 'binding.gyp']) {
    fs.copyFileSync(path.join(repo, file), path.join(plugin, file));
  }
  fs.writeFileSync(path.join(plugin, 'native/src/fixture.cpp'), 'int fixture = 1;\n');
  const mock = path.join(root, 'mock.bash');
  fs.writeFileSync(mock, `
pkg-config() { [[ "$*" == '--exists cairo libdrm pangocairo librsvg-2.0' ]]; }
flock() {
  if [[ \${CHECK_CONTENTION:-no} == yes ]]; then
    local status=0
    command flock -n "$@" || status=$?
    [[ $status == 1 ]] || return 94
    touch "$FIXTURE_ROOT/contended"
  fi
  command flock "$@"
}
npm() {
  case "$PWD" in "$FIXTURE_ROOT"/*) ;; *) return 91 ;; esac
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/commands"
  if [[ "$*" == 'ci --ignore-scripts --include=dev' ]]; then return 0; fi
  [[ "$*" == 'run build' ]] || return 92
  mkdir -p build/Release
  printf 'partial\\n' > build/Release/drm_backend.node
  if [[ \${BUILD_WAIT:-no} == yes ]]; then
    touch "$FIXTURE_ROOT/ready"
    local deadline=$((SECONDS + 10))
    while [[ ! -f "$FIXTURE_ROOT/release" ]]; do
      (( SECONDS < deadline )) || return 93
      sleep 0.01
    done
  fi
  [[ \${BUILD_FAIL:-no} != yes ]] || return 42
  if [[ \${BUILD_MISSING:-no} == yes ]]; then
    rm build/Release/drm_backend.node
  else
    printf '%s\\n' "\${BUILD_TAG:-complete}" > build/Release/drm_backend.node
  fi
}
`);
  const env = { ...process.env, BASH_ENV: mock, HOME: path.join(root, 'home'), XDG_CACHE_HOME: path.join(root, 'cache'), FIXTURE_ROOT: root };
  const start = (extra = {}) => child(t, '/bin/bash', [path.join(plugin, 'bin/marchybar'), 'prepare'], { ...env, ...extra });
  const prepare = async (extra = {}) => {
    const result = await start(extra).done;
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  const entries = () => fs.readdirSync(path.join(root, 'cache/marchybar/native')).map(name => path.join(root, 'cache/marchybar/native', name));
  const artifacts = () => entries().map(dir => path.join(dir, 'build/Release/drm_backend.node')).filter(file => fs.existsSync(file));
  const builds = () => fs.readFileSync(path.join(root, 'commands'), 'utf8').split('\n').filter(line => line === 'run build').length;
  const ready = async (file = 'ready') => {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(root, file))) {
      assert.ok(Date.now() < deadline, `fixture did not signal ${file}`);
      await delay(10);
    }
  };
  return { root, plugin, start, prepare, entries, artifacts, builds, ready };
}

test('native cache retries a failed build instead of accepting partial output (#17)', async t => {
  const f = fixture(t);
  assert.equal((await f.start({ BUILD_FAIL: 'yes' }).done).code, 42);
  await f.prepare();
  assert.equal(f.builds(), 2);
  assert.equal(fs.readFileSync(f.artifacts()[0], 'utf8'), 'complete\n');
  await f.prepare();
  assert.equal(f.builds(), 2, 'successful cache is reused');
});

test('native cache readers wait for the writer and no partial artifact is published (#17)', async t => {
  const f = fixture(t);
  const writer = f.start({ BUILD_WAIT: 'yes' });
  await f.ready();
  const reader = f.start({ CHECK_CONTENTION: 'yes' });
  let finished = false;
  reader.done.then(() => { finished = true; });
  try {
    await f.ready('contended');
    assert.equal(finished, false, 'reader returned while the writer was paused');
    assert.deepEqual(f.artifacts(), [], 'unfinished artifact must not be published');
  } finally {
    fs.writeFileSync(path.join(f.root, 'release'), '');
    await Promise.all([writer.done, reader.done]);
  }
  assert.equal((await writer.done).code, 0);
  assert.equal((await reader.done).code, 0);
  assert.equal(f.builds(), 1);
  assert.equal(fs.readFileSync(f.artifacts()[0], 'utf8'), 'complete\n');
});

test('native cache recovers after a killed writer (#17)', async t => {
  const f = fixture(t);
  const writer = f.start({ BUILD_WAIT: 'yes' });
  await f.ready();
  process.kill(-writer.process.pid, 'SIGKILL');
  assert.equal((await writer.done).signal, 'SIGKILL');
  await f.prepare();
  assert.equal(f.builds(), 2);
  assert.equal(fs.readFileSync(f.artifacts()[0], 'utf8'), 'complete\n');
});

test('native cache rejects a successful build without an artifact (#17)', async t => {
  const f = fixture(t);
  assert.notEqual((await f.start({ BUILD_MISSING: 'yes' }).done).code, 0);
  await f.prepare();
  assert.equal(f.builds(), 2);
});

test('native cache rebuilds old unmarked artifacts (#17)', async t => {
  const f = fixture(t);
  await f.prepare();
  fs.rmSync(path.join(f.entries()[0], '.complete'), { force: true });
  fs.writeFileSync(f.artifacts()[0], 'partial\n');
  await f.prepare();
  assert.equal(f.builds(), 2);
  assert.equal(fs.readFileSync(f.artifacts()[0], 'utf8'), 'complete\n');
});

test('native cache hashes package.json and native sources while reusing unchanged inputs (#23)', async t => {
  const f = fixture(t);
  await f.prepare({ BUILD_TAG: 'script-A' });
  await f.prepare();
  assert.equal(f.builds(), 1);
  const manifestPath = path.join(f.plugin, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.scripts.build = 'CXXFLAGS=-fno-omit-frame-pointer ' + manifest.scripts.build;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await f.prepare({ BUILD_TAG: 'script-B' });
  assert.equal(f.builds(), 2, 'changing only scripts.build must rebuild');
  assert.equal(f.entries().length, 2);
  assert.deepEqual(f.artifacts().map(file => fs.readFileSync(file, 'utf8')).sort(), ['script-A\n', 'script-B\n']);
  fs.writeFileSync(path.join(f.plugin, 'native/src/fixture.cpp'), 'int fixture = 2;\n');
  await f.prepare();
  assert.equal(f.builds(), 3, 'native source changes must also rebuild');
});

test('CLI preserves UTF-8 responses split at every multibyte boundary (#7)', async t => {
  for (const character of ['\u00e9', '\u20ac', '\ud83d\ude80']) {
    for (let split = 1; split < Buffer.byteLength(character); split++) {
      await t.test(`${Buffer.byteLength(character)}-byte character split at ${split}`, { timeout: 5000 }, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-cli-'));
        const socketPath = path.join(root, 'control.sock');
        const sockets = new Set();
        let runner;
        const server = net.createServer(socket => {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.setEncoding('utf8');
          let request = '';
          socket.on('data', async chunk => {
            request += chunk;
            if (!request.includes('\n')) return;
            const { id } = JSON.parse(request);
            const bytes = Buffer.from(JSON.stringify({ id, ok: true, data: { presets: [{ id: 'p', name: `Caf${character}`, customized: false }] } }) + '\n');
            const boundary = bytes.indexOf(Buffer.from(character)) + split;
            socket.write(bytes.subarray(0, boundary));
            // The protocol has no partial-response ACK; scheduling can still coalesce these writes.
            await delay(50);
            socket.write(bytes.subarray(boundary));
          });
        });
        t.after(async () => {
          runner?.stop();
          for (const socket of sockets) socket.destroy();
          await new Promise(resolve => server.close(resolve));
          try { await runner?.done; }
          finally { fs.rmSync(root, { recursive: true, force: true }); }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        runner = child(t, process.execPath, [path.join(repo, 'backend/cli.mjs'), 'list'], { ...process.env, MARCHYBAR_SOCKET: socketPath });
        const result = await runner.done;
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout)[0].name, `Caf${character}`);
      });
    }
  }
});

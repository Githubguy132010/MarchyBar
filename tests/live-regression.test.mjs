import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { DEFAULT_RULES, DEFAULT_SETTINGS, selectPreset, validateAction } from '../backend/model.mjs';

// Install the subprocess fence before live.mjs captures promisified execFile.
let execute = () => { throw new Error('Unexpected subprocess'); };
const original = cp.execFile;
const originalSpawn = cp.spawn;
let launch = () => { throw new Error('Unexpected spawn'); };
cp.spawn = (...args) => launch(...args);
after(() => { cp.spawn = originalSpawn; syncBuiltinESMExports(); });
function fake() { throw new Error('Real subprocesses forbidden'); }
fake[promisify.custom] = (...args) => execute(...args);
cp.execFile = fake;
syncBuiltinESMExports();
const { Actions, LiveData } = await import('../backend/live.mjs');
cp.execFile = original;
syncBuiltinESMExports();

test('bundled Terminal button detaches without waiting for exit or injecting a shortcut', { timeout: 1000 }, async () => {
  const preset = JSON.parse(fs.readFileSync(new URL('../presets/developer.json', import.meta.url), 'utf8'));
  const action = preset.pages.find(page => page.id === 'main').widgets.find(widget => widget.id === 'terminal').action;
  assert.deepEqual(validateAction(action), []);
  const calls = [], errors = [];
  execute = () => { throw new Error('Terminal must not use a timed command'); };
  let unreferenced = false;
  launch = (file, args, options) => {
    calls.push([file, args, options]);
    const child = new EventEmitter();
    child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  let locked = false, preview = false;
  const actions = new Actions({ live: { data: {} }, isLocked: () => locked, isPreview: () => preview, onError: e => errors.push(e) });
  await actions.invoke(action);
  assert.deepEqual(calls, [['omarchy', ['launch', 'terminal'], { detached: true, stdio: 'ignore' }]]);
  assert.equal(unreferenced, true);
  preview = true;
  await actions.invoke(action);
  preview = false;
  locked = true;
  await actions.invoke(action);
  assert.equal(calls.length, 1);
  assert.deepEqual(errors, []);
});

test('detached commands report startup errors and reject invalid detached flags', async () => {
  const errors = [];
  launch = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn missing ENOENT')));
    return child;
  };
  const actions = new Actions({ isLocked: () => false, isPreview: () => false, onError: e => errors.push(e) });
  await actions.invoke({ type: 'command', argv: ['missing'], detached: true });
  assert.deepEqual(errors, ['spawn missing ENOENT']);
  assert.match(validateAction({ type: 'command', argv: ['missing'], detached: 'true' })[0], /detached must be a boolean/);
});

test('ordinary commands retain their timeout and error reporting', async () => {
  const calls = [], errors = [];
  execute = async (...args) => { calls.push(args); throw new Error('command failed'); };
  const actions = new Actions({ isLocked: () => false, isPreview: () => false, onError: e => errors.push(e) });
  for (const detached of [undefined, false]) {
    const action = { type: 'command', argv: ['fixture', 'arg'], detached };
    assert.deepEqual(validateAction(action), []);
    await actions.invoke(action);
  }
  assert.equal(calls.length, 2);
  for (const [file, args, options] of calls) {
    assert.equal(file, 'fixture'); assert.deepEqual(args, ['arg']); assert.equal(options.timeout, 30000);
  }
  assert.deepEqual(errors, ['command failed', 'command failed']);
});

test('desktop IDs resolve direct and nested entries with XDG precedence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-desktop-'));
  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_DATA_DIRS: process.env.XDG_DATA_DIRS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.XDG_DATA_HOME = path.join(dir, 'home');
  process.env.XDG_DATA_DIRS = [path.join(dir, 'first'), path.join(dir, 'second')].join(':');
  for (const relative of ['home/applications/vendor/editor.desktop', 'home/applications/my-vendor/my-editor.desktop', 'home/applications/plain-app.desktop', 'first/applications/vendor-editor.desktop', 'first/applications/system.desktop', 'second/applications/system.desktop']) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[Desktop Entry]\nType=Application\nName=Fixture\nExec=must-not-execute\n');
  }
  const calls = [], errors = [];
  execute = async (file, args) => { calls.push([file, args]); return { stdout: '' }; };
  const actions = new Actions({ live: { data: {} }, isLocked: () => false, isPreview: () => false, onError: e => errors.push(e) });
  for (const [desktop, relative] of [
    ['plain-app.desktop', 'home/applications/plain-app.desktop'],
    ['vendor-editor.desktop', 'home/applications/vendor/editor.desktop'],
    ['my-vendor-my-editor.desktop', 'home/applications/my-vendor/my-editor.desktop'],
    ['system.desktop', 'first/applications/system.desktop'],
  ]) {
    const action = { type: 'launch', desktop };
    assert.deepEqual(validateAction(action), []);
    await actions.invoke(action);
    assert.deepEqual(errors, [], desktop);
    assert.deepEqual(calls.at(-1), ['gio', ['launch', path.join(dir, relative)]]);
  }
  await actions.invoke({ type: 'launch', desktop: 'missing.desktop' });
  assert.deepEqual(errors, ['Application is not installed']);
  assert.equal(calls.length, 4);
});

test('context requests during an in-flight batch coalesce into a trailing refresh', { timeout: 2000 }, async t => {
  const live = new LiveData();
  t.after(() => live.stop());
  let focused = { class: 'firefox', title: 'Browser' }, calls = 0;
  const releases = [];
  execute = (file, args) => {
    assert.equal(file, 'hyprctl');
    calls++;
    const value = args[0] === 'activewindow' ? structuredClone(focused) : args[0] === 'workspaces' ? [{ id: 1, name: '1', windows: 1 }] : { id: 1 };
    if (calls <= 3) return new Promise(resolve => releases.push(() => resolve({ stdout: JSON.stringify(value) })));
    return Promise.resolve({ stdout: JSON.stringify(value) });
  };
  const first = live.refreshContext();
  focused = { class: 'code', title: 'Editor' };
  const later = [live.refreshContext(), live.refreshContext()];
  releases.splice(0).forEach(release => release());
  await Promise.all([first, ...later]);
  assert.equal(calls, 6);
  assert.equal(live.data.app, 'code');
  assert.equal(live.data.title, 'Editor');
  const presets = ['everyday', 'browser', 'developer', 'classic'].map(id => ({ id }));
  assert.equal(selectPreset({ presets, settings: DEFAULT_SETTINGS, rules: DEFAULT_RULES, context: live.data }).id, 'developer');
});

test('preview gestures update the session and never call the system', async () => {
  const updates = [];
  const live = {
    data: { volume: 10, media: { player: 'spotify', status: 'Paused', length: 200, position: 0 } },
    update(patch) { this.data = { ...this.data, ...patch }; updates.push(patch); },
  };
  const touchbar = [];
  const actions = new Actions({
    live, isLocked: () => false, isPreview: () => true,
    onTouchbar: (value, final) => touchbar.push([value, final]),
    onError: error => { throw new Error(error); },
  });
  actions.slider('volume', 40, true);
  actions.slider('seek', 25, false);
  actions.slider('touchbar', 10, false);
  assert.equal(live.data.volume, 40);
  assert.equal(live.data.media.position, 50);
  assert.deepEqual(touchbar, [[10, false]]);
  await actions.invoke({ type: 'workspace', workspace: 3 });
  assert.equal(live.data.workspace, 3);
  await actions.invoke({ type: 'media', command: 'play-pause' });
  assert.equal(live.data.media.status, 'Playing');
  await actions.invoke({ type: 'key', key: 'F5', modifiers: [] });
  assert.deepEqual(updates.at(-1) ? live.data.volume : null, 40);
});

for (const stopped of [false, true]) {
  test(`pending context refresh ${stopped ? 'stops without publishing' : 'retries a failed batch when dirty'}`, { timeout: 2000 }, async t => {
    const live = new LiveData();
    t.after(() => live.stop());
    let rejectFirst, calls = 0, changes = 0;
    live.on('change', () => changes++);
    execute = (file, args) => {
      assert.equal(file, 'hyprctl');
      calls++;
      if (calls === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
      const value = args[0] === 'activewindow' ? { class: 'code', title: 'Editor' } : args[0] === 'workspaces' ? [] : { id: 2 };
      return Promise.resolve({ stdout: JSON.stringify(value) });
    };
    const first = live.refreshContext();
    live.refreshContext();
    if (stopped) live.stop();
    rejectFirst(new Error('injected context query failure'));
    await first;
    assert.equal(calls, stopped ? 3 : 6);
    assert.equal(changes, stopped ? 0 : 1);
    assert.equal(live.data.app, stopped ? '' : 'code');
    assert.equal(live.pending.has('context'), false);
  });
}

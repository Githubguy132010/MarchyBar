import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../backend/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-store-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { root, configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state') };
  return { dir, options, store: new Store(options) };
}

for (const stage of ['rules', 'settings', 'linked', 'unlink']) {
  test(`failed deletion reconciles disk state and revision after ${stage} failure`, t => {
    const { store, options } = fixture(t);
    const target = store.create('Target', null, store.revision);
    const linked = store.create('Linked', null, store.revision);
    linked.pages[0].widgets = [{ id: 'link', type: 'button', weight: 1, action: { type: 'preset', preset: target.id } }];
    store.save(linked, store.revision);
    store.saveRules([{ id: 'target', name: 'Target rule', enabled: true, app: '*', title: '', preset: target.id }], store.revision);
    store.saveSettings({ defaultPreset: target.id, pinnedPreset: target.id }, store.revision);
    const before = store.snapshot();
    const destination = stage === 'linked' ? path.join(store.presetDir, linked.id + '.json')
      : stage === 'unlink' ? path.join(store.presetDir, target.id + '.json') : path.join(store.configDir, stage + '.json');
    const method = stage === 'unlink' ? 'unlinkSync' : 'renameSync', original = fs[method];
    const failure = Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
    t.mock.method(fs, method, (...args) => {
      if (args[stage === 'unlink' ? 0 : 1] === destination) throw failure;
      return original(...args);
    });
    try { assert.throws(() => store.delete(target.id, 'everyday', before.revision), failure); }
    finally { t.mock.restoreAll(); }
    assert.deepEqual(store.snapshot(), new Store(options).snapshot());
    assert.equal(store.get(target.id).name, 'Target');
    if (stage === 'rules') {
      assert.deepEqual(store.snapshot(), before);
    } else {
      assert.notEqual(store.revision, before.revision);
      assert.throws(() => store.saveSettings({ brightness: 42 }, before.revision), /out of date/);
    }
    store.saveSettings({ brightness: 42 }, store.revision);
    assert.equal(store.settings.pinnedPreset, ['rules', 'settings'].includes(stage) ? target.id : 'everyday');
    assert.deepEqual(store.snapshot(), new Store(options).snapshot());
  });
}

for (const dangling of [false, true]) {
  test(`export preserves and rejects a ${dangling ? 'dangling' : 'valid'} destination symlink`, t => {
    const { dir, store } = fixture(t);
    const target = path.join(dir, 'target.json'), destination = path.join(dir, 'export.json');
    if (!dangling) fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, destination);
    assert.throws(() => store.export('everyday', destination), /symbolic link/);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(destination), target);
    if (dangling) assert.equal(fs.existsSync(target), false);
    else assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  });
}

test('export creates and replaces regular destinations', t => {
  const { dir, store } = fixture(t), destination = path.join(dir, 'export.json');
  store.export('everyday', destination);
  assert.equal(JSON.parse(fs.readFileSync(destination)).id, 'everyday');
  store.export('browser', destination);
  assert.equal(JSON.parse(fs.readFileSync(destination)).id, 'browser');
});

test('export propagates destination inspection errors without replacing the file', t => {
  const { dir, store } = fixture(t), destination = path.join(dir, 'export.json');
  fs.writeFileSync(destination, 'untouched');
  const original = fs.lstatSync, failure = Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === destination) throw failure;
    return original(file, ...args);
  });
  try { assert.throws(() => store.export('everyday', destination), failure); }
  finally { t.mock.restoreAll(); }
  assert.equal(fs.readFileSync(destination, 'utf8'), 'untouched');
});

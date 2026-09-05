import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreset, matches, selectPreset, DEFAULT_RULES, DEFAULT_SETTINGS } from '../backend/model.mjs';
import { Store } from '../backend/store.mjs';
import { layout, scene, Gesture } from '../backend/scene.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const presets = fs.readdirSync(root + 'presets').map(f => JSON.parse(fs.readFileSync(root + 'presets/' + f)));

test('every bundled page is valid and usable at both real Touch Bar geometries', () => {
  for (const preset of presets) {
    validatePreset(preset);
    for (const page of preset.pages) for (const width of [2008, 2170]) {
      const l = layout(preset, page.id, { width, height: 60 });
      assert.ok(l.boxes.every(b => b.x >= 0 && b.x + b.w < l.menuX && b.w >= 12));
      assert.equal(l.escapeWidth, width === 2170 ? 96 : 0);
      const s = scene(preset, page.id, { width, height: 60 });
      assert.ok(s.commands.length > 0);
      assert.ok(s.targets.every(t => t.x >= 0 && t.x + t.w <= width));
    }
  }
});
test('reject malformed actions, duplicate widget IDs and missing Fn pages before saving', () => {
  const p = structuredClone(presets[0]);
  p.fnPage = 'missing';
  assert.throws(() => validatePreset(p), /fnPage/);
  p.fnPage = null; p.pages[0].widgets = [
    { id: 'same', type: 'button', weight: 1, action: { type: 'command', argv: [] } },
    { id: 'same', type: 'button', weight: 1, action: { type: 'key', key: 'Return', modifiers: [] } },
  ];
  assert.throws(() => validatePreset(p), /duplicate/);
  assert.throws(() => validatePreset({ ...p, id: '../escape' }), /id:/);
});
test('app matching is case insensitive, ordered and treats regex punctuation literally', () => {
  assert.equal(matches('*chrom*|*firefox*', 'org.chromium.Chromium'), true);
  assert.equal(matches('com.test.App', 'comXtestXApp'), false);
  assert.equal(matches('test[123]', 'test[123]'), true);
  const args = { presets, settings: DEFAULT_SETTINGS, rules: DEFAULT_RULES, context: { app: 'org.mozilla.firefox' } };
  assert.equal(selectPreset(args).id, 'browser');
  assert.equal(selectPreset({ ...args, settings: { ...DEFAULT_SETTINGS, pinnedPreset: 'focus' } }).id, 'focus');
  assert.equal(selectPreset({ ...args, locked: true }).id, 'classic');
  assert.equal(selectPreset({ ...args, context: { app: '' } }).id, 'everyday');
});
test('store supports complete preset lifecycle without modifying factory definitions', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-store-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const store = new Store({ root, configDir: temp + '/config', stateDir: temp + '/state' });
  const original = store.get('everyday');
  store.save({ ...original, name: 'My Everyday' }, store.revision);
  assert.equal(store.get('everyday').customized, true);
  const created = store.create('My workspace', 'everyday', store.revision);
  assert.notEqual(created.id, 'everyday');
  store.saveSettings({ pinnedPreset: created.id }, store.revision);
  assert.throws(() => store.delete(created.id, null, store.revision), /replacement/);
  store.delete(created.id, 'everyday', store.revision);
  assert.equal(store.settings.pinnedPreset, 'everyday');
  store.restore('everyday', store.revision);
  assert.equal(store.get('everyday').name, original.name);
  assert.equal(store.get('everyday').customized, false);
  const imported = store.import(original, store.revision);
  assert.notEqual(imported.id, original.id);
  store.export(imported.id, temp + '/export.json');
  assert.equal(JSON.parse(fs.readFileSync(temp + '/export.json')).id, imported.id);
  assert.throws(() => store.save(imported, 'stale'), /out of date/);
});
test('invalid user file is reported and does not erase the working preset', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-invalid-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(temp + '/presets'); fs.writeFileSync(temp + '/presets/everyday.json', '{broken');
  const store = new Store({ root, configDir: temp, stateDir: temp + '/state' });
  assert.equal(store.get('everyday').name, 'Everyday'); assert.equal(store.errors.length, 1);
});
test('slider captures the original target through a scene change and clamps outside movement', () => {
  const values = [], actions = [];
  const g = new Gesture({ slider: (...v) => values.push(v), action: a => actions.push(a) });
  const targets = [{ x: 0, y: 0, w: 200, h: 60, trackX: 10, trackW: 180, widgetId: 'volume', kind: 'slider', channel: 'volume' }];
  g.input('start', 100, 30, targets, 1);
  g.input('move', 500, 30, [{ ...targets[0], channel: 'brightness' }], 2);
  g.input('end', -100, 30, [], 3);
  assert.deepEqual(values.map(v => v[0]), ['volume', 'volume', 'volume']);
  assert.equal(values[1][1], 100); assert.deepEqual(values[2], ['volume', 0, true]);
  assert.equal(actions.length, 0); assert.equal(g.capture, null);
});
test('locked scene rejects custom actions and cancelled touches never fire', () => {
  const actions = [], g = new Gesture({ slider: () => {}, action: a => actions.push(a) });
  const target = { x: 0, y: 0, w: 100, h: 60, widgetId: 'test', kind: 'button', action: { type: 'command', argv: ['false'] } };
  g.input('start', 20, 20, [target], 1, true); g.input('end', 20, 20, [target], 1, true); assert.equal(actions.length, 0);
  g.input('start', 20, 20, [target], 1); g.input('cancel', 20, 20, [], 1); g.input('end', 20, 20, [target], 1); assert.equal(actions.length, 0);
});

test('preset links survive duplication/import and are redirected before deleting their target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-links-'));
  try {
    const store = new Store({root,configDir:path.join(dir,'config'),stateDir:path.join(dir,'state')});
    const target = store.create('Target',null,store.revision);
    const p = store.create('Linked',null,store.revision);
    p.pages[0].widgets=[{id:'link',type:'button',label:'Go',weight:1,action:{type:'preset',preset:target.id}}];
    store.save(p,store.revision);
    assert.throws(()=>store.delete(target.id,null,store.revision),/replacement/);
    store.delete(target.id,'everyday',store.revision);
    assert.equal(store.get(p.id).pages[0].widgets[0].action.preset,'everyday');
    p.pages[0].widgets[0].action.preset=p.id;store.save(p,store.revision);
    const duplicate=store.create('Copy',p.id,store.revision);
    assert.equal(duplicate.pages[0].widgets[0].action.preset,duplicate.id);
    const imported=store.import(p,store.revision);
    assert.equal(imported.pages[0].widgets[0].action.preset,imported.id);
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
});

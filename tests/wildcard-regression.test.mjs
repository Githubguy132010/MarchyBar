import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matches } from '../backend/model.mjs';

test('wildcards retain alternatives, case folding, literals and single-character matching', () => {
  for (const [pattern, value, expected] of [
    [' *firefox* | code? ', 'CODE1', true], ['code?', 'code', false],
    ['a*b?c', 'axyzbxc', true], ['a*b?c', 'axyzbc', false], ['**', '', true],
    ['a*', 'ba', false], ['test[1].(x)+$', 'test[1].(x)+$', true],
    ['test[1]', 'test1', false], ['', '', true], ['a|', '', true],
    ['\u00e9', '\u00c9', true], ['\u00df', 'SS', false], ['k', '\u212a', false],
    ['?', '\ud83d\ude00', false], ['??', '\ud83d\ude00', true],
    ['*', 'a\nb', false], ['?', '\n', false], ['a\nb', 'a\nb', true],
  ]) assert.equal(matches(pattern, value), expected, JSON.stringify({ pattern, value }));
  assert.equal(matches(null, 'x'), false);
  assert.equal(matches('*', null), false);
});

test('saved adversarial rules return and allow a short timer to run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-wildcard-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const options = { root, configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state') };
  const source = `
    import assert from 'node:assert/strict';
    import { Store } from ${JSON.stringify(new URL('../backend/store.mjs', import.meta.url).href)};
    import { selectPreset, matches } from ${JSON.stringify(new URL('../backend/model.mjs', import.meta.url).href)};
    const store = new Store(${JSON.stringify(options)});
    store.saveRules([{id:'slow',name:'Slow',enabled:true,app:'*a'.repeat(20)+'b',title:'',preset:'browser'}],store.revision);
    const timer = new Promise(resolve => setTimeout(() => { console.log('TIMER_FIRED'); resolve(); }, 10));
    console.log('MATCH_BEGIN');
    assert.equal(selectPreset({...store.snapshot(),context:{app:'a'.repeat(60)}}).id,'everyday');
    for (const pattern of ['*a'.repeat(100)+'b', '*?'.repeat(100)+'b', '*a'.repeat(100)+'*']) {
      assert.equal(matches(pattern, 'a'.repeat(4096)), pattern.endsWith('*'));
    }
    console.log('MATCH_RETURNED');
    await timer;
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL' });
    assert.equal(child.error, undefined, `${child.error?.message}\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /MATCH_RETURNED/);
    assert.match(child.stdout, /TIMER_FIRED/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.configDir, 'rules.json')))[0].app, '*a'.repeat(20) + 'b');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

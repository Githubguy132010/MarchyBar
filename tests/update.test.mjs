import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../bin/marchybar', import.meta.url));
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2), home = process.env.HOME;
if (path.basename(process.argv[1]) === 'git') {
  if (args.slice(2).join(' ') !== 'rev-parse HEAD') process.exit(99);
  console.log(fs.readFileSync(home + '/head', 'utf8'));
} else {
  fs.appendFileSync(home + '/calls', JSON.stringify(args) + '\\n');
  const command = args.join(' ');
  if (command === 'update') process.exit(Number(process.env.SYSTEM_RC || 0));
  if (command === 'plugin update marchybar.touchbar') {
    if (process.env.CHANGED === '1') fs.writeFileSync(home + '/head', 'new');
    process.exit(Number(process.env.PLUGIN_RC || 0));
  }
  if (command === 'restart shell') process.exit(Number(process.env.RESTART_RC || 0));
  process.exit(99);
}
`;

for (const scenario of [
  { name: 'changed plugin restarts the shell', changed: true, calls: ['plugin update marchybar.touchbar', 'restart shell'] },
  { name: 'unchanged or declined plugin does not restart', calls: ['plugin update marchybar.touchbar'] },
  { name: 'combined update activates plugin before Omarchy can reboot', combined: true, changed: true, calls: ['plugin update marchybar.touchbar', 'restart shell', 'update'] },
  { name: 'unchanged combined update needs no extra restart', combined: true, calls: ['plugin update marchybar.touchbar', 'update'] },
  { name: 'failed system update leaves plugin activated', combined: true, changed: true, system: 7, status: 7, calls: ['plugin update marchybar.touchbar', 'restart shell', 'update'] },
  { name: 'failed plugin update stops combined update', combined: true, plugin: 3, status: 3, calls: ['plugin update marchybar.touchbar'] },
  { name: 'failed plugin update does not restart unchanged code', plugin: 3, status: 3, calls: ['plugin update marchybar.touchbar'] },
  { name: 'failed rescan still restarts changed code and reports failure', changed: true, plugin: 4, status: 4, calls: ['plugin update marchybar.touchbar', 'restart shell'] },
  { name: 'locked or failed restart reports the pending command', changed: true, restart: 1, status: 1, calls: ['plugin update marchybar.touchbar', 'restart shell'], error: /Unlock the desktop and run: omarchy restart shell/ },
  { name: 'unknown options do not run updates', args: ['--yes'], status: 2, calls: [] },
  { name: 'extra arguments do not run updates', args: ['--with-omarchy', 'extra'], status: 2, calls: [] },
  { name: 'unmanaged installation does not run updates', unmanaged: true, status: 1, calls: [] },
]) {
  test(`update: ${scenario.name}`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marchybar-update-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'bin'));
    if (!scenario.unmanaged) fs.mkdirSync(path.join(home, '.config/omarchy/plugins/marchybar.touchbar/.git'), { recursive: true });
    for (const name of ['git', 'omarchy']) fs.writeFileSync(path.join(home, 'bin', name), stub, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'head'), 'old');
    fs.writeFileSync(path.join(home, 'calls'), '');
    const result = spawnSync('/bin/bash', [launcher, 'update', ...(scenario.args || (scenario.combined ? ['--with-omarchy'] : []))], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${home}/bin:${process.env.PATH}`,
        CHANGED: scenario.changed ? '1' : '0', SYSTEM_RC: String(scenario.system || 0), PLUGIN_RC: String(scenario.plugin || 0), RESTART_RC: String(scenario.restart || 0) },
    });
    assert.equal(result.status, scenario.status || 0, result.stderr);
    const calls = fs.readFileSync(path.join(home, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).join(' '));
    assert.deepEqual(calls, scenario.calls);
    if (scenario.error) assert.match(result.stderr, scenario.error);
  });
}

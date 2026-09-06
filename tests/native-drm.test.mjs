import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native DRM with mocked libdrm and syscalls only', { skip: process.platform !== 'linux' }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marchybar-native-drm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'drm-fixture');
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const includes = run('pkg-config', ['--cflags', 'libdrm']).trim().split(/\s+/).filter(Boolean);
  run(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror', ...includes,
    'native/src/drm.cpp', 'native/tests/drm_fixture.cpp',
    '-Wl,--wrap=open,--wrap=close,--wrap=mmap,--wrap=munmap,--wrap=ioctl',
    '-o', executable,
  ]);
  for (const scenario of [
    'adp', 'adp-master', 'adp-pitch', 'adp-property', 'adp-unpadded-height', 'adp-size-only-padding',
    'adp-wrong-width', 'adp-wrong-height', 'adp-landscape', 'adp-no-mode', 'adp-no-crtc',
    'adp-short-pitch', 'adp-unaligned-pitch', 'adp-short-height', 'adp-short-size',
    'fail-version', 'fail-resources', 'fail-master', 'fail-create', 'fail-addfb',
    'fail-map', 'fail-mmap', 'fail-activate', 'close-unconfigured',
    't2-right', 't2-left', 't2-normal', 't2-no-property', 'unknown-portrait', 'adp-prefix',
    'adp-dirty-fallback', 'adp-cleanup-errors',
  ]) {
    await t.test(scenario, () => run(executable, [scenario]));
  }
});

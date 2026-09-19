import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSemver, formatSemver, compareSemver, incrementVersion, currentVersion, checkVersionConsistency } from '../scripts/version.mjs';
import { VERSION } from '../backend/version.mjs';

test('semantic versions parse into major, minor, patch and prerelease parts', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: '' });
  assert.deepEqual(parseSemver('1.0.0-rc.1'), { major: 1, minor: 0, patch: 0, prerelease: ['rc', '1'], build: '' });
  assert.deepEqual(parseSemver('1.0.0+build.7'), { major: 1, minor: 0, patch: 0, prerelease: [], build: 'build.7' });
  assert.throws(() => parseSemver('1.0'), /Invalid semantic version/);
  assert.throws(() => parseSemver('01.0.0'), /Invalid semantic version/);
});

test('semantic versions serialize without losing prerelease or build metadata', () => {
  assert.equal(formatSemver(parseSemver('1.2.3-rc.1+build.7')), '1.2.3-rc.1+build.7');
});

test('semantic versions order by precedence', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});

test('release types increment following semantic versioning', () => {
  assert.equal(incrementVersion('0.1.0', 'major'), '1.0.0');
  assert.equal(incrementVersion('1.0.0', 'major'), '2.0.0');
  assert.equal(incrementVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(incrementVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(incrementVersion('1.2.3-rc.1', 'patch'), '1.2.3');
  assert.equal(incrementVersion('1.2.3', 'premajor'), '2.0.0-0');
  assert.equal(incrementVersion('1.2.3', 'preminor'), '1.3.0-0');
  assert.equal(incrementVersion('1.2.3', 'prepatch'), '1.2.4-0');
  assert.equal(incrementVersion('1.2.3', 'prerelease'), '1.2.4-0');
  assert.equal(incrementVersion('1.2.4-0', 'prerelease'), '1.2.4-1');
  assert.equal(incrementVersion('1.2.3', 'premajor', 'rc'), '2.0.0-rc.0');
  assert.equal(incrementVersion('2.0.0-rc.0', 'prerelease', 'rc'), '2.0.0-rc.1');
  assert.throws(() => incrementVersion('1.2.3', 'nonsense'), /Unknown release type/);
});

test('release version is valid and consistent across package.json, manifest.json and PKGBUILD', () => {
  const version = currentVersion();
  parseSemver(version);
  const { ok, state } = checkVersionConsistency();
  assert.ok(ok, `version mismatch: ${JSON.stringify(state)}`);
  const pkgbuild = fs.readFileSync(new URL('../packaging/PKGBUILD', import.meta.url), 'utf8');
  assert.match(pkgbuild, new RegExp(`^pkgver=${version.replace(/\./g, '\\.')}$`, 'm'));
});

test('the backend reports the release version over diagnostics', () => {
  assert.equal(VERSION, currentVersion());
});

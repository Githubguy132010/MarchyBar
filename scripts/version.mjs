#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const VERSION_FILES = {
  package: path.join(ROOT, 'package.json'),
  manifest: path.join(ROOT, 'manifest.json'),
  pkgbuild: path.join(ROOT, 'packaging', 'PKGBUILD'),
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] || '',
  };
}

export function formatSemver({ major, minor, patch, prerelease = [], build = '' }) {
  let out = `${major}.${minor}.${patch}`;
  if (prerelease.length) out += `-${prerelease.join('.')}`;
  if (build) out += `+${build}`;
  return out;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function incrementVersion(version, release, preid = '') {
  if (!['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'].includes(release)) {
    throw new Error(`Unknown release type: ${release}`);
  }
  const next = parseSemver(version);
  next.build = '';
  const startPrerelease = () => (preid ? [preid, '0'] : ['0']);
  switch (release) {
    case 'major':
      if (next.minor !== 0 || next.patch !== 0 || next.prerelease.length === 0) next.major += 1;
      next.minor = 0; next.patch = 0; next.prerelease = [];
      break;
    case 'minor':
      if (next.patch !== 0 || next.prerelease.length === 0) next.minor += 1;
      next.patch = 0; next.prerelease = [];
      break;
    case 'patch':
      if (next.prerelease.length === 0) next.patch += 1;
      else next.prerelease = [];
      break;
    case 'premajor':
      next.major += 1; next.minor = 0; next.patch = 0; next.prerelease = startPrerelease();
      break;
    case 'preminor':
      next.minor += 1; next.patch = 0; next.prerelease = startPrerelease();
      break;
    case 'prepatch':
      next.patch += 1; next.prerelease = startPrerelease();
      break;
    case 'prerelease': {
      if (!next.prerelease.length) {
        next.patch += 1; next.prerelease = startPrerelease();
        break;
      }
      if (preid && next.prerelease[0] !== preid) {
        next.prerelease = [preid, '0'];
        break;
      }
      let incremented = false;
      for (let i = next.prerelease.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(next.prerelease[i])) {
          next.prerelease[i] = String(Number(next.prerelease[i]) + 1);
          incremented = true;
          break;
        }
      }
      if (!incremented) next.prerelease.push('0');
      break;
    }
  }
  return formatSemver(next);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function replaceVersion(file, version) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/"version"\s*:\s*"[^"]*"/.test(text)) throw new Error(`version field not found in ${file}`);
  fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
}

function readPkgbuildVersion(text) {
  const match = text.match(/^pkgver=(.+)$/m);
  return match ? match[1].trim() : null;
}

export function currentVersion() {
  return readJson(VERSION_FILES.package).version;
}

export function readVersionState() {
  const pkgbuild = fs.readFileSync(VERSION_FILES.pkgbuild, 'utf8');
  return {
    package: currentVersion(),
    manifest: readJson(VERSION_FILES.manifest).version,
    pkgbuild: readPkgbuildVersion(pkgbuild),
  };
}

export function checkVersionConsistency() {
  const state = readVersionState();
  const versions = new Set(Object.values(state).filter(Boolean));
  for (const value of Object.values(state)) parseSemver(value);
  return { ok: versions.size === 1, state };
}

export function writeVersion(version) {
  parseSemver(version);
  replaceVersion(VERSION_FILES.package, version);
  replaceVersion(VERSION_FILES.manifest, version);
  const pkgbuild = fs.readFileSync(VERSION_FILES.pkgbuild, 'utf8');
  if (readPkgbuildVersion(pkgbuild) === null) throw new Error('pkgver not found in packaging/PKGBUILD');
  fs.writeFileSync(VERSION_FILES.pkgbuild, pkgbuild.replace(/^pkgver=.*$/m, `pkgver=${version}`));
  return version;
}

function usage() {
  return [
    'Usage: node scripts/version.mjs <command>',
    '',
    'Commands:',
    '  show                     Print the current release version.',
    '  check                    Fail if package.json, manifest.json and packaging/PKGBUILD disagree.',
    '  sync                     Write the package.json version to the other version files.',
    '  bump <release> [--preid <id>]',
    '                           Bump the version (major, minor, patch, premajor, preminor,',
    '                           prepatch, prerelease) and sync the other version files.',
  ].join('\n');
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'show':
      process.stdout.write(`${currentVersion()}\n`);
      return;
    case 'check': {
      const { ok, state } = checkVersionConsistency();
      if (!ok) {
        console.error(`Version mismatch: package.json=${state.package} manifest.json=${state.manifest} PKGBUILD=${state.pkgbuild}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Version ${state.package} is consistent across package.json, manifest.json and packaging/PKGBUILD.`);
      return;
    }
    case 'sync':
      console.log(writeVersion(currentVersion()));
      return;
    case 'bump': {
      const release = rest.find(arg => !arg.startsWith('--'));
      if (!release) {
        console.error(usage());
        process.exitCode = 1;
        return;
      }
      const preidIndex = rest.indexOf('--preid');
      const preid = preidIndex === -1 ? '' : rest[preidIndex + 1] || '';
      console.log(writeVersion(incrementVersion(currentVersion(), release, preid)));
      return;
    }
    default:
      console.error(usage());
      process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

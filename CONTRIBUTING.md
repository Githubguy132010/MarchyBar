# Contributing to MarchyBar

Open an issue for bugs or proposed changes, or send a pull request. Contributions are licensed under GPL-3.0-or-later.

## Versioning and releases

MarchyBar follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). `package.json` is the single source of truth for the release version, and it is mirrored into `manifest.json` and `packaging/PKGBUILD`:

```sh
npm run version:show
npm run version:bump -- minor   # major | minor | patch | premajor | preminor | prepatch | prerelease
npm run version:check           # CI fails when the version files disagree
```

Pick the bump from the user-visible impact:

- **Major** — incompatible changes to presets, settings, actions, or the control protocol that require migration or manual action.
- **Minor** — backward-compatible features such as new widgets, presets, settings, or actions.
- **Patch** — backward-compatible bug fixes, documentation, and internal changes.

The preset `schemaVersion` and control `protocolVersion` are independent integers. Bump them only when their own contracts change; a release bump does not imply either.

To publish, update `CHANGELOG.md`, bump the version, commit, tag `vX.Y.Z`, and push the tag. The release workflow verifies the tag against the version files, runs the checks, and creates the GitHub release.

## Local checks

Install the dependencies in the README, then run:

```sh
npm ci --ignore-scripts
npm run build
npm test
python tests/broker_test.py
tests/test-qml.sh
```

The QML checks require Omarchy and Quickshell. Backend tests and the device-helper fixtures run without Touch Bar hardware. CI builds the native addon and runs those hardware-free tests on Node 22 and 24. QML and physical-device checks remain separate; see [validation](docs/VALIDATION.md).

Validate a clean package, excluding local dependencies and build symlinks:

```sh
package_dir=$(mktemp -d)
git archive HEAD | tar -x -C "$package_dir"
omarchy plugin validate "$package_dir"
```

Never run the renderer as root. Test layout and protocol changes in preview mode before enabling hardware. Keep user presets separate from bundled files. Document any change to the device helper and its required setup procedure.

# Contributing to MarchyBar

Open an issue for bugs or proposed changes, or send a pull request. Contributions are licensed under GPL-3.0-or-later.

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

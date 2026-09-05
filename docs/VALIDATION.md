# Validation and support coverage

Snapshot: 5 September 2026. This is a working first implementation, not a claim that eight physical machines were tested.

## Verified environment

- MacBookPro15,1 (Intel T2, on-screen Escape)
- Omarchy 4.0.2-1; Quickshell 0.3.1-1; Hyprland 0.56.2-1
- linux-t2 7.1.8.arch1-3, with current `t2bce_*` modules
- Node 26.7.0; Cairo 1.18.4; libdrm 2.4.134; Qt 6.11.2

## Completed checks

| Area | Evidence |
| --- | --- |
| Native build | C++ DRM/Cairo/input addon compiled successfully against local system libraries |
| Preset geometry | Every supplied page validated and laid out at both 2008×60 and 2170×60, with target bounds checked |
| Preset persistence | Creation, editing, duplication, deletion, restoring bundled overrides, import/export, stale edits, malformed files, and linked-preset replacement tested |
| Gestures | Slider capture retained across scene changes, values clamped outside bounds, final release delivered, cancelled/locked custom actions suppressed |
| Real protocol | A running daemon and Unix socket exercised for CRUD, rendering PNGs, app selection, pinning, trials, rollback, lock privacy, rejected oversized layouts, import/export, and shutdown |
| Native QML | Quickshell loaded the actual Editor and Omarchy controls; draft isolation, undo/redo, widget creation/reorder, unsaved-change guard, save, and dropdown binding tested |
| Device helper | Active-local-user authorization, device identity refusal, brightness validation, idempotent restoration, and crash-journal recovery tested with isolated fixtures |
| Suspend coordination | Actual logind delay inhibitor acquired successfully; service unit validated |
| Physical display | Real DRM lease acquired; renderer reported 2170×60; framebuffer captured |
| Physical input | User confirmed correct display orientation, touch positions, working volume slider, and Fn alternate page |
| Hardware restoration | Disable returned USB configuration 1 and original keyboard ACL; re-enable returned configuration 2 |
| Lock lifecycle | An isolated session backend using the real device restored firmware on a lock heartbeat, reacquired on unlock, and restored again on disable |
| Concurrent enable | Simultaneous requests shared one hardware-acquisition operation successfully |
| Omarchy integration | Installed and enabled through the real `omarchy plugin add` command; native editor opened from shell summon; theme tokens and real live data displayed |

The lock-lifecycle check exercised actual hardware release/reacquisition without locking the user's desktop. It is distinct from an end-to-end lock/PAM test.

## Coverage still requiring additional hardware or a dedicated session

- Physical MacBookPro15,2, 15,3, 15,4, 16,1, 16,2, 16,3, and 16,4. Their identifiers are supported, and both geometries are tested; physical certification of these models is not claimed.
- A full system suspend/resume, hibernate, logout/login, and lid-close cycle. Do these in a dedicated testing session rather than interrupting active work.
- Long-duration power consumption, burn-in behavior, and repeated USB disconnect stress.
- Distribution testing with every supported Node LTS and a clean latest-stable T2 Omarchy installation.

## Reproduce automated checks

```sh
npm ci --ignore-scripts
npm run build
npm test
python tests/broker_test.py
tests/test-qml.sh
systemd-analyze verify packaging/marchybar-device.service
```

`tests/test-qml.sh` starts an isolated Quickshell configuration using the installed Omarchy controls. It does not load the real service, lease hardware, or write user presets. The standard `qmltestrunner` cannot load Quickshell's statically linked plugin, so the harness runs in Quickshell itself. A known unrelated portal registration warning may appear.

For linting, map `qs/Commons` and `qs/Ui` to the installed Omarchy source in a temporary import directory, then pass it to `/usr/lib/qt6/bin/qmllint -I`. Qt's static type information does not describe some Omarchy dynamic theme properties or `QProcess::ExitStatus`; native runtime tests cover those bindings. No syntax/property-override errors are accepted.

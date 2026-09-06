# Experimental Apple Silicon support

This implementation targets an existing, compatible Omarchy installation on:

| Machine | Identifier | Device-tree board |
| --- | --- | --- |
| 13-inch MacBook Pro, M1, 2020 | `MacBookPro17,1` | `apple,j293` |
| 13-inch MacBook Pro, M2, 2022 | `Mac14,7` | `apple,j493` |

Neither machine has been physically tested with MarchyBar. Other Apple Silicon Macs have no Touch Bar. This is not a macOS port or an installer for Omarchy on ARM64.

## Research findings

The Touch Bar hardware has already been reverse engineered. Asahi shipped `tiny-dfr` with working controls before the drivers reached mainline Linux 6.15. A working `tiny-dfr` installation is the recommended prerequisite; a kernel version alone does not prove the drivers and firmware are installed.

| Component | Apple Silicon interface | MarchyBar handling |
| --- | --- | --- |
| Display | DRM driver `adp`, module `adpdrm` | Dedicated DRM card, visible `60x2008`, rotated to logical `2008x60` |
| Allocation | tiny-dfr requests 64-pixel-wide XRGB8888 storage | Request padded width, honor returned pitch/size, keep visible width 60 |
| Touch | SPI driver `apple-z2`, module `apple_z2` | Exact model name, SPI bus, physical identifier and DT ancestry; evdev MT ranges |
| Backlight | `panel-summit`, MIPI DCS | Verified Summit ancestry and known Touch Bar backlight path |
| Fn | M1 `Apple SPI Keyboard`; M2 `Apple MTP keyboard` | Apple vendor, expected bus, KEY_A and KEY_FN capabilities |
| Release | No firmware function-row fallback | Blank backlight, close renderer and restore temporary ACLs |

The current backlight path is `/sys/class/backlight/228600000.dsi.0`; older Asahi kernels used `228200000.display-pipe.0`. The broker requires Summit driver ancestry for either path and refuses unknown devices rather than granting broader access. Older kernel variations may therefore require a follow-up patch.

Z2 emits landscape touch coordinates with the device-tree Y inversion already applied. MarchyBar reads ranges from evdev rather than hardcoding them. It does not rotate touch coordinates with the framebuffer.

Apple Silicon does **not** use the T2 USB `05ac:8302` / `appletbdrm` path. No USB reset, configuration switch, or driver unload is performed for Asahi. Its display controller depends on bootloader initialization; trying to reset it is not an appropriate recovery strategy.

### Sources

- [Asahi M1 feature support](https://asahilinux.org/docs/platform/feature-support/m1/) and [M2 feature support](https://asahilinux.org/docs/platform/feature-support/m2/).
- [Asahi's January 2024 Touch Bar announcement](https://asahilinux.org/2024/01/fedora-asahi-new/#touchbar).
- Linux v6.15 [ADP driver](https://github.com/torvalds/linux/blob/v6.15/drivers/gpu/drm/adp/adp_drv.c), [Summit panel](https://github.com/torvalds/linux/blob/v6.15/drivers/gpu/drm/panel/panel-summit.c), and [Z2 input](https://github.com/torvalds/linux/blob/v6.15/drivers/input/touchscreen/apple_z2.c).
- Linux v6.15 [J293 device tree](https://github.com/torvalds/linux/blob/v6.15/arch/arm64/boot/dts/apple/t8103-j293.dts) and [J493 device tree](https://github.com/torvalds/linux/blob/v6.15/arch/arm64/boot/dts/apple/t8112-j493.dts).
- tiny-dfr revision `eb711c87fcbddda67be3fd5ff45385b139e8fb34`: [DRM setup](https://github.com/AsahiLinux/tiny-dfr/blob/eb711c87fcbddda67be3fd5ff45385b139e8fb34/src/display.rs), [rendering/input](https://github.com/AsahiLinux/tiny-dfr/blob/eb711c87fcbddda67be3fd5ff45385b139e8fb34/src/main.rs), and [device rules](https://github.com/AsahiLinux/tiny-dfr/tree/eb711c87fcbddda67be3fd5ff45385b139e8fb34/etc/udev/rules.d).

## Test setup

Use a dedicated session with a physical keyboard available. Save work before testing sleep, lock, or service failures. Keep your tiny-dfr configuration unchanged. Do not run MarchyBar's renderer as root.

1. Record the working baseline before stopping anything:

```sh
uname -a
tr '\0' '\n' < /sys/firmware/devicetree/base/compatible
systemctl status tiny-dfr.service --no-pager
pgrep -a -x tiny-dfr
```

2. Clone the published testing branch into a new directory outside the installed plugin. Use Node 22.9+ and the Linux build dependencies from the README. Run the hardware-free checks in this external checkout, not inside the installed plugin:

```sh
git clone --branch feat/apple-silicon-touchbar --single-branch \
  https://github.com/Githubguy132010/MarchyBar.git "$HOME/MarchyBar-pr"
cd "$HOME/MarchyBar-pr"
```

```sh
npm ci --ignore-scripts
npm run build
npm test
python3 tests/broker_test.py
tests/test-qml.sh
```

For a first installation, use the local Git repository as Omarchy's source. Git cloning copies committed files, not the build output or `node_modules` that would violate plugin symlink checks:

```sh
plugin="$HOME/.config/omarchy/plugins/marchybar.touchbar"
omarchy plugin add "$HOME/MarchyBar-pr" --yes
git -C "$plugin" remote set-url origin https://github.com/Githubguy132010/MarchyBar.git
omarchy plugin validate "$plugin"
"$plugin/bin/marchybar" prepare
omarchy plugin enable marchybar.touchbar
omarchy restart shell
```

Run each command only after the preceding command succeeds. `prepare` builds into the external cache on the target architecture. Do not copy an x86 addon or run `npm ci` inside the installed plugin.

If MarchyBar is already installed, do not add it again. Check `git -C "$plugin" status --short` and stop if it has local changes. Preserve the current commit, disable hardware, and explicitly fetch the PR:

```sh
git -C "$plugin" branch marchybar-before-pr HEAD
"$plugin/bin/marchybar" disable
git -C "$plugin" fetch https://github.com/Githubguy132010/MarchyBar.git feat/apple-silicon-touchbar
git -C "$plugin" switch --detach FETCH_HEAD
omarchy plugin validate "$plugin"
"$plugin/bin/marchybar" prepare
omarchy restart shell
```

Do not use the normal plugin update commands/buttons during PR testing: Omarchy fetches the remote default `HEAD`, not the selected PR branch. For subsequent PR commits, disable hardware, explicitly fetch the branch as above, run `git -C "$plugin" merge --ff-only FETCH_HEAD`, then validate, prepare, and restart the shell. Stop on a non-fast-forward update; do not force-reset a tester's checkout.

3. Prevent device-triggered tiny-dfr restarts for this boot. Run this only if tiny-dfr was the baseline renderer; another daemon requires its own stop procedure. MarchyBar never masks or stops it automatically:

```sh
sudo systemctl mask --runtime --now tiny-dfr.service
systemctl is-active tiny-dfr.service
pgrep -a -x tiny-dfr
```

`is-active` should report inactive and `pgrep` should find no process. Their nonzero exit statuses are expected. Stop if masking fails or a renderer remains active.

4. From the installed PR checkout, install the helper through the normal explicit authentication flow:

```sh
"$plugin/bin/marchybar" setup
"$plugin/bin/marchybar" diagnostics
```

The helper checks device identities before installation. On Asahi it also installs `99-zz-marchybar.rules` after tiny-dfr's rules, keeping display/touch access root-only until a lease. The built-in keyboard stays on the desktop seat. Missing or unrecognized hardware should cause a refusal, not require relaxed permissions.

5. Open the editor and enable the bar. Confirm diagnostics identify `profile: "asahi"`, `experimental: true`, and the correct model. Test one simple preset before trying imported commands.

For helper updates, disable MarchyBar before running setup again. Asahi setup refuses a display already held by a renderer, including MarchyBar itself.

## Hardware checklist

Report each item as passed, failed, or not tested. Include the exact PR commit and kernel/Omarchy versions.

- Native ARM64 build and all automated checks pass on the target machine.
- Diagnostics recognize the expected model and verified driver devices.
- Geometry is `2008x60`, with no software Escape button, clipping, shifted edges, or padded columns visible.
- Labels are upright; taps near both ends and the top/bottom edges activate the correct targets.
- Volume and Touch Bar brightness sliders track a drag and release correctly. A second finger does not steal a gesture.
- Fn changes to the alternate page and returns on release. Keyboard shortcuts and main-display brightness work.
- Dim/off/wake works; the first touch while dark wakes without executing a stale action.
- Disable leaves the bar dark; re-enable restores MarchyBar. No firmware controls are expected on M1/M2.
- Lock/unlock, helper restart, backend exit, logout/login, and repeated suspend/resume do not expose a stale layout or leave stuck touches/Fn.
- Test lid close separately. The existing ACPI lid-state reader is not an Apple Silicon lid implementation; logind suspend coordination is not proof of lid-only behavior.
- Removing the helper and returning to tiny-dfr restores the baseline layout and working input.

Hardware-free DRM tests mock libdrm and syscalls. They establish allocation/geometry and cleanup calls, not physical scanout or effective udev permissions. ADP has legacy KMS helpers, but MarchyBar's visible-size framebuffer registration, flushing, rotation, and shutdown behavior still require this checklist. ARM64 CI likewise does not emulate Apple hardware.

## Return to tiny-dfr

Run each step only after the previous one succeeds:

```sh
plugin="$HOME/.config/omarchy/plugins/marchybar.touchbar"
"$plugin/bin/marchybar" disable
"$plugin/bin/marchybar" uninstall-system
sudo systemctl unmask --runtime tiny-dfr.service
sudo systemctl start tiny-dfr.service
```

Use `unmask` only if you created the runtime mask for this test. Keep any pre-existing service policy intact.

Disabling alone is insufficient: MarchyBar's restrictive device rules remain installed. Uninstall removes both rule files and retriggers only the identified Asahi display/touch devices so the distro's permissions apply again. It does not unmask or start another service. If uninstall fails, keep tiny-dfr masked, inspect the error, and retry after resolving it. Do not delete a pending lease journal or grant yourself the `input`/`video` groups.

A runtime mask disappears on reboot, but MarchyBar's installed rules do not. Complete the handoff before rebooting out of the test session, or reapply the runtime mask before trying MarchyBar again.

Complete the helper removal before reverting the PR source. An existing user can then restore `marchybar-before-pr` with `git switch`, validate the plugin, prepare its renderer, and restart the shell. A first-install tester can remove the plugin with `omarchy plugin remove marchybar.touchbar --yes` and restart the shell. Neither action deletes user presets.

For failures, collect `bin/marchybar diagnostics` and `journalctl -u marchybar-device.service -b --no-pager`. Review logs before sharing; application names, commands, and other session details may be private.

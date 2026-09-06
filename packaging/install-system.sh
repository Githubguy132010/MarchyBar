#!/bin/bash
# Installs only the device-specific helper. The renderer always runs as the user.
set -euo pipefail
export PATH=/usr/bin:/bin
[[ $EUID == 0 ]] || { echo 'Run marchybar setup from the editor or command line.' >&2; exit 1; }
MARCHYBAR_PACKAGE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == --remove ]]; then
  helper_state() {
    local properties key value
    properties=$(systemctl show marchybar-device.service -p LoadState -p ActiveState -p SubState -p Result) || {
      echo 'Cannot confirm device helper state; keeping helper files.' >&2; return 1;
    }
    load= active= sub= result=
    while IFS='=' read -r key value; do
      case $key in
        LoadState) load=$value ;;
        ActiveState) active=$value ;;
        SubState) sub=$value ;;
        Result) result=$value ;;
      esac
    done <<< "$properties"
  }
  helper_state
  if [[ $load != not-found ]]; then
    [[ $load == loaded ]] || { echo 'Cannot identify device helper unit; keeping helper files.' >&2; exit 1; }
    [[ $active != failed && $result == success ]] || {
      echo 'Device helper failed. Resolve cleanup with journalctl -u marchybar-device.service before removing it.' >&2; exit 1;
    }
    systemctl disable --now marchybar-device.service || {
      echo 'Could not stop/disable device helper; keeping helper files. Retry after checking its service state.' >&2; exit 1;
    }
    helper_state
  fi
  [[ $active == inactive && $sub == dead && ( $result == success || $load == not-found ) ]] || {
    echo 'Device helper is not confirmed stopped cleanly; keeping helper files.' >&2; exit 1;
  }
  [[ ! -e /run/marchybar/lease.json ]] || {
    echo 'Device cleanup is pending. Restart the helper to recover before removing it.' >&2; exit 1;
  }
  handoff_devices=
  if [[ -e /sys/firmware/devicetree/base/compatible ]]; then
    # Use this authenticated checkout even on a retry after partial removal.
    handoff_devices=$(/usr/bin/python3 -I "$MARCHYBAR_PACKAGE/device-broker.py" --asahi-udev-devices) || {
      echo 'Cannot identify Asahi handoff devices; keeping helper files.' >&2; exit 1;
    }
  fi
  rm -f /run/marchybar/device.sock /run/marchybar/lease.tmp
  rmdir /run/marchybar 2>/dev/null || true
  rm -f /etc/udev/rules.d/90-marchybar.rules /etc/udev/rules.d/99-zz-marchybar.rules
  udevadm control --reload-rules
  if [[ -n $handoff_devices ]]; then
    while IFS= read -r device; do
      # Only identified DRM, touch input parent and touch event; never keyboard,
      # backlight or USB. Add also runs distro rules restricted to ACTION=add.
      udevadm trigger --action=add "$device" || {
        echo 'Asahi permission handoff failed. Keep competing services masked and retry marchybar uninstall-system.' >&2; exit 1;
      }
    done <<< "$handoff_devices"
    udevadm settle --timeout=5 || {
      echo 'Asahi permission handoff did not settle. Keep competing services masked and retry marchybar uninstall-system.' >&2; exit 1;
    }
    echo 'Asahi display/touch nodes retriggered with distro rules. No competing service was unmasked or started by this installer.'
  fi
  rm -f /etc/systemd/system/marchybar-device.service /usr/local/lib/marchybar/device-broker.py
  rmdir /usr/local/lib/marchybar 2>/dev/null || true
  systemctl daemon-reload
  echo 'Device helper removed. Your presets are preserved.'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unknown setup argument' >&2; exit 1; }
for binary in python3 getfacl setfacl loginctl udevadm modprobe; do
  command -v "$binary" >/dev/null || { echo "Missing $binary. Install the dependencies listed in README.md." >&2; exit 1; }
done
# Setup explicitly authenticates this checkout through pkexec. Probe its bundled
# broker in isolated mode, then install root-owned copies as before.
profile=$(/usr/bin/python3 -I "$MARCHYBAR_PACKAGE/device-broker.py" --check-model)
/usr/bin/python3 -I -c 'from gi.repository import Gio, GLib' || { echo 'Install python-gobject before setup.' >&2; exit 1; }
case $profile in
  t2)
    modprobe appletbdrm
    modprobe hid_appletb_bl ;;
  asahi)
    # Bound devices also prove built-in drivers are available. Module filenames
    # differ from the platform/SPI driver names used for device identification.
    if ! /usr/bin/python3 -I "$MARCHYBAR_PACKAGE/device-broker.py" --check-devices; then
      for module in adpdrm adpdrm-mipi panel-summit apple_z2; do
        modprobe "$module" || true
      done
      udevadm settle --timeout=5
      /usr/bin/python3 -I "$MARCHYBAR_PACKAGE/device-broker.py" --check-devices
    fi
    /usr/bin/python3 -I "$MARCHYBAR_PACKAGE/device-broker.py" --check-idle ;;
  *) echo 'Unsupported device profile' >&2; exit 1 ;;
esac
if systemctl is-active --quiet marchybar-device.service; then systemctl stop marchybar-device.service; fi
install -d -m 0755 /usr/local/lib/marchybar
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/device-broker.py" /usr/local/lib/marchybar/device-broker.py
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/marchybar-device.service" /etc/systemd/system/marchybar-device.service
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/90-marchybar.rules" /etc/udev/rules.d/90-marchybar.rules
if [[ $profile == asahi ]]; then
  install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/90-marchybar.rules" /etc/udev/rules.d/99-zz-marchybar.rules
fi
udevadm control --reload-rules
if [[ $profile == asahi ]]; then
  # Apply isolation to already-present devices without retriggering keyboards.
  for device in /sys/class/drm/card[0-9]*; do
    [[ ${device##*/} =~ ^card[0-9]+$ ]] || continue
    [[ $(readlink -f "$device/device/driver") == /sys/bus/platform/drivers/adp ]] || continue
    udevadm trigger --action=change "$device"
  done
  for device in /sys/class/input/input* /sys/class/input/event*; do
    name=
    if [[ -r $device/name ]]; then read -r name < "$device/name" || true
    elif [[ -r $device/device/name ]]; then read -r name < "$device/device/name" || true
    fi
    case $name in
      'MacBookPro17,1 Touch Bar'|'Mac14,7 Touch Bar') udevadm trigger --action=change "$device" ;;
    esac
  done
  udevadm settle --timeout=5
fi
systemctl daemon-reload
systemctl enable --now marchybar-device.service
systemctl is-active --quiet marchybar-device.service
for ((attempt=0; attempt<100; attempt++)); do
  [[ -S /run/marchybar/device.sock ]] && break
  sleep 0.1
done
[[ -S /run/marchybar/device.sock ]] || { echo 'Device helper did not become ready. Check journalctl -u marchybar-device.service.' >&2; exit 1; }
echo 'Device helper installed. Enable MarchyBar to activate the custom Touch Bar.'

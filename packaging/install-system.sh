#!/bin/bash
# Installs only the device-specific helper. The renderer always runs as the user.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run marchybar setup from the editor or command line.' >&2; exit 1; }
MARCHYBAR_PACKAGE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == --remove ]]; then
  systemctl disable --now marchybar-device.service || true
  rm -f /etc/systemd/system/marchybar-device.service /etc/udev/rules.d/90-marchybar.rules /usr/local/lib/marchybar/device-broker.py
  rmdir /usr/local/lib/marchybar 2>/dev/null || true
  systemctl daemon-reload
  udevadm control --reload-rules
  echo 'Device helper removed. Your presets are preserved.'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unknown setup argument' >&2; exit 1; }
case $(cat /sys/devices/virtual/dmi/id/product_name) in
  MacBookPro15,[1234]|MacBookPro16,[1234]) ;;
  *) echo 'The hardware helper supports Intel T2 MacBook Pro models only.' >&2; exit 1 ;;
esac
for binary in python3 getfacl setfacl loginctl udevadm modprobe; do
  command -v "$binary" >/dev/null || { echo "Missing $binary. Install the dependencies listed in README.md." >&2; exit 1; }
done
/usr/bin/python3 -c 'from gi.repository import Gio, GLib' || { echo 'Install python-gobject before setup.' >&2; exit 1; }
modprobe appletbdrm
modprobe hid_appletb_bl
if systemctl is-active --quiet marchybar-device.service; then systemctl stop marchybar-device.service; fi
install -d -m 0755 /usr/local/lib/marchybar
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/device-broker.py" /usr/local/lib/marchybar/device-broker.py
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/marchybar-device.service" /etc/systemd/system/marchybar-device.service
install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/90-marchybar.rules" /etc/udev/rules.d/90-marchybar.rules
udevadm control --reload-rules
systemctl daemon-reload
systemctl enable --now marchybar-device.service
systemctl is-active --quiet marchybar-device.service
echo 'Device helper installed. Enable MarchyBar to activate the custom Touch Bar.'

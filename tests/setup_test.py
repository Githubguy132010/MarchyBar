"""Inert installer branch tests; no services, modules or device rules are changed."""
from pathlib import Path
import configparser
import shutil
import subprocess
import unittest


class SetupTest(unittest.TestCase):
  def test_authenticated_checkout_probe_keeps_t2_install_path(self):
    source = (Path(__file__).parents[1] / 'packaging/install-system.sh').read_text()
    start = source.index('[[ $# == 0 ]]')
    end = source.index('\nesac\n', start) + len('\nesac\n')
    shell = r'''set -euo pipefail
MARCHYBAR_PACKAGE='/home/example/user owned checkout/packaging'
command() { [[ $1 == -v ]]; }
/usr/bin/python3() {
  [[ $1 == -I ]] || return 99
  if [[ $2 == "$MARCHYBAR_PACKAGE/device-broker.py" && $3 == --check-model ]]; then
    printf 'MOCK checkout probe\n' >&2
    printf '%s\n' "$PROFILE"
  elif [[ $2 == -c && $3 == 'from gi.repository import Gio, GLib' ]]; then
    return 0
  else return 99
  fi
}
modprobe() { printf 'MOCK modprobe %s\n' "$*"; }
'''
    for profile, success in [('t2', True), ('unsupported', False)]:
      result = subprocess.run(['/bin/bash', '--noprofile', '--norc'],
                              input=shell + source[start:end], capture_output=True, text=True,
                              timeout=10, env={'PATH': '/nonexistent', 'PROFILE': profile})
      self.assertEqual(result.returncode == 0, success, result.stderr)
      self.assertIn('MOCK checkout probe', result.stderr)
      if success:
        self.assertEqual(result.stdout, 'MOCK modprobe appletbdrm\nMOCK modprobe hid_appletb_bl\n')
      else:
        self.assertNotIn('MOCK modprobe', result.stdout)
    self.assertNotIn('st_uid', source)
    self.assertNotIn('Untrusted setup source', source)
    self.assertIn('install -o root -g root -m 0644 "$MARCHYBAR_PACKAGE/device-broker.py"', source)

  def test_asahi_driver_probe_accepts_builtins_and_checks_modprobe_fallback(self):
    source = (Path(__file__).parents[1] / 'packaging/install-system.sh').read_text()
    branch = source.split('case $profile in\n', 1)[1].split('\nesac\n', 1)[0]
    shell = r'''set -euo pipefail
profile=$PROFILE
MARCHYBAR_PACKAGE=/inert
checks=0
/usr/bin/python3() {
  printf 'MOCK python %s\n' "$*"
  if [[ $* == *--check-devices ]]; then
    checks=$((checks + 1))
    [[ $BUILTIN == 1 || $checks == 2 && $READY == 1 ]]
  elif [[ $* == *--check-idle ]]; then
    [[ $IDLE == 1 ]]
  else return 99
  fi
}
modprobe() { printf 'MOCK modprobe %s\n' "$*"; return 1; }
udevadm() { printf 'MOCK udevadm %s\n' "$*"; }
'''
    for builtin, ready, idle, success in [(1, 0, 1, True), (0, 1, 1, True),
                                          (0, 0, 1, False), (1, 1, 0, False)]:
      result = subprocess.run(['/bin/bash', '--noprofile', '--norc'],
                              input=shell + 'case $profile in\n' + branch + '\nesac\n',
                              capture_output=True, text=True, timeout=10,
                              env={'PATH': '/nonexistent', 'PROFILE': 'asahi', 'BUILTIN': str(builtin),
                                   'READY': str(ready), 'IDLE': str(idle)})
      with self.subTest(builtin=builtin, ready=ready, idle=idle):
        self.assertEqual(result.returncode == 0, success, result.stderr)
        self.assertNotIn('appletb', result.stdout)
        if builtin:
          self.assertNotIn('MOCK modprobe', result.stdout)
        else:
          for module in ('adpdrm', 'adpdrm-mipi', 'panel-summit', 'apple_z2'):
            self.assertIn('MOCK modprobe ' + module + '\n', result.stdout)

  def test_asahi_rules_override_later_tiny_dfr_without_keyboard_isolation(self):
    base = Path(__file__).parents[1] / 'packaging'
    source = (base / 'install-system.sh').read_text()
    rules = (base / '90-marchybar.rules').read_text()
    self.assertIn('/etc/udev/rules.d/99-zz-marchybar.rules', source)
    self.assertGreater('99-zz-marchybar.rules', '99-touchbar-tiny-dfr.rules')
    self.assertIn('MODE:="0600"', rules)
    self.assertIn('GROUP:="root"', rules)
    # tiny-dfr.service BindsTo these aliases. Clearing them prevents a manual
    # restart even after the user removes their runtime service mask.
    self.assertNotIn('ENV{SYSTEMD_WANTS}', rules)
    self.assertNotIn('ENV{SYSTEMD_ALIAS}', rules)
    self.assertNotIn('TAG-="systemd"', rules)
    self.assertNotIn('SUBSYSTEM=="backlight"', rules)
    self.assertNotIn('keyboard', rules.lower())
    self.assertNotIn('ENV{ID_SEAT}:=', rules)
    adp_rule = next(line for line in rules.splitlines() if 'DRIVERS=="adp"' in line)
    self.assertNotIn('of_node/compatible', adp_rule)
    self.assertNotIn('systemctl stop tiny-dfr', source)
    self.assertNotIn('systemctl mask', source)
    if shutil.which('udevadm'):
      result = subprocess.run(['udevadm', 'verify', str(base / '90-marchybar.rules')],
                              capture_output=True, text=True, timeout=10)
      self.assertEqual(result.returncode, 0, result.stderr)

  def test_combined_suite_contains_asahi_without_duplicate_test_ids(self):
    suite = unittest.TestLoader().loadTestsFromNames(['broker_test', 'asahi_broker_test', 'setup_test'])
    def ids(tests):
      for test in tests:
        if isinstance(test, unittest.TestSuite):
          yield from ids(test)
        else:
          yield test.id()
    names = list(ids(suite))
    self.assertEqual(len(names), len(set(names)))
    self.assertTrue(any(name.startswith('asahi_broker_test.DiscoveryTest.') for name in names))
    self.assertTrue(any(name.startswith('asahi_broker_test.AsahiRecoveryTest.') for name in names))
    self.assertFalse(any(name.startswith('unittest.loader._FailedTest.') for name in names))

  def test_runtime_journal_survives_explicit_stop_and_restart(self):
    unit = configparser.ConfigParser(interpolation=None)
    unit.read(Path(__file__).parents[1] / 'packaging/marchybar-device.service')
    self.assertEqual(unit['Service']['RuntimeDirectory'], 'marchybar')
    self.assertEqual(unit['Service']['RuntimeDirectoryPreserve'], 'yes')
    self.assertEqual(unit['Service']['RuntimeDirectoryMode'], '0755')
    self.assertEqual(unit['Service']['UMask'], '0077')

  def remove(self, *, state='loaded', stop_fails=False, still_active=False,
             query_fails=False, remove_fails=False, reload_fails=False, pending=False,
             shutdown_fails=False, asahi=False, probe_fails=False, trigger_fails=False,
             settle_fails=False, rules_reload_fails=False):
    source = (Path(__file__).parents[1] / 'packaging/install-system.sh').read_text()
    start = source.index('if [[ ${1:-} == --remove ]]; then')
    end = source.index('\nfi\n', start) + len('\nfi\n')
    commands = r'''set -euo pipefail
stopped=0
MARCHYBAR_PACKAGE=/inert
/usr/bin/python3() {
  [[ $* == '-I /inert/device-broker.py --asahi-udev-devices' ]] || return 99
  [[ $PROBE_FAILS == 0 ]] || return 1
  printf '/sys/class/drm/card3\n/sys/devices/platform/spi/touch/input/input7\n/sys/class/input/event7\n'
}
systemctl() {
  printf 'MOCK systemctl %s\n' "$*" >&2
  case "$1" in
    show)
      [[ $QUERY_FAILS == 0 ]] || return 1
      if [[ $STATE == absent ]]; then
        printf 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n'
      elif [[ $stopped == 1 && $SHUTDOWN_FAILS == 1 ]]; then
        printf 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\n'
      elif [[ $STATE == inactive || $stopped == 1 && $STILL_ACTIVE == 0 ]]; then
        printf 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\n'
      elif [[ $STATE == failed ]]; then
        printf 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\n'
      else
        printf 'LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\n'
      fi ;;
    disable|stop)
      [[ $STOP_FAILS == 0 ]] || return 1
      stopped=1 ;;
    daemon-reload) [[ $RELOAD_FAILS == 0 ]] ;;
    *) printf 'Unexpected systemctl call\n' >&2; return 99 ;;
  esac
}
rm() { printf 'MOCK rm %s\n' "$*"; [[ $REMOVE_FAILS == 0 ]]; }
rmdir() { printf 'MOCK rmdir %s\n' "$*"; }
udevadm() {
  printf 'MOCK udevadm %s\n' "$*"
  case $1 in
    trigger) [[ $TRIGGER_FAILS == 0 ]] ;;
    settle) [[ $SETTLE_FAILS == 0 ]] ;;
    control) [[ $RULES_RELOAD_FAILS == 0 ]] ;;
    *) return 99 ;;
  esac
}
'''
    # Redirect the recovery check to a harmless existing/nonexistent fixture path.
    branch = source[start:end].replace('/run/marchybar/lease.json',
                                       '/dev/null' if pending else '/nonexistent/marchybar/lease.json')
    branch = branch.replace('/sys/firmware/devicetree/base/compatible',
                            '/dev/null' if asahi else '/nonexistent/marchybar/compatible')
    return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-s', '--', '--remove'],
                          input=commands + branch, capture_output=True, text=True, timeout=10,
                          env={'PATH': '/nonexistent', 'STATE': state,
                               'STOP_FAILS': str(int(stop_fails)), 'STILL_ACTIVE': str(int(still_active)),
                               'QUERY_FAILS': str(int(query_fails)), 'REMOVE_FAILS': str(int(remove_fails)),
                                'RELOAD_FAILS': str(int(reload_fails)),
                                'PROBE_FAILS': str(int(probe_fails)),
                                'TRIGGER_FAILS': str(int(trigger_fails)),
                                'SETTLE_FAILS': str(int(settle_fails)),
                                'RULES_RELOAD_FAILS': str(int(rules_reload_fails)),
                                'SHUTDOWN_FAILS': str(int(shutdown_fails))})

  def test_asahi_uninstall_retriggers_only_identified_nodes_after_rules_removed(self):
    result = self.remove(asahi=True)
    self.assertEqual(result.returncode, 0, result.stderr)
    triggers = [line for line in result.stdout.splitlines() if line.startswith('MOCK udevadm trigger')]
    self.assertEqual(triggers, [
      'MOCK udevadm trigger --action=add /sys/class/drm/card3',
      'MOCK udevadm trigger --action=add /sys/devices/platform/spi/touch/input/input7',
      'MOCK udevadm trigger --action=add /sys/class/input/event7'])
    self.assertLess(result.stdout.index('MOCK rm -f /etc/udev/rules.d/'),
                    result.stdout.index('MOCK udevadm control --reload-rules'))
    self.assertLess(result.stdout.index('MOCK udevadm control --reload-rules'),
                    result.stdout.index(triggers[0]))
    self.assertLess(result.stdout.index('MOCK udevadm settle --timeout=5'),
                    result.stdout.index('MOCK rm -f /etc/systemd/system/marchybar-device.service'))
    self.assertNotIn('tiny-dfr', result.stderr)
    self.assertNotIn('trigger', self.remove().stdout)

  def test_asahi_handoff_failure_is_retryable_and_never_reports_success(self):
    for args in ({'probe_fails': True}, {'rules_reload_fails': True},
                 {'trigger_fails': True}, {'settle_fails': True}):
      with self.subTest(args=args):
        result = self.remove(asahi=True, **args)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Device helper removed.', result.stdout)
        self.assertNotIn('MOCK rm -f /etc/systemd/system/marchybar-device.service', result.stdout)
        if args.get('probe_fails'):
          self.assertNotIn('MOCK rm', result.stdout)
        if args.get('rules_reload_fails'):
          self.assertNotIn('MOCK udevadm trigger', result.stdout)
        retry = self.remove(asahi=True, state='inactive')
        self.assertEqual(retry.returncode, 0, retry.stderr)

  def test_pending_recovery_never_retriggers_asahi(self):
    result = self.remove(asahi=True, pending=True)
    self.assertNotEqual(result.returncode, 0)
    self.assertNotIn('MOCK udevadm', result.stdout)

  def test_stop_failure_keeps_helper_files(self):
    result = self.remove(stop_fails=True)
    self.assertNotEqual(result.returncode, 0, result.stdout)
    self.assertNotIn('MOCK rm ', result.stdout)
    self.assertNotIn('Device helper removed.', result.stdout)
    self.assertIn('stop', result.stderr.lower())

  def test_confirmed_stop_is_required(self):
    for args in ({'still_active': True}, {'query_fails': True}, {'state': 'failed'},
                 {'pending': True}, {'shutdown_fails': True}):
      with self.subTest(args=args):
        result = self.remove(**args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn('MOCK rm ', result.stdout)

  def test_successful_absent_and_inactive_removal(self):
    for state in ('loaded', 'absent', 'inactive'):
      with self.subTest(state=state):
        result = self.remove(state=state)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('MOCK rm ', result.stdout)
        self.assertIn('Device helper removed.', result.stdout)
        self.assertIn('MOCK rm -f /run/marchybar/device.sock /run/marchybar/lease.tmp', result.stdout)
        self.assertIn('MOCK rmdir /run/marchybar', result.stdout)

  def test_pending_recovery_blocks_even_absent_or_inactive_removal(self):
    for state in ('absent', 'inactive'):
      with self.subTest(state=state):
        result = self.remove(state=state, pending=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('MOCK rm ', result.stdout)
        self.assertNotIn('MOCK rmdir ', result.stdout)

  def test_partial_removal_errors_are_reported_and_retry_succeeds(self):
    for args in ({'remove_fails': True}, {'reload_fails': True}):
      with self.subTest(args=args):
        result = self.remove(**args)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Device helper removed.', result.stdout)
        retry = self.remove(state='absent')
        self.assertEqual(retry.returncode, 0, retry.stderr)


if __name__ == '__main__':
  unittest.main()

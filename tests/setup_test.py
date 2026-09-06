"""Execute only the removal branch, with shell functions replacing every command."""
from pathlib import Path
import configparser
import subprocess
import unittest


class SetupTest(unittest.TestCase):
  def test_runtime_journal_survives_explicit_stop_and_restart(self):
    unit = configparser.ConfigParser(interpolation=None)
    unit.read(Path(__file__).parents[1] / 'packaging/marchybar-device.service')
    self.assertEqual(unit['Service']['RuntimeDirectory'], 'marchybar')
    self.assertEqual(unit['Service']['RuntimeDirectoryPreserve'], 'yes')
    self.assertEqual(unit['Service']['RuntimeDirectoryMode'], '0755')
    self.assertEqual(unit['Service']['UMask'], '0077')

  def remove(self, *, state='loaded', stop_fails=False, still_active=False,
             query_fails=False, remove_fails=False, reload_fails=False, pending=False,
             shutdown_fails=False):
    source = (Path(__file__).parents[1] / 'packaging/install-system.sh').read_text()
    start = source.index('if [[ ${1:-} == --remove ]]; then')
    end = source.index('\nfi\n', start) + len('\nfi\n')
    commands = r'''set -euo pipefail
stopped=0
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
udevadm() { printf 'MOCK udevadm %s\n' "$*"; }
'''
    # Redirect the recovery check to a harmless existing/nonexistent fixture path.
    branch = source[start:end].replace('/run/marchybar/lease.json',
                                       '/dev/null' if pending else '/nonexistent/marchybar/lease.json')
    return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-s', '--', '--remove'],
                          input=commands + branch, capture_output=True, text=True, timeout=10,
                          env={'PATH': '/nonexistent', 'STATE': state,
                               'STOP_FAILS': str(int(stop_fails)), 'STILL_ACTIVE': str(int(still_active)),
                               'QUERY_FAILS': str(int(query_fails)), 'REMOVE_FAILS': str(int(remove_fails)),
                               'RELOAD_FAILS': str(int(reload_fails)),
                               'SHUTDOWN_FAILS': str(int(shutdown_fails))})

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

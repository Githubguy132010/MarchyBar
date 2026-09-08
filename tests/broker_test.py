import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from setup_test import SetupTest
from system_action_test import SystemActionTest

spec = importlib.util.spec_from_file_location('broker', Path(__file__).parents[1] / 'packaging/device-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

class BrokerTest(unittest.TestCase):
  def test_only_active_local_user_can_acquire(self):
    def command(args):
      if 'list-sessions' in args:
        return '1 1000 example seat0 20 user tty1 no -'
      return 'User=1000\nActive=yes\nRemote=no\nClass=user'
    with patch.object(broker, 'command', command):
      self.assertTrue(broker.active_local(1000))
      self.assertFalse(broker.active_local(0))
      self.assertFalse(broker.active_local(1001))
    with patch.object(broker, 'command', side_effect=['1 1000 example', 'User=1000\nActive=yes\nRemote=yes\nClass=user']):
      self.assertFalse(broker.active_local(1000))

  def test_mode_change_requires_device_identity(self):
    with tempfile.TemporaryDirectory() as tmp:
      device=Path(tmp)
      (device/'idVendor').write_text('1234')
      (device/'idProduct').write_text('8302')
      (device/'bConfigurationValue').write_text('1')
      with self.assertRaises(RuntimeError): broker.mode(device,2)
      self.assertEqual((device/'bConfigurationValue').read_text(),'1')

  def test_lease_restores_original_mode_and_light(self):
    with tempfile.TemporaryDirectory() as tmp:
      device=Path(tmp)
      for name,value in {'idVendor':'05ac','idProduct':'8302','bConfigurationValue':'1','brightness':'73','max_brightness':'255'}.items():
        (device/name).write_text(value)
      with patch.object(broker,'usb_device',return_value=device), patch.object(broker,'backlight',return_value=device), patch.object(broker,'RECOVERY',device/'lease.json'):
        lease=broker.Lease(1000)
        lease.brightness(100)
        self.assertEqual((device/'brightness').read_text(),'100')
        for value in [-1,256,True,'100']:
          with self.assertRaises(ValueError): lease.brightness(value)
        broker.mode(device,2)
        broker.save_journal({'original': lease.original, 'brightness': lease.original_brightness, 'acls': []})
        lease.close();lease.close()
        self.assertEqual((device/'bConfigurationValue').read_text(),'1')
        self.assertEqual((device/'brightness').read_text(),'73')

  def test_restart_recovers_interrupted_mode(self):
    with tempfile.TemporaryDirectory() as tmp:
      device=Path(tmp)
      for name,value in {'idVendor':'05ac','idProduct':'8302','bConfigurationValue':'2','brightness':'128','max_brightness':'255'}.items():
        (device/name).write_text(value)
      journal=device/'lease.json'
      journal.write_text('{"original":1,"brightness":"42","acls":[]}')
      with patch.object(broker,'usb_device',return_value=device), patch.object(broker,'backlight',return_value=device), patch.object(broker,'RECOVERY',journal):
        broker.recover()
      self.assertEqual((device/'bConfigurationValue').read_text(),'1')
      self.assertEqual((device/'brightness').read_text(),'42')
      self.assertFalse(journal.exists())

class RecoveryTest(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory(prefix='marchybar-broker-')
    self.addCleanup(tmp.cleanup)
    self.device = Path(tmp.name)
    for name, value in {'idVendor': '05ac', 'idProduct': '8302', 'bConfigurationValue': '1',
                        'brightness': '73', 'max_brightness': '255'}.items():
      (self.device / name).write_text(value)
    self.journal = self.device / 'lease.json'
    self.files = {'drm': '/dev/dri/card900', 'touch': '/dev/input/event900',
                  'keyboard': '/dev/input/event901'}
    self.baseline = 'user::rw-\ngroup::---\nother::---'
    self.acls = dict.fromkeys(self.files.values(), self.baseline)
    self.failures = {}
    self.attempts = []
    self.identities = {file: SimpleNamespace(st_ino=index, st_rdev=index + 900)
                       for index, file in enumerate(self.files.values())}
    real_stat = os.stat

    def stat(path, *args, **kwargs):
      if str(path) in self.identities:
        value = self.identities[str(path)]
        if isinstance(value, Exception):
          raise value
        return value
      return real_stat(path, *args, **kwargs)

    def command(args):
      if args == ['/usr/bin/udevadm', 'settle', '--timeout=5']:
        return ''
      if args[:2] == ['/usr/bin/getfacl', '-cp']:
        return self.acls[args[-1]]
      if args[:2] == ['/usr/bin/setfacl', '-m']:
        self.acls[args[-1]] += '\n' + args[2]
        return ''
      raise AssertionError(f'Unexpected command: {args}')

    def run(args, **kwargs):
      if args[:2] == ['/usr/bin/pgrep', '-x']:
        return SimpleNamespace(returncode=1)
      if args[:2] == ['/usr/bin/setfacl', '--set-file=-']:
        file = args[-1]
        self.attempts.append(file)
        if self.failures.get(file, 0):
          self.failures[file] -= 1
          raise subprocess.TimeoutExpired(args, 3)
        self.acls[file] = kwargs['input'].strip()
        return SimpleNamespace(returncode=0)
      raise AssertionError(f'Unexpected subprocess: {args}')

    for target, kwargs in [('usb_device', {'return_value': self.device}),
                           ('backlight', {'return_value': self.device}),
                           ('RECOVERY', {'new': self.journal}),
                           ('nodes', {'return_value': self.files}),
                           ('command', {'side_effect': command}),
                           ('active_local', {'return_value': True}),
                           ('LEASE', {'new': None}), ('SLEEPING', {'new': False}),
                           ('STOPPING', {'new': False})]:
      self.enterContext(patch.object(broker, target, **kwargs))
    self.enterContext(patch.object(broker.os, 'stat', side_effect=stat))
    self.enterContext(patch.object(broker.subprocess, 'run', side_effect=run))
    self.enterContext(patch.object(broker.glob, 'glob', return_value=[]))
    self.enterContext(patch.object(broker.time, 'sleep'))

  def acquire(self):
    lease = broker.Lease(1000)
    lease.acquire()
    return lease

  def assert_restored(self, original='1'):
    self.assertEqual((self.device / 'bConfigurationValue').read_text(), original)
    self.assertEqual((self.device / 'brightness').read_text(), '73')
    self.assertFalse(self.journal.exists())
    self.assertTrue(all(acl == self.baseline for acl in self.acls.values()))

  def test_close_retries_failed_acl_without_replaying_successful_nodes(self):
    lease = self.acquire()
    file = self.files['keyboard']
    self.failures[file] = 1
    self.assertFalse(lease.close())
    self.assertTrue(lease.closed)
    self.assertTrue(self.journal.exists())
    self.assertEqual([entry[0] for entry in json.loads(self.journal.read_text())['acls']], [file])
    self.assertIn('u:1000:r', self.acls[file])
    self.assertTrue(lease.close())
    self.assertTrue(lease.close())
    self.assert_restored()
    self.assertEqual(self.attempts.count(file), 2)
    self.assertEqual(self.attempts.count(self.files['drm']), 1)

  def test_recover_retries_failed_acl(self):
    self.acquire()
    self.failures[self.files['keyboard']] = 1
    with self.assertRaisesRegex(RuntimeError, 'ACL'):
      broker.recover()
    self.assertTrue(self.journal.exists())
    broker.recover()
    broker.recover()
    self.assert_restored()

  def test_missing_acl_tool_is_not_mistaken_for_missing_node(self):
    self.acquire()
    with patch.object(broker.subprocess, 'run', side_effect=FileNotFoundError('missing setfacl')):
      with self.assertRaisesRegex(RuntimeError, 'ACL'):
        broker.recover()
    self.assertEqual(len(json.loads(self.journal.read_text())['acls']), 3)
    broker.recover()
    self.assert_restored()

  def test_partial_acquisition_failure_restores_granted_permissions(self):
    command = broker.command.side_effect

    def fail_grant(args):
      if args[:2] == ['/usr/bin/setfacl', '-m'] and args[-1] == self.files['touch']:
        raise subprocess.TimeoutExpired(args, 6)
      return command(args)

    with patch.object(broker, 'command', side_effect=fail_grant):
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertIsNone(broker.LEASE)
    self.assert_restored()

  def test_missing_and_replaced_nodes_are_not_written(self):
    self.acquire()
    self.identities[self.files['drm']] = FileNotFoundError('removed')
    self.identities[self.files['touch']] = SimpleNamespace(st_ino=99, st_rdev=901)
    self.identities[self.files['keyboard']] = SimpleNamespace(st_ino=2, st_rdev=999)
    broker.recover()
    self.assertEqual(self.attempts, [])
    self.assertFalse(self.journal.exists())

  def test_stat_permission_failure_remains_pending(self):
    self.acquire()
    file = self.files['keyboard']
    identity = self.identities[file]
    self.identities[file] = PermissionError('injected stat denial')
    with self.assertRaisesRegex(RuntimeError, 'ACL'):
      broker.recover()
    self.assertTrue(self.journal.exists())
    self.identities[file] = identity
    broker.recover()
    self.assert_restored()

  def test_reacquire_recovers_original_baseline_before_snapshot(self):
    first = self.acquire()
    with patch.object(broker, 'mode', side_effect=OSError('injected USB reset failure')):
      first.close()
    self.assertEqual(json.loads(self.journal.read_text())['original'], 1)
    second = self.acquire()
    self.assertEqual(json.loads(self.journal.read_text())['original'], 1)
    second.close()
    self.assert_restored()

  def test_persistent_recovery_failure_blocks_reacquire_without_journal_loss(self):
    first = self.acquire()
    with patch.object(broker, 'mode', side_effect=OSError('injected USB reset failure')):
      first.close()
      for _ in range(2):
        with self.assertRaisesRegex(RuntimeError, 'recover'):
          self.acquire()
        self.assertEqual(json.loads(self.journal.read_text())['original'], 1)
    broker.recover()
    self.assert_restored()

  def test_true_original_mode_two_is_preserved(self):
    (self.device / 'bConfigurationValue').write_text('2')
    lease = self.acquire()
    lease.close()
    self.assert_restored('2')

  def test_brightness_restore_failure_retains_journal(self):
    self.acquire()
    self.device.joinpath('brightness').unlink()
    self.device.joinpath('brightness').mkdir()
    with self.assertRaises(RuntimeError):
      broker.recover()
    self.assertTrue(self.journal.exists())
    self.device.joinpath('brightness').rmdir()
    broker.recover()
    self.assert_restored()

  def test_missing_backlight_retains_original_brightness_for_retry(self):
    self.acquire()
    with patch.object(broker, 'backlight', return_value=None):
      with self.assertRaisesRegex(RuntimeError, 'backlight'):
        broker.recover()
    self.assertEqual(json.loads(self.journal.read_text())['brightness'], '73')
    broker.recover()
    self.assert_restored()

  def test_journal_update_failure_preserves_baseline_for_retry(self):
    self.acquire()
    before = self.journal.read_text()
    with patch.object(broker, 'save_journal', side_effect=OSError('injected journal write failure')):
      with self.assertRaisesRegex(RuntimeError, 'journal write'):
        broker.recover()
    self.assertEqual(self.journal.read_text(), before)
    broker.recover()
    self.assert_restored()

  def test_invalid_journal_blocks_acquisition_without_overwrite(self):
    self.journal.write_text('{invalid')
    with self.assertRaisesRegex(RuntimeError, 'recover'):
      self.acquire()
    self.assertEqual(self.journal.read_text(), '{invalid')
    self.assertEqual((self.device / 'bConfigurationValue').read_text(), '1')

  def test_journal_replacement_keeps_private_permissions(self):
    self.journal.with_suffix('.tmp').write_text('interrupted temporary write')
    self.journal.with_suffix('.tmp').chmod(0o644)
    broker.save_journal({'original': 1, 'brightness': '73', 'acls': []})
    self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
    lease = self.acquire()
    self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
    self.failures[self.files['keyboard']] = 1
    lease.close()
    self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)

  def test_partial_grant_timeout_and_rollback_failure_remain_recoverable(self):
    command = broker.command.side_effect

    def fail_grant(args):
      result = command(args)
      if args[:2] == ['/usr/bin/setfacl', '-m'] and args[-1] == self.files['touch']:
        self.failures[self.files['touch']] = 1
        raise subprocess.TimeoutExpired(args, 6)
      return result

    with patch.object(broker, 'command', side_effect=fail_grant):
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}, {'id': 2, 'action': 'ping'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertFalse(replies[2]['ok'])
    self.assertIsNone(broker.LEASE)
    saved = json.loads(self.journal.read_text())
    self.assertEqual(saved['original'], 1)
    self.assertEqual([entry[0] for entry in saved['acls']], [self.files['touch']])
    self.assertIn('u:1000:r', self.acls[self.files['touch']])
    broker.recover()
    self.assert_restored()

  def test_journal_failure_before_grant_never_leaves_unrecorded_permissions(self):
    save = broker.save_journal

    def fail_journal(value):
      if len(value['acls']) == 2:
        raise OSError('injected pre-grant journal failure')
      save(value)

    with patch.object(broker, 'save_journal', side_effect=fail_journal):
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertEqual(self.attempts, [self.files['drm']])
    self.assert_restored()

  def test_journal_write_rejects_symlink_without_touching_target(self):
    target = self.device / 'unrelated'
    target.write_text('unchanged')
    self.journal.with_suffix('.tmp').symlink_to(target)
    with self.assertRaises(OSError):
      broker.save_journal({'original': 1, 'brightness': '73', 'acls': []})
    self.assertEqual(target.read_text(), 'unchanged')
    self.assertFalse(self.journal.exists())

  def test_session_audit_does_not_revoke_replacement_owner(self):
    old = self.acquire()
    broker.LEASE = old
    replacement = None

    def session_changed(uid):
      nonlocal replacement
      old.close()
      broker.LEASE = None
      replacement = self.acquire()
      broker.LEASE = replacement
      replacement.brightness(120)
      return False

    with patch.object(broker, 'active_local', side_effect=session_changed), \
         patch.object(broker.time, 'monotonic', side_effect=[0, 4]):
      broker.SleepMonitor.audit_session(SimpleNamespace())
    self.assertIs(broker.LEASE, replacement)
    self.assertFalse(replacement.closed)
    self.assertEqual((self.device / 'brightness').read_text(), '120')
    replacement.close()
    broker.LEASE = None
    self.assert_restored()

  def test_old_close_retry_cannot_restore_a_replacement_lease(self):
    old = self.acquire()
    self.failures[self.files['keyboard']] = 1
    old.close()
    replacement = self.acquire()
    broker.LEASE = replacement
    before = self.journal.read_text()
    self.assertFalse(old.close())
    self.assertEqual(self.journal.read_text(), before)
    self.assertFalse(replacement.closed)
    replacement.close()
    broker.LEASE = None
    self.assert_restored()

  def test_existing_owner_is_undisturbed_by_competing_acquire(self):
    owner = self.acquire()
    broker.LEASE = owner
    before = self.journal.read_text()
    replies = self.handler(iter([{'id': 1, 'action': 'acquire'}, {'id': 2, 'action': 'release'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertEqual(self.journal.read_text(), before)
    self.assertIs(broker.LEASE, owner)
    self.assertFalse(owner.closed)
    owner.close()
    broker.LEASE = None
    self.assert_restored()

  def test_shutdown_blocks_reacquisition_during_grace_period(self):
    owner = self.acquire()
    broker.LEASE = owner

    def release_and_reacquire(message):
      owner.close()
      broker.LEASE = None
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
      self.assertFalse(replies[1]['ok'])

    owner.notify = release_and_reacquire
    with self.assertRaises(SystemExit) as stopped:
      broker.stop(None, None)
    self.assertEqual(stopped.exception.code, 0)
    self.assertTrue(broker.STOPPING)
    self.assertIsNone(broker.LEASE)
    self.assert_restored()

  def test_failed_shutdown_retains_journal_and_exits_nonzero(self):
    owner = self.acquire()
    broker.LEASE = owner
    self.failures[self.files['keyboard']] = 1
    with patch.object(broker.time, 'monotonic', side_effect=[0, 4]), \
         self.assertRaises(SystemExit) as stopped:
      broker.stop(None, None)
    self.assertEqual(stopped.exception.code, 1)
    self.assertTrue(owner.closed)
    self.assertIsNone(broker.LEASE)
    self.assertTrue(self.journal.exists())
    broker.recover()
    self.assert_restored()

  def test_startup_recovery_failure_does_not_accept_clients(self):
    self.acquire()
    self.failures[self.files['keyboard']] = 1
    # main is inert here: no privilege, system socket, D-Bus or signal registration.
    with patch.object(broker.os, 'geteuid', return_value=0), \
         patch.object(broker, 'SOCKET', str(self.device / 'device.sock')), \
         patch.object(broker, 'SleepMonitor') as monitor, \
         patch.object(broker, 'Server') as server, \
         patch.object(broker.signal, 'signal'), \
         patch.object(broker.os, 'chmod'):
      with self.assertRaisesRegex(RuntimeError, 'ACL'):
        broker.main()
      server.assert_not_called()
      monitor.assert_not_called()
      self.assertTrue(self.journal.exists())
      broker.main()
      server.assert_called_once()
      monitor.assert_called_once()
    self.assert_restored()

  def handler(self, actions):
    class Reader:
      def readline(self, limit):
        action = next(actions, None)
        while callable(action):
          action()
          action = next(actions, None)
        return (json.dumps(action) + '\n').encode() if action else b''

    handler = broker.Handler.__new__(broker.Handler)
    handler.request = SimpleNamespace(getsockopt=lambda *args: struct.pack('3i', 9001, 1000, 1000),
                                      settimeout=lambda value: None)
    handler.rfile = Reader()
    handler.wfile = io.BytesIO()
    handler.handle()
    return {value['id']: value for line in handler.wfile.getvalue().splitlines()
            if 'id' in (value := json.loads(line))}

  def test_forced_release_rejects_stale_requests_and_preserves_new_owner(self):
    for event, release in (('sleep', True), ('sleep', False), ('inactive', True),
                           ('inactive', False), ('replacement', True), ('replacement', False)):
      with self.subTest(event=event, release=release):
        broker.SLEEPING = False
        (self.device / 'brightness').write_text('73')
        replacement = None

        def revoke():
          nonlocal replacement
          lease = broker.LEASE
          with patch.object(broker.time, 'monotonic', side_effect=[0, 4]):
            if event == 'sleep':
              broker.SleepMonitor.sleep(SimpleNamespace(fd=None), None, None, None, None, None,
                                        SimpleNamespace(unpack=lambda: (True,)))
            else:
              with patch.object(broker, 'active_local', return_value=False):
                broker.SleepMonitor.audit_session(SimpleNamespace())
          self.assertTrue(lease.closed)
          self.assertIsNone(broker.LEASE)
          self.assert_restored()
          if event == 'replacement':
            replacement = self.acquire()
            broker.LEASE = replacement
            replacement.brightness(120)

        actions = [{'id': 1, 'action': 'acquire'}, revoke,
                   {'id': 2, 'action': 'brightness', 'value': 0}, {'id': 3, 'action': 'ping'}]
        if release:
          actions.append({'id': 4, 'action': 'release'})
        replies = self.handler(iter(actions))
        self.assertTrue(replies[1]['ok'])
        self.assertFalse(replies[2]['ok'])
        self.assertFalse(replies[3]['ok'])
        if release:
          self.assertTrue(replies[4]['ok'])
        if replacement:
          self.assertIs(broker.LEASE, replacement)
          self.assertFalse(replacement.closed)
          self.assertEqual((self.device / 'brightness').read_text(), '120')
          replacement.close()
          broker.LEASE = None
        self.assert_restored()

  def test_sleep_preparation_rejects_writes_before_forced_release(self):
    def sleeping():
      broker.SLEEPING = True
    replies = self.handler(iter([{'id': 1, 'action': 'acquire'}, sleeping,
                                 {'id': 2, 'action': 'brightness', 'value': 0},
                                 {'id': 3, 'action': 'ping'}]))
    self.assertFalse(replies[2]['ok'])
    self.assertFalse(replies[3]['ok'])
    self.assert_restored()

  def test_release_reports_incomplete_cleanup_and_retry_recovers(self):
    def fail_cleanup():
      self.failures[self.files['keyboard']] = 1
    replies = self.handler(iter([{'id': 1, 'action': 'acquire'},
                                 {'id': 2, 'action': 'brightness', 'value': 100},
                                 {'id': 3, 'action': 'ping'}, fail_cleanup,
                                 {'id': 4, 'action': 'release'}, {'id': 5, 'action': 'acquire'},
                                 {'id': 6, 'action': 'release'}]))
    self.assertTrue(all(replies[i]['ok'] for i in (1, 2, 3, 5, 6)))
    self.assertFalse(replies[4]['ok'])
    self.assert_restored()


if __name__=='__main__': unittest.main()

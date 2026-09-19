"""Synthetic sysfs and mocked device calls only; never touches real hardware."""
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import tempfile

import broker_test

broker = broker_test.broker


class DiscoveryTest(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = Path(tmp.name)
    self.enterContext(patch.object(broker, 'Path', side_effect=lambda path:
        self.root / str(path).lstrip('/') if str(path).startswith('/sys/') else Path(path)))
    self.write('/sys/firmware/devicetree/base/compatible', b'apple,j293\0apple,t8103\0apple,arm-platform\0')

  def write(self, path, value):
    p = self.root / str(path).lstrip('/')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(value if isinstance(value, bytes) else value.encode())
    return p

  def device(self, path, driver, compatible, subsystem):
    p = self.root / path.lstrip('/')
    p.mkdir(parents=True, exist_ok=True)
    (p / 'driver').symlink_to('/sys/bus/' + subsystem + '/drivers/' + driver)
    (p / 'subsystem').symlink_to('/sys/bus/' + subsystem)
    self.write(path + '/of_node/compatible', compatible.encode() + b'\0')
    return p

  def fixtures(self, model='apple,j293', light='228600000.dsi.0'):
    touch, keyboard, bus = broker.ASAHI_MODELS[model]
    self.write('/sys/firmware/devicetree/base/compatible', model.encode() + b'\0apple,arm-platform\0')
    soc = 't8103' if model == 'apple,j293' else 't8112'
    self.device('/sys/class/drm/card3/device', 'adp',
                'apple,' + soc + '-display-pipe\0apple,h7-display-pipe', 'platform')
    self.device('/sys/class/input/event7/device', 'apple-z2', model + '-touchbar', 'spi')
    for key, value in {'name': touch, 'phys': 'apple_z2', 'id/bustype': '001c', 'id/vendor': '0000'}.items():
      self.write('/sys/class/input/event7/device/' + key, value)
    for key, value in {'name': keyboard, 'id/bustype': bus, 'id/vendor': '05ac'}.items():
      self.write('/sys/class/input/event8/device/' + key, value)
    # v6.15 j293/j493 panel@0 is a MIPI child with a model-specific compatible
    # followed by the generic entry matched by the panel-summit driver.
    panel = self.device('/sys/devices/platform/dsi/panel', 'panel-summit',
                        model + '-summit\0apple,summit', 'mipi-dsi')
    light_path = panel / 'backlight' / light
    light_path.mkdir(parents=True)
    (light_path / 'brightness').write_text('73')
    (light_path / 'max_brightness').write_text('2047')
    cls = self.root / 'sys/class/backlight'
    cls.mkdir(parents=True)
    (cls / light).symlink_to(light_path)

  def test_explicit_models_and_nul_boundaries(self):
    for value, expected in [(b'apple,j293\0apple,t8103\0', ('asahi', 'apple,j293')),
                            (b'apple,j493\0apple,t8112\0', ('asahi', 'apple,j493'))]:
      self.write('/sys/firmware/devicetree/base/compatible', value)
      self.assertEqual(broker.hardware_profile(), expected)
    for value in [b'apple,j293x\0', b'apple,j493-touchbar\0', b'apple,j999\0',
                  b'apple,j293\0apple,j493\0', b'apple,j999\0apple,j293\0',
                  b'apple,j293', b'apple,j293\napple,t8103\0', b'']:
      with self.subTest(value=value):
        self.write('/sys/firmware/devicetree/base/compatible', value)
        with self.assertRaises(RuntimeError):
          broker.hardware_profile()

  def test_unsupported_dmi_is_not_an_asahi_fallback(self):
    (self.root / 'sys/firmware/devicetree/base/compatible').unlink()
    for model in ('MacBookPro17,1', 'Mac14,7', 'MacBookPro18,1', 'Other'):
      self.write('/sys/devices/virtual/dmi/id/product_name', model)
      with self.assertRaises(RuntimeError):
        broker.hardware_profile()
    self.write('/sys/devices/virtual/dmi/id/product_name', 'MacBookPro16,2')
    self.assertEqual(broker.hardware_profile(), ('t2', 'MacBookPro16,2'))

  def test_m1_discovery_and_current_backlight(self):
    self.fixtures()
    with patch.object(broker, 'keyboard_keys', return_value=True) as keys:
      self.assertEqual(broker.nodes('asahi', 'apple,j293'),
                       {'drm': '/dev/dri/card3', 'touch': '/dev/input/event7', 'keyboard': '/dev/input/event8'})
      keys.assert_called_once_with('/dev/input/event8', (30, 464))
    self.assertEqual(broker.backlight('asahi').name, '228600000.dsi.0')

  def test_m2_discovery_and_legacy_backlight(self):
    self.fixtures('apple,j493', '228200000.display-pipe.0')
    with patch.object(broker, 'keyboard_keys', return_value=True):
      self.assertTrue(all(broker.nodes('asahi', 'apple,j493').values()))
    self.assertEqual(broker.backlight('asahi').name, '228200000.display-pipe.0')

  def test_handoff_enumerates_only_verified_drm_touch_parent_and_event(self):
    self.fixtures()
    event = self.root / 'sys/class/input/event7'
    parent = self.root / 'sys/devices/platform/spi/touch/input/input7'
    parent.parent.mkdir(parents=True)
    (event / 'device').rename(parent)
    (event / 'device').symlink_to(parent)
    with patch.object(broker, 'keyboard_keys', return_value=True):
      self.assertEqual(broker.asahi_udev_devices(), [
        '/sys/class/drm/card3', str(parent), str(event)])
    self.write('/sys/class/input/event7/device/id/vendor', '05ac')
    self.assertEqual(broker.asahi_udev_devices(), ['/sys/class/drm/card3'])
    with patch.object(broker, 'hardware_profile', return_value=('t2', 'MacBookPro16,1')):
      self.assertEqual(broker.asahi_udev_devices(), [])

  def test_touch_requires_every_identity_field(self):
    self.fixtures()
    for field, value in [('name', 'Mac14,7 Touch Bar'), ('phys', 'usb/apple_z2'),
                         ('id/vendor', '05ac'), ('id/bustype', '0003'),
                         ('of_node/compatible', 'apple,j493-touchbar\0')]:
      p = self.root / 'sys/class/input/event7/device' / field
      original = p.read_bytes()
      p.write_text(value)
      with self.subTest(field=field):
        self.assertIsNone(broker.nodes('asahi', 'apple,j293')['touch'])
      p.write_bytes(original)
    p = self.root / 'sys/class/input/event7/device/driver'
    p.unlink()
    p.symlink_to('/sys/bus/spi/drivers/apple_z2')
    self.assertIsNone(broker.nodes('asahi', 'apple,j293')['touch'])

  def test_drm_and_panel_require_driver_and_compatible(self):
    self.fixtures()
    self.write('/sys/class/drm/card3/device/of_node/compatible', b'apple,other-display-pipe\0')
    self.assertIsNone(broker.nodes('asahi', 'apple,j293')['drm'])
    self.write('/sys/class/drm/card3/device/of_node/compatible', b'apple,h7-display-pipe\0')
    p = self.root / 'sys/class/drm/card3/device/driver'
    p.unlink()
    p.symlink_to('/sys/bus/platform/drivers/adpdrm')
    self.assertIsNone(broker.nodes('asahi', 'apple,j293')['drm'])
    self.write('/sys/devices/platform/dsi/panel/of_node/compatible', b'apple,summit-extra\0')
    self.assertIsNone(broker.backlight('asahi'))

  def test_panel_requires_bound_summit_driver_on_compatible_ancestor(self):
    self.fixtures()
    panel = self.root / 'sys/devices/platform/dsi/panel'
    light = broker.backlight('asahi')
    self.assertEqual(broker.ancestor(light, 'panel-summit', 'apple,summit'), panel)
    self.assertEqual((panel / 'of_node/compatible').read_bytes(), b'apple,j293-summit\0apple,summit\0')
    (panel / 'driver').unlink()
    (panel / 'driver').symlink_to('/sys/bus/mipi-dsi/drivers/panel_summit')
    self.assertIsNone(broker.backlight('asahi'))

  def test_ancestry_matches_one_bound_device_not_unrelated_parents(self):
    parent = self.device('/sys/devices/platform/spi/touch', 'apple-z2', 'apple,j293-touchbar', 'spi')
    child = parent / 'input/input0/event0'
    child.mkdir(parents=True)
    self.assertEqual(broker.ancestor(child, 'apple-z2', 'apple,j293-touchbar', 'spi'), parent)
    self.assertIsNone(broker.ancestor(child, 'apple-z2', 'apple,j293-touchbar', 'usb'))
    (parent / 'driver').unlink()
    (child / 'driver').symlink_to('/sys/bus/spi/drivers/apple-z2')
    self.assertIsNone(broker.ancestor(child, 'apple-z2', 'apple,j293-touchbar'))

  def test_backlight_names_and_ambiguity_fail_closed(self):
    self.fixtures()
    cls = self.root / 'sys/class/backlight'
    light = cls / '228600000.dsi.0'
    target = light.resolve()
    light.rename(cls / 'unrelated-touchbar')
    self.assertIsNone(broker.backlight('asahi'))
    light.symlink_to(target)
    (cls / '228200000.display-pipe.0').symlink_to(target)
    with self.assertRaisesRegex(RuntimeError, 'Ambiguous'):
      broker.backlight('asahi')

  def test_keyboard_is_not_arbitrary_apple_input(self):
    self.fixtures()
    for field, value in [('name', 'Apple Internal Keyboard'), ('id/vendor', '0000'), ('id/bustype', '0003')]:
      p = self.root / 'sys/class/input/event8/device' / field
      original = p.read_text()
      p.write_text(value)
      with patch.object(broker, 'keyboard_keys', return_value=True) as keys:
        self.assertIsNone(broker.nodes('asahi', 'apple,j293')['keyboard'])
        keys.assert_not_called()
      p.write_text(original)
    with patch.object(broker, 'keyboard_keys', return_value=False):
      self.assertIsNone(broker.nodes('asahi', 'apple,j293')['keyboard'])

  def test_ioctl_requires_both_a_and_fn(self):
    for present in [(), (30,), (464,), (30, 464)]:
      def ioctl(fd, request, bits, mutate):
        for key in present:
          bits[key // 8] |= 1 << (key % 8)
      with patch('builtins.open', return_value=io.BytesIO()), patch.object(broker.fcntl, 'ioctl', side_effect=ioctl):
        self.assertEqual(broker.keyboard_keys('/inert', (30, 464)), len(present) == 2)


class AsahiRecoveryTest(unittest.TestCase):
  acquire = broker_test.RecoveryTest.acquire
  handler = broker_test.RecoveryTest.handler

  def setUp(self):
    broker_test.RecoveryTest.setUp(self)
    self.enterContext(patch.object(broker, 'hardware_profile', return_value=('asahi', 'apple,j293')))
    self.usb = self.enterContext(patch.object(broker, 'usb_device', side_effect=AssertionError('Asahi USB discovery')))
    self.mode = self.enterContext(patch.object(broker, 'mode', side_effect=AssertionError('Asahi USB mode')))
    self.addCleanup(self.usb.assert_not_called)
    self.addCleanup(self.mode.assert_not_called)

  def test_profile_metadata_and_explicit_grants(self):
    self.files['untrusted-extra'] = '/do/not/grant'
    lease = broker.Lease(1000)
    result = lease.acquire()
    self.assertEqual(result, {key: self.files[key] for key in ('drm', 'touch', 'keyboard')} | {'profile': 'asahi'})
    saved = json.loads(self.journal.read_text())
    self.assertEqual((saved['version'], saved['profile'], saved['model']), (1, 'asahi', 'apple,j293'))
    self.assertNotIn('original', saved)
    self.assertNotIn('brightness', saved)
    self.assertEqual(len(saved['acls']), 3)
    lease.brightness(150)
    self.assertTrue(lease.close())
    self.assertEqual((self.device / 'brightness').read_text(), '0')
    self.assertFalse(self.journal.exists())

  def test_restart_blanks_before_acl_restoration(self):
    self.acquire().brightness(180)
    run = broker.subprocess.run.side_effect
    def check_blank(args, **kwargs):
      self.assertEqual((self.device / 'brightness').read_text(), '0')
      return run(args, **kwargs)
    with patch.object(broker.subprocess, 'run', side_effect=check_blank):
      broker.recover()
    self.assertFalse(self.journal.exists())

  def test_failed_acl_is_dark_and_retryable(self):
    lease = self.acquire()
    self.failures[self.files['keyboard']] = 1
    self.assertFalse(lease.close())
    self.assertEqual((self.device / 'brightness').read_text(), '0')
    self.assertTrue(self.journal.exists())
    self.assertTrue(lease.close())

  def test_blank_failure_keeps_journal_but_revokes_acls(self):
    lease = self.acquire()
    with patch.object(broker, 'backlight', return_value=None):
      self.assertFalse(lease.close())
    self.assertTrue(self.journal.exists())
    self.assertEqual(json.loads(self.journal.read_text())['acls'], [])
    self.assertTrue(lease.close())
    self.assertEqual((self.device / 'brightness').read_text(), '0')

  def test_failed_blank_write_and_reacquisition_preserve_recovery(self):
    lease = self.acquire()
    light = self.device / 'brightness'
    light.unlink()
    light.mkdir()
    self.assertFalse(lease.close())
    before = self.journal.read_text()
    with self.assertRaisesRegex(RuntimeError, 'recover'):
      self.acquire()
    self.assertEqual(self.journal.read_text(), before)
    light.rmdir()
    self.assertTrue(lease.close())
    self.assertEqual(light.read_text(), '0')

  def test_partial_grant_failure_blanks_and_returns_no_profile(self):
    command = broker.command.side_effect
    def fail_grant(args):
      result = command(args)
      if args[:2] == ['/usr/bin/setfacl', '-m'] and args[-1] == self.files['touch']:
        raise OSError('injected grant failure')
      return result
    with patch.object(broker, 'command', side_effect=fail_grant):
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertNotIn('data', replies[1])
    self.assertTrue(all(acl == self.baseline for acl in self.acls.values()))
    self.assertEqual((self.device / 'brightness').read_text(), '0')
    self.assertFalse(self.journal.exists())

  def test_recovery_rejects_wrong_profile_version_and_model(self):
    self.acquire()
    original = json.loads(self.journal.read_text())
    for change in [{'profile': 't2'}, {'profile': 'other'}, {'version': 2}, {'version': True}, {'model': 'apple,j493'}]:
      saved = original | change
      self.journal.write_text(json.dumps(saved))
      with self.subTest(change=change), self.assertRaises(RuntimeError):
        broker.recover()
      self.assertEqual(json.loads(self.journal.read_text()), saved)
      self.assertEqual(self.attempts, [])
    self.journal.write_text('{"original": 1, "brightness": "73", "acls": []}')
    with self.assertRaisesRegex(RuntimeError, 'profile'):
      broker.recover()

  def test_asahi_journal_cannot_be_replayed_on_t2(self):
    self.acquire()
    before = self.journal.read_text()
    with patch.object(broker, 'hardware_profile', return_value=('t2', 'MacBookPro16,1')):
      with self.assertRaisesRegex(RuntimeError, 'profile'):
        broker.recover()
    self.assertEqual(self.journal.read_text(), before)
    self.assertEqual(self.attempts, [])

  def test_replaced_nodes_are_not_given_saved_acls(self):
    self.acquire()
    for file in self.files.values():
      self.identities[file] = SimpleNamespace(st_ino=999, st_rdev=999)
    broker.recover()
    self.assertEqual(self.attempts, [])
    self.assertEqual((self.device / 'brightness').read_text(), '0')
    self.assertFalse(self.journal.exists())

  def test_discovery_failure_does_not_block_unchanged_acl_revocation(self):
    self.acquire()
    with patch.object(broker, 'nodes', side_effect=RuntimeError('injected discovery failure')) as discovery:
      broker.recover()
      discovery.assert_not_called()
    self.assertEqual(self.attempts, list(self.files.values()))
    self.assertTrue(all(acl == self.baseline for acl in self.acls.values()))
    self.assertEqual((self.device / 'brightness').read_text(), '0')
    self.assertFalse(self.journal.exists())

  def test_unverifiable_entry_does_not_block_other_acl_revocation(self):
    self.acquire()
    touch = self.files['touch']
    identity = self.identities[touch]
    self.identities[touch] = PermissionError('injected identity failure')
    with patch.object(broker, 'nodes', side_effect=RuntimeError('injected discovery failure')):
      with self.assertRaisesRegex(RuntimeError, 'ACL identity check'):
        broker.recover()
    self.assertEqual(self.attempts, [self.files['drm'], self.files['keyboard']])
    self.assertEqual(self.acls[self.files['drm']], self.baseline)
    self.assertEqual(self.acls[self.files['keyboard']], self.baseline)
    self.assertEqual([entry[0] for entry in json.loads(self.journal.read_text())['acls']], [touch])
    self.identities[touch] = identity
    broker.recover()

  def test_recovery_never_writes_changed_backlight(self):
    lease = self.acquire()
    saved = json.loads(self.journal.read_text())
    saved['backlight'] += '-other'
    self.journal.write_text(json.dumps(saved))
    self.assertFalse(lease.close())
    self.assertEqual((self.device / 'brightness').read_text(), '73')
    self.assertTrue(self.journal.exists())

  def test_event_blanks_before_notification_and_without_grace_delay(self):
    lease = self.acquire()
    broker.LEASE = lease
    def notified(message):
      self.assertEqual((self.device / 'brightness').read_text(), '0')
      self.assertTrue(lease.closed)
    lease.notify = notified
    broker.time.sleep.reset_mock()
    broker.release_for_event('inactive', lease)
    broker.time.sleep.assert_not_called()
    self.assertIsNone(broker.LEASE)

  def test_competitor_or_open_drm_prevents_any_grant(self):
    for status in (0, 2):
      with patch.object(broker.subprocess, 'run', return_value=SimpleNamespace(returncode=status)):
        with self.assertRaises(RuntimeError):
          self.acquire()
      self.assertFalse(self.journal.exists())
    with patch.object(broker.glob, 'glob', return_value=['/proc/inert/fd/3']), \
         patch.object(broker.os, 'readlink', return_value=self.files['drm']):
      with self.assertRaisesRegex(RuntimeError, 'already has'):
        self.acquire()
    self.assertFalse(self.journal.exists())

  def test_second_idle_rejection_never_journals_grants_or_blanks(self):
    with patch.object(broker, 'require_idle', side_effect=[None, RuntimeError('competing renderer')]) as idle, \
         patch.object(broker, 'save_journal', wraps=broker.save_journal) as journal:
      replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
    self.assertEqual(idle.call_count, 2)
    self.assertFalse(replies[1]['ok'])
    self.assertIn('competing renderer', replies[1]['error'])
    journal.assert_not_called()
    self.assertFalse(self.journal.exists())
    self.assertEqual((self.device / 'brightness').read_text(), '73')
    self.assertEqual(self.attempts, [])
    self.assertTrue(all(acl == self.baseline for acl in self.acls.values()))
    self.assertFalse(any(call.args[0][0] == '/usr/bin/setfacl' for call in broker.command.call_args_list))
    self.assertIsNone(broker.LEASE)

  def test_active_lease_and_session_guards_remain_enforced(self):
    owner = self.acquire()
    broker.LEASE = owner
    replies = self.handler(iter([{'id': 1, 'action': 'acquire'}]))
    self.assertFalse(replies[1]['ok'])
    self.assertIs(broker.LEASE, owner)
    with patch.object(broker, 'active_local', return_value=False):
      replies = self.handler(iter([{'id': 2, 'action': 'acquire'}]))
      self.assertFalse(replies[2]['ok'])
    owner.close()
    broker.LEASE = None


if __name__ == '__main__':
  unittest.main()

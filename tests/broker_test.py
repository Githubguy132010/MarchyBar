import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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

if __name__=='__main__': unittest.main()

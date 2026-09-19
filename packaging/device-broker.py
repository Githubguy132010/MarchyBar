#!/usr/bin/python3
"""MarchyBar's root-owned, device-specific lease broker. No shell evaluation.

The renderer runs as the active local user. This broker only changes the known
Touch Bar USB mode, grants temporary ACLs on identified nodes and sets its light.
Closing a lease revokes access and restores T2 firmware or blanks the Asahi panel.
Incomplete restoration stays journaled and blocks acquisition until recovery succeeds.
"""
import fcntl
import glob
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time

SOCKET = '/run/marchybar/device.sock'
LOCK = threading.RLock()
LEASE = None
SLEEPING = False
STOPPING = False
RECOVERY = Path("/run/marchybar/lease.json")
ASAHI_MODELS = {
  'apple,j293': ('MacBookPro17,1 Touch Bar', 'Apple SPI Keyboard', '001c'),
  'apple,j493': ('Mac14,7 Touch Bar', 'Apple MTP keyboard', '0019'),
}


def compatibles(path):
  try:
    data = Path(path).read_bytes()
  except FileNotFoundError:
    return []
  # Device-tree properties are NUL-separated strings, not substring matches.
  if not data or not data.endswith(b'\0'):
    raise RuntimeError('Malformed device-tree compatible property')
  return data[:-1].decode('ascii').split('\0')


def hardware_profile():
  path = Path('/sys/firmware/devicetree/base/compatible')
  values = compatibles(path)
  if values:
    models = [value for value in values if value in ASAHI_MODELS]
    if len(models) == 1 and values[0] == models[0]:
      return 'asahi', models[0]
    raise RuntimeError('Unsupported Apple Silicon model')
  model = read('/sys/devices/virtual/dmi/id/product_name')
  if model in [f'MacBookPro{generation},{variant}' for generation in (15, 16) for variant in (1, 2, 3, 4)]:
    return 't2', model
  raise RuntimeError('Unsupported Touch Bar model')


def ancestor(path, driver, compatible, subsystem=None):
  path = path.resolve()
  for p in (path, *path.parents):
    if ((p / 'driver').resolve().name == driver
        and (subsystem is None or (p / 'subsystem').resolve().name == subsystem)
        and compatible in compatibles(p / 'of_node/compatible')):
      return p
  return None


def keyboard_keys(file, keys):
  try:
    with open(file, 'rb', buffering=0) as f:
      bits = bytearray(96)
      fcntl.ioctl(f, 0x80604521, bits, True)  # EVIOCGBIT(EV_KEY, 96)
      return all(bits[key // 8] & (1 << (key % 8)) for key in keys)
  except OSError:
    return False


def save_journal(value):
  temp = RECOVERY.with_suffix('.tmp')
  with open(temp, 'w', opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW, 0o600)) as file:
    os.fchmod(file.fileno(), 0o600)
    json.dump(value, file)
    file.flush()
    os.fsync(file.fileno())
  os.replace(temp, RECOVERY)


def command(args):
  return subprocess.run(args, check=True, capture_output=True, text=True, timeout=6,
                        env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}).stdout.strip()


def read(path):
  try:
    return Path(path).read_text().strip()
  except OSError:
    return ''


def active_local(uid):
  if uid < 1000:
    return False
  sessions = command(['/usr/bin/loginctl', 'list-sessions', '--no-legend', '--no-pager'])
  for line in sessions.splitlines():
    fields = line.split()
    if len(fields) < 2 or fields[1] != str(uid):
      continue
    props = command(['/usr/bin/loginctl', 'show-session', fields[0], '-p', 'Active', '-p', 'Remote', '-p', 'Class', '-p', 'User'])
    p = dict(row.split('=', 1) for row in props.splitlines() if '=' in row)
    if p.get('User') == str(uid) and p.get('Active') == 'yes' and p.get('Remote') == 'no' and p.get('Class') == 'user':
      return True
  return False


def usb_device():
  for p in Path('/sys/bus/usb/devices').iterdir():
    if read(p / 'idVendor') == '05ac' and read(p / 'idProduct') == '8302':
      return p
  raise RuntimeError('No T2 Touch Bar display found')


def mode(device, target):
  if read(device / 'idVendor') != '05ac' or read(device / 'idProduct') != '8302':
    raise RuntimeError('Touch Bar identity changed')
  if read(device / 'bConfigurationValue') != str(target):
    (device / 'bConfigurationValue').write_text('0')
    time.sleep(0.15)
    (device / 'bConfigurationValue').write_text(str(target))


def nodes(profile='t2', model=None):
  if profile == 'asahi':
    touch_name, keyboard_name, keyboard_bus = ASAHI_MODELS[model]
    found = {'drm': None, 'touch': None, 'keyboard': None}
    for key, base, pattern in [('drm', '/sys/class/drm', 'card[0-9]*'),
                               ('touch', '/sys/class/input', 'event*')]:
      for p in Path(base).glob(pattern):
        selected = None
        if key == 'drm':
          if p.name[4:].isdigit() and ancestor(p / 'device', 'adp', 'apple,h7-display-pipe', 'platform'):
            selected = 'drm'
        else:
          device = p / 'device'
          name, vendor, bus = (read(device / field) for field in ('name', 'id/vendor', 'id/bustype'))
          if (name == touch_name and vendor == '0000' and bus == '001c'
              and read(device / 'phys') == 'apple_z2'
              and ancestor(device, 'apple-z2', model + '-touchbar', 'spi')):
            selected = 'touch'
          elif (name == keyboard_name and vendor == '05ac' and bus == keyboard_bus
                and keyboard_keys('/dev/input/' + p.name, (30, 464))):  # KEY_A, KEY_FN
            selected = 'keyboard'
        if selected:
          if found[selected]:
            raise RuntimeError(f'Ambiguous Asahi {selected} devices')
          found[selected] = ('/dev/dri/' if selected == 'drm' else '/dev/input/') + p.name
    return found
  if profile != 't2':
    raise RuntimeError('Unsupported device profile')
  drm = touch = keyboard = None
  for p in Path('/sys/class/drm').glob('card[0-9]*'):
    if '-' not in p.name and 'DRIVER=appletbdrm' in read(p / 'device/uevent'):
      drm = '/dev/dri/' + p.name
  for p in Path('/sys/class/input').glob('event*'):
    name = read(p / 'device/name')
    vendor = read(p / 'device/id/vendor')
    if 'Touch Bar' in name and ('Touchpad' in name or 'touchpad' in name) and vendor == '05ac':
      touch = '/dev/input/' + p.name
    if 'Apple Internal Keyboard' in name and vendor == '05ac':
      # The trackpad has the same name. Only grant the node with KEY_A.
      if keyboard_keys('/dev/input/' + p.name, (30,)):
        keyboard = '/dev/input/' + p.name
  return {'drm': drm, 'touch': touch, 'keyboard': keyboard}


def backlight(profile='t2'):
  if profile == 'asahi':
    found = []
    for p in Path('/sys/class/backlight').glob('*'):
      if (p.name in ('228600000.dsi.0', '228200000.display-pipe.0')
          and ancestor(p, 'panel-summit', 'apple,summit')
          and (p / 'brightness').exists() and (p / 'max_brightness').exists()):
        found.append(p)
    if len(found) > 1:
      raise RuntimeError('Ambiguous Asahi backlights')
    return found[0] if found else None
  if profile != 't2':
    raise RuntimeError('Unsupported device profile')
  for base in ['/sys/class/backlight', '/sys/class/leds']:
    for p in Path(base).glob('*'):
      if 'appletb' in p.name or 'touchbar' in p.name:
        if (p / 'brightness').exists() and (p / 'max_brightness').exists():
          return p
  return None


def asahi_udev_devices():
  profile, model = hardware_profile()
  if profile != 'asahi':
    return []
  found = nodes(profile, model)
  devices = []
  if found['drm']:
    devices.append('/sys/class/drm/' + Path(found['drm']).name)
  if found['touch']:
    event = Path('/sys/class/input') / Path(found['touch']).name
    parent = (event / 'device').resolve()
    if not parent.name.startswith('input') or not parent.name[5:].isdigit():
      raise RuntimeError('Unexpected Asahi input parent identity')
    devices.extend([str(parent), str(event)])
  return devices


def require_idle(existing):
  # Never stop another renderer or let an uncertain process check grant access.
  for name in ['tiny-dfr', 'touchbard']:
    r = subprocess.run(['/usr/bin/pgrep', '-x', name], capture_output=True)
    if r.returncode == 0:
      raise RuntimeError(f'{name} is running. Stop it before enabling MarchyBar.')
    if r.returncode != 1:
      raise RuntimeError(f'Cannot check whether {name} is running')
  if existing:
    for fd in glob.glob('/proc/[0-9]*/fd/*'):
      try:
        if os.path.realpath(os.readlink(fd)) == existing:
          raise RuntimeError('Another renderer already has the Touch Bar open')
      except FileNotFoundError:
        pass  # The process or descriptor exited during enumeration.


class Lease:
  def __init__(self, uid):
    # Handler holds LOCK: finish pending cleanup before taking a new baseline.
    recover()
    self.uid = uid
    self.acls = []
    self.profile, self.model = hardware_profile()
    self.device = usb_device() if self.profile == 't2' else None
    self.original = int(read(self.device / 'bConfigurationValue') or 1) if self.device else None
    self.light = backlight(self.profile)
    if self.profile == 'asahi' and not self.light:
      raise RuntimeError('Asahi Touch Bar backlight unavailable')
    self.original_brightness = read(self.light / 'brightness') if self.light else None
    self.journal = {'original': self.original, 'brightness': self.original_brightness, 'acls': self.acls}
    if self.profile == 'asahi':
      self.journal = {'version': 1, 'profile': 'asahi', 'model': self.model,
                      'backlight': str(self.light.resolve()), 'acls': self.acls}
    self.closed = False
    self.restored = False
    self.notify = None

  def acquire(self):
    existing = None
    if self.profile == 'asahi' or self.original == 2:
      existing = nodes(self.profile, self.model)['drm']
    require_idle(existing)
    if self.profile == 't2':
      # T2 must journal before changing USB mode.
      save_journal(self.journal)
      os.chmod(RECOVERY, 0o600)
      mode(self.device, 2)
    for _ in range(40):
      found = nodes(self.profile, self.model)
      if found['drm'] and found['touch']:
        break
      time.sleep(0.1)
    else:
      raise RuntimeError('Custom display/input did not appear; original mode will be restored')
    # udev/logind may still replace ACLs while assigning the isolated seat.
    command(['/usr/bin/udevadm', 'settle', '--timeout=5'])
    found = nodes(self.profile, self.model)
    if not found['drm'] or not found['touch']:
      raise RuntimeError('Touch Bar disappeared during device setup')
    if self.profile == 'asahi':
      require_idle(found['drm'])
      # Until this check passes, cleanup must not blank a competing renderer.
      save_journal(self.journal)
    for key in ('drm', 'touch', 'keyboard'):
      file = found[key]
      if not file:
        continue
      st = os.stat(file)
      acl = command(['/usr/bin/getfacl', '-cp', file])
      self.acls.append((file, st.st_ino, st.st_rdev, acl))
      save_journal(self.journal)
      command(['/usr/bin/setfacl', '-m', f'u:{self.uid}:{"rw" if key == "drm" else "r"}', file])
    self.light = backlight(self.profile)
    result = {key: found[key] for key in ('drm', 'touch', 'keyboard')}
    if self.profile == 'asahi':
      result['profile'] = 'asahi'
    return result

  def brightness(self, value):
    if self.closed or SLEEPING or STOPPING:
      raise RuntimeError('Touch Bar lease is no longer active')
    if type(value) is not int or not 0 <= value <= 255:
      raise ValueError('Brightness must be an integer from 0 to 255')
    self.light = backlight(self.profile)
    if not self.light:
      raise RuntimeError('Touch Bar backlight unavailable')
    if self.profile == 'asahi' and (hardware_profile() != (self.profile, self.model)
                                  or str(self.light.resolve()) != self.journal['backlight']):
      raise RuntimeError('Asahi backlight identity changed')
    maximum = int(read(self.light / 'max_brightness'))
    (self.light / 'brightness').write_text(str(round(value / 255 * maximum)))

  def close(self):
    if self.restored:
      return True
    # Reject requests even if permission restoration needs another attempt.
    self.closed = True
    try:
      recover()
      self.restored = True
      return True
    except RuntimeError as e:
      print(str(e), flush=True)
      return False


class Handler(socketserver.StreamRequestHandler):
  def handle(self):
    global LEASE
    _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    mine = None
    self.write_lock = threading.Lock()
    try:
      self.request.settimeout(20)
      while True:
        raw = self.rfile.readline(4097)
        if not raw:
          break
        if len(raw) > 4096:
          break
        ident = None
        try:
          msg = json.loads(raw)
          ident = msg.get('id')
          action = msg.get('action')
          if action != 'release' and not active_local(uid):
            if mine:
              with LOCK:
                if LEASE is mine and mine.profile == 'asahi':
                  mine.close()
              self.send({'event': 'inactive'})
            raise PermissionError('Only the active local desktop session can use MarchyBar hardware')
          with LOCK:
            if action == 'acquire':
              if STOPPING:
                raise RuntimeError('The device helper is stopping')
              if SLEEPING:
                raise RuntimeError('The system is preparing to sleep')
              if LEASE is not None:
                raise RuntimeError('Touch Bar is already leased')
              mine = Lease(uid)
              mine.notify = self.send
              try:
                data = mine.acquire()
              except Exception:
                mine.close()
                mine = None
                raise
              LEASE = mine
            elif action == 'release':
              restored = True
              if mine:
                if LEASE is mine:
                  restored = mine.close()
                  LEASE = None
                mine = None
              if LEASE is None and RECOVERY.exists():
                restored = False
              if not restored:
                raise RuntimeError('Touch Bar cleanup is incomplete; recovery will be retried before acquisition')
              data = {'restored': True}
            elif action in ('brightness', 'ping'):
              if SLEEPING or STOPPING or mine is None or mine.closed or LEASE is not mine:
                raise RuntimeError('Touch Bar lease is no longer active')
              if action == 'brightness':
                mine.brightness(msg.get('value'))
                data = {'brightness': msg['value']}
              else:
                data = {'alive': True}
            else:
              raise ValueError('Unsupported device operation')
          answer = {'id': ident, 'ok': True, 'data': data}
        except Exception as e:
          answer = {'id': ident, 'ok': False, 'error': str(e)}
        self.send(answer)
    finally:
      with LOCK:
        if mine and LEASE is mine:
          mine.close()
          LEASE = None

  def send(self, message):
    with self.write_lock:
      try:
        self.wfile.write((json.dumps(message) + '\n').encode())
        self.wfile.flush()
      except OSError:
        pass


def release_for_event(event, lease=None):
  global LEASE
  with LOCK:
    if lease is None:
      lease = LEASE
    if LEASE is not lease:
      return
    # Asahi has no firmware fallback. Blank before notifications or grace periods.
    if lease and lease.profile == 'asahi':
      lease.close()
    if lease and lease.notify:
      lease.notify({'event': event})
  # Let the renderer close DRM and input before resetting USB.
  deadline = time.monotonic() + 3
  while lease and not lease.closed and time.monotonic() < deadline:
    time.sleep(0.025)
  with LOCK:
    if lease and LEASE is lease:
      lease.close()
      LEASE = None


class SleepMonitor:
  def __init__(self):
    from gi.repository import Gio, GLib
    self.Gio, self.GLib = Gio, GLib
    self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    self.fd = None
    self.inhibit()
    self.bus.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
        'PrepareForSleep', '/org/freedesktop/login1', None, Gio.DBusSignalFlags.NONE, self.sleep)
    GLib.timeout_add_seconds(2, self.audit_session)
    self.loop = GLib.MainLoop()
    threading.Thread(target=self.loop.run, daemon=True).start()

  def audit_session(self):
    with LOCK:
      lease = LEASE
    try:
      if lease and not lease.closed and not active_local(lease.uid):
        release_for_event('inactive', lease)
    except Exception as e:
      print(f'Session audit: {e}', flush=True)
    return True

  def inhibit(self):
    try:
      result, fds = self.bus.call_with_unix_fd_list_sync('org.freedesktop.login1',
          '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'Inhibit',
          self.GLib.Variant('(ssss)', ('sleep', 'MarchyBar', 'Release Touch Bar before sleep', 'delay')),
          self.GLib.VariantType.new('(h)'), self.Gio.DBusCallFlags.NONE, 3000, None, None)
      self.fd = fds.get(result.unpack()[0])
    except Exception as e:
      print(f'Suspend coordination unavailable: {e}', flush=True)

  def sleep(self, connection, sender, path, interface, signal_name, parameters):
    global SLEEPING
    with LOCK:
      SLEEPING = parameters.unpack()[0]
    if SLEEPING:
      release_for_event('sleep')
      if self.fd is not None:
        os.close(self.fd)
        self.fd = None
    else:
      self.inhibit()


def recover():
  if LEASE is not None and not LEASE.closed:
    raise RuntimeError('Cannot recover while a Touch Bar lease is active')
  if not RECOVERY.exists():
    return
  try:
    saved = json.loads(RECOVERY.read_text())
    profile, model = hardware_profile()
    if saved.get('profile', 't2') != profile:
      raise RuntimeError('Recovery profile does not match this machine')
    if profile == 'asahi' and (type(saved.get('version')) is not int or saved['version'] != 1
                               or saved.get('model') != model):
      raise RuntimeError('Unsupported Asahi recovery version or model identity')
    if profile == 't2' and ('version' in saved or 'profile' in saved):
      raise RuntimeError('Unsupported T2 recovery journal format')
    pending = []
    errors = []
    if profile == 'asahi':
      try:
        light = backlight(profile)
        if not light or str(light.resolve()) != saved.get('backlight'):
          raise RuntimeError('Asahi recovery backlight identity unavailable or changed')
        (light / 'brightness').write_text('0')
      except (OSError, RuntimeError) as e:
        errors.append(str(e))
    for file, inode, rdev, acl in saved.get('acls', []):
      # Recovery data is root-owned, but still restrict writes to device nodes.
      if not file.startswith(('/dev/input/event', '/dev/dri/card')):
        continue
      try:
        st = os.stat(file)
      except FileNotFoundError:
        continue
      except OSError as e:
        pending.append((file, inode, rdev, acl))
        errors.append(f'ACL identity check failed for {file}: {e}')
        continue
      try:
        if st.st_ino == inode and st.st_rdev == rdev:
          # The root-owned journal and unchanged inode/rdev identify this grant.
          # Unrelated sysfs discovery failures must not prevent its revocation.
          subprocess.run(['/usr/bin/setfacl', '--set-file=-', file], input=acl + '\n', text=True, check=True, timeout=3)
      except (OSError, subprocess.SubprocessError) as e:
        pending.append((file, inode, rdev, acl))
        errors.append(f'ACL restoration failed for {file}: {e}')
    saved['acls'] = pending
    save_journal(saved)
    if profile == 't2':
      try:
        mode(usb_device(), saved['original'] if saved['original'] in [1, 2] else 1)
        light = backlight()
        if saved.get('brightness') is not None:
          if not light:
            raise RuntimeError('Touch Bar backlight unavailable during restoration')
          (light / 'brightness').write_text(str(int(saved['brightness'])))
      except (OSError, RuntimeError) as e:
        errors.append(str(e))
    if errors:
      raise RuntimeError('; '.join(errors))
    RECOVERY.unlink()
  except Exception as e:
    raise RuntimeError(f'Cannot recover interrupted Touch Bar lease: {e}') from e


class Server(socketserver.ThreadingUnixStreamServer):
  daemon_threads = True


def stop(signum, frame):
  global STOPPING
  with LOCK:
    STOPPING = True
  release_for_event('shutdown')
  raise SystemExit(1 if RECOVERY.exists() else 0)


def main():
  if os.geteuid() != 0:
    raise SystemExit('The device broker must run through its system service')
  os.makedirs(os.path.dirname(SOCKET), mode=0o755, exist_ok=True)
  try:
    os.unlink(SOCKET)
  except FileNotFoundError:
    pass
  recover()
  monitor = SleepMonitor()
  with Server(SOCKET, Handler) as server:
    os.chmod(SOCKET, 0o666)  # Requests are authenticated with SO_PEERCRED + logind.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


if __name__ == '__main__':
  if sys.argv[1:] == ['--check-model']:
    print(hardware_profile()[0])
  elif sys.argv[1:] == ['--check-devices']:
    profile, model = hardware_profile()
    found = nodes(profile, model)
    if not found['drm'] or not found['touch'] or not backlight(profile):
      raise SystemExit('Verified Touch Bar display, touch and backlight devices are required')
  elif sys.argv[1:] == ['--check-idle']:
    profile, model = hardware_profile()
    require_idle(nodes(profile, model)['drm'])
  elif sys.argv[1:] == ['--asahi-udev-devices']:
    for device in asahi_udev_devices():
      print(device)
  elif len(sys.argv) != 1:
    raise SystemExit('Unsupported broker argument')
  else:
    main()

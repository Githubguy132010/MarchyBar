#!/usr/bin/python3
"""MarchyBar's root-owned, device-specific lease broker. No shell evaluation.

The renderer runs as the active local user. This broker only changes the known
Touch Bar USB mode, grants temporary ACLs on identified nodes and sets its light.
Closing a lease revokes access and restores the original firmware configuration.
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
import threading
import time

SOCKET = '/run/marchybar/device.sock'
LOCK = threading.RLock()
LEASE = None
SLEEPING = False
RECOVERY = Path("/run/marchybar/lease.json")


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


def nodes():
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
      try:
        with open('/dev/input/' + p.name, 'rb', buffering=0) as f:
          bits = bytearray(96)
          fcntl.ioctl(f, 0x80604521, bits, True)  # EVIOCGBIT(EV_KEY, 96)
          if bits[30 // 8] & (1 << (30 % 8)):
            keyboard = '/dev/input/' + p.name
      except OSError:
        pass
  return {'drm': drm, 'touch': touch, 'keyboard': keyboard}


def backlight():
  for base in ['/sys/class/backlight', '/sys/class/leds']:
    for p in Path(base).glob('*'):
      if 'appletb' in p.name or 'touchbar' in p.name:
        if (p / 'brightness').exists() and (p / 'max_brightness').exists():
          return p
  return None


class Lease:
  def __init__(self, uid):
    self.uid = uid
    self.acls = []
    self.device = usb_device()
    self.original = int(read(self.device / 'bConfigurationValue') or 1)
    self.light = backlight()
    self.original_brightness = read(self.light / 'brightness') if self.light else None
    self.closed = False
    self.notify = None

  def acquire(self):
    # Refuse to disrupt an existing renderer. The user can stop it deliberately.
    for name in ['tiny-dfr', 'touchbard']:
      r = subprocess.run(['/usr/bin/pgrep', '-x', name], capture_output=True)
      if r.returncode == 0:
        raise RuntimeError(f'{name} is running. Stop it before enabling MarchyBar.')
    if self.original == 2:
      existing = nodes()['drm']
      if existing:
        for fd in glob.glob('/proc/[0-9]*/fd/*'):
          try:
            if os.readlink(fd) == existing:
              raise RuntimeError('Another renderer already has the Touch Bar open')
          except OSError:
            pass
    # Journal before changing mode, so a broker restart can undo an interrupted lease.
    RECOVERY.write_text(json.dumps({'original': self.original, 'brightness': self.original_brightness, 'acls': []}))
    os.chmod(RECOVERY, 0o600)
    mode(self.device, 2)
    for _ in range(40):
      found = nodes()
      if found['drm'] and found['touch']:
        break
      time.sleep(0.1)
    else:
      raise RuntimeError('Custom display/input did not appear; original mode will be restored')
    for key, file in found.items():
      if not file:
        continue
      st = os.stat(file)
      acl = command(['/usr/bin/getfacl', '-cp', file])
      self.acls.append((file, st.st_ino, st.st_rdev, acl))
      RECOVERY.write_text(json.dumps({'original': self.original, 'brightness': self.original_brightness, 'acls': self.acls}))
      command(['/usr/bin/setfacl', '-m', f'u:{self.uid}:{"rw" if key == "drm" else "r"}', file])
    self.light = backlight()
    return found

  def brightness(self, value):
    if type(value) is not int or not 0 <= value <= 255:
      raise ValueError('Brightness must be an integer from 0 to 255')
    self.light = backlight()
    if not self.light:
      raise RuntimeError('Touch Bar backlight unavailable')
    maximum = int(read(self.light / 'max_brightness'))
    (self.light / 'brightness').write_text(str(round(value / 255 * maximum)))

  def close(self):
    if self.closed:
      return
    self.closed = True
    for file, inode, rdev, acl in self.acls:
      try:
        st = os.stat(file)
        if st.st_ino == inode and st.st_rdev == rdev:
          subprocess.run(['/usr/bin/setfacl', '--set-file=-', file], input=acl + '\n', text=True, check=True, timeout=3)
      except (OSError, subprocess.SubprocessError):
        pass
    try:
      mode(self.device, self.original)
      light = backlight()
      if light and self.original_brightness is not None:
        (light / 'brightness').write_text(self.original_brightness)
      RECOVERY.unlink(missing_ok=True)
    except (OSError, RuntimeError) as e:
      print(f'MarchyBar could not restore Touch Bar mode: {e}', flush=True)


class Handler(socketserver.StreamRequestHandler):
  def handle(self):
    global LEASE
    _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    mine = None
    self.write_lock = threading.Lock()
    try:
      self.request.settimeout(120)
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
              self.send({'event': 'inactive'})
            raise PermissionError('Only the active local desktop session can use MarchyBar hardware')
          with LOCK:
            if action == 'acquire':
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
              if mine:
                mine.close()
                LEASE = None
                mine = None
              data = {'restored': True}
            elif action == 'brightness' and mine:
              mine.brightness(msg.get('value'))
              data = {'brightness': msg['value']}
            elif action == 'ping' and mine:
              data = {'alive': True}
            else:
              raise ValueError('Unsupported device operation')
          answer = {'id': ident, 'ok': True, 'data': data}
        except Exception as e:
          answer = {'id': ident, 'ok': False, 'error': str(e)}
        self.send(answer)
    finally:
      with LOCK:
        if mine:
          mine.close()
          if LEASE is mine:
            LEASE = None

  def send(self, message):
    with self.write_lock:
      try:
        self.wfile.write((json.dumps(message) + '\n').encode())
        self.wfile.flush()
      except OSError:
        pass


def release_for_event(event):
  with LOCK:
    lease = LEASE
    if lease and lease.notify:
      lease.notify({'event': event})
  # Let the renderer close DRM and input before resetting USB.
  deadline = time.monotonic() + 3
  while lease and not lease.closed and time.monotonic() < deadline:
    time.sleep(0.025)
  with LOCK:
    if lease and not lease.closed:
      lease.close()


class SleepMonitor:
  def __init__(self):
    from gi.repository import Gio, GLib
    self.Gio, self.GLib = Gio, GLib
    self.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    self.fd = None
    self.inhibit()
    self.bus.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
        'PrepareForSleep', '/org/freedesktop/login1', None, Gio.DBusSignalFlags.NONE, self.sleep)
    self.loop = GLib.MainLoop()
    threading.Thread(target=self.loop.run, daemon=True).start()

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
    global SLEEPING, LEASE
    SLEEPING = parameters.unpack()[0]
    if SLEEPING:
      release_for_event('sleep')
      with LOCK:
        LEASE = None
      if self.fd is not None:
        os.close(self.fd)
        self.fd = None
    else:
      self.inhibit()


def recover():
  if not RECOVERY.exists():
    return
  try:
    saved = json.loads(RECOVERY.read_text())
    for file, inode, rdev, acl in saved.get('acls', []):
      # Recovery data is root-owned, but still restrict writes to device nodes.
      if not file.startswith(('/dev/input/event', '/dev/dri/card')):
        continue
      try:
        st = os.stat(file)
        if st.st_ino == inode and st.st_rdev == rdev:
          subprocess.run(['/usr/bin/setfacl', '--set-file=-', file], input=acl + '\n', text=True, check=True, timeout=3)
      except (OSError, subprocess.SubprocessError):
        pass
    mode(usb_device(), saved['original'] if saved['original'] in [1, 2] else 1)
    light = backlight()
    if light and saved.get('brightness') is not None:
      (light / 'brightness').write_text(str(int(saved['brightness'])))
    RECOVERY.unlink()
  except Exception as e:
    raise RuntimeError(f'Cannot recover interrupted Touch Bar lease: {e}') from e


class Server(socketserver.ThreadingUnixStreamServer):
  daemon_threads = True


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
    def stop(signum, frame):
      release_for_event('shutdown')
      raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


if __name__ == '__main__':
  main()

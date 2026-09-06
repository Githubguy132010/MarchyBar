import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const native = require(process.env.MARCHYBAR_NATIVE_PATH || '../build/Release/drm_backend.node');
export const MODELS = ['MacBookPro15,1', 'MacBookPro15,2', 'MacBookPro15,3', 'MacBookPro15,4', 'MacBookPro16,1', 'MacBookPro16,2', 'MacBookPro16,3', 'MacBookPro16,4'];
const readSysfs = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? null : ''; } };
export function diagnose({ read = readSysfs, exists = fs.existsSync, list = fs.readdirSync } = {}) {
  let model = (read('/sys/devices/virtual/dmi/id/product_name') || '').trim();
  let profile = null;
  const compatible = read('/sys/firmware/devicetree/base/compatible');
  // Only a missing DT property permits DMI fallback, matching the broker.
  if (compatible === null) {
    if (MODELS.includes(model)) profile = 't2';
  } else if (compatible.endsWith('\0') && !/[^\x00-\x7f]/.test(compatible)) {
    const values = compatible.slice(0, -1).split('\0');
    const models = new Map([['apple,j293', 'MacBookPro17,1'], ['apple,j493', 'Mac14,7']]);
    if (models.has(values[0]) && values.filter(value => models.has(value)).length === 1) {
      model = models.get(values[0]); profile = 'asahi';
    }
  }
  const kernel = (read('/proc/sys/kernel/osrelease') || '').trim();
  const broker = exists('/run/marchybar/device.sock');
  let driver = false;
  if (profile === 'asahi') {
    driver = exists('/sys/module/adpdrm');
    // Built-in adp has no module entry. Require a bound device, not just registration.
    if (!driver) {
      try { driver = list('/sys/bus/platform/drivers/adp').some(name => exists(`/sys/bus/platform/drivers/adp/${name}/driver`)); } catch {}
    }
  } else {
    driver = exists(`/usr/lib/modules/${kernel}/kernel/drivers/gpu/drm/tiny/appletbdrm.ko.zst`) || exists('/sys/module/appletbdrm');
  }
  // Recognition is not physical verification. The broker checks display, input and backlight.
  const supported = profile !== null;
  return { model, profile, experimental: profile === 'asahi', kernel, supported, driver, broker, status: !supported ? 'preview-only' : !broker ? 'setup-required' : 'available' };
}

export class Device {
  constructor({ onInput, onFn, onActivity, onDisconnect, onSleep }) { Object.assign(this, { onInput, onFn, onActivity, onDisconnect, onSleep }); this.nextId = 1; this.pending = new Map(); this.closed = true; }
  async open() {
    this.closed = false;
    this.socket = net.createConnection('/run/marchybar/device.sock');
    this.socket.on('error', () => {});
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    let buffer = '';
    this.socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 65536) { this.socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        try {
          const m = JSON.parse(buffer.slice(0, end)), pending = this.pending.get(m.id);
          if (['sleep','shutdown','inactive'].includes(m.event)) this.onSleep?.(m.event);
          if (pending) { this.pending.delete(m.id); clearTimeout(pending.timer); m.ok ? pending.resolve(m.data) : pending.reject(new Error(m.error)); }
        } catch {} buffer = buffer.slice(end + 1);
      }
    });
    this.socket.once('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Device helper disconnected')); } this.pending.clear(); if (!this.closed) this.onDisconnect('Device helper disconnected'); });
    try {
      this.info = await this.request('acquire');
      this.display = new native.DrmDisplay(this.info.drm); this.geometry = this.display.setup();
      this.geometry.softwareEscape = this.geometry.width >= 2170;
      this.touch = new native.TouchReader(this.info.touch);
      const ranges = this.touch.ranges();
      this.touch.start((type, rawX, rawY) => {
        if (this.closed) return;
        if (type < 0) { this.onDisconnect('Touch Bar disconnected'); return; }
        const x = (rawX - ranges.minX) / (ranges.maxX - ranges.minX) * this.geometry.width;
        const y = (rawY - ranges.minY) / (ranges.maxY - ranges.minY) * this.geometry.height;
        // The wake-only gate must see the off state before activity clears it.
        this.onInput(['start', 'move', 'end'][type], x, y); this.onActivity();
      });
      if (this.info.keyboard) {
        this.keyboard = new native.KeyboardReader(this.info.keyboard);
        this.keyboard.start((code, value) => {
          if (this.closed) return;
          if (code < 0) { this.onFn(false); this.onDisconnect('Keyboard disconnected'); return; }
          this.onActivity(); if (code === 464) this.onFn(value !== 0);
        });
      }
      return this.geometry;
    } catch (e) { await this.close(); throw e; }
  }
  request(action, value) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Device helper unavailable'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Device helper timed out')); }, 12000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, action, value }) + '\n');
    });
  }
  render(commands) { this.display?.render(commands); }
  async brightness(value) { return this.request('brightness', Math.round(value)); }
  async close() {
    this.closed = true;
    this.touch?.stop(); this.touch = null; this.keyboard?.stop(); this.keyboard = null;
    this.display?.close(); this.display = null;
    if (this.socket && !this.socket.destroyed) { try { await this.request('release'); } catch {} this.socket.destroy(); }
    this.socket = null;
  }
}

export class Preview {
  constructor(width = 2170, height = 60) { this.display = new native.PreviewDisplay(width, height); this.geometry = this.display.setup(); }
  render(commands) { this.display.render(commands); }
  save(file) { const temp = file + '.tmp.png'; this.display.screenshot(temp); fs.renameSync(temp, file); }
  close() { this.display.close(); }
}

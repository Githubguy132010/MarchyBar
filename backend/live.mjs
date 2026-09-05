import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { clamp } from './model.mjs';
const execute = promisify(execFile);
export async function run(file, args = [], options = {}) {
  const { stdout } = await execute(file, args, { timeout: 3500, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', ...options });
  return stdout.trim();
}
const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const dirs = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

export class LiveData extends EventEmitter {
  constructor() {
    super(); this.data = { app: '', title: '', workspace: 1, workspaces: [], media: {}, volume: null, brightness: null, keyboard: null, battery: null, cpu: null, memory: null };
    this.stopped = false; this.children = new Set(); this.timers = new Set(); this.pending = new Set(); this.editorFocused = false; this.audioSink = '';
  }
  update(patch) { this.data = { ...this.data, ...patch }; this.emit('change', this.data); }
  async job(name, fn) {
    if (this.pending.has(name) || this.stopped) return;
    this.pending.add(name); try { await fn(); } catch {} finally { this.pending.delete(name); }
  }
  every(fn, ms) { const timer = setInterval(fn, ms); this.timers.add(timer); return timer; }
  later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) fn(); }, ms); this.timers.add(timer); return timer; }
  start() {
    this.refreshContext(); this.refreshAudio(); this.refreshBrightness(); this.refreshMedia(); this.metrics(); this.battery(); this.connectHyprland();
    this.watch('pactl', ['subscribe'], line => { if (/sink|server/.test(line)) this.refreshAudio(); });
    this.watch('playerctl', ['--follow', 'metadata', '--format', '{{playerName}}'], () => this.refreshMedia());
    this.every(() => this.metrics(), 2000);
    this.every(() => { this.battery(); this.refreshBrightness(); }, 10000);
    this.every(() => this.refreshMedia(), 5000);
  }
  watch(file, args, callback) {
    if (this.stopped) return;
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] }); this.children.add(child);
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.length > 65536) buffer = ''; let end; while ((end = buffer.indexOf('\n')) >= 0) { callback(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } });
    child.on('error', () => {});
    child.once('close', () => { this.children.delete(child); this.later(() => this.watch(file, args, callback), 5000); });
  }
  connectHyprland() {
    if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || this.stopped) return;
    const socketPath = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE, '.socket2.sock');
    const socket = net.createConnection(socketPath); this.hyprSocket = socket;
    let buffer = '', debounce;
    socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 65536) buffer = '';
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (/^(activewindow|workspace|focusedmon|openwindow|closewindow|movewindow|createworkspace|destroyworkspace)/.test(line)) {
          clearTimeout(debounce); debounce = setTimeout(() => this.refreshContext(), 80);
        }
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(debounce); this.later(() => this.connectHyprland(), 3000); });
  }
  refreshContext() {
    return this.job('context', async () => {
      const [window, workspaces, active] = await Promise.all(['activewindow', 'workspaces', 'activeworkspace'].map(v => run('hyprctl', [v, '-j']).then(JSON.parse)));
      const patch = { workspace: active.id, workspaces: workspaces.filter(w => w.id > 0).sort((a, b) => a.id - b.id).map(w => ({ id: w.id, name: /^\d+$/.test(w.name) ? w.id : w.name, windows: w.windows })) };
      if (!this.editorFocused && !/marchybar/i.test(window.class || '')) { patch.app = window.class || ''; patch.title = window.title || ''; }
      this.update(patch);
    });
  }
  refreshAudio() {
    return this.job('audio', async () => {
      try {
        this.audioSink = await run('omarchy', ['audio', 'output', 'sink']);
        if (!this.audioSink) throw new Error('No output');
        const sinks = JSON.parse(await run('pactl', ['-f', 'json', 'list', 'sinks']));
        const sink = sinks.find(s => s.name === this.audioSink);
        if (!sink) throw new Error('No output');
        const values = Object.values(sink.volume || {}).map(v => parseFloat(v.value_percent)).filter(Number.isFinite);
        this.update({ volume: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, muted: sink.mute });
      } catch { this.audioSink = ''; this.update({ volume: null, muted: false }); }
    });
  }
  refreshBrightness() {
    return this.job('brightness', async () => {
      let brightness = null; try { brightness = parseFloat(await run('omarchy', ['brightness', 'display'])); } catch {}
      this.keyboardDevice = dirs('/sys/class/leds').find(n => n.includes('kbd_backlight'));
      const base = this.keyboardDevice ? '/sys/class/leds/' + this.keyboardDevice : '';
      const current = Number(read(base + '/brightness')), max = Number(read(base + '/max_brightness'));
      this.update({ brightness: Number.isFinite(brightness) ? brightness : null, keyboard: max > 0 ? current / max * 100 : null });
    });
  }
  refreshMedia() {
    return this.job('media', async () => {
      try {
        const player = (await run('playerctl', ['--list-all'])).split('\n')[0];
        const [status, title, artist, length, position] = await Promise.all([
          ['status'], ['metadata', 'xesam:title'], ['metadata', 'xesam:artist'], ['metadata', 'mpris:length'], ['position'],
        ].map(args => run('playerctl', ['--player', player, ...args]).catch(() => '')));
        this.update({ media: { player, status, title, artist, length: Number(length) / 1e6, position: Number(position) || 0, updatedAt: Date.now() } });
      } catch { this.update({ media: {} }); }
    });
  }
  metrics() {
    const fields = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const total = fields.slice(0, 8).reduce((a, b) => a + b, 0), idle = fields[3] + (fields[4] || 0);
    const cpu = this.lastCPU && total > this.lastCPU.total ? 100 * (1 - (idle - this.lastCPU.idle) / (total - this.lastCPU.total)) : 0;
    this.lastCPU = { total, idle };
    const mem = Object.fromEntries(read('/proc/meminfo').split('\n').map(l => { const m = l.match(/^(\w+):\s*(\d+)/); return m ? [m[1], Number(m[2])] : ['', 0]; }));
    const lid = dirs('/proc/acpi/button/lid').map(n => read('/proc/acpi/button/lid/' + n + '/state')).join(' ');
    this.update({ lidClosed: /closed/i.test(lid), cpu: clamp(cpu, 0, 100), memory: mem.MemTotal ? 100 * (1 - mem.MemAvailable / mem.MemTotal) : null });
  }
  battery() {
    const name = dirs('/sys/class/power_supply').find(n => read(`/sys/class/power_supply/${n}/type`) === 'Battery');
    const base = `/sys/class/power_supply/${name}`;
    this.update({ battery: name ? Number(read(base + '/capacity')) : null, charging: name ? read(base + '/status') === 'Charging' : false });
  }
  stop() { this.stopped = true; for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers.clear(); this.hyprSocket?.destroy(); for (const c of this.children) c.kill(); this.children.clear(); }
}

export class Actions {
  constructor({ live, onPreset, onPage, onEditor, onTouchbar, isLocked, isPreview, onError = () => {} }) { Object.assign(this, { live, onPreset, onPage, onEditor, onTouchbar, isLocked, isPreview, onError }); this.channels = new Map(); }
  async invoke(action) {
    if (this.isLocked()) return;
    try {
      if (action.type === 'preset') return this.onPreset(action.preset);
      if (action.type === 'page') return this.onPage(action.page);
      if (action.type === 'editor') return this.onEditor();
      if (this.isPreview()) return;
      switch (action.type) {
        case 'key': {
          const args = [];
          for (const m of action.modifiers) args.push('-M', m);
          args.push('-k', action.key);
          for (const m of [...action.modifiers].reverse()) args.push('-m', m);
          await run('wtype', args); break;
        }
        case 'media': await run('playerctl', [...(this.live.data.media.player ? ['--player', this.live.data.media.player] : []), action.command]); this.live.refreshMedia(); break;
        case 'workspace': await run('hyprctl', ['dispatch', `hl.dsp.focus({ workspace = "${action.workspace}" })`]); break;
        case 'launch': {
          const roots = [path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications'), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').map(p => path.join(p, 'applications'))];
          const file = roots.map(p => path.join(p, action.desktop)).find(p => fs.existsSync(p));
          if (!file) throw new Error('Application is not installed');
          await run('gio', ['launch', file]); break;
        }
        case 'command': await run(action.argv[0], action.argv.slice(1), { timeout: 30000 }); break;
      }
    } catch (e) { this.onError(e.message); }
  }
  slider(channel, value, final = false) {
    if (this.isLocked() || this.isPreview()) return;
    // Serialize each output; retain the latest requested value while an earlier write runs.
    const state = this.channels.get(channel) || { running: false, pending: null };
    state.pending = { value: clamp(value, 0, 100), final }; this.channels.set(channel, state);
    if (!state.running) this.flush(channel, state);
  }
  async flush(channel, state) {
    state.running = true;
    while (state.pending) {
      const { value, final } = state.pending; state.pending = null;
      if (this.isLocked()) break;
      try {
        switch (channel) {
          case 'volume':
            if (!this.live.audioSink) throw new Error('No audio output');
            await run('pactl', ['set-sink-volume', this.live.audioSink, `${Math.round(value)}%`]);
            this.live.update({ volume: value }); if (final) this.live.refreshAudio(); break;
          case 'brightness': await run('omarchy', ['brightness', 'display', '--no-osd', `${Math.max(1, Math.round(value))}%`]); this.live.update({ brightness: value }); break;
          case 'keyboard': if (this.live.keyboardDevice) { await run('brightnessctl', ['-d', this.live.keyboardDevice, 'set', `${Math.round(value)}%`]); this.live.update({ keyboard: value }); } break;
          case 'touchbar': await this.onTouchbar(value, final); break;
          case 'seek': {
            const m = this.live.data.media;
            if (m.player && m.length > 0) { await run('playerctl', ['--player', m.player, 'position', String(m.length * value / 100)]); this.live.update({ media: { ...m, position: m.length * value / 100 } }); }
            break;
          }
        }
      } catch (e) { this.onError(e.message); }
      if (state.pending) await new Promise(r => setTimeout(r, 30));
    }
    state.running = false;
  }
}

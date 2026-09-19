import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { Store, atomicWrite } from './store.mjs';
import { PROTOCOL_VERSION, TYPES, CHANNELS, validatePreset, selectPreset, DEFAULT_THEME, clamp } from './model.mjs';
import { scene, normalizeTheme, Gesture } from './scene.mjs';
import { LiveData, Actions, run } from './live.mjs';
import { Device, Preview, diagnose } from './hardware.mjs';
import { VERSION } from './version.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_SOCKET = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'marchybar', 'control.sock');

export class MarchyBar {
  constructor({ socketPath = DEFAULT_SOCKET, previewOnly = false, configDir, stateDir, live = true } = {}) {
    this.socketPath = socketPath; this.previewOnly = previewOnly; this.liveEnabled = live;
    this.store = new Store({ root: ROOT, configDir, stateDir });
    this.live = new LiveData(); this.theme = DEFAULT_THEME; this.clients = new Set(); this.sequence = 0;
    this.geometry = { width: this.store.settings.previewWidth, height: 60 };
    this.previewDisplay = new Preview(this.geometry.width, this.geometry.height);
    this.runtimeDir = path.dirname(socketPath); fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.previewPath = path.join(this.runtimeDir, 'preview.png');
    this.hardware = diagnose(); this.status = previewOnly ? 'preview' : this.hardware.status;
    this.error = ''; this.lastHeartbeat = 0; this.locked = !previewOnly; this.manualPage = null; this.fn = false; this.trial = null; this.sceneRevision = 0;
    this.actions = new Actions({ live: this.live, isLocked: () => this.locked, isPreview: () => !this.device,
      onPreset: id => this.applyPreset(id), onPage: id => this.handle({ method: 'page', params: { id } }),
      onEditor: () => this.broadcast({ event: 'openEditor' }), onTouchbar: (value, final) => this.setBrightness(value, final), onError: error => this.fail(error) });
    this.gesture = new Gesture({ action: a => this.actions.invoke(a), slider: (...args) => this.actions.slider(...args), changed: () => this.draw(), released: () => this.refresh() });
    this.live.on('change', () => this.refresh());
  }
  fail(error) { this.error = String(error).slice(0, 2000); this.broadcastState(); }
  get active() {
    const selection = selectPreset({ ...this.store.snapshot(), context: this.live.data, locked: this.locked });
    const preset = this.locked ? this.store.bundled.find(p => p.id === 'classic') : this.trial ? this.trial.preset : this.store.get(selection.id);
    let page = this.fn && preset.fnPage ? preset.fnPage : (this.trial && !this.locked ? this.trial.page : this.manualPage) || preset.defaultPage;
    if (!preset.pages.some(p => p.id === page)) page = preset.defaultPage;
    return { ...selection, id: preset.id, preset, page, reason: this.trial && !this.locked ? 'Trying changes · revert automatically' : selection.reason };
  }
  data() {
    if (this.locked) return { app: '', title: '', volume: this.live.data.volume, brightness: this.live.data.brightness, keyboard: this.live.data.keyboard, battery: this.live.data.battery, touchbar: (this.currentBrightness ?? this.store.settings.brightness) / 255 * 100 };
    return { ...this.live.data, touchbar: (this.currentBrightness ?? this.store.settings.brightness) / 255 * 100 };
  }
  snapshot() {
    const a = this.active;
    return { protocolVersion: PROTOCOL_VERSION, ...this.store.snapshot(), status: this.status, hardware: this.hardware,
      activePreset: a.id, activePage: a.page, reason: a.reason, geometry: this.geometry, locked: this.locked,
      data: this.data(), error: this.error, trialEnds: this.trial?.ends || null, frame: this.sequence,
      previewPath: this.previewPath, widgetTypes: TYPES, channels: CHANNELS, theme: this.theme };
  }
  send(client, message) { if (!client.destroyed && client.writableLength < 2 * 1024 * 1024) client.write(JSON.stringify(message) + '\n'); }
  broadcast(message) { for (const c of this.clients) this.send(c, message); }
  broadcastState() { this.broadcast({ event: 'state', state: this.snapshot() }); }
  refresh() {
    if (this.stopping) return;
    if (this.gesture.capture && !this.locked) { this.draw(); return; }
    // Track the underlying selection, not the temporary trial preset.
    const a = selectPreset({ ...this.store.snapshot(), context: this.live.data, locked: this.locked });
    if (this.currentPreset !== a.id) { this.manualPage = null; this.currentPreset = a.id; }
    this.draw(); this.broadcastState();
  }
  draw() {
    if (this.drawing) return;
    this.drawing = true;
    try {
      const a = this.active;
      // Preserve the exact scene and hit map for the duration of a touch.
      const p = this.gesture?.capture && this.currentScenePreset ? this.currentScenePreset : a.preset;
      const page = this.gesture?.capture && this.currentScenePage ? this.currentScenePage : a.page;
      const s = scene(p, page, this.geometry, this.data(), this.theme, this.gesture?.capture || {});
      if (!this.gesture?.capture) { this.currentScenePreset = structuredClone(p); this.currentScenePage = page; this.sceneRevision++; }
      this.currentScene = s;
      const signature = JSON.stringify(s.commands);
      if (signature !== this.lastFrame) {
        this.lastFrame = signature;
        if (!this.off) this.device?.render(s.commands);
        if (!this.previewDraft) { this.previewDisplay.render(s.commands); this.savePreview(); }
      }
    } catch (e) { this.error = e.message; }
    finally { this.drawing = false; }
  }
  savePreview() {
    if (this.previewTimer) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      try { this.previewDisplay.save(this.previewPath); this.sequence++; this.broadcast({ event: 'frame', frame: this.sequence, previewPath: this.previewPath }); }
      catch (e) { this.fail(e.message); }
    }, 75);
  }
  renderPreview(preset, page, width) {
    const p = this.locked ? this.store.bundled.find(p => p.id === 'classic') : validatePreset(preset), geometry = { width: width || this.geometry.width, height: 60 };
    const s = scene(p, page || p.defaultPage, geometry, this.data(), this.theme);
    if (this.previewDisplay.geometry.width !== geometry.width) { this.previewDisplay.close(); this.previewDisplay = new Preview(geometry.width, 60); }
    this.previewDraft = { preset: p, page: s.page, geometry };
    this.previewDisplay.render(s.commands); this.savePreview();
    return { boxes: s.boxes, geometry, previewPath: this.previewPath };
  }
  applyPreset(id) {
    this.store.get(id); this.revertTrial(); this.manualPage = null;
    this.store.saveSettings({ pinnedPreset: id }, this.store.revision); this.error = ''; this.refresh();
    this.store.lastGood(this.store.get(id));
  }
  revertTrial() { clearTimeout(this.trialTimer); this.trialTimer = null; this.trial = null; }
  input(phase, x, y) {
    if (this.off && phase === 'start') { this.wakeOnly = true; this.setIdle(false, false); }
    if (this.wakeOnly) { if (phase === 'end' || phase === 'cancel') this.wakeOnly = false; return; }
    this.gesture.input(phase, x, y, this.currentScene?.targets || [], this.sceneRevision, this.locked);
  }
  async enableHardware() {
    if (this.enabling) return this.enabling;
    this.enabling = this.openHardware();
    try { return await this.enabling; } finally { this.enabling = null; }
  }
  async openHardware() {
    if (this.previewOnly) throw new Error('This instance is in preview-only mode');
    if (this.device) return;
    this.hardware = diagnose();
    if (!this.hardware.supported) throw new Error('This is not a recognized Touch Bar model. Preview is available.');
    if (this.hardware.profile === 't2' && !this.hardware.t2Kernel) throw new Error(this.hardware.kernelNote || 'Boot the linux-t2 kernel to use the Touch Bar. Omarchy 4.0.4 keeps T2 Macs on linux-t2.');
    if (this.locked) { this.store.saveSettings({ hardwareEnabled: true }, this.store.revision); this.status = 'locked'; this.refresh(); return; }
    if (!this.hardware.broker) throw new Error('Run MarchyBar setup to install the device helper');
    this.status = 'starting'; this.broadcastState();
    const device = new Device({ onInput: (...args) => this.input(...args), onFn: value => { this.fn = value; this.refresh(); }, onActivity: () => this.setIdle(false, false), onSleep: event => { this.disableHardware(false).then(() => { this.status = 'recovering'; this.retryAt = Date.now() + 10000; this.broadcastState(); }); }, onDisconnect: error => { this.disableHardware(false).then(() => { this.status = 'recovering'; this.fail(error); }); } });
    try {
      this.geometry = await device.open(); this.device = device;
      this.previewDisplay.close(); this.previewDisplay = new Preview(this.geometry.width, this.geometry.height);
      await device.brightness(this.store.settings.brightness);
      this.store.saveSettings({ hardwareEnabled: true }, this.store.revision);
      this.status = 'ready'; this.error = ''; this.lastFrame = null; this.refresh();
    } catch (e) {
      if (this.device === device) this.device = null;
      this.gesture.cancel(); this.fn = false; this.wakeOnly = false;
      await device.close();
      this.status = this.store.settings.hardwareEnabled ? 'recovering' : 'error'; this.retryAt = Date.now() + 10000; this.fail(e.message); throw e;
    }
  }
  async disableHardware(persist = true) {
    if (this.enabling) { try { await this.enabling; } catch {} }
    this.gesture.cancel(); this.fn = false; this.wakeOnly = false;
    const d = this.device; this.device = null;
    if (d) await d.close();
    if (persist) this.store.saveSettings({ hardwareEnabled: false }, this.store.revision);
    this.status = this.previewOnly ? 'preview' : 'disabled'; this.refresh();
  }
  async setBrightness(value, final = true) {
    const brightness = Math.round(clamp(value, 0, 100) / 100 * 255);
    await this.device?.brightness(brightness);
    this.currentBrightness = brightness;
    if (final) this.store.saveSettings({ brightness }, this.store.revision); this.refresh();
  }
  async setIdle(dimmed, off) {
    off = off || this.live.data.lidClosed === true;
    if (this.dimmed === dimmed && this.off === off) return;
    this.dimmed = dimmed; this.off = off;
    if (this.device) {
      try { await this.device.brightness(off ? 0 : dimmed ? Math.round(this.store.settings.brightness * 0.16) : this.store.settings.brightness); }
      catch (e) { this.fail(e.message); }
      if (!off) { this.lastFrame = null; this.draw(); }
    }
  }
  async handle(msg, client) {
    const params = msg.params || {}, revision = msg.revision;
    switch (msg.method) {
      case 'hello': if (params.protocolVersion !== PROTOCOL_VERSION) throw new Error('Incompatible MarchyBar protocol version'); return this.snapshot();
      case 'get': return this.snapshot();
      case 'editor.present': {
        const windows = JSON.parse(await run('hyprctl', ['clients', '-j']));
        const w = windows.find(w => w.title === 'MarchyBar' && w.class === 'org.quickshell');
        if (!w || !/^0x[0-9a-f]+$/i.test(w.address)) return false;
        const monitors = JSON.parse(await run('hyprctl', ['monitors', '-j']));
        const m = monitors.find(m => m.id === w.monitor) || monitors.find(m => m.focused);
        if (!m) return false;
        const mw = m.width / m.scale, mh = m.height / m.scale;
        const width = Math.round(Math.min(1180, mw - 48)), height = Math.round(Math.min(800, mh - 80));
        const selector = `address:${w.address}`;
        for (const command of [
          `hl.dsp.window.float({ action = "set", window = "${selector}" })`,
          `hl.dsp.window.resize({ x = ${width}, y = ${height}, relative = false, window = "${selector}" })`,
          `hl.dsp.window.move({ x = ${Math.round(m.x + (mw-width)/2)}, y = ${Math.round(m.y + (mh-height)/2)}, relative = false, window = "${selector}" })`,
        ]) await run('hyprctl', ['dispatch', command]);
        return true;
      }
      case 'preset.save': { this.validateFit(params.preset); const p = this.store.save(params.preset, revision); this.previewDraft = null; this.refresh(); return p; }
      case 'preset.create': { const p = this.store.create(params.name || 'Untitled preset', params.from, revision); this.refresh(); return p; }
      case 'preset.delete': try { this.store.delete(params.id, params.replacement, revision); return true; } finally { this.refresh(); }
      case 'preset.restore': this.store.restore(params.id, revision); this.refresh(); return true;
      case 'preset.import': { this.validateFit(params.preset); const p = this.store.import(params.preset, revision); this.refresh(); return p; }
      case 'file.import': {
        if (typeof params.path !== 'string' || !path.isAbsolute(params.path)) throw new Error('Choose a local preset file');
        const st = fs.lstatSync(params.path); if (!st.isFile() || st.size > 1024 * 1024) throw new Error('Choose a regular preset JSON file under 1 MB');
        const document = JSON.parse(fs.readFileSync(params.path, 'utf8')); this.validateFit(document);
        const p = this.store.import(document, revision); this.refresh(); return p;
      }
      case 'file.export': {
        if (typeof params.path !== 'string' || !path.isAbsolute(params.path)) throw new Error('Choose a local destination');
        const p = this.store.get(params.id); delete p.bundled; delete p.customized; atomicWrite(params.path, p); return true;
      }
      case 'preset.export': { const p = this.store.get(params.id); delete p.bundled; delete p.customized; return p; }
      case 'preset.apply': this.applyPreset(params.id); return true;
      case 'rules.save': this.store.saveRules(params.rules, revision); this.refresh(); return true;
      case 'settings.save': this.store.saveSettings(params.settings, revision); this.currentBrightness = this.store.settings.brightness; if (this.device) await this.device.brightness(this.off ? 0 : this.dimmed ? Math.round(this.currentBrightness * .16) : this.currentBrightness); this.refresh(); return true;
      case 'automatic': this.store.saveSettings({ automatic: true, pinnedPreset: null }, this.store.revision); this.revertTrial(); this.refresh(); return true;
      case 'preview': return this.renderPreview(params.preset, params.page, params.width);
      case 'preview.close': this.previewDraft = null; if (this.previewDisplay.geometry.width !== this.geometry.width) { this.previewDisplay.close(); this.previewDisplay = new Preview(this.geometry.width, 60); } this.lastFrame = null; this.draw(); return true;
      case 'try': {
        const p = validatePreset(params.preset); scene(p, params.page || p.defaultPage, this.geometry, this.data(), this.theme);
        this.revertTrial(); this.trial = { preset: p, page: params.page || p.defaultPage, ends: Date.now() + 20000 };
        this.trialTimer = setTimeout(() => { this.revertTrial(); this.refresh(); }, 20000); this.refresh(); return true;
      }
      case 'revert': this.revertTrial(); this.refresh(); return true;
      case 'page': if (this.trial && !this.locked) this.trial.page = params.id; else this.manualPage = params.id; this.refresh(); return true;
      case 'theme': this.theme = normalizeTheme(params); this.lastFrame = null; this.refresh(); if (this.previewDraft) this.renderPreview(this.previewDraft.preset, this.previewDraft.page, this.previewDraft.geometry.width); return true;
      case 'heartbeat': {
        this.lastHeartbeat = Date.now(); const locked = params.locked !== false;
        if (locked !== this.locked) {
          this.locked = locked; this.gesture.cancel(); this.revertTrial(); this.previewDraft = null; this.lastFrame = null;
          if (locked && this.device) { await this.disableHardware(false); this.status = 'locked'; }
          else if (!locked && this.store.settings.hardwareEnabled && !this.previewOnly) await this.enableHardware();
          this.refresh();
        }
        this.live.editorFocused = params.editorOpen === true;
        if (typeof params.dimmed === 'boolean' && typeof params.off === 'boolean') this.setIdle(params.dimmed, params.off);
        return true;
      }
      case 'hardware.enable': await this.enableHardware(); return true;
      case 'hardware.disable': await this.disableHardware(); return true;
      case 'diagnostics': return { ...diagnose(), node: process.version, protocol: PROTOCOL_VERSION, backend: VERSION, geometry: this.geometry, status: this.status, errors: this.store.errors, error: this.error };
      case 'simulate': {
        if (!this.previewOnly) throw new Error('Simulation is available only in a preview-only instance');
        if (params.data) this.live.update(params.data);
        if (typeof params.locked === 'boolean') this.locked = params.locked;
        if (params.input) this.input(params.input.phase, params.input.x, params.input.y);
        this.refresh(); return true;
      }
      case 'shutdown': setTimeout(() => this.stop(), 50); return true;
      default: throw new Error('Unknown MarchyBar request');
    }
  }
  validateFit(preset) {
    const p = validatePreset(preset);
    for (const width of [2008, 2170]) for (const page of p.pages) scene(p, page.id, { width, height: 60 }, {}, this.theme);
    return p;
  }
  async start() {
    const existing = fs.lstatSync(this.socketPath, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket()) throw new Error('Refusing a non-socket or symbolic-link socket path');
      const alive = await new Promise((resolve, reject) => {
        const s = net.createConnection(this.socketPath);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', error => { if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
      });
      if (alive) throw new Error('MarchyBar is already running');
      const current = fs.lstatSync(this.socketPath, { throwIfNoEntry: false });
      if (!current?.isSocket() || current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('Socket path changed during probing');
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer(client => {
      this.clients.add(client); this.send(client, { event: 'state', state: this.snapshot() });
      const decoder = new StringDecoder('utf8');
      let buffer = '', bytes = 0, chain = Promise.resolve();
      client.on('error', () => {}); client.once('close', () => this.clients.delete(client));
      client.on('data', chunk => {
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end + 1;
          bytes += stop - start;
          if (bytes > 1024 * 1024) { client.destroy(); return; }
          buffer += decoder.write(chunk.subarray(start, stop)); start = stop;
          if (end < 0) break;
          const raw = buffer.slice(0, -1); buffer = ''; bytes = 0;
          chain = chain.then(async () => {
            let msg;
            try { msg = JSON.parse(raw); if (!msg || typeof msg !== 'object' || !Number.isInteger(msg.id)) throw new Error('Invalid request'); const data = await this.handle(msg, client); this.send(client, { id: msg.id, ok: true, data, revision: this.store.revision }); }
            catch (e) { this.send(client, { id: msg?.id ?? null, ok: false, error: e.message, errors: e.errors || [] }); }
          });
        }
      });
    });
    // libuv unlinks its bind path on close, even if that path was replaced.
    // A directory fd keeps the bind path short and safe after removing its names.
    this.socketDir = fs.mkdtempSync(path.join(this.runtimeDir, '.socket-'));
    try {
      this.socketDirFd = fs.openSync(this.socketDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const boundPath = `/proc/self/fd/${this.socketDirFd}/s`;
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(boundPath, resolve); });
      fs.chmodSync(boundPath, 0o600);
      this.socketStat = fs.lstatSync(boundPath);
      fs.linkSync(boundPath, this.socketPath);
      fs.unlinkSync(boundPath);
      fs.rmdirSync(this.socketDir);
    } catch (error) { await this.stop(); throw error; }
    if (this.liveEnabled) this.live.start();
    this.refresh();
    this.safetyTimer = setInterval(() => {
      if (!this.previewOnly && Date.now() - this.lastHeartbeat > 7000 && !this.locked) { this.locked = true; this.gesture.cancel(); this.previewDraft = null; this.disableHardware(false).then(() => { this.status = 'locked'; this.refresh(); }); }
      if (this.device) this.device.request('ping').catch(e => this.fail(e.message));
      else if (this.store.settings.hardwareEnabled && !this.previewOnly && this.status === 'recovering' && Date.now() > (this.retryAt || 0) && !this.suspended && !this.locked) this.enableHardware().catch(() => {});
    }, 5000);
    if (this.store.settings.hardwareEnabled && !this.previewOnly) this.enableHardware().catch(() => {});
    return this;
  }
  async stop() {
    if (this.stopping) return; this.stopping = true;
    clearInterval(this.safetyTimer); clearTimeout(this.trialTimer); clearTimeout(this.previewTimer);
    this.live.stop(); await this.disableHardware(false); this.gesture.cancel();
    clearTimeout(this.previewTimer); this.previewDisplay.close();
    for (const c of this.clients) c.destroy();
    await new Promise(resolve => this.server?.close(resolve) || resolve());
    // Keep the fd until libuv finishes unlinking, so it cannot target a reused fd.
    if (this.socketDirFd !== undefined) { fs.closeSync(this.socketDirFd); this.socketDirFd = undefined; }
    try {
      const current = fs.lstatSync(this.socketPath);
      if (current.isSocket() && current.dev === this.socketStat?.dev && current.ino === this.socketStat?.ino) fs.unlinkSync(this.socketPath);
    } catch {}
    if (this.socketDir) { try { fs.rmdirSync(this.socketDir); } catch {} }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const get = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  const app = new MarchyBar({ socketPath: get('--socket'), configDir: get('--config'), stateDir: get('--state'), previewOnly: process.argv.includes('--preview'), live: !process.argv.includes('--no-live') });
  app.start().then(() => console.error(`MarchyBar ready: ${app.socketPath}`)).catch(e => { console.error(e.message); process.exitCode = 1; app.previewDisplay.close(); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}

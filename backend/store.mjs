import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { clone, validId, validatePreset, validateRules, validateSettings, DEFAULT_RULES, DEFAULT_SETTINGS, ValidationError } from './model.mjs';

export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing to replace a symbolic link');
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function readJSON(file) { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symbolic links are not preset files'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
const actions = preset => preset.pages.flatMap(p => p.widgets.flatMap(w => [w.action, w.holdAction].filter(Boolean)));
const redirect = (preset, from, to) => { for (const action of actions(preset)) if (action.type === 'preset' && action.preset === from) action.preset = to; return preset; };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export class Store {
  constructor({ root, configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'marchybar'), stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'marchybar') }) {
    this.root = root; this.configDir = configDir; this.stateDir = stateDir;
    this.presetDir = path.join(configDir, 'presets');
    fs.mkdirSync(this.presetDir, { recursive: true, mode: 0o700 });
    this.errors = [];
    this.bundled = fs.readdirSync(path.join(root, 'presets')).filter(f => f.endsWith('.json')).map(f => validatePreset(readJSON(path.join(root, 'presets', f))));
    this.load();
  }
  load() {
    this.errors = []; this.presets = this.bundled.map(p => ({ ...clone(p), bundled: true, customized: false }));
    for (const f of fs.readdirSync(this.presetDir).filter(f => f.endsWith('.json'))) {
      try {
        const p = validatePreset(readJSON(path.join(this.presetDir, f)));
        if (f !== p.id + '.json') throw new Error('Filename does not match preset ID');
        const index = this.presets.findIndex(b => b.id === p.id);
        const entry = { ...p, bundled: index >= 0, customized: index >= 0 };
        if (index >= 0) this.presets[index] = entry; else this.presets.push(entry);
      } catch (e) { this.errors.push(`${f}: ${e.message}`); }
    }
    const settingsFile = path.join(this.configDir, 'settings.json'), rulesFile = path.join(this.configDir, 'rules.json');
    try { this.settings = validateSettings(fs.existsSync(settingsFile) ? readJSON(settingsFile) : DEFAULT_SETTINGS, this.presets); }
    catch (e) { this.settings = clone(DEFAULT_SETTINGS); this.errors.push(`settings.json: ${e.message}`); }
    try { this.rules = validateRules(fs.existsSync(rulesFile) ? readJSON(rulesFile) : DEFAULT_RULES, this.presets); }
    catch (e) { this.rules = clone(DEFAULT_RULES); this.errors.push(`rules.json: ${e.message}`); }
    this.revision = digest({ presets: this.presets, settings: this.settings, rules: this.rules });
  }
  snapshot() { return { presets: clone(this.presets), settings: clone(this.settings), rules: clone(this.rules), errors: [...this.errors], revision: this.revision }; }
  checkRevision(revision) { if (revision !== this.revision) throw new Error('Your editor is out of date. Reload the latest version before saving.'); }
  get(id) { const p = this.presets.find(p => p.id === id); if (!p) throw new Error('Preset not found'); return clone(p); }
  save(preset, revision) {
    this.checkRevision(revision); const p = validatePreset(preset);
    delete p.bundled; delete p.customized;
    for (const action of actions(p)) if (action.type === 'preset' && action.preset !== p.id && !this.presets.some(v => v.id === action.preset)) throw new Error('Button references a missing preset: ' + action.preset);
    atomicWrite(path.join(this.presetDir, p.id + '.json'), p); this.load(); return this.get(p.id);
  }
  create(name, from, revision) {
    this.checkRevision(revision);
    const id = crypto.randomUUID();
    const p = from ? this.get(from) : { schemaVersion: 1, pages: [{ id: 'main', name: 'Main', widgets: [{ id: crypto.randomUUID(), type: 'clock', weight: 1, label: 'Clock' }] }], defaultPage: 'main', fnPage: null };
    return this.save({ ...redirect(p, p.id, id), id, name, description: from ? `Based on ${p.name}` : '' }, revision);
  }
  delete(id, replacement, revision) {
    this.checkRevision(revision); const p = this.get(id);
    if (p.bundled) throw new Error('Bundled presets can be restored, not deleted');
    const linked = this.presets.filter(other => other.id !== id && actions(other).some(a => a.type === 'preset' && a.preset === id));
    const refs = linked.length > 0 || this.rules.some(r => r.preset === id) || this.settings.defaultPreset === id || this.settings.pinnedPreset === id;
    if (refs && (!replacement || replacement === id)) throw new Error('Choose a replacement for the app rules and settings using this preset');
    if (replacement) this.get(replacement);
    // Redirect references before removing their target. Each intermediate state is valid.
    if (refs) {
      this.rules = this.rules.map(r => r.preset === id ? { ...r, preset: replacement } : r);
      this.settings = { ...this.settings, defaultPreset: this.settings.defaultPreset === id ? replacement : this.settings.defaultPreset, pinnedPreset: this.settings.pinnedPreset === id ? replacement : this.settings.pinnedPreset };
      atomicWrite(path.join(this.configDir, 'rules.json'), this.rules);
      atomicWrite(path.join(this.configDir, 'settings.json'), this.settings);
    }
    for (const other of linked) {
      const updated = redirect(clone(other), id, replacement); delete updated.bundled; delete updated.customized;
      atomicWrite(path.join(this.presetDir, other.id + '.json'), updated);
    }
    fs.unlinkSync(path.join(this.presetDir, id + '.json')); this.load();
  }
  restore(id, revision) {
    this.checkRevision(revision); if (!this.bundled.some(p => p.id === id)) throw new Error('Only bundled presets have a factory version');
    const f = path.join(this.presetDir, id + '.json'); if (fs.existsSync(f)) fs.unlinkSync(f); this.load();
  }
  saveRules(rules, revision) { this.checkRevision(revision); atomicWrite(path.join(this.configDir, 'rules.json'), validateRules(rules, this.presets)); this.load(); }
  saveSettings(settings, revision) { this.checkRevision(revision); atomicWrite(path.join(this.configDir, 'settings.json'), validateSettings({ ...this.settings, ...settings }, this.presets)); this.load(); }
  export(id, file) { const p = this.get(id); delete p.bundled; delete p.customized; atomicWrite(file, p); }
  import(document, revision) {
    const p = validatePreset(document);
    if (this.presets.some(v => v.id === p.id)) { const previous = p.id; p.id = crypto.randomUUID(); redirect(p, previous, p.id); p.name = p.name.slice(0, 69) + ' (imported)'; }
    return this.save(p, revision);
  }
  lastGood(preset) { atomicWrite(path.join(this.stateDir, 'last-good.json'), validatePreset(preset)); }
}

// MarchyBar's data contract. Shared by the daemon, CLI, import validation and tests.
export const SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const TYPES = ['button', 'slider', 'media', 'workspaces', 'clock', 'battery', 'cpu', 'memory', 'app', 'spacer'];
export const CHANNELS = ['volume', 'brightness', 'keyboard', 'touchbar', 'seek'];
export const DEFAULT_THEME = {
  background: '#1a1b26', foreground: '#c0caf5', muted: '#565f89', accent: '#7aa2f7',
  selected: '#292e42', urgent: '#f7768e', fontFamily: 'monospace', radius: 0,
};
export const DEFAULT_SETTINGS = {
  schemaVersion: 1, defaultPreset: 'everyday', pinnedPreset: null, automatic: true,
  hardwareEnabled: false, brightness: 128, dimAfter: 30, offAfter: 60, previewWidth: 2170, previewHeight: 60,
};
export const DEFAULT_RULES = [
  { id: 'browser', name: 'Web browsers', enabled: true, app: '*chrom*|*firefox*|*brave*|*zen*', title: '', preset: 'browser' },
  { id: 'editor', name: 'Code editors', enabled: true, app: '*code*|*zed*|*jetbrains*', title: '', preset: 'developer' },
  { id: 'terminal', name: 'Terminals', enabled: true, app: '*ghostty*|*Alacritty*|*kitty*|*foot*', title: '', preset: 'developer' },
  { id: 'music', name: 'Music players', enabled: true, app: '*spotify*|*vlc*|*mpv*|*vibez*', title: '', preset: 'media' },
];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export function validId(value) { return typeof value === 'string' && ID.test(value) && !value.includes('..'); }
export function clone(value) { return structuredClone(value); }
export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
export class ValidationError extends Error {
  constructor(errors) { super(errors.join('\n')); this.name = 'ValidationError'; this.errors = errors; }
}
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 160) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const finite = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validateAction(a, path = 'action') {
  if (!plain(a)) return [`${path}: choose an action`];
  switch (a.type) {
    case 'key': return text(a.key, 60) && /^[A-Za-z0-9_+ -]+$/.test(a.key) && Array.isArray(a.modifiers) && a.modifiers.length <= 4 && a.modifiers.every(m => ['ctrl', 'alt', 'shift', 'logo'].includes(m)) ? [] : [`${path}: invalid key or modifiers`];
    case 'media': return ['play-pause', 'next', 'previous', 'stop'].includes(a.command) ? [] : [`${path}: invalid media command`];
    case 'workspace': return Number.isInteger(a.workspace) && a.workspace >= 1 && a.workspace <= 99 ? [] : [`${path}: workspace must be 1–99`];
    case 'launch': return text(a.desktop, 200) && /^[A-Za-z0-9._-]+\.desktop$/.test(a.desktop) ? [] : [`${path}: choose a .desktop application ID`];
    case 'command': return Array.isArray(a.argv) && a.argv.length > 0 && a.argv.length <= 32 && a.argv.every(v => text(v, 2048)) && a.argv[0].length > 0 ? [] : [`${path}: command must be a nonempty argument array`];
    case 'preset': return validId(a.preset) ? [] : [`${path}: invalid preset ID`];
    case 'page': return validId(a.page) ? [] : [`${path}: invalid page ID`];
    default: return [`${path}: unsupported action type`];
  }
}

export function validatePreset(preset) {
  const e = [];
  if (!plain(preset)) throw new ValidationError(['Preset must be a JSON object']);
  if (preset.schemaVersion !== SCHEMA_VERSION) e.push('schemaVersion: unsupported preset version');
  if (!validId(preset.id)) e.push('id: use letters, digits, dashes or underscores');
  if (!text(preset.name, 80) || !preset.name.trim()) e.push('name: enter a name (maximum 80 characters)');
  if (preset.description !== undefined && !text(preset.description, 300)) e.push('description: maximum 300 characters');
  if (!Array.isArray(preset.pages) || !preset.pages.length || preset.pages.length > 12) e.push('pages: include 1–12 pages');
  const pageIds = new Set();
  for (const [pi, page] of (Array.isArray(preset.pages) ? preset.pages : []).entries()) {
    const pp = `pages[${pi}]`;
    if (!plain(page)) { e.push(`${pp}: invalid page`); continue; }
    if (!validId(page.id) || pageIds.has(page.id)) e.push(`${pp}.id: invalid or duplicate page ID`);
    pageIds.add(page.id);
    if (!text(page.name, 60) || !page.name.trim()) e.push(`${pp}.name: enter a page name`);
    if (!Array.isArray(page.widgets) || page.widgets.length < 1 || page.widgets.length > 24) e.push(`${pp}.widgets: include 1–24 widgets`);
    const ids = new Set();
    for (const [wi, w] of (Array.isArray(page.widgets) ? page.widgets : []).entries()) {
      const wp = `${pp}.widgets[${wi}]`;
      if (!plain(w)) { e.push(`${wp}: invalid widget`); continue; }
      if (!validId(w.id) || ids.has(w.id)) e.push(`${wp}.id: invalid or duplicate widget ID`);
      ids.add(w.id);
      if (!TYPES.includes(w.type)) e.push(`${wp}.type: unsupported widget`);
      if (!finite(w.weight, 0.25, 12)) e.push(`${wp}.weight: width must be 0.25–12`);
      if (w.label !== undefined && !text(w.label, 80)) e.push(`${wp}.label: maximum 80 characters`);
      if (w.icon !== undefined && !text(w.icon, 8)) e.push(`${wp}.icon: maximum 8 characters`);
      if (w.type === 'button') e.push(...validateAction(w.action, `${wp}.action`));
      if (w.holdAction) { if (w.type !== 'button') e.push(`${wp}.holdAction: hold actions belong to buttons`); e.push(...validateAction(w.holdAction, `${wp}.holdAction`)); }
      if (w.type === 'slider' && !CHANNELS.includes(w.channel)) e.push(`${wp}.channel: unsupported slider`);
    }
  }
  if (!pageIds.has(preset.defaultPage)) e.push('defaultPage: choose an existing page');
  if (preset.fnPage !== null && preset.fnPage !== undefined && !pageIds.has(preset.fnPage)) e.push('fnPage: choose an existing page');
  for (const page of Array.isArray(preset.pages) ? preset.pages : []) {
    for (const w of Array.isArray(page?.widgets) ? page.widgets : []) {
      for (const a of [w?.action, w?.holdAction]) if (a?.type === 'page' && !pageIds.has(a.page)) e.push(`widget ${w.id}: page action references a missing page`);
    }
  }
  if (e.length) throw new ValidationError(e);
  return clone(preset);
}

export function validateRules(rules, presets) {
  const ids = new Set(), known = new Set(presets.map(p => p.id));
  if (!Array.isArray(rules) || rules.length > 100) throw new ValidationError(['Rules must be a list of up to 100 entries']);
  const e = [];
  for (const [i, r] of rules.entries()) {
    if (!plain(r)) { e.push(`rule ${i}: invalid rule`); continue; }
    if (!validId(r.id) || ids.has(r.id)) e.push(`rule ${i}: invalid or duplicate ID`);
    ids.add(r.id);
    if (!text(r.name, 80) || !r.name.trim()) e.push(`rule ${i}: enter a name`);
    if (!text(r.app, 240) || !r.app.trim()) e.push(`rule ${i}: enter an application pattern`);
    if (!text(r.title, 160)) e.push(`rule ${i}: title filter is too long`);
    if (typeof r.enabled !== 'boolean') e.push(`rule ${i}: enabled must be true or false`);
    if (!known.has(r.preset)) e.push(`rule ${i}: preset does not exist`);
  }
  if (e.length) throw new ValidationError(e);
  return clone(rules);
}

export function matches(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false;
  return pattern.split('|').some(p => {
    p = p.trim();
    // Single-character regexes retain the existing case folding without backtracking.
    const tokens = p.split('').map(c => c === '*' ? null : new RegExp(c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i'));
    let previous = new Uint8Array(p.length + 1), current = new Uint8Array(p.length + 1);
    previous[0] = 1;
    for (let j = 1; j <= p.length; j++) previous[j] = p[j - 1] === '*' ? previous[j - 1] : 0;
    // Each input character visits each pattern position once: O(value.length * p.length).
    for (let i = 0; i < value.length; i++) {
      const c = value[i], wildcard = !/[\n\r\u2028\u2029]/.test(c);
      current[0] = 0;
      for (let j = 1; j <= p.length; j++) {
        current[j] = p[j - 1] === '*' ? current[j - 1] || (wildcard && previous[j]) : previous[j - 1] && tokens[j - 1].test(c);
      }
      [previous, current] = [current, previous];
    }
    return Boolean(previous[p.length]);
  });
}
export function selectPreset({ presets, settings, rules, context, locked = false }) {
  const known = id => presets.some(p => p.id === id);
  if (locked) return { id: 'classic', reason: 'Locked · basic controls', locked: true };
  if (known(settings.pinnedPreset)) return { id: settings.pinnedPreset, reason: 'Pinned by you' };
  if (settings.automatic) {
    const r = rules.find(r => r.enabled && known(r.preset) && matches(r.app, context.app || '') && (!r.title || (context.title || '').toLowerCase().includes(r.title.toLowerCase())));
    if (r) return { id: r.preset, reason: `Automatic · ${r.name}`, rule: r.id };
  }
  return { id: known(settings.defaultPreset) ? settings.defaultPreset : presets[0]?.id, reason: settings.automatic ? 'Default · no app rule matched' : 'Automatic switching off' };
}

export function widgetTemplate(type, id) {
  if (!TYPES.includes(type)) throw new ValidationError(['Unknown widget type']);
  const w = { id, type, label: type[0].toUpperCase() + type.slice(1), weight: ['slider', 'media', 'workspaces'].includes(type) ? 2 : 1 };
  if (type === 'button') { w.label = 'New button'; w.action = { type: 'key', key: 'Return', modifiers: [] }; }
  if (type === 'slider') { w.label = 'Volume'; w.channel = 'volume'; }
  return w;
}

export function validateSettings(input, presets) {
  const s = { ...DEFAULT_SETTINGS, ...input }, known = new Set(presets.map(p => p.id)), e = [];
  if (!known.has(s.defaultPreset)) e.push('Default preset does not exist');
  if (s.pinnedPreset !== null && !known.has(s.pinnedPreset)) e.push('Pinned preset does not exist');
  if (typeof s.hardwareEnabled !== 'boolean') e.push('Hardware enabled must be true or false');
  if (typeof s.automatic !== 'boolean') e.push('Automatic must be true or false');
  if (!finite(s.brightness, 0, 255)) e.push('Touch Bar brightness must be 0–255');
  if (!finite(s.dimAfter, 0, 3600) || !finite(s.offAfter, 0, 7200) || (s.offAfter && s.offAfter < s.dimAfter)) e.push('Off timeout must follow the dim timeout (0 disables)');
  if (![2008, 2170].includes(s.previewWidth) || s.previewHeight !== 60) e.push('Choose a supported preview geometry');
  if (e.length) throw new ValidationError(e);
  return s;
}

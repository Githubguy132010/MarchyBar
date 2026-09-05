import { clamp, DEFAULT_THEME } from './model.mjs';

export const MIN_WIDTH = { button: 58, slider: 165, media: 280, workspaces: 145, clock: 90, battery: 85, cpu: 80, memory: 80, app: 135, spacer: 12 };
const safeText = value => String(value ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, 300);
export function rgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return { r: 1, g: 1, b: 1 };
  return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
}
export function normalizeTheme(value) {
  const t = { ...DEFAULT_THEME };
  for (const key of ['background', 'foreground', 'muted', 'accent', 'selected', 'urgent']) if (/^#[0-9a-f]{6}$/i.test(value?.[key])) t[key] = value[key];
  if (typeof value?.fontFamily === 'string' && value.fontFamily.length < 200) t.fontFamily = value.fontFamily;
  if (Number.isFinite(value?.radius)) t.radius = clamp(value.radius, 0, 12);
  return t;
}

export function layout(preset, pageId, geometry) {
  const { width, height } = geometry;
  if (!Number.isFinite(width) || width < 1000 || width > 6000 || height < 40 || height > 200) throw new Error('Unsupported Touch Bar geometry');
  const page = preset.pages.find(p => p.id === pageId) || preset.pages.find(p => p.id === preset.defaultPage);
  if (!page) throw new Error('The preset has no active page');
  const escapeWidth = (geometry.softwareEscape ?? width >= 2170) ? 96 : 0;
  const menuWidth = 66, gap = 5, start = escapeWidth + (escapeWidth ? gap : 0);
  const available = width - start - menuWidth - gap * (page.widgets.length + 1);
  const minimum = page.widgets.reduce((sum, w) => sum + MIN_WIDTH[w.type], 0);
  if (minimum > available) throw new Error(`This page needs ${Math.ceil(minimum - available)} fewer pixels. Remove a widget or put it on another page.`);
  const total = page.widgets.reduce((sum, w) => sum + w.weight, 0), spare = available - minimum;
  let x = start;
  const boxes = page.widgets.map(w => {
    const box = { ...w, x, y: 0, w: MIN_WIDTH[w.type] + spare * w.weight / total, h: height };
    x += box.w + gap; return box;
  });
  return { page, boxes, escapeWidth, menuX: width - menuWidth, menuWidth, width, height };
}

export function scene(preset, pageId, geometry, data = {}, theme = DEFAULT_THEME, interaction = {}) {
  const t = normalizeTheme(theme), l = layout(preset, pageId, geometry), commands = [], targets = [];
  const H = l.height;
  const rect = (x, y, w, h, color, a = 1, radius = t.radius) => commands.push({ cmd: 'fill_rect', x, y, w, h, ...rgb(color), a, tl: radius, tr: radius, br: radius, bl: radius });
  const text = (str, x, y, w, size = 17, color = t.foreground, align = 'center', bold = false) => commands.push({ cmd: 'text', text: safeText(str), x, y, ...rgb(color), a: 1, size, family: t.fontFamily, bold, italic: false, align, containerX: x, containerW: w, lineHeight: size * 1.3 });
  const target = (box, extra) => targets.push({ x: box.x, y: box.y, w: box.w, h: box.h, widgetId: box.id, ...extra });
  const meter = (box, name, value, suffix = '%') => {
    text(value === null || value === undefined ? '—' : `${Math.round(value)}${suffix}`, box.x + 4, 5, box.w - 8, 20, t.foreground, 'center', true);
    text(name, box.x + 4, 32, box.w - 8, 12, t.muted);
    if (Number.isFinite(value)) rect(box.x + 10, H - 5, (box.w - 20) * clamp(value, 0, 100) / 100, 2, t.accent, 1, 0);
  };
  commands.push({ cmd: 'clear', ...rgb(t.background) });
  if (l.escapeWidth) {
    rect(0, 3, l.escapeWidth, H - 6, t.selected);
    text('esc', 0, 16, l.escapeWidth, 19);
    target({ id: '__escape', x: 0, y: 0, w: l.escapeWidth, h: H }, { kind: 'button', action: { type: 'key', key: 'Escape', modifiers: [] }, safeAtLock: true });
  }
  for (const b of l.boxes) {
    if (b.type === 'spacer') continue;
    const down = interaction.widgetId === b.id;
    rect(b.x, 3, b.w, H - 6, down ? t.accent : t.selected, down ? 0.32 : 0.58);
    commands.push({ cmd: 'clip_push', x: b.x + 3, y: 0, w: b.w - 6, h: H, tl: 0, tr: 0, br: 0, bl: 0 });
    switch (b.type) {
      case 'button':
        if (b.icon) { text(b.icon, b.x + 5, 3, b.w - 10, 22); text(b.label || '', b.x + 5, 33, b.w - 10, 12, t.muted); }
        else text(b.label || 'Button', b.x + 6, 18, b.w - 12, 17);
        target(b, { kind: 'button', action: b.action, holdAction: b.holdAction });
        break;
      case 'slider': {
        const value = b.channel === 'touchbar' ? data.touchbar : b.channel === 'seek' ? (data.media?.length > 0 ? data.media.position / data.media.length * 100 : null) : data[b.channel];
        const percent = Number.isFinite(value) ? clamp(value, 0, 100) : null;
        const label = b.label || b.channel;
        text(label, b.x + 13, 4, b.w - 58, 12, t.muted, 'left');
        text(percent === null ? '—' : `${Math.round(percent)}%`, b.x + b.w - 60, 4, 45, 12, t.foreground, 'right');
        const trackX = b.x + 15, trackW = b.w - 30;
        rect(trackX, 33, trackW, 12, t.muted, 0.25, 3);
        if (percent !== null) { rect(trackX, 33, trackW * percent / 100, 12, t.accent, 1, 3); rect(trackX + trackW * percent / 100 - 3, 29, 6, 20, t.foreground, 1, 2); }
        target(b, { kind: 'slider', channel: b.channel, trackX, trackW, enabled: percent !== null });
        break;
      }
      case 'clock': text(data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), b.x + 3, 5, b.w - 6, 21); text(data.date || new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric' }), b.x + 3, 33, b.w - 6, 12, t.muted); break;
      case 'battery': meter(b, data.charging ? 'Charging' : 'Battery', data.battery); break;
      case 'cpu': meter(b, 'CPU', data.cpu); break;
      case 'memory': meter(b, 'Memory', data.memory); break;
      case 'app': text(data.app || 'Omarchy', b.x + 10, 6, b.w - 20, 18); text(data.title || 'Your workspace', b.x + 10, 33, b.w - 20, 12, t.muted); break;
      case 'workspaces': {
        const ws = data.workspaces?.length ? data.workspaces.slice(0, 7) : [{ id: 1 }, { id: 2 }, { id: 3 }];
        const unit = (b.w - 12) / ws.length;
        for (const [i, v] of ws.entries()) {
          const x = b.x + 6 + unit * i;
          if (v.id === data.workspace) rect(x + 2, 10, unit - 4, H - 20, t.accent, 0.3);
          text(String(v.name || v.id), x + 2, 18, unit - 4, 18, v.id === data.workspace ? t.accent : t.foreground);
          target({ ...b, x, w: unit }, { kind: 'button', action: { type: 'workspace', workspace: v.id } });
        }
        break;
      }
      case 'media': {
        const m = data.media || {}, controlsW = 132, labelW = b.w - controlsW - 12;
        text(m.title || 'Nothing playing', b.x + 12, 5, labelW - 10, 16, t.foreground, 'left');
        text(m.artist || 'Play something to begin', b.x + 12, 32, labelW - 10, 12, t.muted, 'left');
        for (const [i, [label, command]] of [['‹', 'previous'], [m.status === 'Playing' ? 'Ⅱ' : '▶', 'play-pause'], ['›', 'next']].entries()) {
          const x = b.x + b.w - controlsW + i * 42;
          text(label, x, 15, 40, 21);
          target({ ...b, x, w: 42 }, { kind: 'button', action: { type: 'media', command }, enabled: !!m.player });
        }
        break;
      }
    }
    commands.push({ cmd: 'clip_pop' });
  }
  rect(l.menuX, 3, l.menuWidth, H - 6, t.selected);
  text('≡', l.menuX, 12, l.menuWidth, 26, t.accent);
  target({ id: '__menu', x: l.menuX, y: 0, w: l.menuWidth, h: H }, { kind: 'button', action: { type: 'editor' } });
  return { commands, targets, boxes: l.boxes, page: l.page.id, geometry };
}

export class Gesture {
  constructor({ action, slider, changed = () => {}, released = () => {} }) { Object.assign(this, { action, slider, changed, released }); this.capture = null; this.timer = null; }
  input(phase, x, y, targets, revision, locked = false) {
    if (![x, y].every(Number.isFinite)) return;
    if (phase === 'start') {
      this.cancel();
      const hit = targets.find(t => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h && t.enabled !== false && (!locked || t.safeAtLock));
      if (!hit) return;
      this.capture = { ...structuredClone(hit), revision, startX: x, startY: y, moved: false, held: false };
      if (hit.kind === 'slider') this.slide(x, false);
      else if (hit.holdAction) this.timer = setTimeout(() => { if (this.capture) { this.capture.held = true; this.action(this.capture.holdAction); } }, 550);
      this.changed();
    } else if (phase === 'move' && this.capture) {
      if (Math.abs(x - this.capture.startX) > 12 || Math.abs(y - this.capture.startY) > 12) { this.capture.moved = true; clearTimeout(this.timer); }
      if (this.capture.kind === 'slider') this.slide(x, false);
    } else if (phase === 'end' && this.capture) {
      const c = this.capture;
      if (c.kind === 'slider') this.slide(x, true);
      else if (!c.held && !c.moved && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) this.action(c.action);
      this.cancel(); this.released();
    } else if (phase === 'cancel') { this.cancel(); this.released(); }
  }
  slide(x, final) { const c = this.capture; this.slider(c.channel, clamp((x - c.trackX) / c.trackW * 100, 0, 100), final); }
  cancel() { clearTimeout(this.timer); this.timer = null; this.capture = null; this.changed(); }
}

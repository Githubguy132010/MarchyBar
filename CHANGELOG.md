# Changelog

## Unreleased

- Support Omarchy 4.0.4: T2 Macs stay on `linux-t2` while other machines move to `linux-omarchy`. Hardware diagnostics now detect a non-T2 kernel on supported models, report a `wrong-kernel` status with a boot/`linux-t2-headers` recovery hint, and refuse hardware enablement until the T2 kernel is running. The editor surfaces the note in the Device tab.
- Restore backend startup and setup/update paths on Omarchy 4.0.3 by resolving the plugin directory relative to its QML file.
- Read lock state through public IPC, preserving fail-closed behavior when the shell is unavailable, instead of accessing its now-private authentication service.

## 0.1.0 — 2026-09-05

First public release of MarchyBar for Omarchy on Intel T2 MacBook Pro computers.

- Native preset editor with six bundled layouts, pages, Fn alternate pages, draft editing, undo/redo, import/export, and automatic app rules.
- Live widgets and sliders, Omarchy theme integration, and a rendered preview with a 20-second trial and rollback.
- User-session renderer and a separately installed device helper with active-session checks, temporary device access, and firmware restoration.
- Touch Bar brightness in percent, including 0%, with edits preserved during live updates.

Physically tested on MacBookPro15,1. Other supported model identifiers and both display geometries are handled in code; additional physical models and full suspend/resume cycles still need testing. See [validation](docs/VALIDATION.md).

# Architecture

## Three processes, separate responsibilities

```text
Omarchy shell (Quickshell)
  Service.qml ←→ user Unix socket ←→ Node session backend
  Editor.qml                         ├─ presets and app rules
  BarWidget.qml                      ├─ Hyprland / PipeWire / MPRIS
                                     └─ native DRM + Cairo + evdev
                                             ↑ device lease
                                     Python device helper (systemd)
                                             └─ specific T2 USB mode / ACL / backlight
```

The shell uses Omarchy's actual `qs.Ui` controls and `qs.Commons` theme tokens. It keeps an editable draft separate from persisted state. The background service supplies a lock/idle heartbeat and reconnects by recreating the Quickshell socket after failed connections. This handles the [Quickshell socket implementation](https://github.com/quickshell-mirror/quickshell/blob/master/src/io/socket.cpp), which retains its failed underlying `QLocalSocket`.

The session backend owns configuration, layout selection, drawing, hit testing, live data, and user actions. Its native addon contains only the upstream C++ renderer/input code. There is no React dependency, alternate desktop settings toolkit, global input grab, or root session renderer.

The root helper accepts four operations: acquire, release, brightness, and ping. It authenticates Unix peer credentials against an active local logind user session. One connection owns one lease. It switches only USB 05ac:8302, waits for the custom DRM/touch nodes and udev completion, records ACLs, and grants narrowly scoped temporary access. It restores the exact original ACL when the same device inode still exists, then the previous USB mode and backlight. A root-owned runtime journal supports recovery after a helper crash. An active renderer or competing tiny-dfr/touchbard process is rejected.

Logind's `PrepareForSleep` signal is coordinated with a delay inhibitor. The helper tells the session renderer to close its file descriptors before restoring the firmware mode and releasing the inhibitor. It never unloads the T2 bridge. The backend retries hardware acquisition after recovery; a sleeping helper rejects acquisition. Locking or losing the shell heartbeat closes the custom renderer and returns firmware controls. On unlock the saved enabled preference reconnects MarchyBar.

## Selection and interaction

Selection order is: lock fallback, temporary trial, pinned preset, first matching enabled app rule, default preset. A trial has a 20-second deadline and is discarded on lock. Holding Fn temporarily selects the preset's `fnPage`.

A touch captures its target and action at touch-down. App/layout changes wait until that gesture ends. Slider output is serialized per channel with the newest value replacing pending intermediate values. Release supplies a final value. Preset/theme rendering and hit targets are derived from the same layout function. User actions are direct argument-array subprocess calls, with bounded execution time.

The preview uses the same Cairo renderer as hardware. Draft rendering doesn't touch the physical display; `try` explicitly opts into a time-limited physical preview. Both 2008 and 2170 widths are validated before saving/importing. No unsupported whole-row compression makes touch targets smaller.

## Configuration contract

Preset schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "my-layout",
  "name": "My layout",
  "description": "A minimal example",
  "defaultPage": "main",
  "fnPage": null,
  "pages": [{
    "id": "main",
    "name": "Main",
    "widgets": [
      {"id": "clock", "type": "clock", "weight": 1},
      {"id": "volume", "type": "slider", "channel": "volume", "label": "Volume", "weight": 2},
      {"id": "save", "type": "button", "label": "Save", "weight": 1,
       "action": {"type": "key", "key": "s", "modifiers": ["ctrl"]}}
    ]
  }]
}
```

Widgets: `button`, `slider`, `media`, `workspaces`, `clock`, `battery`, `cpu`, `memory`, `app`, `spacer`. Every widget has a unique ID within its page and a weight from 0.25 to 12. Sliders use `volume`, `brightness`, `keyboard`, `touchbar`, or `seek`. Buttons require an action; optional `holdAction` uses the same action schema.

Action variants:

| Type | Fields |
| --- | --- |
| key | `key`, `modifiers` (ctrl, alt, shift, logo) |
| media | `command` (play-pause, previous, next, stop) |
| workspace | `workspace` (1–99) |
| launch | `desktop` (application .desktop ID) |
| command | `argv` (array of strings) |
| preset | `preset` (preset ID) |
| page | `page` (page ID in the current preset) |

Rules contain `id`, `name`, `enabled`, `app`, `title`, and `preset`. Application matching is case insensitive; `*`, `?`, and `|` are the only pattern operators. `title` is an optional case-insensitive substring, not executable regex.

## Session protocol

Newline-delimited JSON over `$XDG_RUNTIME_DIR/marchybar/control.sock`. Directory mode 0700; socket mode 0600. Protocol version 1. Incoming lines are capped at 1 MiB. The server sends an initial state event on connection.

Request:

```json
{"id":1,"method":"hello","params":{"protocolVersion":1}}
```

Response:

```json
{"id":1,"ok":true,"data":{},"revision":"current-store-revision"}
```

Errors set `ok:false` and `error`, optionally `errors`. Configuration mutations require the current revision and reject stale edits. UI requests retain the revision from when editing started. `get` returns current state; state/frame events keep clients synchronized.

Methods: `hello`, `get`, `preset.create`, `preset.save`, `preset.delete`, `preset.restore`, `preset.import`, `preset.export`, `preset.apply`, `file.import`, `file.export`, `rules.save`, `settings.save`, `automatic`, `preview`, `preview.close`, `try`, `revert`, `page`, `theme`, `heartbeat`, `hardware.enable`, `hardware.disable`, `diagnostics`, `editor.present`, `shutdown`. `simulate` is available exclusively in a hardware-free preview instance.

`file.import` reads a regular local JSON file no larger than 1 MiB. `file.export` writes atomically and refuses destination symlinks. These are user-session operations, never privileged helper operations.

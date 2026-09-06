# QML issue verification

Run `tests/test-qml.sh`. It runs the original five checks and the regression
suite using the installed Omarchy controls, QtTest keyboard/mouse events and
Quickshell's offscreen platform. Fixtures and generated QML stay in a temporary
directory, honoring `TMPDIR`. No live Service instance, backend process, device operation,
user preset, or desktop configuration is loaded or changed.

The service harness extracts the actual top-level `request`, `receive`, and
`reconnect` functions into an inert Item with mock transport and shell objects.
The editor backend serializes submitted values immediately and can hold replies.
Successful writes deliver their state before their acknowledgement, matching
the backend's ordering. Persistence assertions concern the mock snapshot, not
user files or a real Store.

## Reproduction and results

The first regression run against unchanged product QML failed all 17 initial
cases. These failures covered every issue listed below. After fixes, all initial
cases and the expanded negative controls pass.

| Issue | Observed before the fix | Passing regression coverage | Product files |
| --- | --- | --- | --- |
| #1 | Two `openEditor` events called `summon` twice, not `hide`. | Second event hides the clean editor, cancels deferred presentation, and guards dirty drafts. | Service.qml, Editor.qml |
| #4 | Preset A acknowledgement made B clean; rules B became A immediately. | Submitted snapshot, newer edits, pending field text, failed writes, same/other preset reload, rules reload, and typing during pending rules save. | Editor.qml |
| #9 | Both restore and delete sent r2 after a dialog opened at r1. | Held confirmations retain r1 and reject concurrent state; unchanged confirmations succeed. | Editor.qml, Service.qml |
| #10 | Rejection cleared editing; disconnected request never invoked completion. | Failed writes stay pending and retryable, unrelated success cannot settle them, edits survive pending requests, and actual service reconnect invokes failure. | SettingNumber.qml, Editor.qml, Service.qml |
| #14 | Actual accepted `1,000` input emitted zero. The initial brightness test saw request value 0 instead of 2550 after raising its test-only maximum. | Final tests use Dim after directly: en_US `1,000` and de_DE `1.000` submit 1000; ungrouped, zero, upper bound and intermediate input are checked. | SettingNumber.qml |
| #15 | Each focused rule-text delegate was destroyed after changed rule data arrived. | Name, app and title retain text, focus and starting revision; telemetry does not replace delegates; clean changed rules still reload. | Editor.qml |
| #20 | Typing `x` behind confirmation changed the preset name to `x`. | Typing, save, undo/redo, repeated Tab/Backtab cannot reach the background; Escape restores focus; prompt acceptance and Continue are keyboard-accessible. | Editor.qml |
| #21 | Ctrl+S with pending width sent no request on a clean draft; numeric Escape closed the window. | Width with/without another edit, workspace, command-array and hold-action input commit before save or block invalid input; numeric Escape cancels without a later blur write. | Editor.qml, SettingNumber.qml |
| #25 | Actual popup selection followed by Undo left brightness displayed for a volume model. | Channel, action, default/Fn page and default-preset controls track model changes after real popup selection, undo/redo, reload and navigation. | Editor.qml |
| #26 | Invalid source index grew three widgets to four and raised TypeError; switching pages left three old hit boxes. | Source/destination bounds, delayed old replies, fewer/same-length pages, preset switching, held replies, valid mouse drag and identical refresh during a drag. | Editor.qml |

## Limits

Offscreen tests do not establish compositor tiling/fullscreen behavior, actual
Touch Bar input, or native Wayland focus behavior. Those require a dedicated
host session. No physical setting was sent. Mock rejection tests verify the
QML completion paths, not backend validation or disk persistence.

## Independent review follow-up

Three additional defects were reproduced before changing the product again:

- An actual mouse click on the second preview cell after typing width `8.5`
  saved the first widget's old width `2`. Invalid width also allowed selection
  to move. Selection now commits pending fields first or blocks the change.
- A settings or preset save advanced the mock to r2 while clean rules retained
  r1. Clean unchanged rules now update only their revision, preserving the
  existing delegates and focus. Dirty rules and pending saves retain their
  starting revision.
- Rejected and disconnected default-preset selections displayed `second` while
  both modelValue and the snapshot remained `test`. Controlled dropdowns now
  explicitly resynchronize after selection. The asynchronous setting also
  disables further choices until completion and resynchronizes on completion.

The initial follow-up run had six failures across these three defects. The mock
now enforces revisions for preset, rules and settings saves, not only reset.
Additional tests cover mouse selection through the widget list, page selection,
add/reorder/undo, blocked action-type selection, delayed settings success/failure,
disconnect after sending, and dirty/pending rule revision negative controls.

## Preview test synchronization

The drag fixture's fixed 20 ms image-load wait and 10 ms layout wait were not
sufficient. Three of five repeated runs failed before mouse input: the SVG image
was still `Image.Loading`, painted geometry was `0x0`, and the hit area had zero
height. This was a test readiness race, not a failed drag.

Preview mouse tests now wait up to five seconds for `Image.Ready`, nonzero
painted geometry and a nonzero hit area. A readiness timeout still fails the
suite. The drag test also asserts that the MouseArea remains pressed and is the
same object after an identical preview refresh, then checks the reordered model.

After this test-only change, all 76 checks passed in 10 consecutive runs and
12 further runs with four suites in parallel alongside `npm test`. The parallel
Node test run passed 91 tests. All QML runs used `TMPDIR=/tmp/opencode`; the
runner continues to honor the caller's temporary-directory setting.

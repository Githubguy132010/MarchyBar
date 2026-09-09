import QtQuick
import Quickshell.Io

// Read the public lock IPC instead of accessing Omarchy's private auth service.
// Unknown, failed, or stale queries must never enable Touch Bar actions.
Item {
  id: root
  property bool locked: true
  property bool known: false
  property var probeCommand: ["timeout", "--kill-after=1s", "1s", "omarchy-shell", "lock", "isLocked"]

  function acceptResult(exitCode, output) {
    var value = String(output).trim()
    known = exitCode === 0 && (value === "true" || value === "false")
    locked = !known || value !== "false"
    freshness.restart()
  }

  Process {
    id: probe
    command: root.probeCommand
    stdout: StdioCollector { id: result; waitForEnd: true }
    onExited: function(exitCode) { root.acceptResult(exitCode, result.text) }
  }
  Timer {
    interval: 250; repeat: true; running: true; triggeredOnStart: true
    onTriggered: { if (!probe.running) probe.running = true }
  }
  Timer {
    id: freshness
    interval: 1500
    onTriggered: { root.known = false; root.locked = true }
  }
}

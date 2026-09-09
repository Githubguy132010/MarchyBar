import QtQuick
import Quickshell

ShellRoot {
  id: suite
  property int phase: 0
  Service {
    id: service
    manifest: ({id: "marchybar.touchbar"})
    // Match 4.0.3's public API: no private lock service or source directory.
    shell: QtObject { function firstPartyServiceFor(id) { return null } }
    Component.onCompleted: lockService.probeCommand = ["sh", "-c", "printf false"]
  }
  function verify(value, message) {
    if (!value) throw new Error(message)
  }
  Timer {
    interval: 50; running: true; repeat: true
    onTriggered: {
      try {
        if (suite.phase === 0) {
          if (service.buildMessage !== "MARCHYBAR_STUB_daemon" || !service.lockService.known) return
          verify(service.pluginRoot === Quickshell.env("MARCHYBAR_TEST_ROOT"), "Plugin path did not round-trip spaces, percent, and Unicode")
          verify(!service.lockService.locked, "Public IPC did not report unlocked")
          service.lockService.acceptResult(0, "true\n")
          verify(service.lockService.locked && service.lockService.known, "Lock response was ignored")
          service.lockService.acceptResult(1, "false")
          verify(service.lockService.locked && !service.lockService.known, "Failed query unlocked the device")
          service.lockService.acceptResult(0, "Function not found.")
          verify(service.lockService.locked && !service.lockService.known, "Invalid response unlocked the device")
          service.lockService.acceptResult(0, "")
          verify(service.lockService.locked && !service.lockService.known, "Empty response unlocked the device")
          service.lockService.acceptResult(0, "false")
          verify(!service.lockService.locked, "Valid response did not recover")
          service.lockService.probeCommand = ["sh", "-c", "sleep 3; printf false"]
          suite.phase = 1
        } else if (suite.phase === 1 && !service.lockService.known) {
          verify(service.lockService.locked, "Stale query did not fail closed")
          console.log("MARCHYBAR_QML_ALL_PASSED: service startup, public manifest, lock IPC and stale-state safety")
          Qt.quit()
        }
      } catch (error) {
        console.error("MARCHYBAR_QML_FAILED: " + error)
        Qt.quit()
      }
    }
  }
  Timer { interval: 10000; running: true; onTriggered: { console.error("MARCHYBAR_QML_FAILED: service test timeout"); Qt.quit() } }
}

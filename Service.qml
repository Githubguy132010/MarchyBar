import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

Item {
  id: root
  property var shell: null
  property var manifest: null
  property string omarchyPath: ""
  property var pluginRegistry: null
  property var barWidgetRegistry: null
  property var snapshot: ({ presets: [], rules: [], settings: ({}), data: ({}), hardware: ({}), status: "starting" })
  property bool connected: transport.connected
  property bool editorOpen: false
  property string error: ""
  property string buildMessage: "Starting MarchyBar…"
  property int frame: 0
  property string previewPath: ""
  property int nextId: 1
  property var pending: ({})
  readonly property string pluginRoot: manifest ? manifest.__sourceDir : ""
  readonly property string socketPath: Quickshell.env("XDG_RUNTIME_DIR") + "/marchybar/control.sock"
  readonly property var lockService: shell ? shell.firstPartyServiceFor("omarchy.lock") : null
  signal responseError(string message)
  signal frameReady()

  function request(method, params, callback, revision) {
    if (!connected) { error = "The backend is still starting."; return }
    var id = nextId++
    if (callback) pending[id] = callback
    transport.write(JSON.stringify({ id: id, method: method, params: params || {}, revision: revision || snapshot.revision }) + "\n")
    transport.flush()
  }
  function receive(data) {
    try {
      var msg = JSON.parse(data)
      if (msg.event === "state") { snapshot = msg.state; frame = snapshot.frame; previewPath = snapshot.previewPath || "" }
      else if (msg.event === "frame") { frame = msg.frame; previewPath = msg.previewPath; frameReady() }
      else if (msg.event === "openEditor" && shell) shell.summon("marchybar.touchbar", "{}")
      else if (msg.id !== undefined) {
        var callback = pending[msg.id]
        delete pending[msg.id]
        if (!msg.ok) { error = msg.error; responseError(error) }
        else error = ""
        if (callback) callback(msg.ok, msg.ok ? msg.data : msg.error)
      }
    } catch (e) { error = "Could not read backend response: " + e }
  }
  function heartbeat() {
    if (!connected) return
    request("heartbeat", { locked: lockService ? lockService.locked : true, editorOpen: editorOpen,
      dimmed: dimMonitor.enabled && dimMonitor.isIdle, off: offMonitor.enabled && offMonitor.isIdle })
  }
  function pushTheme() {
    if (!connected) return
    request("theme", { background: String(Color.background), foreground: String(Color.foreground), accent: String(Color.accent),
      muted: String(Color.muted), urgent: String(Color.urgent), selected: String(Qt.tint(Color.background, Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.14))),
      fontFamily: Style.font.family, radius: Style.cornerRadius })
  }
  function startBackend() {
    if (pluginRoot && !daemon.running && !connected) daemon.running = true
  }
  function setupSystem() { setup.running = true }

  Process {
    id: daemon
    command: ["/bin/bash", root.pluginRoot + "/bin/marchybar", "daemon"]
    stderr: SplitParser { onRead: data => { root.buildMessage = data; if (/Error|failed|Missing/.test(data)) root.error = data } }
    onExited: function(exitCode) { if (exitCode !== 0 && !root.connected) root.error = root.buildMessage }
  }
  Process {
    id: setup
    command: ["/bin/bash", root.pluginRoot + "/bin/marchybar", "setup"]
    stderr: SplitParser { onRead: data => { root.buildMessage = data } }
    onExited: function(exitCode) {
      if (exitCode === 0) root.request("hardware.enable", {})
      else root.error = "Setup did not finish. " + root.buildMessage
    }
  }
  Socket {
    id: transport
    path: root.socketPath
    connected: true
    parser: SplitParser { onRead: data => root.receive(data) }
    onConnectedChanged: {
      if (connected) { root.error = ""; root.request("hello", { protocolVersion: 1 }); root.heartbeat(); root.pushTheme() }
    }
  }
  IdleMonitor { id: dimMonitor; enabled: Number(root.snapshot.settings.dimAfter || 0) > 0; timeout: Number(root.snapshot.settings.dimAfter || 30); respectInhibitors: true; onIsIdleChanged: root.heartbeat() }
  IdleMonitor { id: offMonitor; enabled: Number(root.snapshot.settings.offAfter || 0) > 0; timeout: Number(root.snapshot.settings.offAfter || 60); respectInhibitors: true; onIsIdleChanged: root.heartbeat() }
  Timer { interval: 1500; repeat: true; running: true; onTriggered: { if (!transport.connected) { transport.connected = true; root.startBackend() } else root.heartbeat() } }
  Connections { target: root.lockService; function onLockedChanged() { root.heartbeat() } }
  Connections { target: Color; function onBackgroundChanged() { themeDebounce.restart() } function onForegroundChanged() { themeDebounce.restart() } function onAccentChanged() { themeDebounce.restart() } }
  Connections { target: Style; function onFontFamilyChanged() { themeDebounce.restart() } function onCornerRadiusChanged() { themeDebounce.restart() } }
  Timer { id: themeDebounce; interval: 100; onTriggered: root.pushTheme() }
  onManifestChanged: Qt.callLater(startBackend)
  Component.onCompleted: Qt.callLater(startBackend)
  Component.onDestruction: { transport.connected = false; daemon.running = false }
}

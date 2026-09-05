import QtQuick
import qs.Ui as Ui
import qs.Commons

Ui.BarWidget {
  id: root
  moduleName: "marchybar.touchbar"
  readonly property var service: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  function open() { if (bar && bar.shell) bar.shell.summon(moduleName, "{}") }
  function close() { if (bar && bar.shell) bar.shell.hide(moduleName) }
  readonly property bool opened: service ? service.editorOpen : false
  Ui.WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "▰"
    tooltipText: "MarchyBar · " + (root.service ? (root.service.snapshot.reason || "Touch Bar presets") : "Starting")
    onPressed: function(code) {
      if (code === Qt.RightButton && root.service) root.service.request("automatic", {})
      else if (code === Qt.LeftButton) root.open()
    }
  }
}

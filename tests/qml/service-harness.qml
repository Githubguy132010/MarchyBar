import QtQuick

Item {
  id: root
  property bool connected: false
  property string error: ""
  property int nextId: 1
  property var pending: ({})
  property var snapshot: ({revision:"r1"})
  property int frame: 0
  property string previewPath: ""
  property bool editorOpen: false
  property var shell: null
  property var transport: null
  signal responseError(string message)
  signal frameReady()
  QtObject { id: socketComponent; function createObject(parent) { return null } }
  // PRODUCT_FUNCTIONS
}

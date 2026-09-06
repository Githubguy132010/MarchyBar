import QtQuick
import qs.Ui as Ui

Ui.TextField {
  id: root
  property int savedValue: 0
  property int minimum: 0
  property int maximum: 100
  property bool editing: false
  property bool pending: false
  property int editVersion: 0
  signal committed(int value, var complete)
  color: editing ? accent : foreground

  validator: IntValidator { bottom: root.minimum; top: root.maximum }
  // State snapshots keep arriving while the user edits. Only synchronize when
  // there is no local draft; never bind the editable text to the live snapshot.
  Component.onCompleted: text = String(savedValue)
  onSavedValueChanged: if (!editing) text = String(savedValue)
  onTextEdited: { editing = true; editVersion++ }
  onEditingFinished: {
    if (!editing || pending) return
    if (!acceptableInput) return
    var value = Number.fromLocaleString(Qt.locale(validator.locale), text)
    if (!Number.isFinite(value)) return
    if (value === savedValue) { editing = false; text = String(savedValue); return }
    var version = editVersion
    pending = true
    committed(value, function(ok) {
      root.pending = false
      if (ok && version === root.editVersion) { root.editing = false; root.text = String(root.savedValue) }
    })
  }
  Keys.onShortcutOverride: event => { if (event.key === Qt.Key_Escape && editing) event.accepted = true }
  Keys.onEscapePressed: event => { if (editing) { editVersion++; editing = false; text = String(savedValue); event.accepted = true } else event.accepted = false }
}

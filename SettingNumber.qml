import QtQuick
import qs.Ui as Ui

Ui.TextField {
  id: root
  property int savedValue: 0
  property int minimum: 0
  property int maximum: 100
  property bool editing: false
  signal committed(int value)

  validator: IntValidator { bottom: root.minimum; top: root.maximum }
  // State snapshots keep arriving while the user edits. Only synchronize when
  // there is no local draft; never bind the editable text to the live snapshot.
  Component.onCompleted: text = String(savedValue)
  onSavedValueChanged: if (!editing) text = String(savedValue)
  onTextEdited: editing = true
  onEditingFinished: {
    if (!editing) return
    if (!acceptableInput) return
    var value = Number(text)
    editing = false
    if (value !== savedValue) committed(value)
    else text = String(savedValue)
  }
  Keys.onEscapePressed: { editing = false; text = String(savedValue) }
}

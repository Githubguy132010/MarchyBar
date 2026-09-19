pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import Quickshell
import qs.Ui as Ui
import qs.Commons

Item {
  id: root
  property var shell: null
  property var manifest: null
  property string omarchyPath: ""
  property var pluginRegistry: null
  property var barWidgetRegistry: null
  property var service: shell ? shell.serviceFor("marchybar.touchbar") : null
  readonly property var model: service ? service.snapshot : ({presets: [], rules: [], settings: {}, data: {}, hardware: {}})
  property bool opened: false
  property int tab: 0
  property var draft: null
  property string savedDraft: ""
  property string editRevision: ""
  property int draftGeneration: 0
  property bool saving: false
  property var pendingFields: []
  property int pageIndex: 0
  property int widgetIndex: 0
  property var history: []
  property var future: []
  readonly property alias brightnessEditor: brightnessField
  readonly property alias widgetTypeSelector: addType
  property var boxes: []
  readonly property string previewContext: draft ? draftGeneration + ":" + pageIndex + ":" + previewWidth + ":" + JSON.stringify(draft) : ""
  property int previewGeneration: 0
  property int previewWidth: 2170
  property string previewError: ""
  property var ruleDraft: []
  property string rulesBaseline: "[]"
  property string rulesRevision: ""
  property int rulesGeneration: 0
  property bool savingRules: false
  property var ruleTextEdits: ({})
  readonly property var editedRules: ruleDraft.map(r => Object.assign({}, r, ruleTextEdits[r.id] || {}))
  property string notice: ""
  property var confirmAction: null
  property string confirmTitle: ""
  property string confirmText: ""
  property bool promptVisible: false
  property string promptTitle: ""
  property string promptValue: ""
  property var promptAction: null
  property bool exporting: false
  readonly property bool modalActive: Boolean(confirmAction) || promptVisible
  property var previousFocus: null
  readonly property bool dirty: draft && (pendingFields.length > 0 || JSON.stringify(draft) !== savedDraft)
  readonly property bool rulesDirty: JSON.stringify(editedRules) !== rulesBaseline
  readonly property var page: draft && draft.pages[pageIndex] ? draft.pages[pageIndex] : null
  readonly property var widget: page && page.widgets[widgetIndex] ? page.widgets[widgetIndex] : null
  readonly property var presetOptions: (model.presets || []).map(p => ({value:p.id, label:p.name}))
  readonly property var pageOptions: draft ? draft.pages.map(p => ({value:p.id,label:p.name})) : []

  component Label: Text {
    textFormat: Text.PlainText
    color: Color.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    wrapMode: Text.WordWrap
  }
  component Hint: Label { color: Color.muted; font.pixelSize: Style.font.bodySmall }
  component Button: Ui.Button { focusable: true }
  component Dropdown: Ui.Dropdown {
    id: dropdown
    property string modelValue: ""
    function syncValue() { value = Qt.binding(() => dropdown.modelValue) }
    // A rejected selection may leave modelValue unchanged, so explicitly resync.
    onChanged: Qt.callLater(syncValue)
    // The host control assigns value before emitting changed, removing a plain binding.
    Binding { target: dropdown; property: "value"; value: dropdown.modelValue; restoreMode: Binding.RestoreNone }
  }
  component DraftField: Ui.TextField {
    id: field
    property var applyValue
    property bool pendingEdit: false
    function clearEdit() { pendingEdit = false; root.pendingFields = root.pendingFields.filter(f => f !== field) }
    function commitEdit() {
      if (!pendingEdit) return true
      if (!acceptableInput) { root.notice = "Complete the highlighted field before saving"; forceActiveFocus(); return false }
      try { applyValue(text) } catch (e) { root.notice = String(e); forceActiveFocus(); return false }
      clearEdit(); return true
    }
    onTextEdited: { if (!pendingEdit) { pendingEdit = true; root.pendingFields = root.pendingFields.concat([field]) } }
    onEditingFinished: commitEdit()
    Component.onDestruction: clearEdit()
  }
  component Line: Rectangle { implicitHeight: 1; Layout.fillWidth: true; color: Color.muted; opacity: 0.3 }
  function copy(v) { return JSON.parse(JSON.stringify(v)) }
  function call(method, params, callback, revision) { if (service) service.request(method, params, callback, revision) }
  function open(payload) {
    opened = true; window.visible = true; presentTimer.restart()
    if (service) { service.editorOpen = true; service.heartbeat() }
    if (!draft && model.presets.length) load(model.activePreset || model.presets[0].id)
    if (!rulesDirty) loadRules()
  }
  function close() {
    guard(function() {
      root.opened = false; window.visible = false
      presentTimer.stop()
      if (root.service) { root.service.editorOpen = false; root.service.heartbeat() }
      root.call("preview.close", {})
    })
  }
  function guard(action) {
    if (dirty || rulesDirty) confirm("Discard unsaved changes?", "Your saved presets and app rules will stay as they are.", function() { root.clearFields(); root.draftGeneration++; root.draft = null; root.savedDraft = ""; root.loadRules(); action() })
    else action()
  }
  function updateSystem(withOmarchy) {
    guard(function() {
      root.confirm("Update " + (withOmarchy ? "MarchyBar and Omarchy?" : "MarchyBar?"),
        "Updates run in a terminal and may restart the shell, closing this editor. Saved presets and the Touch Bar enabled setting are preserved.",
        function() { root.close(); root.service.updateSystem(withOmarchy) })
    })
  }
  function confirm(title, text, action) { if (!modalActive) previousFocus = window.contentItem.Window.window ? window.contentItem.Window.window.activeFocusItem : null; confirmTitle = title; confirmText = text; confirmAction = action }
  function prompt(title, value, action) { if (!modalActive) previousFocus = window.contentItem.Window.window ? window.contentItem.Window.window.activeFocusItem : null; promptTitle = title; promptValue = value; promptAction = action; promptVisible = true; Qt.callLater(() => promptField.forceActiveFocus()) }
  function clearFields() { for (var field of pendingFields.slice()) field.clearEdit() }
  function commitFields() {
    for (var field of pendingFields.slice()) if (!field.commitEdit()) return false
    return true
  }
  function selectWidget(index) { if (!commitFields()) return false; widgetIndex = index; return true }
  function selectPage(index) { if (!commitFields()) return false; pageIndex = index; widgetIndex = 0; return true }
  function load(id) {
    var p = model.presets.find(p => p.id === id)
    if (!p) return
    clearFields(); draftGeneration++
    draft = copy(p); delete draft.bundled; delete draft.customized
    savedDraft = JSON.stringify(draft); editRevision = model.revision || ""
    pageIndex = 0; widgetIndex = 0; history = []; future = []; previewError = ""; previewTimer.restart()
  }
  function mutate(fn) {
    if (!draft) return
    var d = copy(draft)
    fn(d)
    var stack = history.slice(-49); stack.push(copy(draft)); history = stack; future = []; draft = d
    previewTimer.restart()
  }
  function changeWidget(key, value) { if (widget && JSON.stringify(widget[key]) !== JSON.stringify(value)) mutate(d => { d.pages[pageIndex].widgets[widgetIndex][key] = value }) }
  function moveWidget(from, to) {
    if (!page || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= page.widgets.length || to < 0 || to >= page.widgets.length || from === to) return
    if (!commitFields()) return
    mutate(d => { var w = d.pages[pageIndex].widgets.splice(from,1)[0]; d.pages[pageIndex].widgets.splice(to,0,w) }); widgetIndex = to
  }
  function undo() { if (!commitFields() || !history.length) return; var h = history.slice(); var f = future.slice(); f.push(copy(draft)); draft = h.pop(); history = h; future = f; pageIndex = Math.min(pageIndex,draft.pages.length-1); widgetIndex = 0; previewTimer.restart() }
  function redo() { if (!commitFields() || !future.length) return; var f = future.slice(); var h = history.slice(); h.push(copy(draft)); draft = f.pop(); future = f; history = h; pageIndex = Math.min(pageIndex,draft.pages.length-1); widgetIndex = 0; previewTimer.restart() }
  function save() {
    if (modalActive || saving || !draft) return
    if (!commitFields()) return
    var submitted = copy(draft), generation = draftGeneration
    saving = true
    call("preset.save", {preset:submitted}, function(ok, data) {
      root.saving = false
      if (ok && generation === root.draftGeneration) { root.savedDraft = JSON.stringify(submitted); root.editRevision = root.model.revision; root.notice = "Preset saved" }
    }, editRevision)
  }
  function preview() {
    if (!opened || !draft || !page) return
    var context = previewContext, generation = previewGeneration
    call("preview", {preset:draft,page:page.id,width:previewWidth}, function(ok,data) {
      if (context !== root.previewContext || generation !== root.previewGeneration || !root.opened) return
      if (ok) { root.boxes = data.boxes; root.previewError = "" } else root.previewError = data
    })
  }
  function addWidget(type) {
    if (!commitFields()) return
    var w = {id:"widget-"+Date.now(),type:type,label:type[0].toUpperCase()+type.slice(1),weight:["slider","media","workspaces"].includes(type)?2:1}
    if (type === "button") w.action = {type:"key",key:"Return",modifiers:[]}
    if (type === "slider") { w.channel = "volume"; w.label = "Volume" }
    mutate(d => d.pages[pageIndex].widgets.push(w)); widgetIndex = page.widgets.length-1
  }
  function loadRules() { rulesGeneration++; ruleTextEdits = ({}); ruleDraft = copy(model.rules || []); rulesBaseline = JSON.stringify(ruleDraft); rulesRevision = model.revision || "" }
  function editRuleText(id, key, value) { var edits = copy(ruleTextEdits); if (!edits[id]) edits[id] = {}; edits[id][key] = value; ruleTextEdits = edits }
  function editRule(index, key, value) { var r = copy(editedRules); r[index][key] = value; ruleTextEdits = ({}); ruleDraft = r }
  function moveRule(index, delta) { var r=copy(editedRules), to=index+delta; if(to<0||to>=r.length)return; r.splice(to,0,r.splice(index,1)[0]);ruleTextEdits=({});ruleDraft=r }
  function saveRules() {
    if (savingRules || modalActive) return
    var submitted = copy(editedRules), generation = rulesGeneration
    savingRules = true
    call("rules.save", {rules:submitted}, function(ok) {
      root.savingRules = false
      if (ok && generation === root.rulesGeneration) { root.rulesBaseline = JSON.stringify(submitted); root.rulesRevision = root.model.revision; root.notice = "App rules saved" }
    }, rulesRevision)
  }
  function defaultAction(type) {
    return ({key:{type:"key",key:"Return",modifiers:[]},media:{type:"media",command:"play-pause"},workspace:{type:"workspace",workspace:1},launch:{type:"launch",desktop:"org.gnome.Nautilus.desktop"},command:{type:"command",argv:["omarchy","launch","terminal"],detached:true},preset:{type:"preset",preset:"everyday"},page:{type:"page",page:draft.defaultPage}})[type]
  }
  function actionField(key,value) { var a=copy(widget.action); a[key]=value; changeWidget("action",a) }
  function localPath(url) { return decodeURIComponent(String(url).replace(/^file:\/\//,"")) }
  Connections {
    target: root.service
    function onSnapshotChanged() {
      if (!root.draft && root.opened && root.model.presets.length) root.load(root.model.activePreset)
      if (!root.rulesDirty && !root.savingRules) {
        if (JSON.stringify(root.model.rules || []) !== root.rulesBaseline) root.loadRules()
        else root.rulesRevision = root.model.revision || ""
      }
      if (root.opened && root.draft) livePreview.restart()
    }
  }
  onNoticeChanged: if(notice) noticeTimer.restart()
  onPreviewContextChanged: { previewGeneration++; boxes = []; if (opened) previewTimer.restart() }
  onOpenedChanged: if (!opened) { previewGeneration++; boxes = [] }
  onModalActiveChanged: if (!modalActive && previousFocus) Qt.callLater(() => { if (root.previousFocus && !root.modalActive) root.previousFocus.forceActiveFocus() })
  Timer { id:noticeTimer; interval:4500; onTriggered:root.notice="" }
  Timer { id: presentTimer; interval: 200; onTriggered:root.call("editor.present",{}) }
  Timer { id: previewTimer; interval: 180; onTriggered: root.preview() }
  Timer { id: livePreview; interval: 400; onTriggered: root.preview() }

  FileDialog {
    id: fileDialog
    title: root.exporting ? "Export preset" : "Import preset"
    fileMode: root.exporting ? FileDialog.SaveFile : FileDialog.OpenFile
    nameFilters: ["MarchyBar preset (*.json)"]
    defaultSuffix: "json"
    onAccepted: {
      if (root.exporting) root.call("file.export", {id:root.draft.id,path:root.localPath(selectedFile)}, function(ok) {if(ok)root.notice="Preset exported"})
      else root.call("file.import", {path:root.localPath(selectedFile)}, function(ok,p) { if(ok)root.load(p.id) })
    }
  }
  FloatingWindow {
    id: window
    visible: root.opened
    title: "MarchyBar"
    implicitWidth: 1180
    implicitHeight: 800
    minimumSize: Qt.size(960,640)
    color: Color.background
    onClosed: { root.close(); if(root.opened) Qt.callLater(() => { window.visible = true }) }
    Shortcut { sequence: "Ctrl+S"; enabled: root.opened && !root.modalActive && root.tab===0 && root.dirty && !root.saving; onActivated: root.save() }
    Shortcut { sequence: "Ctrl+Z"; enabled: root.opened && !root.modalActive && root.tab===0; onActivated: root.undo() }
    Shortcut { sequence: "Ctrl+Shift+Z"; enabled: root.opened && !root.modalActive && root.tab===0; onActivated: root.redo() }
    Shortcut { sequence: "Escape"; enabled: root.opened; onActivated: { if(root.promptVisible)root.promptVisible=false;else if(root.confirmAction)root.confirmAction=null;else root.close() } }

    ColumnLayout {
      enabled: !root.modalActive
      anchors.fill: parent; anchors.margins: 24; spacing: 16
      RowLayout {
        Layout.fillWidth: true
        ColumnLayout { spacing: 4
          Label { text: "MarchyBar"; font.pixelSize: Style.font.heading; font.bold: true }
          Hint { text: "Your Touch Bar, at home in Omarchy." }
        }
        Item { Layout.fillWidth: true }
          Label { text: root.model.status === "ready" ? "● Connected" : "○ " + (({starting:"Starting", "setup-required":"Preview", "preview-only":"Preview", preview:"Preview", available:"Preview", "wrong-kernel":"Wrong kernel",disabled:"Disabled",recovering:"Reconnecting",error:"Needs attention",locked:"Desktop locked"})[root.model.status] || root.model.hardware.kernelNote || "Starting"); color: root.model.status === "ready" ? Color.accent : Color.muted }
        Button { text: "Automatic"; selected: Boolean(root.model.settings.automatic && !root.model.settings.pinnedPreset); onClicked: root.call("automatic",{}) }
      }
      RowLayout {
        Repeater { model: ["Presets", "App rules", "Device"]
          Button { required property int index; required property string modelData; text:modelData; selected:root.tab===index; onClicked:root.tab=index }
        }
        Item { Layout.fillWidth:true }
        Hint { text: root.model.reason || ""; Layout.maximumWidth: 450 }
      }
      Line {}
      Rectangle {
        visible: Boolean((root.service && root.service.error) || root.model.error || root.notice)
        Layout.fillWidth:true; implicitHeight: alert.implicitHeight+16; color: "transparent"; border.color: Color.muted; radius:Style.cornerRadius
        Label { id:alert; anchors.fill:parent; anchors.margins:8; text:(root.service && root.service.error) || root.model.error || root.notice; color: (root.service && root.service.error) || root.model.error ? Color.urgent : Color.accent }
      }
      StackLayout {
        Layout.fillWidth:true; Layout.fillHeight:true; currentIndex:root.tab
        RowLayout {
          spacing:24
          ColumnLayout {
            Layout.preferredWidth:220; Layout.maximumWidth:220; Layout.fillHeight:true; spacing:8
            Hint { text:"YOUR PRESETS" }
            Controls.ScrollView {
              contentWidth: availableWidth
              Layout.fillHeight:true; Layout.fillWidth:true; clip:true
              ColumnLayout { width:parent.width; spacing:4
                Repeater { model:root.model.presets || []
                  Button { required property var modelData; Layout.fillWidth:true; text:modelData.name; leftAlign:true; selected:root.draft && root.draft.id===modelData.id; tooltipText:modelData.description || ""; onClicked: { var id=modelData.id; root.guard(() => root.load(id)) } }
                }
              }
            }
            RowLayout {
              Button { objectName:"newPreset"; text:"+ New"; bordered:true; onClicked:root.guard(() => root.prompt("New preset", "My preset", name => root.call("preset.create",{name:name},(ok,p)=>{if(ok)root.load(p.id)}))) }
              Button { text:"Import"; onClicked:root.guard(() => {root.exporting=false;fileDialog.open()}) }
            }
            Hint { Layout.fillWidth:true; text:"Choose a preset to edit. Apply pins it; Automatic follows your app rules." }
          }
          ColumnLayout {
            Layout.fillWidth:true; Layout.fillHeight:true; spacing:14; visible:root.draft!==null
            RowLayout {
              Ui.TextField { Layout.fillWidth:true; text:root.draft ? root.draft.name : ""; objectName:"presetName"; placeholderText:"Preset name"; onTextEdited:root.mutate(d=>{d.name=text}) }
              Button { text:"Duplicate"; onClicked:{var from=root.draft.id;var name=root.draft.name;root.guard(()=>root.prompt("Duplicate saved preset",name+" copy",value=>root.call("preset.create",{name:value,from:from},(ok,p)=>{if(ok)root.load(p.id)})))} }
              Button { text:"Export"; tooltipText:"Export the saved version"; onClicked:{root.exporting=true;fileDialog.open()} }
            }
            Ui.TextField { Layout.fillWidth:true; text:root.draft ? root.draft.description || "" : ""; placeholderText:"A short description"; onTextEdited:root.mutate(d=>{d.description=text}) }
            RowLayout {
              Dropdown { Layout.fillWidth:true; options:root.pageOptions; modelValue:root.page?root.page.id:""; onChanged:value=>root.selectPage(root.draft.pages.findIndex(p=>p.id===value)) }
              Button { text:"+ Page"; onClicked:{if(!root.commitFields())return;root.prompt("New page","New page",name=>{root.mutate(d=>d.pages.push({id:"page-"+Date.now(),name:name,widgets:[{id:"clock",type:"clock",weight:1}]}));root.pageIndex=root.draft.pages.length-1;root.widgetIndex=0})} }
              Button { text:"Rename"; onClicked:root.prompt("Rename page",root.page.name,name=>root.mutate(d=>{d.pages[root.pageIndex].name=name})) }
              Button { text:"Remove"; enabled:root.draft && root.draft.pages.length>1; opacity:enabled?1:0.4; onClicked:{if(!root.commitFields())return;root.confirm("Remove this page?","Buttons that link to this page must be updated before saving.",()=>{var old=root.page.id;root.mutate(d=>{d.pages.splice(root.pageIndex,1);if(d.defaultPage===old)d.defaultPage=d.pages[0].id;if(d.fnPage===old)d.fnPage=null});root.pageIndex=0;root.widgetIndex=0})} }
            }
            RowLayout {
              Hint { text:"Default" }
              Dropdown { Layout.fillWidth:true; options:root.pageOptions; modelValue:root.draft?root.draft.defaultPage:""; onChanged:value=>root.mutate(d=>{d.defaultPage=value}) }
              Hint { text:"Hold Fn" }
              Dropdown { Layout.fillWidth:true; options:[{value:"",label:"No alternate page"}].concat(root.pageOptions); modelValue:root.draft?root.draft.fnPage || "":""; onChanged:value=>root.mutate(d=>{d.fnPage=value||null}) }
              Dropdown { options:[{value:"2170",label:"2170 · on-screen Esc"},{value:"2008",label:"2008 · physical Esc"}]; modelValue:String(root.previewWidth); onChanged:value=>{root.previewWidth=Number(value);previewTimer.restart()} }
            }
            ColumnLayout {
              Layout.fillWidth:true; spacing:8
              Hint { text:"LIVE PREVIEW · click to select · drag to reorder" }
              Item {
                id:previewBox
                Layout.fillWidth:true; implicitHeight:40
                Image { id:previewImage; anchors.fill:parent; fillMode:Image.PreserveAspectFit; cache:false; source:root.service && root.service.previewPath ? "file://"+root.service.previewPath+"?v="+root.service.frame : "" }
                Repeater { model:root.boxes
                  Rectangle {
                    id:cell
                    required property var modelData
                    required property int index
                    x:modelData.x/root.previewWidth*previewBox.width
                    width:modelData.w/root.previewWidth*previewBox.width
                    height:previewImage.paintedHeight
                    y:(previewBox.height-height)/2
                    color:"transparent"; border.width:root.widgetIndex===index?2:0; border.color:Color.accent; radius:Style.cornerRadius
                    MouseArea {
                      anchors.fill:parent; cursorShape:Qt.OpenHandCursor
                      property real startX:0
                      onPressed:mouse=>{
                        var index=cell.index, generation=root.previewGeneration
                        startX=mouse.x
                        if(!root.selectWidget(index) || generation!==root.previewGeneration) mouse.accepted=false
                      }
                      onReleased:mouse=>{
                        var position=(cell.x+mouse.x)/previewBox.width*root.previewWidth
                        var target=root.boxes.findIndex(b=>position>=b.x && position<b.x+b.w)
                        if(Math.abs(mouse.x-startX)>10 && target>=0)root.moveWidget(cell.index,target)
                      }
                    }
                  }
                }
              }
              Label { Layout.fillWidth:true; visible:root.previewError!==""; text:root.previewError; color:Color.urgent }
            }
            RowLayout {
              Layout.fillHeight:true; Layout.fillWidth:true; spacing:18
              ColumnLayout {
                Layout.preferredWidth:230; Layout.fillHeight:true
                Controls.ScrollView {
              contentWidth: availableWidth
                  Layout.fillWidth:true; Layout.fillHeight:true; clip:true
                  ColumnLayout { width:parent.width
                    Repeater { model:root.page?root.page.widgets:[]
                      Button { required property var modelData; required property int index; Layout.fillWidth:true; leftAlign:true; text:(index+1)+"  "+(modelData.label || modelData.type); selected:root.widgetIndex===index; onClicked:root.selectWidget(index) }
                    }
                  }
                }
                RowLayout {
                  Ui.Dropdown { id:addType; objectName:"addWidgetType"; Layout.fillWidth:true; options:root.model.widgetTypes || []; value:"button"; onChanged: value => addType.value=value }
                  Button { text:"+"; tooltipText:"Add widget"; onClicked:root.addWidget(addType.value) }
                }
              }
              Controls.ScrollView {
              contentWidth: availableWidth
                Layout.fillHeight:true; Layout.fillWidth:true; clip:true
                ColumnLayout {
                  width:parent.width; spacing:10; visible:Boolean(root.widget!==null)
                  RowLayout {
                    Label { text:root.widget?root.widget.type.toUpperCase():""; font.bold:true; Layout.fillWidth:true }
                    Button { text:"←"; tooltipText:"Move left"; onClicked:root.moveWidget(root.widgetIndex,root.widgetIndex-1) }
                    Button { text:"→"; tooltipText:"Move right"; onClicked:root.moveWidget(root.widgetIndex,root.widgetIndex+1) }
                    Button { text:"Remove"; enabled:root.page && root.page.widgets.length>1; onClicked:{if(!root.commitFields())return;root.mutate(d=>d.pages[root.pageIndex].widgets.splice(root.widgetIndex,1));root.widgetIndex=Math.max(0,root.widgetIndex-1)} }
                  }
                  Ui.TextField { Layout.fillWidth:true; text:root.widget?root.widget.label || "":""; placeholderText:"Widget label"; onTextEdited:root.changeWidget("label",text) }
                  RowLayout {
                    Hint { text:"Width" }
                    DraftField { Layout.preferredWidth:70; text:root.widget?String(root.widget.weight):"1"; validator:DoubleValidator {bottom:0.25;top:12;decimals:2} applyValue:value=>root.changeWidget("weight",Number.fromLocaleString(Qt.locale(validator.locale),value)) }
                    Hint { text:"Relative share of available space"; Layout.fillWidth:true }
                  }
                  Dropdown { visible:Boolean(root.widget && root.widget.type==="slider"); Layout.fillWidth:true; options:root.model.channels || []; modelValue:root.widget?root.widget.channel || "volume":"volume"; onChanged:value=>root.changeWidget("channel",value) }
                  ColumnLayout {
                    visible:Boolean(root.widget && root.widget.type==="button"); Layout.fillWidth:true; spacing:10
                    Hint { text:"ON TAP" }
                    Dropdown { Layout.fillWidth:true; options:["key","media","workspace","launch","command","preset","page"]; modelValue:root.widget && root.widget.action?root.widget.action.type:"key"; onChanged:value=>{if(root.commitFields())root.changeWidget("action",root.defaultAction(value))} }
                    Ui.TextField { Layout.fillWidth:true; visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="key"); text:root.widget && root.widget.action?root.widget.action.key || "":""; placeholderText:"Key (Return, F1, s…)"; onTextEdited:root.actionField("key",text) }
                    RowLayout {
                      visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="key")
                      Repeater { model:["ctrl","alt","shift","logo"]
                        Button { required property string modelData; text:modelData; selected:Boolean(root.widget && root.widget.action && (root.widget.action.modifiers || []).includes(modelData)); onClicked:{var m=(root.widget.action.modifiers||[]).slice();var i=m.indexOf(modelData);if(i<0)m.push(modelData);else m.splice(i,1);root.actionField("modifiers",m)} }
                      }
                    }
                    Dropdown { visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="media"); Layout.fillWidth:true; options:["play-pause","previous","next","stop"]; modelValue:root.widget && root.widget.action?root.widget.action.command || "play-pause":"play-pause"; onChanged:value=>root.actionField("command",value) }
                    DraftField { Layout.fillWidth:true; visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="workspace"); text:root.widget && root.widget.action?String(root.widget.action.workspace||1):"1"; validator:IntValidator {bottom:1;top:99} applyValue:value=>root.actionField("workspace",Number.fromLocaleString(Qt.locale(validator.locale),value)) }
                    Ui.TextField { Layout.fillWidth:true; visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="launch"); text:root.widget && root.widget.action?root.widget.action.desktop || "":""; placeholderText:"Application desktop ID"; onTextEdited:root.actionField("desktop",text) }
                    DraftField { Layout.fillWidth:true; visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="command"); text:root.widget && root.widget.action?JSON.stringify(root.widget.action.argv || []):"[]"; placeholderText:'["program", "argument"]'; applyValue:value=>{var argv=JSON.parse(value);if(!Array.isArray(argv)||!argv.length||argv.some(a=>typeof a!=="string"))throw new Error("Use a JSON array of command arguments");root.actionField("argv",argv)} }
                    Button { visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="command"); text:"Run independently"; selected:Boolean(root.widget && root.widget.action && root.widget.action.detached); tooltipText:"For applications that stay open. Do not wait for exit or capture output."; onClicked:root.actionField("detached",!root.widget.action.detached) }
                    Dropdown { visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="preset"); Layout.fillWidth:true; options:root.presetOptions; modelValue:root.widget && root.widget.action?root.widget.action.preset || "everyday":"everyday"; onChanged:value=>root.actionField("preset",value) }
                    Dropdown { visible:Boolean(root.widget && root.widget.action && root.widget.action.type==="page"); Layout.fillWidth:true; options:root.pageOptions; modelValue:root.widget && root.widget.action?root.widget.action.page || "":""; onChanged:value=>root.actionField("page",value) }
                  }
                  Hint { visible:root.widget && root.widget.type==="button"; text:"HOLD ACTION · optional JSON" }
                  DraftField { visible:root.widget && root.widget.type==="button"; Layout.fillWidth:true; text:root.widget && root.widget.holdAction?JSON.stringify(root.widget.holdAction):""; placeholderText:'{"type":"media","command":"play-pause"}'; applyValue:value=>{var action=value.trim()?JSON.parse(value):null;if(action!==null && (typeof action!=="object"||Array.isArray(action)||!action.type))throw new Error("Hold action must be an action object");root.mutate(d=>{if(action)d.pages[root.pageIndex].widgets[root.widgetIndex].holdAction=action;else delete d.pages[root.pageIndex].widgets[root.widgetIndex].holdAction})} }
                }
              }
            }
            Line {}
            RowLayout {
              Button { text:"Reload"; tooltipText:"Reload saved changes after a stale-edit warning"; onClicked:{var id=root.draft.id;root.guard(()=>root.load(id))} }
              Button { text:"Undo"; enabled:root.history.length>0; onClicked:root.undo() }
              Button { text:"Redo"; enabled:root.future.length>0; onClicked:root.redo() }
              Button { text:"Reset"; tooltipText:"Restore a bundled preset or delete a custom preset"; onClicked:{var p=root.model.presets.find(p=>p.id===root.draft.id);var revision=root.editRevision;root.confirm(p.bundled?"Restore original preset?":"Delete this preset?",p.bundled?"Your edits to this preset will be removed.":"App rules and the default will use Everyday instead.",()=>root.call(p.bundled?"preset.restore":"preset.delete",{id:p.id,replacement:"everyday"},ok=>{if(ok)root.load(p.bundled?p.id:"everyday")},revision))} }
              Item { Layout.fillWidth:true }
              Hint { text:root.dirty?"Unsaved changes":"Saved" }
              Button { text:root.model.trialEnds?"Revert":"Try 20s"; onClicked:root.call(root.model.trialEnds?"revert":"try",root.model.trialEnds?{}:{preset:root.draft,page:root.page.id}) }
              Button { objectName:"savePreset"; text:"Save"; bordered:true; selected:root.dirty; enabled:root.dirty && !root.saving; onClicked:root.save() }
              Button { text:"Apply"; bordered:true; enabled:!root.dirty; tooltipText:root.dirty?"Save your changes first":"Pin this preset"; onClicked:root.call("preset.apply",{id:root.draft.id}) }
            }
          }
        }
        ColumnLayout {
          spacing:14
          Label { text:"A layout for every app"; font.bold:true; font.pixelSize:Style.font.heading }
          Hint { text:"Rules run from top to bottom. Use * for any text, ? for one character, and | for alternatives. A pinned preset pauses switching."; Layout.fillWidth:true }
          Label { text:"Current app: "+(root.model.data.app || "None"); color:Color.accent }
          Controls.ScrollView {
              contentWidth: availableWidth
            Layout.fillWidth:true; Layout.fillHeight:true; clip:true
            ColumnLayout {
              width:parent.width; spacing:16
              Repeater { model:root.ruleDraft
                ColumnLayout {
                  id:ruleRow
                  required property var modelData
                  required property int index
                  Layout.fillWidth:true; spacing:8
                  RowLayout {
                    Ui.ToggleSwitch { checked:ruleRow.modelData.enabled; onToggled:root.editRule(ruleRow.index,"enabled",!checked) }
                    Ui.TextField { Layout.fillWidth:true; text:ruleRow.modelData.name; placeholderText:"Rule name"; onTextEdited:root.editRuleText(ruleRow.modelData.id,"name",text) }
                    Dropdown { Layout.preferredWidth:200; options:root.presetOptions; modelValue:ruleRow.modelData.preset; onChanged:value=>root.editRule(ruleRow.index,"preset",value) }
                    Button { text:"↑"; onClicked:root.moveRule(ruleRow.index,-1) }
                    Button { text:"↓"; onClicked:root.moveRule(ruleRow.index,1) }
                    Button { text:"Remove"; onClicked:{var r=root.copy(root.editedRules);r.splice(ruleRow.index,1);root.ruleTextEdits=({});root.ruleDraft=r} }
                  }
                  RowLayout {
                    Ui.TextField { Layout.fillWidth:true; text:ruleRow.modelData.app; placeholderText:"Application pattern"; onTextEdited:root.editRuleText(ruleRow.modelData.id,"app",text) }
                    Ui.TextField { Layout.fillWidth:true; text:ruleRow.modelData.title; placeholderText:"Window title contains (optional)"; onTextEdited:root.editRuleText(ruleRow.modelData.id,"title",text) }
                  }
                  Line {}
                }
              }
            }
          }
          RowLayout {
            Button { text:"+ Add rule"; bordered:true; onClicked:{var r=root.copy(root.editedRules);r.push({id:"rule-"+Date.now(),name:"New rule",enabled:true,app:root.model.data.app || "*",title:"",preset:"everyday"});root.ruleTextEdits=({});root.ruleDraft=r} }
            Item { Layout.fillWidth:true }
            Button { text:"Discard"; enabled:root.rulesDirty; onClicked:root.loadRules() }
            Button { text:"Save rules"; bordered:true; selected:root.rulesDirty; enabled:root.rulesDirty && !root.savingRules; onClicked:root.saveRules() }
          }
        }
        Controls.ScrollView {
              contentWidth: availableWidth
          clip:true
          ColumnLayout {
            width:parent.width; spacing:20
            Label { text:"Touch Bar"; font.bold:true; font.pixelSize:Style.font.heading }
            Label { text:(root.model.hardware.model || "Detecting hardware")+" · "+(root.model.hardware.kernel || ""); Layout.fillWidth:true }
            Label { visible:Boolean(root.model.hardware.kernelNote); text:root.model.hardware.kernelNote || ""; color:Color.urgent; wrapMode:Text.Wrap; Layout.fillWidth:true }
            Hint { text:"The one-time device helper gives MarchyBar access only to the Touch Bar and the built-in keyboard for Fn and wake detection. Disabling restores the previous firmware mode."; Layout.fillWidth:true }
            RowLayout {
              Button { text:"Set up Touch Bar"; bordered:true; enabled:Boolean(root.service); onClicked:root.service.setupSystem() }
              Button { text:root.model.status==="ready"?"Disable Touch Bar":"Enable Touch Bar"; bordered:true; enabled:Boolean(root.model.hardware.broker); onClicked:root.call(root.model.status==="ready"?"hardware.disable":"hardware.enable",{}) }
              Button { text:"Refresh diagnostics"; onClicked:root.call("diagnostics",{},(ok,d)=>{if(ok)diagnostic.text=JSON.stringify(d,null,2)}) }
            }
            Line {}
            RowLayout { Hint { text:"Default preset"; Layout.preferredWidth:220 } Dropdown {
              id:defaultPreset; Layout.preferredWidth:260; options:root.presetOptions; modelValue:root.model.settings.defaultPreset || "everyday"
              property bool pending:false
              enabled:!pending
              onChanged:value=>{pending=true;root.call("settings.save",{settings:{defaultPreset:value}},()=>{defaultPreset.pending=false;defaultPreset.syncValue()})}
            } }
            RowLayout { Hint { text:"Touch Bar brightness (0–100%)"; Layout.preferredWidth:300 } SettingNumber { id:brightnessField; Layout.preferredWidth:120; savedValue:Math.round((root.model.settings.brightness ?? 128) / 255 * 100); minimum:0; maximum:100; onCommitted:(value,complete)=>root.call("settings.save",{settings:{brightness:Math.round(value / 100 * 255)}},complete) } }
            RowLayout { Hint { text:"Dim after seconds (0 = never)"; Layout.preferredWidth:300 } SettingNumber { objectName:"dimAfter"; Layout.preferredWidth:120; savedValue:root.model.settings.dimAfter ?? 0; maximum:3600; onCommitted:(value,complete)=>root.call("settings.save",{settings:{dimAfter:value}},complete) } }
            RowLayout { Hint { text:"Turn off after seconds (0 = never)"; Layout.preferredWidth:300 } SettingNumber { objectName:"offAfter"; Layout.preferredWidth:120; savedValue:root.model.settings.offAfter ?? 0; maximum:7200; onCommitted:(value,complete)=>root.call("settings.save",{settings:{offAfter:value}},complete) } }
            Hint { text:"Preview supports both T2 Touch Bar widths. MarchyBar discovers the real panel size and touch coordinates when enabled. The original firmware controls return when the desktop locks."; Layout.fillWidth:true }
            Label { id:diagnostic; Layout.fillWidth:true; text:""; font.pixelSize:Style.font.bodySmall }
            Line {}
            Label { text:"Updates"; font.bold:true; font.pixelSize:Style.font.heading }
            Hint { text:"Update MarchyBar on its own, or update Omarchy too. The editor closes during updates. The Touch Bar returns automatically if enabled. Device helper changes still require Set up Touch Bar."; Layout.fillWidth:true }
            RowLayout {
              Button { text:"Update MarchyBar"; bordered:true; enabled:Boolean(root.service); onClicked:root.updateSystem(false) }
              Button { text:"Update with Omarchy"; bordered:true; enabled:Boolean(root.service); onClicked:root.updateSystem(true) }
            }
          }
        }
      }
    }
    Controls.Popup {
      anchors.centerIn:parent; width:parent.width; height:parent.height; visible:root.modalActive
      modal:true; focus:true; padding:0; closePolicy:Controls.Popup.NoAutoClose
      background: Rectangle { color:Qt.rgba(0,0,0,0.6) }
      onOpened: { if(root.promptVisible)promptField.forceActiveFocus();else cancelButton.forceActiveFocus() }
      Rectangle {
        anchors.centerIn:parent; width:520; height:dialogContent.implicitHeight+48; color:Color.background; border.color:Color.accent; radius:Style.cornerRadius
        Keys.onEscapePressed: { root.confirmAction = null; root.promptVisible = false }
        ColumnLayout {
          id:dialogContent; anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top;anchors.margins:24;spacing:16
          Label { text:root.promptVisible?root.promptTitle:root.confirmTitle; font.bold:true; Layout.fillWidth:true }
          Label { visible:!root.promptVisible; text:root.confirmText; Layout.fillWidth:true }
          Ui.TextField { id:promptField; objectName:"promptField"; visible:root.promptVisible; Layout.fillWidth:true; text:root.promptValue; onTextEdited:root.promptValue=text; onAccepted:if(root.promptValue.trim()){var action=root.promptAction;root.promptVisible=false;action(root.promptValue.trim())} }
          RowLayout {
            Item { Layout.fillWidth:true }
            Button { id:cancelButton; text:"Cancel"; onClicked:{root.confirmAction=null;root.promptVisible=false} }
            Button { text:root.promptVisible?"Create":"Continue"; bordered:true; onClicked:{if(root.promptVisible){if(!root.promptValue.trim())return;var action=root.promptAction;root.promptVisible=false;action(root.promptValue.trim())}else{var action=root.confirmAction;root.confirmAction=null;action()}} }
          }
        }
      }
    }
  }
}

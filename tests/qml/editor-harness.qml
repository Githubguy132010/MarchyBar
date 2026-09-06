import QtQuick
import Quickshell

ShellRoot {
  id: testCase
  property var fixture: ({schemaVersion:1,id:"test",name:"Test",description:"",defaultPage:"main",fnPage:null,pages:[{id:"main",name:"Main",widgets:[{id:"clock",type:"clock",weight:1},{id:"battery",type:"battery",weight:1}]}]})
  QtObject {
    id: backend
    property var snapshot: ({presets:[testCase.fixture],rules:[],settings:{},data:{},hardware:{},revision:"r1",widgetTypes:["button","slider","clock"],channels:["volume"]})
    property var lastRequest: null
    property int presentations: 0
    property bool editorOpen: false
    property string error: ""
    property string previewPath: ""
    property int frame: 0
    function heartbeat() {}
    function request(method, params, callback, revision) {
      lastRequest = {method:method,params:params}
      if(method==="editor.present") presentations++
      if(method==="preview" && callback) callback(true,{boxes:[],geometry:{width:2170,height:60}})
      if(method==="preset.save" && callback) callback(true,params.preset)
    }
  }
  Editor { id: editor; service:backend }
  Service { id: service; shell:host; editorOpen:backend.editorOpen }
  QtObject {
    id: host
    function firstPartyServiceFor(id) { return null }
    function summon(id, payload) { testCase.compare(id,"marchybar.touchbar"); editor.open(payload) }
    function hide(id) { testCase.compare(id,"marchybar.touchbar"); editor.close() }
  }
  function compare(a,b) { if(a!==b) throw new Error("Expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)) }
  function verify(value) { if(!value) throw new Error("Assertion failed") }
  Timer {
    interval:150;running:true
    onTriggered: {
      try {
        for(var name of ["test_draftIsolationAndUndo","test_addAndMoveWidget","test_discardGuardAndSave","test_dropdownChangesWidgetType","test_brightnessDraftAndPercent","test_hamburgerToggle","test_hamburgerDiscardGuard"]) { testCase.init();testCase[name]();console.log("MARCHYBAR_QML_PASS",name) }
        closeCheck.start()
      } catch(e) { console.error("MARCHYBAR_QML_FAILED",e.stack || String(e)); Qt.quit() }
    }
  }
  Timer {
    id: closeCheck
    interval:300
    onTriggered: {
      try {
        testCase.compare(backend.presentations,0)
        console.log("MARCHYBAR_QML_PASS","test_noPresentationAfterRapidClose")
        console.log("MARCHYBAR_QML_ALL_PASSED")
      } catch(e) { console.error("MARCHYBAR_QML_FAILED",e.stack || String(e)) }
      Qt.quit()
    }
  }
  function init() { editor.draft=null;editor.savedDraft="";editor.load("test") }
  function tapHamburger() { service.receive(JSON.stringify({event:"openEditor"})); compare(service.error,"") }
  function test_hamburgerToggle() {
    tapHamburger();compare(editor.opened,true);compare(backend.editorOpen,true)
    tapHamburger();compare(editor.opened,false);compare(backend.editorOpen,false)
    compare(backend.lastRequest.method,"preview.close")
    tapHamburger();compare(editor.opened,true);compare(backend.editorOpen,true)
    tapHamburger();compare(editor.opened,false);compare(backend.editorOpen,false)
  }
  function test_hamburgerDiscardGuard() {
    tapHamburger()
    editor.changeWidget("label","Unsaved")
    tapHamburger();verify(editor.confirmAction!==null)
    compare(editor.opened,true);compare(backend.editorOpen,true)
    editor.confirmAction=null
    compare(editor.dirty,true);compare(editor.opened,true)
    tapHamburger();verify(editor.confirmAction!==null)
    editor.confirmAction();editor.confirmAction=null
    compare(editor.opened,false);compare(backend.editorOpen,false)
    compare(editor.draft,null);compare(backend.lastRequest.method,"preview.close")
  }
  function test_draftIsolationAndUndo() {
    compare(editor.dirty,false)
    editor.widgetIndex=0
    editor.changeWidget("label","Changed")
    compare(editor.draft.pages[0].widgets[0].label,"Changed")
    compare(fixture.pages[0].widgets[0].label,undefined)
    compare(editor.dirty,true)
    editor.undo();compare(editor.dirty,false)
    editor.redo();compare(editor.draft.pages[0].widgets[0].label,"Changed")
  }
  function test_addAndMoveWidget() {
    editor.addWidget("slider")
    compare(editor.page.widgets.length,3)
    compare(editor.widget.channel,"volume")
    editor.moveWidget(2,0)
    compare(editor.page.widgets[0].type,"slider")
    compare(editor.widgetIndex,0)
  }
  function test_discardGuardAndSave() {
    editor.changeWidget("label","Changed")
    var called=false;editor.guard(()=>{called=true})
    compare(called,false);verify(editor.confirmAction!==null)
    editor.confirmAction();editor.confirmAction=null;compare(called,true);compare(editor.draft,null)
    editor.load("test");editor.changeWidget("label","Saved");editor.save();compare(editor.dirty,false)
  }
  function test_brightnessDraftAndPercent() {
    backend.snapshot = Object.assign({},backend.snapshot,{settings:{brightness:128}})
    var field=editor.brightnessEditor
    compare(field.text,"50")
    field.text="7";field.textEdited()
    backend.snapshot=Object.assign({},backend.snapshot,{settings:{brightness:200},data:{cpu:15}})
    compare(field.text,"7")
    field.text="75";field.textEdited();field.editingFinished()
    compare(backend.lastRequest.method,"settings.save")
    compare(backend.lastRequest.params.settings.brightness,191)
    field.text="0";field.textEdited();field.editingFinished()
    compare(backend.lastRequest.params.settings.brightness,0)
    backend.snapshot=Object.assign({},backend.snapshot,{settings:{brightness:0}})
    compare(field.text,"0")
    field.text="101";field.textEdited();verify(!field.acceptableInput)
    field.editing=false
  }
  function test_dropdownChangesWidgetType() {
    var dropdown=editor.widgetTypeSelector
    verify(dropdown!==null)
    dropdown.changed("slider")
    compare(dropdown.value,"slider")
    editor.addWidget(dropdown.value)
    compare(editor.widget.type,"slider")
  }
}

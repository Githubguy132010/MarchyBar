import QtQuick
import Quickshell
import QtTest
import QtQuick.Window

ShellRoot {
  id: suite
  property var fixture: ({schemaVersion:1,id:"test",name:"Test",description:"",bundled:true,customized:true,defaultPage:"main",fnPage:null,pages:[{id:"main",name:"Main",widgets:[{id:"volume",type:"slider",channel:"volume",weight:2},{id:"keyboard",type:"slider",channel:"keyboard",weight:1},{id:"button",type:"button",weight:1,action:{type:"workspace",workspace:1}}]},{id:"other",name:"Other",widgets:[{id:"clock",type:"clock",weight:1}]}]})
  QtObject {
    id: backend
    property var snapshot: ({presets:[],rules:[],settings:{},data:{},hardware:{}})
    property var requests: []
    property var held: []
    property bool holdWrites: false
    property bool holdPreviews: false
    property bool rejectSettings: false
    property bool editorOpen: false
    property string error: ""
    property string previewPath: ""
    property int frame: 0
    property var controlService: null
    function heartbeat() {}
    function request(method, params, callback, revision) {
      if(controlService) { controlService.request(method,params,callback,revision);return }
      var h = {method:method,params:JSON.parse(JSON.stringify(params)),callback:callback,revision:revision === undefined ? snapshot.revision : revision}
      requests = requests.concat([h])
      if ((holdWrites && ["preset.save","rules.save","settings.save"].includes(method)) || (holdPreviews && method==="preview")) { held=held.concat([h]); return }
      finish(h)
    }
    function finish(h, success) {
      var next=JSON.parse(JSON.stringify(snapshot)), ok=success!==false, data=true
      if (["preset.restore","preset.delete","preset.save","rules.save","settings.save"].includes(h.method)) ok=ok && h.revision===snapshot.revision
      if(h.method==="settings.save" && rejectSettings) ok=false
      if(ok) {
        if(h.method==="preset.save") { next.presets=next.presets.map(p=>p.id===h.params.preset.id?h.params.preset:p); data=h.params.preset }
        if(h.method==="rules.save") next.rules=h.params.rules
        if(h.method==="settings.save") Object.assign(next.settings,h.params.settings)
        if(h.method==="preview") data={boxes:h.params.preset.pages.find(p=>p.id===h.params.page).widgets.map((w,i)=>({id:w.id,x:i*700,w:700}))}
        if(h.method.endsWith(".save")) { next.revision="r"+(Number(snapshot.revision.slice(1))+1);snapshot=next }
      }
      error=ok?"":"Rejected write"
      if(h.callback) h.callback(ok,ok?data:error)
    }
    function release(ok) { var h=held[0];held=held.slice(1);finish(h,ok) }
  }
  Editor { id: editor; service:backend }
  ServiceHarness { id: service }
  QtObject {
    id: shellMock
    property int summons: 0
    property int hides: 0
    function summon(id,payload) { summons++;editor.open(payload) }
    function hide(id) { hides++;editor.close() }
  }
  TestCase {
    id: tests
    name: "MarchyBarRegressions"
    when: false
    function compare(actual,expected) { if(actual!==expected) throw new Error("Expected "+JSON.stringify(expected)+", got "+JSON.stringify(actual)) }
    function verify(value) { if(!value) throw new Error("Assertion failed") }
    function child(item, predicate) {
      if(predicate(item)) return item
      for(var c of (item.children || [])) { var found=child(c,predicate);if(found)return found }
      return null
    }
    function content() { return editor.brightnessEditor.Window.window.contentItem }
    function field(placeholder) { return child(content(),x=>x.placeholderText===placeholder) }
    function button(text) { return child(content(),x=>x.text===text && typeof x.clicked==="function") }
    function dropdown(value) { return child(content(),x=>x.value===value && typeof x.open==="function" && x.options!==undefined) }
    function type(item,text) { item.forceActiveFocus();keyClick(Qt.Key_A,Qt.ControlModifier);if(!text.length)keyClick(Qt.Key_Backspace);for(var i=0;i<text.length;i++)keyClick(text[i]) }
    function select(d,index) { d.open();wait(10);for(var i=0;i<d.options.length;i++)keyClick(Qt.Key_Up);for(var j=0;j<index;j++)keyClick(Qt.Key_Down);keyClick(Qt.Key_Return) }
    function widthField() { return child(content(),x=>x.validator!==undefined && x.validator!==null && x.validator.decimals===2) }
    function writes(method) { return backend.requests.filter(r=>r.method===method) }
    function waitFor(condition, message) {
      var deadline=Date.now()+5000
      while(!condition() && Date.now()<deadline)wait(10)
      if(!condition())throw new Error(message)
    }
    function readyPreview() {
      var image=child(content(),x=>x.fillMode===Image.PreserveAspectFit)
      // Data URLs load asynchronously too. Elapsed time does not imply painted geometry.
      image.source="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2170' height='60'%3E%3C/svg%3E"
      waitFor(()=>image.status===Image.Ready && image.paintedHeight>0,"Preview fixture did not load and paint")
      editor.preview()
      waitFor(()=>{
        var cell=child(content(),x=>x.cursorShape===Qt.OpenHandCursor)
        return cell && cell.width>0 && cell.height>0
      },"Preview hit area did not acquire geometry")
      return image
    }
    function init() {
      editor.confirmAction=null;editor.promptVisible=false;editor.draft=null;editor.savedDraft="";editor.ruleDraft=[];editor.rulesBaseline="[]"
      backend.controlService=null;backend.holdWrites=false;backend.holdPreviews=false;backend.rejectSettings=false;backend.held=[];backend.requests=[];backend.error=""
      backend.snapshot={presets:[editor.copy(suite.fixture),Object.assign(editor.copy(suite.fixture),{id:"second",name:"Second",bundled:false})],rules:[{id:"browser",name:"Web browsers",enabled:true,app:"*firefox*",title:"",preset:"test"}],settings:{brightness:128,dimAfter:30,offAfter:3600,defaultPreset:"test"},data:{},hardware:{},revision:"r1",widgetTypes:["button","slider","clock"],channels:["volume","brightness","keyboard"]}
      editor.tab=0;editor.load("test");editor.loadRules();editor.open();tests.parent=content();wait(30)
      service.shell=shellMock;service.pending={};service.connected=false;service.editorOpen=false;shellMock.summons=0;shellMock.hides=0
      editor.brightnessEditor.maximum=100;editor.brightnessEditor.editing=false;editor.brightnessEditor.pending=false;editor.brightnessEditor.text="50"
    }
    function test_issue1_menuToggle() {
      service.receive(JSON.stringify({event:"openEditor"}));service.editorOpen=true
      service.receive(JSON.stringify({event:"openEditor"}))
      compare(shellMock.summons,1);compare(shellMock.hides,1);compare(editor.opened,false)
      wait(220);compare(writes("editor.present").length,0)
    }
    function test_issue4_presetAck() {
      backend.holdWrites=true;editor.mutate(d=>d.name="Submitted A");editor.save();editor.mutate(d=>d.name="Unsaved B");backend.release()
      compare(backend.snapshot.presets[0].name,"Submitted A");compare(editor.draft.name,"Unsaved B");verify(editor.dirty)
      var switched=false;editor.guard(()=>{switched=true});compare(switched,false)
    }
    function test_issue4_rulesAck() {
      backend.holdWrites=true;editor.editRule(0,"name","Submitted A");button("Save rules").clicked();editor.editRule(0,"name","Unsaved B");backend.release()
      compare(backend.snapshot.rules[0].name,"Submitted A");compare(editor.ruleDraft[0].name,"Unsaved B");verify(editor.rulesDirty)
    }
    function test_issue9_reset_data() { return [{tag:"restore",id:"test"},{tag:"delete",id:"second"}] }
    function test_issue9_reset(data) {
      editor.load(data.id);button("Reset").clicked()
      var next=editor.copy(backend.snapshot);next.revision="r2";next.presets[0].name="Concurrent override";backend.snapshot=next
      editor.confirmAction()
      var req=backend.requests[backend.requests.length-1];compare(req.revision,"r1");compare(backend.error,"Rejected write");compare(backend.snapshot.presets[0].name,"Concurrent override")
    }
    function test_issue10_failedSetting() {
      editor.tab=2;var f=editor.brightnessEditor;backend.rejectSettings=true
      type(f,"70");keyClick(Qt.Key_Return);compare(f.text,"70");verify(f.editing)
      backend.rejectSettings=false;keyClick(Qt.Key_Return);compare(writes("settings.save").length,2);compare(f.editing,false)
    }
    function test_issue10_disconnectedCallback() { var called=false;service.request("settings.save",{},ok=>{called=true;compare(ok,false)});verify(called) }
    function test_issue14_locale_data() { return [{tag:"en_US",locale:"en_US",text:"1,000"},{tag:"de_DE",locale:"de_DE",text:"1.000"},{tag:"ungrouped",locale:"en_US",text:"1000"},{tag:"zero",locale:"en_US",text:"0"},{tag:"bound",locale:"en_US",text:"3600"}] }
    function test_issue14_locale(data) {
      editor.tab=2;var f=child(content(),x=>x.objectName==="dimAfter");f.validator.locale=data.locale
      type(f,data.text);verify(f.acceptableInput);keyClick(Qt.Key_Return)
      compare(writes("settings.save")[0].params.settings.dimAfter, data.tag==="zero"?0:data.tag==="bound"?3600:1000)
    }
    function test_issue15_pendingRules_data() { return ["Rule name","Application pattern","Window title contains (optional)"].map(p=>({tag:p,placeholder:p})) }
    function test_issue15_pendingRules(data) {
      editor.tab=1;wait(10);var f=field(data.placeholder);type(f,"Pending text")
      var next=editor.copy(backend.snapshot);next.rules[0].title="External change";next.revision="r2";backend.snapshot=next;wait(10)
      compare(f.text,"Pending text");verify(f.activeFocus);verify(editor.rulesDirty);compare(editor.rulesRevision,"r1")
    }
    function test_issue20_modal() {
      var f=field("Preset name");type(f,"Name before dialog");keyClick(Qt.Key_Escape);verify(editor.confirmAction!==null)
      keyClick(Qt.Key_A,Qt.ControlModifier);keyClick(Qt.Key_X);keyClick(Qt.Key_S,Qt.ControlModifier)
      compare(editor.draft.name,"Name before dialog");compare(writes("preset.save").length,0);verify(!f.activeFocus)
    }
    function test_issue21_saveWidth() {
      var f=child(content(),x=>x.validator!==undefined && x.validator!==null && x.validator.decimals===2)
      type(f,"8.5");keyClick(Qt.Key_S,Qt.ControlModifier)
      compare(writes("preset.save").length,1);compare(writes("preset.save")[0].params.preset.pages[0].widgets[0].weight,8.5);compare(editor.dirty,false)
    }
    function test_issue21_dirtyWidth() {
      editor.mutate(d=>d.name="Renamed");type(widthField(),"8.5");keyClick(Qt.Key_S,Qt.ControlModifier)
      compare(writes("preset.save")[0].params.preset.pages[0].widgets[0].weight,8.5);compare(editor.dirty,false)
    }
    function test_issue21_escapeSetting() {
      editor.tab=2;var f=editor.brightnessEditor;type(f,"7");keyClick(Qt.Key_Escape)
      verify(editor.opened);compare(f.text,"50");compare(f.editing,false);keyClick(Qt.Key_Tab);compare(writes("settings.save").length,0)
    }
    function test_issue25_dropdown() {
      var d=dropdown("volume");d.open();wait(10);keyClick(Qt.Key_Down);keyClick(Qt.Key_Return);compare(editor.widget.channel,"brightness")
      editor.undo();compare(editor.widget.channel,"volume");compare(d.value,"volume");editor.widgetIndex=1;compare(d.value,"keyboard")
    }
    function test_issue26_bounds() { editor.moveWidget(11,0);compare(editor.page.widgets.length,3);verify(editor.page.widgets[0]!==undefined) }
    function test_issue26_stalePreview() {
      editor.preview();compare(editor.boxes.length,3);backend.holdPreviews=true;editor.preview();editor.pageIndex=1
      compare(editor.boxes.length,0);backend.release();compare(editor.boxes.length,0);compare(editor.page.widgets.length,1)
    }
    function test_issue1_dirtyToggle() {
      editor.mutate(d=>d.name="Unsaved");service.editorOpen=true;service.receive(JSON.stringify({event:"openEditor"}))
      compare(shellMock.hides,1);verify(editor.opened);verify(editor.confirmAction!==null);compare(editor.draft.name,"Unsaved")
      keyClick(Qt.Key_Escape);verify(editor.opened);verify(!editor.confirmAction);verify(!editor.modalActive)
    }
    function test_issue4_navigation_data() { return [{tag:"other",id:"second"},{tag:"same",id:"test"}] }
    function test_issue4_navigation(data) {
      backend.holdWrites=true;editor.mutate(d=>d.name="Submitted A");editor.save();editor.load(data.id);editor.mutate(d=>d.name="New draft")
      var baseline=editor.savedDraft,revision=editor.editRevision;backend.release()
      compare(editor.savedDraft,baseline);compare(editor.editRevision,revision);compare(editor.draft.name,"New draft");verify(editor.dirty)
    }
    function test_issue4_rulesReload() {
      backend.holdWrites=true;editor.editRule(0,"name","Submitted A");button("Save rules").clicked();editor.loadRules();editor.editRule(0,"name","New draft")
      var baseline=editor.rulesBaseline;backend.release();compare(editor.rulesBaseline,baseline);compare(editor.ruleDraft[0].name,"New draft");verify(editor.rulesDirty)
    }
    function test_issue4_pendingTextAndFailure() {
      backend.holdWrites=true;editor.mutate(d=>d.name="Submitted A");editor.save();backend.release(false);verify(editor.dirty)
      editor.save();type(widthField(),"8.5");backend.release();verify(editor.dirty);compare(widthField().text,"8.5")
      editor.save();backend.release();compare(editor.dirty,false);compare(backend.snapshot.presets[0].pages[0].widgets[0].weight,8.5)
    }
    function test_issue4_rulesTypingAfterSend() {
      editor.tab=1;editor.editRule(0,"name","Submitted A");backend.holdWrites=true;button("Save rules").clicked()
      var f=field("Rule name");type(f,"Unsaved B");backend.release();compare(f.text,"Unsaved B");verify(f.activeFocus);verify(editor.rulesDirty)
      compare(editor.editedRules[0].name,"Unsaved B");compare(backend.snapshot.rules[0].name,"Submitted A")
    }
    function test_issue9_unchanged_data() { return [{tag:"restore",id:"test"},{tag:"delete",id:"second"}] }
    function test_issue9_unchanged(data) {
      editor.load(data.id);button("Reset").clicked();editor.confirmAction();compare(backend.error,"")
      var req=backend.requests[backend.requests.length-1];compare(req.revision,"r1");compare(req.method,data.id==="test"?"preset.restore":"preset.delete")
    }
    function test_issue10_rejectThenUnrelatedSave() {
      editor.tab=2;var dim=child(content(),x=>x.objectName==="dimAfter"), off=child(content(),x=>x.objectName==="offAfter")
      backend.rejectSettings=true;type(dim,"70");keyClick(Qt.Key_Return);verify(dim.editing)
      // Move focus without retrying on blur, then allow the unrelated write.
      off.forceActiveFocus();backend.rejectSettings=false;type(off,"90");keyClick(Qt.Key_Return)
      compare(backend.error,"");compare(dim.text,"70");verify(dim.editing);compare(backend.snapshot.settings.dimAfter,30)
      dim.forceActiveFocus();keyClick(Qt.Key_Return);compare(backend.snapshot.settings.dimAfter,70);compare(dim.editing,false)
    }
    function test_issue10_disconnectAndNewEdit() {
      editor.tab=2;var f=editor.brightnessEditor;backend.holdWrites=true
      type(f,"70");keyClick(Qt.Key_Return);type(f,"80");backend.release(false);verify(f.editing);compare(f.text,"80")
      keyClick(Qt.Key_Return);backend.release();compare(f.editing,false);compare(backend.snapshot.settings.brightness,204)
    }
    function test_issue10_realServiceDisconnect() {
      editor.tab=2;backend.controlService=service;var f=editor.brightnessEditor
      type(f,"70");keyClick(Qt.Key_Return);verify(f.editing);verify(!f.pending)
      service.connected=true;service.transport=transportFactory.createObject(service);keyClick(Qt.Key_Return);verify(f.pending)
      service.reconnect();verify(!f.pending);verify(f.editing);compare(f.text,"70")
      backend.controlService=null
    }
    function test_issue14_intermediate() {
      editor.tab=2;var f=child(content(),x=>x.objectName==="dimAfter");type(f,"");verify(!f.acceptableInput);keyClick(Qt.Key_Return);compare(writes("settings.save").length,0)
      type(f,"4000");verify(!f.acceptableInput);keyClick(Qt.Key_Return);compare(writes("settings.save").length,0)
    }
    function test_issue15_telemetryAndCleanRefresh() {
      editor.tab=1;var f=field("Rule name");type(f,"Pending");var next=editor.copy(backend.snapshot);next.data.cpu=25;next.revision="r2";backend.snapshot=next
      compare(f.text,"Pending");verify(f.activeFocus);compare(editor.rulesRevision,"r1")
      editor.loadRules();next=editor.copy(backend.snapshot);next.rules[0].name="External";next.revision="r3";backend.snapshot=next;wait(10)
      compare(field("Rule name").text,"External");compare(editor.rulesRevision,"r3");compare(editor.rulesDirty,false)
    }
    function test_issue20_modalKeysAndRestore() {
      var f=field("Preset name");type(f,"Local name");keyClick(Qt.Key_Escape);wait(10)
      var before=JSON.stringify(editor.draft), requests=backend.requests.length
      for(var i=0;i<8;i++) { keyClick(Qt.Key_Tab);verify(content().Window.window.activeFocusItem!==f) }
      keyClick(Qt.Key_Backtab);keyClick(Qt.Key_Z,Qt.ControlModifier);keyClick(Qt.Key_Z,Qt.ControlModifier|Qt.ShiftModifier);keyClick(Qt.Key_S,Qt.ControlModifier)
      compare(JSON.stringify(editor.draft),before);compare(backend.requests.length,requests)
      keyClick(Qt.Key_Escape);wait(10);verify(!editor.confirmAction);verify(!editor.modalActive);verify(f.activeFocus);compare(editor.draft.name,"Local name")
    }
    function test_issue20_promptAndKeyboardButtons() {
      var called="";editor.prompt("Name","Initial",v=>{called=v});wait(10);var f=field("Preset name")
      keyClick(Qt.Key_S,Qt.ControlModifier);keyClick(Qt.Key_Z,Qt.ControlModifier);compare(writes("preset.save").length,0);verify(!f.activeFocus)
      var prompt=child(content(),x=>x.objectName==="promptField");type(prompt,"New name");keyClick(Qt.Key_Return);compare(called,"New name")
      var continued=false;editor.confirm("Continue?","Test",()=>{continued=true});wait(10)
      keyClick(Qt.Key_Tab);keyClick(Qt.Key_Space);verify(continued);verify(!editor.confirmAction)
    }
    function test_issue21_fields_data() { return [{tag:"width",kind:"width",text:"8.5",valid:true},{tag:"invalidWidth",kind:"width",text:"",valid:false},{tag:"workspace",kind:"workspace",text:"9",valid:true},{tag:"invalidWorkspace",kind:"workspace",text:"0",valid:false},{tag:"argv",kind:"argv",text:'["echo","ok"]',valid:true},{tag:"invalidArgv",kind:"argv",text:"[",valid:false},{tag:"nonArray",kind:"argv",text:"{}",valid:false},{tag:"hold",kind:"hold",text:'{"type":"media","command":"stop"}',valid:true},{tag:"invalidHold",kind:"hold",text:"{",valid:false}] }
    function test_issue21_fields(data) {
      var f
      if(data.kind==="width") f=widthField()
      else {
        editor.widgetIndex=2
        if(data.kind==="workspace") f=child(content(),x=>x.validator && x.validator.top===99)
        else if(data.kind==="argv") { editor.changeWidget("action",{type:"command",argv:["old"]});f=field('["program", "argument"]') }
        else f=field('{"type":"media","command":"play-pause"}')
      }
      type(f,data.text);keyClick(Qt.Key_S,Qt.ControlModifier)
      compare(writes("preset.save").length,data.valid?1:0)
      if(!data.valid) { verify(editor.dirty);verify(f.activeFocus);compare(f.text,data.text);return }
      var widget=writes("preset.save")[0].params.preset.pages[0].widgets[editor.widgetIndex]
      if(data.kind==="width")compare(widget.weight,8.5)
      if(data.kind==="workspace")compare(widget.action.workspace,9)
      if(data.kind==="argv")compare(JSON.stringify(widget.action.argv),data.text)
      if(data.kind==="hold")compare(JSON.stringify(widget.holdAction),data.text)
      compare(editor.dirty,false)
    }
    function test_issue25_allSelectors() {
      var d=dropdown("volume");select(d,1);editor.undo();compare(d.value,"volume");editor.redo();compare(d.value,"brightness");editor.load("second");compare(d.value,"volume")
      editor.widgetIndex=2;d=dropdown("workspace");select(d,1);compare(editor.widget.action.type,"media");editor.undo();editor.widgetIndex=2;compare(d.value,"workspace")
      var defaults=[];function collect(item) { if(item.modelValue==="main" && item.options)defaults.push(item);for(var c of item.children || [])collect(c) };collect(content())
      d=defaults[1];select(d,1);compare(editor.draft.defaultPage,"other");editor.undo();compare(d.value,"main")
      d=child(content(),x=>x.options && x.options[0] && x.options[0].label==="No alternate page");select(d,2);compare(editor.draft.fnPage,"other");editor.undo();compare(d.value,"")
      editor.tab=2;d=child(content(),x=>x.modelValue==="test" && x.parent && x.parent.children[0].text==="Default preset");select(d,1);compare(backend.snapshot.settings.defaultPreset,"second")
      var next=editor.copy(backend.snapshot);next.settings.defaultPreset="test";backend.snapshot=next;compare(d.value,"test")
    }
    function test_issue26_mouseDrag() {
      var image=readyPreview(), cell=child(content(),x=>x.cursorShape===Qt.OpenHandCursor)
      var start=editor.page.widgets[0].id
      mousePress(cell,10,cell.height/2);verify(cell.pressed);editor.preview();wait(10)
      compare(child(content(),x=>x.cursorShape===Qt.OpenHandCursor),cell);verify(cell.pressed)
      mouseMove(cell,cell.width*1.5,cell.height/2);mouseRelease(cell,cell.width*1.5,cell.height/2)
      compare(editor.page.widgets[1].id,start);compare(editor.page.widgets.length,3)
      readyPreview();cell=child(content(),x=>x.cursorShape===Qt.OpenHandCursor);mousePress(cell,10,cell.height/2);verify(cell.pressed)
      backend.holdPreviews=true;editor.pageIndex=1;wait(10);mouseRelease(image,10,image.height/2)
      compare(editor.page.widgets.length,1);compare(editor.page.widgets[0].id,"clock");compare(editor.boxes.length,0)
    }
    function test_issue26_sameLengthAndPreset() {
      editor.mutate(d=>d.pages[1].widgets=editor.copy(d.pages[0].widgets).map(w=>Object.assign(w,{id:"other-"+w.id})))
      editor.preview();backend.holdPreviews=true;editor.preview();editor.pageIndex=1;compare(editor.boxes.length,0);backend.release();compare(editor.boxes.length,0)
      editor.preview();editor.load("second");backend.release();compare(editor.boxes.length,0);compare(editor.dirty,false)
      backend.holdPreviews=false;editor.preview();compare(editor.boxes.length,3)
    }
    function test_review_previewSelection_data() { return [{tag:"valid",text:"8.5",valid:true},{tag:"invalid",text:"",valid:false}] }
    function test_review_previewSelection(data) {
      var image=readyPreview(), f=widthField();type(f,data.text)
      mouseClick(image,1000/2170*image.width,image.height/2)
      compare(editor.widgetIndex,data.valid?1:0)
      if(data.valid) {
        editor.save();compare(backend.snapshot.presets[0].pages[0].widgets[0].weight,8.5);compare(editor.page.widgets[1].weight,1)
      } else { compare(f.text,"");verify(f.activeFocus);editor.save();compare(writes("preset.save").length,0) }
    }
    function test_review_cleanRulesRevision_data() { return [{tag:"settings",method:"settings.save"},{tag:"preset",method:"preset.save"}] }
    function test_review_cleanRulesRevision(data) {
      editor.tab=1;var f=field("Rule name");f.forceActiveFocus()
      if(data.method==="settings.save")backend.request(data.method,{settings:{dimAfter:40}})
      else { editor.mutate(d=>d.name="Saved preset");editor.save() }
      compare(editor.rulesRevision,"r2");compare(field("Rule name"),f);verify(f.activeFocus)
      type(f,"Rule after save");editor.saveRules();compare(backend.error,"");compare(backend.snapshot.rules[0].name,"Rule after save")
    }
    function test_review_dirtyRulesRevision() {
      editor.tab=1;type(field("Rule name"),"Local rule");backend.request("settings.save",{settings:{dimAfter:40}})
      compare(editor.rulesRevision,"r1");editor.saveRules();compare(backend.error,"Rejected write");verify(editor.rulesDirty);compare(editor.editedRules[0].name,"Local rule")
    }
    function test_review_rejectedDefault_data() { return [{tag:"rejected",disconnected:false},{tag:"disconnected",disconnected:true}] }
    function test_review_rejectedDefault(data) {
      editor.tab=2;var d=child(content(),x=>x.modelValue==="test" && x.parent && x.parent.children[0].text==="Default preset")
      backend.rejectSettings=true;if(data.disconnected)backend.controlService=service
      select(d,1);compare(d.modelValue,"test");compare(d.value,"test");compare(backend.snapshot.settings.defaultPreset,"test")
      backend.controlService=null;backend.rejectSettings=false;select(d,1);compare(d.value,"second");compare(backend.snapshot.settings.defaultPreset,"second")
    }
    function test_review_selectionPaths_data() {
      var rows=[];for(var path of ["list","page","add","move","undo"])for(var valid of [true,false])rows.push({tag:path+(valid?" valid":" invalid"),path:path,valid:valid});return rows
    }
    function test_review_selectionPaths(data) {
      if(data.path==="undo")editor.mutate(d=>d.name="Renamed")
      var f=widthField();type(f,data.valid?"8.5":"")
      if(data.path==="list") { var b=button("2  slider");mouseClick(b,b.width/2,b.height/2) }
      if(data.path==="page") { select(dropdown("main"),1);wait(10) }
      if(data.path==="add") { var b=button("+");mouseClick(b,b.width/2,b.height/2) }
      if(data.path==="move") { var b=button("\u2192");mouseClick(b,b.width/2,b.height/2) }
      if(data.path==="undo") { var b=button("Undo");mouseClick(b,b.width/2,b.height/2) }
      if(!data.valid) {
        compare(editor.pageIndex,0);compare(editor.widgetIndex,0);compare(editor.page.widgets.length,3);compare(editor.page.widgets[0].weight,2)
        compare(f.text,"");verify(editor.dirty);verify(f.activeFocus)
        if(data.path==="page")compare(dropdown("main").value,"main")
      } else {
        var original=editor.draft.pages[0].widgets.find(w=>w.id==="volume")
        compare(original.weight,data.path==="undo"?2:8.5)
        if(data.path==="page")compare(editor.pageIndex,1)
        if(data.path==="list")compare(editor.widgetIndex,1)
        if(data.path==="add")compare(editor.page.widgets.length,4)
        if(data.path==="move")compare(editor.page.widgets[1].id,"volume")
      }
    }
    function test_review_actionSelectionBlocked() {
      editor.widgetIndex=2;var d=dropdown("workspace"), f=child(content(),x=>x.validator && x.validator.top===99)
      type(f,"0");select(d,1);wait(10)
      compare(editor.widget.action.type,"workspace");compare(d.value,"workspace");compare(f.text,"0");verify(f.activeFocus)
    }
    function test_review_pendingRulesRevision() {
      editor.tab=1;editor.editRule(0,"name","Submitted");backend.holdWrites=true;editor.saveRules()
      editor.editRule(0,"name","Web browsers");verify(!editor.rulesDirty)
      var next=editor.copy(backend.snapshot);next.revision="r2";backend.snapshot=next
      compare(editor.rulesRevision,"r1");backend.release();compare(backend.error,"Rejected write");compare(editor.rulesRevision,"r1")
    }
    function test_review_pendingDefault_data() { return [{tag:"success",ok:true},{tag:"failure",ok:false}] }
    function test_review_pendingDefault(data) {
      editor.tab=2;var d=child(content(),x=>x.modelValue==="test" && x.parent && x.parent.children[0].text==="Default preset")
      backend.holdWrites=true;select(d,1);verify(!d.enabled);wait(10);compare(d.value,"test")
      backend.release(data.ok);verify(d.enabled);compare(d.value,data.ok?"second":"test")
      var next=editor.copy(backend.snapshot);next.settings.defaultPreset=data.ok?"test":"second";backend.snapshot=next
      compare(d.value,next.settings.defaultPreset)
    }
    function test_review_defaultDisconnectAfterSend() {
      editor.tab=2;var d=child(content(),x=>x.modelValue==="test" && x.parent && x.parent.children[0].text==="Default preset")
      backend.controlService=service;service.connected=true;service.transport=transportFactory.createObject(service)
      select(d,1);verify(!d.enabled);service.reconnect();verify(d.enabled);compare(d.value,"test");compare(backend.snapshot.settings.defaultPreset,"test")
      backend.controlService=null
    }
  }
  Component { id:transportFactory; QtObject { property bool connected:true; function write(data) {} function flush() {} } }
  Timer {
    interval:100;running:true
    onTriggered: {
      var failures=0, count=0
      for(var name of Object.keys(tests).filter(n=>n.startsWith("test_")&&!n.endsWith("_data")).sort()) {
        var rows=typeof tests[name+"_data"]==="function"?tests[name+"_data"]():[{}]
        for(var row of rows) {
          count++
          try { tests.init();tests[name](row);console.log("PASS",name,row.tag || "") }
          catch(e) { failures++;console.error("FAIL!",name,row.tag || "",String(e),e.stack || "") }
        }
      }
      console.log("RESULT",count-failures,"passed",failures,"failed")
      if(!failures)console.log("MARCHYBAR_QML_ALL_PASSED")
      Qt.quit()
    }
  }
}

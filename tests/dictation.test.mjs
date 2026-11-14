import { test } from "node:test";
import assert from "node:assert/strict";
import { dictate, toggleNativeDictation } from "../apps/streamdeck-plugin/src/dictation.mts";

const pressed = { outcome: "native-state-confirmed", nativeControlPressed: true,
  workspaceMatched: true, actionRequested: "start", nativeState: "recording" };

test("native dictation requires Codex to confirm recording, not just accept the click", async () => {
  const workspace = "Project $(stay literal)";
  const calls = [];
  const invoke = (reply) => (file, args, options, done) => {
    calls.push({file,args,options}); done(null,JSON.stringify(reply));
  };
  assert.deepEqual(await toggleNativeDictation(workspace,"/safe/helper",invoke(pressed)),
    {ok:true,outcome:"native-state-confirmed",detail:""});
  assert.deepEqual(calls[0].args,["--toggle","--workspace",workspace]);
  assert.equal(calls[0].options.shell,undefined);
  for (const result of [
    {...pressed,nativeControlPressed:false}, {...pressed,workspaceMatched:false},
    {...pressed,actionRequested:"send"}, {outcome:"ambiguous-native-controls"},
    {...pressed,nativeState:"idle"}, {...pressed,outcome:"native-control-pressed"},
    {...pressed,outcome:"native-start-failed"},
    {...pressed,actionRequested:"stop",nativeState:"recording"},
    {...pressed,actionRequested:"stop",nativeState:"starting"},
  ]) assert.equal((await toggleNativeDictation(workspace,"/safe/helper",invoke(result))).ok,false);
  // Codex shows "starting" as soon as it accepts the press, before the microphone is ready.
  assert.equal((await toggleNativeDictation(workspace,"/safe/helper",
    invoke({...pressed,nativeState:"starting"}))).ok,true);
  assert.equal((await toggleNativeDictation(workspace,"/safe/helper",
    invoke({...pressed,actionRequested:"stop",nativeState:"transcribing"}))).ok,true);
  let called=false;
  assert.equal((await toggleNativeDictation("","/safe/helper",()=>{called=true})).ok,false);
  assert.equal(called,false);
  assert.deepEqual(await toggleNativeDictation(workspace,"/safe/helper",(_f,_a,_o,done)=>done(new Error("missing"),"")),
    {ok:false,outcome:"helper-unavailable",detail:""});
});

test("only a bounded machine status from the helper reaches the log", async () => {
  const reply = (detail) => (_f,_a,_o,done) => done(null,JSON.stringify({...pressed,detail}));
  const detail = "ax=enabled win=focused scans=2 nodes=1840 ms=120 views=1 cand=idle:url:epfxs:w412 pick=only act=start try=press st=recording total=910";
  assert.equal((await toggleNativeDictation("Fixture","/safe/helper",reply(detail))).detail,detail);
  for (const unsafe of ["Draft: please delete the repo", "cand=idle\nINFO forged", "x".repeat(401), {nested:true}, 7]) {
    assert.deepEqual(await toggleNativeDictation("Fixture","/safe/helper",reply(unsafe)),
      {ok:true,outcome:"native-state-confirmed",detail:""});
  }
});

test("the sidebar is opened only when no Codex composer is on screen", async () => {
  const script = (replies) => {
    const calls = [];
    const run = (_f,args,_o,done) => { calls.push(args); done(null,JSON.stringify(replies[calls.length-1])); };
    return {calls,run};
  };
  let opened = 0;
  const open = (ok) => async () => { opened++; return ok; };

  const visible = script([pressed]);
  assert.equal((await dictate("Fixture","/safe/helper",open(true),visible.run)).ok,true);
  assert.equal(opened,0);
  assert.deepEqual(visible.calls,[["--toggle","--workspace","Fixture"]]);

  // Busy, ambiguous and disabled controls are reported, never worked around.
  for (const outcome of ["ambiguous-native-controls","dictation-starting","native-control-disabled","native-state-unconfirmed"]) {
    const refused = script([{outcome}]);
    assert.deepEqual(await dictate("Fixture","/safe/helper",open(true),refused.run),{ok:false,outcome,detail:""});
    assert.equal(refused.calls.length,1);
  }
  assert.equal(opened,0);

  const hidden = script([{outcome:"native-control-unavailable"},pressed]);
  assert.equal((await dictate("Fixture","/safe/helper",open(true),hidden.run)).ok,true);
  assert.equal(opened,1);
  assert.deepEqual(hidden.calls,[["--toggle","--workspace","Fixture"],
    ["--toggle","--workspace","Fixture","--await-control"]]);

  const offline = script([{outcome:"native-control-unavailable",detail:"cand=none"}]);
  assert.deepEqual(await dictate("Fixture","/safe/helper",open(false),offline.run),
    {ok:false,outcome:"sidebar-unavailable",detail:"cand=none"});
  assert.equal(offline.calls.length,1);
});

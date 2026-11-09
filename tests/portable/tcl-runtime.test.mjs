import nodeTest from 'node:test';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {TclRuntime,TclError,TclCancelledError,tclList,tclValue,tclWord} from '../../dist/server/tcl-runtime.js';
import {TCL_VERSION,TCL_SOURCE_SHA256,TCL_EXECUTABLE,checkTcl} from '../../dist/scripts/setup-tcl.js';
const test=(name,fn)=>nodeTest(name,{skip:existsSync(TCL_EXECUTABLE)?false:'Run npm run tcl:setup to install the optional Tcl interpreter.'},fn);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runtime(t,options={}){const value=new TclRuntime(options);t.after(()=>value.destroy());await value.ready;return value;}

test('the pinned official runtime is real Tcl8.6 with procedures, scopes, references, lists, dictionaries and coroutines',async t=>{
 const r=await runtime(t);assert.equal(r.version,TCL_VERSION);assert.equal(await checkTcl(),TCL_VERSION);assert.match(TCL_SOURCE_SHA256,/^[a-f0-9]{64}$/);
 const result=await r.execute(String.raw`
set shared 7
proc reference {name} {upvar 1 $name item;incr item 2}
proc calculation {value} {global shared;set local $value;reference local;expr {$local + $shared}}
namespace eval sample {variable names [list {two words} {a;[b]$c}];proc first {} {variable names;lindex $names 0}}
set data [dict create answer [calculation 3] words [sample::first]]
set squares [lmap n {1 2 3} {expr {$n*$n}}]
coroutine counter apply {{} {yield first;yield second;return third}}
set next [counter]
list [dict get $data answer] [dict get $data words] $squares $next [counter]
`);
 assert.equal(result,'12 {two words} {1 4 9} second third');
 assert.equal(await r.execute('set shared'),'7');
});

test('host values and globals preserve exact Unicode, Tcl metacharacters and nested list/dictionary boundaries',async t=>{
 const weird='a $variable [set bad 1]; "quote" \\ slash\nline\0 café — 😀';
 const r=await runtime(t,{onCommand:async(command,args,context)=>{
  assert.equal(command,'@');assert.deepEqual(args,['reply','payload']);assert.equal(context.world,'Fixture');assert.match(context.taskId,/^t\d+$/);
  return {text:weird,list:['a b',['x','y z']],number:42,bool:true};
 }});
 assert.equal(await r.execute('set incoming',{globals:{incoming:weird}}),weird);
 assert.equal(await r.execute('set value [@ reply payload];dict get $value text',{context:{world:'Fixture'}}),weird);
 assert.equal(await r.execute('lindex [dict get [@ reply payload] list] 1 1',{context:{world:'Fixture'}}),'y z');
 assert.equal(await r.execute(`list [string equal ${tclWord(weird)} $incoming] [llength ${tclWord(tclList(['a b','[c]']))}] [dict get ${tclWord(tclValue({a:2}))} a]`),'1 2 2');
 assert.equal(await r.execute('info exists bad'),'0');
});

test('sourceTrusted shares procedure definitions and asynchronous errors remain catchable in Tcl',async t=>{
 const r=await runtime(t,{onCommand:async(command,args)=>{if(command==='fail')throw new Error('Native declined [literal]');return Number(args[0])+1;}});
 await r.sourceTrusted('proc library {value} {hostAdd $value}');
 assert.equal(await r.execute('library 41'),'42');
 assert.equal(await r.execute('set code [catch {fail} message options];list $code $message [dict get $options -code]'),'1 {Native declined [literal]} 1');
 await assert.rejects(r.execute('error {fixture failure}'),error=>error instanceof TclError&&error.message==='fixture failure'&&error.errorInfo.includes('fixture failure'));
 assert.equal(await r.execute('expr {6*7}'),'42');
});

test('independent coroutines wait for host replies concurrently without nesting or head-of-line blocking',async t=>{
 const pending=new Map(),calls=[];const r=await runtime(t,{onCommand:(command,args,context,meta)=>new Promise(resolve=>{calls.push({command,args,context,meta});pending.set(args[0],resolve);})});
 const first=r.execute('awaitNative first',{context:{world:'one'}}),second=r.execute('awaitNative second',{context:{world:'two'}});
 while(pending.size<2)await tick();assert.equal(r.tasks.size,2);
 pending.get('second')('finished-second');assert.equal(await second,'finished-second');assert.equal(r.tasks.size,1);
 pending.get('first')('finished-first');assert.equal(await first,'finished-first');
 assert.deepEqual(calls.map(call=>call.args[0]),['first','second']);assert.notEqual(calls[0].context.taskId,calls[1].context.taskId);
 assert.ok(calls.every(call=>call.meta.signal instanceof AbortSignal));
});

test('after callbacks retain context and use coroutine vwait, even when another task writes before RPC handling',async t=>{
 const calls=[];const r=await runtime(t,{onCommand:async(command,args,context)=>{calls.push({command,args,context});return 'ok';}});
 const wait=r.execute('vwait changed;set changed',{context:{world:'fixture'}}),write=r.execute('set changed {written concurrently}');
 assert.equal(await write,'written concurrently');assert.equal(await wait,'written concurrently');
 assert.equal(await r.execute('after 1 {set ::timerDone [callbackEvent {two words}]};vwait ::timerDone;set ::timerDone',{context:{world:'timer-world'}}),'ok');
 assert.equal(calls[0].command,'callbackEvent');assert.equal(calls[0].context.world,'timer-world');
 assert.equal(await r.execute('set token [after 1000 {set ::shouldNotRun 1}];set kind [lindex [after info $token] 1];after cancel $token;list $kind [llength [after info]]'),'timer 0');
 assert.equal(await r.execute('after 0 {set ::updated yes};update;set ::updated'),'yes');
});

test('native bootstrap may override trace without breaking coroutine variable waits',async t=>{
 const r=await runtime(t);
 await r.sourceTrusted('proc trace {level body} {return nativeTrace}');
 assert.equal(await r.execute('after 1 {set ::done trace-safe};vwait ::done;set ::done'),'trace-safe');
 assert.equal(await r.execute('trace 4 {fixture}'),'nativeTrace');
});

test('safe scripts cannot access subprocesses, files, sockets, extensions, inherited environment or parent channels',async t=>{
 const commands=[];const r=await runtime(t,{onCommand:async command=>{commands.push(command);return 'unexpected';}});
 for(const script of ['exec echo nope','open /etc/passwd','socket localhost 80','load /tmp/evil.so','source /etc/passwd','file delete /tmp/nope','interp invokehidden {} exec echo nope','interp expose {} exec','interp limit {} command -value {}','::wa::host exec echo nope'])await assert.rejects(r.execute(script),TclError,script);
 assert.equal(await r.execute('list [info exists env] [llength [chan names]]'),'0 0');
 assert.deepEqual(commands,[]);
});

test('command/time limits stop loops, cannot be caught away, and permit later scripts',async t=>{
 const r=await runtime(t,{commandLimit:1000,timeLimitMs:50});
 await assert.rejects(r.execute('while 1 {incr ::counter}'),/limit exceeded/);
 await assert.rejects(r.execute('while 1 {}'),/time limit exceeded/);
 await assert.rejects(r.execute('while 1 {catch {while 1 {}}}'),/limit exceeded/);
 assert.equal(await r.execute('expr {40+2}'),'42');
});

test('cancellation aborts host continuations, ignores late replies and removes world callbacks',async t=>{
 let resolveCall,signal;const r=await runtime(t,{onCommand:(_command,_args,_context,meta)=>{signal=meta.signal;return new Promise(resolve=>{resolveCall=resolve;});}});
 const pending=r.execute('awaitNative forever;set ::shouldNotResume 1',{context:{world:'cancel-world'}});const rejection=assert.rejects(pending,TclCancelledError);
 while(!resolveCall)await tick();assert.equal(r.cancel(pending),1);await rejection;assert.equal(signal.aborted,true);resolveCall('late');
 await r.execute('after 20 {set ::shouldNotFire 1}',{context:{world:'cancel-world'}});
 assert.equal(r.cancel({world:'cancel-world'}),1);await delay(35);await r.barrier();
 assert.equal(await r.execute('list [info exists shouldNotResume] [info exists shouldNotFire]'),'0 0');
 const waiting=r.execute('after 10000');const rejected=assert.rejects(waiting,TclCancelledError);await tick();r.cancelAll();await rejected;
 assert.equal(await r.execute('expr 42'),'42');
});

test('source, output, concurrency and wall-time bounds reject scripts without leaking execution',async t=>{
 const r=await runtime(t,{maxScriptBytes:256,maxOutputBytes:512,maxTasks:1,wallTimeoutMs:30,onCommand:()=>new Promise(()=>{})});
 await assert.rejects(r.execute('x'.repeat(257)),/source exceeds/);
 const pending=r.execute('waitForever');const rejected=assert.rejects(pending,/wall-time budget/);await tick();await assert.rejects(r.execute('expr 1'),/Too many concurrent/);await rejected;
 await assert.rejects(r.execute('puts [string repeat x 1024]'),/output budget|output exceeds/);
});

test('puts is captured as data and never corrupts the parent IPC channel',async t=>{
 const output=[];const r=await runtime(t,{onOutput:(text,meta)=>output.push({text,...meta})});
 assert.equal(await r.execute('puts {call t999 1 unsafe};puts -nonewline stderr {a\nb};return done',{context:{world:'print-world'}}),'done');
 assert.equal(output[0].text,'call t999 1 unsafe\n');assert.equal(output[1].channel,'stderr');assert.equal(output[1].text,'a\nb');assert.equal(output[0].context.world,'print-world');
});

test('an unresponsive executing script is killed when it cannot acknowledge wall-time cancellation',async t=>{
 const r=await runtime(t,{timeLimitMs:10000,wallTimeoutMs:30,commandLimit:1000000000});
 await assert.rejects(r.execute('while 1 {}'),/wall-time budget/);
 await delay(300);assert.equal(r.closed,true);
});

test('background scripts pause wall time during awaited calls and rearm bounded execution on each resume',async t=>{
 const r=await runtime(t,{commandLimit:200,timeLimitMs:30,wallTimeoutMs:15,maxOutputBytes:512});
 assert.equal(await r.execute('for {set index 0} {$index<8} {incr index} {after 20};set index',{background:true}),'8');
 // Foreground work retains its cumulative wall budget, with explicit overrides
 // available for console jobs and long presentations.
 await assert.rejects(r.execute('after 30'),/wall-time budget/);
 assert.equal(await r.execute('after 30;return done',{wallTimeoutMs:150}),'done');
 await assert.rejects(r.execute('while 1 {}',{background:true,wallTimeoutMs:200}),/time limit exceeded/);
 assert.equal(await r.execute('expr 42'),'42');
});

test('background tasks retain an overall host-call budget and cannot fake a yielded state to bypass the CPU watchdog',async t=>{
 const r=await runtime(t,{backgroundHostCallLimit:3});
 await assert.rejects(r.execute('for {set i 0} {$i<5} {incr i} {after 0}',{background:true}),/host-call budget/);
 const stuck=await runtime(t,{commandLimit:1000000000,timeLimitMs:10000,wallTimeoutMs:20,onCommand:()=>new Promise(()=>{})});
 await assert.rejects(stuck.execute('::wa_emit waitForever;while 1 {}',{background:true}),/wall-time budget/);
 await delay(300);assert.equal(stuck.closed,true);
});

test('a Tcl version without coroutines fails with an actionable setup error',async t=>{
 const r=new TclRuntime({executable:'/usr/bin/tclsh'});t.after(()=>r.destroy());
 // macOS supplies8.5 here; avoid depending on its version on other systems.
 try{await r.ready;assert.match(r.version,/^8\.[6-9]\./);}catch(error){assert.match(error.message,/Tcl worker exited|Cannot start Tcl|did not start/);}
});

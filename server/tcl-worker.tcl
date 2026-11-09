# Trusted process harness. World/library code runs only in the safe child.
if {[package vcompare [info patchlevel] 8.6] < 0} {error "Tcl 8.6+ with coroutines is required"}
namespace eval ::wa_worker {
 variable child world
 variable current {}
 variable callCounter 0
 variable timerCounter 0
 variable buffer {}
 variable tasks
 variable timers
 variable watches
 variable commandLimit [lindex $::argv 0]
 variable timeLimit [lindex $::argv 1]
 variable maxFrame [lindex $::argv 2]
}
proc ::wa_worker::encode {value} {if {$value eq {}} {return -};return [binary encode hex [encoding convertto utf-8 $value]]}
proc ::wa_worker::decode {value} {if {$value eq {-}} {return {}};if {![regexp {^(?:[0-9a-f]{2})*$} $value]} {error {Invalid IPC hex}};return [encoding convertfrom utf-8 [binary decode hex $value]]}
proc ::wa_worker::send {args} {puts stdout [join $args { }];flush stdout}
proc ::wa_worker::blocked {command} {expr {[namespace tail $command] in {exec open socket load unload source cd file glob pwd fconfigure encoding exit}}}
proc ::wa_worker::emit {command args} {
 variable current;variable tasks;variable callCounter;variable child;variable watches
 if {$current eq {} || ![info exists tasks($current,coroutine)]} {error {No active Tcl task}}
 if {[blocked $command]} {error "Command is unavailable in the safe interpreter: $command"}
 set call [incr callCounter];set tasks($current,pending) $call
 if {$command eq {::tcl::vwait}} {
  if {[llength $args] != 1} {error {vwait requires one variable name}}
  set var [lindex $args 0];if {![string match ::* $var]} {set var ::$var}
  set callback [list ::wa_variable_changed $call]
  interp eval $child [list ::wa::tclTrace add variable $var {write unset} $callback]
  set watches($call) [list $var $callback]
 }
 set values {};foreach arg $args {lappend values [encode $arg]}
 send call $current $call [encode $command] {*}$values
 return $call
}
proc ::wa_worker::variableChanged {call args} {variable watches;if {[info exists watches($call)]} {send variable $call}}
proc ::wa_worker::clearWatch {call} {
 variable watches;variable child
 if {[info exists watches($call)]} {lassign $watches($call) var callback;catch {interp eval $child [list ::wa::tclTrace remove variable $var {write unset} $callback]};unset watches($call)}
}
proc ::wa_worker::print {args} {
 variable current
 set newline 1;if {[lindex $args 0] eq {-nonewline}} {set newline 0;set args [lrange $args 1 end]}
 if {[llength $args] == 1} {set channel stdout;set text [lindex $args 0]} elseif {[llength $args] == 2 && [lindex $args 0] in {stdout stderr}} {lassign $args channel text} else {error {Safe puts accepts stdout or stderr only}}
 send print $current $channel $newline [encode $text]
 return {}
}
proc ::wa_worker::schedule {args} {
 variable current;variable timers;variable timerCounter
 set op [lindex $args 0]
 if {$op eq {info}} {
  if {[llength $args] == 1} {return [array names timers]}
  set id [lindex $args 1];if {[llength $args] != 2 || ![info exists timers($id)]} {error {Unknown after event}}
  return [list [lindex $timers($id) 1] [lindex $timers($id) 2]]
 }
 if {$op eq {cancel}} {
  if {[llength $args] < 2} {error {after cancel requires an id or script}}
  set wanted [concat {*}[lrange $args 1 end]]
  foreach id [array names timers] {if {$id eq $wanted || [lindex $timers($id) 1] eq $wanted} {after cancel [lindex $timers($id) 0];unset timers($id);send timer-cancel $id;break}}
  return {}
 }
 if {[llength $args] < 2} {error {after requires a delay and script}}
 if {$op ne {idle} && (![string is integer -strict $op] || $op < 0 || $op > 2147483647)} {error {Invalid after delay}}
 if {[array size timers] >= 4096} {error {Too many scheduled callbacks}}
 incr timerCounter
 set script [concat {*}[lrange $args 1 end]]
 set id wa_after#$timerCounter
 set token [after $op [list ::wa_worker::fire $id]]
 set timers($id) [list $token $script [expr {$op eq {idle}?{idle}:{timer}}]]
 send timer $current $id
 return $id
}
proc ::wa_worker::fire {id} {variable timers;if {![info exists timers($id)]} {return};set script [lindex $timers($id) 1];unset timers($id);send callback $id [encode $script]}
proc ::wa_worker::disarm {} {variable child;interp limit $child command -value {};interp limit $child time -seconds {} -milliseconds {}}
proc ::wa_worker::arm {id} {
 variable child;variable tasks;variable commandLimit;variable timeLimit
 set tasks($id,startCommands) [interp eval $child {info cmdcount}]
 set remaining [expr {$commandLimit-$tasks($id,commands)}]
 if {$remaining <= 0} {error {Tcl task command limit exceeded}}
 interp limit $child command -value [expr {$tasks($id,startCommands)+$remaining}] -granularity 1
 set remainingTime [expr {$timeLimit-$tasks($id,time)}]
 if {$remainingTime <= 0} {error {Tcl task execution time limit exceeded}}
 set tasks($id,startTime) [clock milliseconds]
 set deadline [expr {$tasks($id,startTime)+$remainingTime}]
 interp limit $child time -seconds [expr {$deadline/1000}] -milliseconds [expr {$deadline%1000}] -granularity 1
}
proc ::wa_worker::drop {id} {
 variable tasks;variable child
 if {![info exists tasks($id,coroutine)]} {return}
 if {[info exists tasks($id,pending)]} {clearWatch $tasks($id,pending)}
 catch {interp eval $child [list rename $tasks($id,coroutine) {}]}
 foreach key [array names tasks "$id,*"] {unset tasks($key)}
}
proc ::wa_worker::slice {id command} {
 variable tasks;variable current;variable child
 set current $id
 if {$tasks($id,background)} {set tasks($id,commands) 0;set tasks($id,time) 0}
 set code [catch {arm $id;interp eval $child $command} result options]
 disarm
 if {[info exists tasks($id,startCommands)]} {incr tasks($id,commands) [expr {[interp eval $child {info cmdcount}]-$tasks($id,startCommands)}]}
 if {[info exists tasks($id,startTime)]} {incr tasks($id,time) [expr {[clock milliseconds]-$tasks($id,startTime)}]}
 set current {}
 if {$code} {drop $id;send done $id error [encode $result] [encode [expr {[dict exists $options -errorinfo]?[dict get $options -errorinfo]:{}}]];return}
 if {[llength [interp eval $child [list info commands $tasks($id,coroutine)]]]} {
  if {![info exists tasks($id,pending)] || $result ne [list ::wa::wait $tasks($id,pending)]} {drop $id;send done $id error [encode {The task yielded without an awaited host command}] -} else {send yielded $id $tasks($id,pending)}
 } else {drop $id;send done $id ok [encode $result] -}
}
proc ::wa_worker::dispatch {line} {
 variable tasks;variable child
 set words [split $line { }];set op [lindex $words 0]
 if {$op eq {run}} {
  lassign $words ignored id mode script;set pairs {};foreach {name value} [lrange $words 4 end] {lappend pairs [decode $name] [decode $value]}
  if {![regexp {^t[0-9]+$} $id] || [info exists tasks($id,coroutine)]} {error {Invalid task id}}
  set tasks($id,coroutine) ::wa::task_$id;set tasks($id,commands) 0;set tasks($id,time) 0;set tasks($id,background) [expr {$mode eq {background}}]
  slice $id [list coroutine $tasks($id,coroutine) ::wa::run [decode $script] $pairs]
 } elseif {$op eq {resume}} {
  lassign $words ignored id call status value
  if {![info exists tasks($id,pending)] || $tasks($id,pending) ne $call} {return}
  clearWatch $call;unset tasks($id,pending)
  slice $id [list $tasks($id,coroutine) [list $status [decode $value]]]
 } elseif {$op eq {cancel}} {set id [lindex $words 1];drop $id;send cancelled $id} elseif {$op eq {cancel-timer}} {
  variable timers;set id [lindex $words 1];if {[info exists timers($id)]} {after cancel [lindex $timers($id) 0];unset timers($id)};send timer-cancel $id
 } elseif {$op eq {reset}} {
  variable timers;foreach id [array names timers] {after cancel [lindex $timers($id) 0];unset timers($id);send timer-cancel $id}
  foreach key [array names tasks {*,coroutine}] {drop [lindex [split $key ,] 0]}
 } elseif {$op eq {barrier}} {send barrier [lindex $words 1]} else {error {Unknown worker operation}}
}
proc ::wa_worker::readable {} {
 variable buffer;variable maxFrame
 append buffer [read stdin]
 if {[string length $buffer] > $maxFrame} {send fatal [encode {Tcl IPC input exceeds its bound}];exit 1}
 while {[set end [string first \n $buffer]] >= 0} {set line [string range $buffer 0 $end-1];set buffer [string range $buffer $end+1 end];if {[catch {dispatch $line} error]} {send fatal [encode $error];exit 1}}
 if {[eof stdin]} {exit 0}
}
interp create -safe $::wa_worker::child
interp recursionlimit $::wa_worker::child 512
foreach command {after vwait update puts} {interp hide $::wa_worker::child $command wa_native_$command}
interp alias $::wa_worker::child ::wa_emit {} ::wa_worker::emit
interp alias $::wa_worker::child ::wa_variable_changed {} ::wa_worker::variableChanged
interp alias $::wa_worker::child ::wa_print {} ::wa_worker::print
interp alias $::wa_worker::child ::wa_schedule {} ::wa_worker::schedule
interp eval $::wa_worker::child {
 namespace eval ::wa {}
 rename trace ::wa::tclTrace
 proc trace {args} {tailcall ::wa::tclTrace {*}$args}
 proc ::wa::host {command args} {
  if {[info coroutine] eq {}} {error {Host commands require an active script task}}
  set call [::wa_emit $command {*}$args]
  lassign [yield [list ::wa::wait $call]] status value
  if {$status ne {ok}} {return -code error $value}
  return $value
 }
 proc ::wa::run {script globals} {foreach {name value} $globals {uplevel #0 [list set $name $value]};uplevel #0 $script}
 proc unknown {command args} {tailcall ::wa::host $command {*}$args}
 proc puts {args} {::wa_print {*}$args}
 proc after {args} {
  if {[llength $args] == 1 && [string is integer -strict [lindex $args 0]]} {return [::wa::host ::tcl::sleep [lindex $args 0]]}
  return [::wa_schedule {*}$args]
 }
 proc vwait {name} {::wa::host ::tcl::vwait $name;return {}}
 proc update {{which {}}} {if {$which ni {{} idletasks}} {error {bad option: must be idletasks}};::wa::host ::tcl::update $which;return {}}
}
fconfigure stdin -blocking 0 -encoding utf-8 -translation lf
fconfigure stdout -buffering line -encoding utf-8 -translation lf
fileevent stdin readable ::wa_worker::readable
::wa_worker::send ready [::wa_worker::encode [info patchlevel]]
vwait ::wa_worker::forever

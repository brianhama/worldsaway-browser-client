# Native WA compatibility prelude for the Tcl safe child interpreter only.
# The runtime supplies ::wa::host command args as a resumable asynchronous alias.
# Never source this file into the worker's master interpreter.
namespace eval ::wa::native {
    variable messages [dict create]
    variable threads [dict create]
    variable threadSerial 0
    variable constants [dict create MESSAGE_standardReply 70]
}

proc ::wa::native::releaseThread {{thread ""}} {
    if {$thread eq ""} {
        set coroutine [info coroutine]
        if {![dict exists $::wa::native::threads $coroutine]} { return "" }
        set thread [dict get $::wa::native::threads $coroutine]
    }
    if {[dict exists $::wa::native::messages $thread]} {
        dict unset ::wa::native::messages $thread
    }
    foreach {coroutine id} $::wa::native::threads {
        if {$id eq $thread} { dict unset ::wa::native::threads $coroutine }
    }
    unset -nocomplain ::context_$thread ::methodId_$thread ::errorInfo_$thread
    return ""
}

proc thread_id {} {
    set coroutine [info coroutine]
    if {$coroutine eq ""} { return 0 }
    if {![dict exists $::wa::native::threads $coroutine]} {
        # Tcl coroutine deletion on cancellation does not run its finally
        # clauses. Sweep dead threads before assigning another native identity.
        foreach {old id} $::wa::native::threads {
            if {![llength [info commands $old]]} { ::wa::native::releaseThread $id }
        }
        dict set ::wa::native::threads $coroutine [incr ::wa::native::threadSerial]
    }
    return [dict get $::wa::native::threads $coroutine]
}

proc ::wa::native::identifier {value} {
    if {[dict exists $::wa::native::constants $value]} {
        return [dict get $::wa::native::constants $value]
    }
    # Keep unverified constants unresolved. The host may have additional
    # source-backed constants; it must not coerce unknown symbols into zero.
    return $value
}

proc bind-message {message binding} {
    # The Node host represents native message handles as canonical Tcl dicts.
    # It may return an entire packet, or just the payload dictionary.
    if {[dict exists $message fields]} { set message [dict get $message fields] }
    dict set ::wa::native::messages [thread_id] $binding $message
    return ""
}

proc @ {binding field} {
    set thread [thread_id]
    if {![dict exists $::wa::native::messages $thread $binding]} {
        error "No $binding message is bound to this native thread."
    }
    set values [dict get $::wa::native::messages $thread $binding]
    if {[dict exists $values $field]} { return [dict get $values $field] }
    if {[regexp {^(.*)\((-?[0-9]+)\)$} $field all key index] && [dict exists $values $key]} {
        return [lindex [dict get $values $key] $index]
    }
    error "The $binding message has no field $field."
}

proc @obj {noid field args} {
    if {[llength $args] > 1} { error "usage: @obj noid field ?value?" }
    return [::wa::host @obj $noid $field {*}$args]
}

proc @class {noid field} {
    return [::wa::host @class $noid $field]
}

# Native long strings may be constructed from a caller variable or a bound
# message field. Resolve those within Tcl before crossing the host boundary.
proc lstring {operation args} {
    if {$operation eq "var" && [llength $args] == 1} {
        return [::wa::host lstring set [uplevel 1 [list set [lindex $args 0]]]]
    }
    if {$operation eq "set" && [llength $args] == 2} {
        return [::wa::host lstring set [@ [lindex $args 0] [lindex $args 1]]]
    }
    return [::wa::host lstring $operation {*}$args]
}

proc ::wa::native::parameters {body {level 2}} {
    set result [list]
    set pending ""
    foreach line [split $body "\n"] {
        if {$pending eq "" && [string match {#*} [string trimleft $line]]} { continue }
        append pending $line "\n"
        if {![info complete $pending]} { continue }
        # The argument body is field/value data with caller-scope Tcl
        # substitutions. Multiple pairs may occupy one physical line; nested
        # quoted/braced/bracketed words may span several complete lines.
        set words [uplevel $level "list $pending"]
        lappend result {*}$words
        set pending ""
    }
    if {[string trim $pending] ne ""} { error "Incomplete native message parameter body." }
    if {[llength $result] % 2} {
        error "Native message parameters require alternating field and value words."
    }
    return $result
}

# Native controls accept either a deferred script or a local numeric message
# callback. Only the latter has a field/value parameter body to substitute in
# the creating procedure's scope. Script callbacks must remain unevaluated.
foreach ::wa::native::controlName {
    ctrlStaticText ctrlGroupBox ctrlLineEdit ctrlTextEdit ctrlDefButton
    ctrlEscButton ctrlButton ctrlCheckBox ctrlRadioButton ctrlListBox
    ctrlComboBox ctrlEditCombo ctrlGraphic
} {
    proc $::wa::native::controlName {dialog control x y width height text args} {
        if {[llength $args] == 3} {
            set parameters [::wa::native::parameters [lindex $args 2] 2]
            set args [lreplace $args 2 2 $parameters]
        }
        set nativeCommand [namespace tail [lindex [info level 0] 0]]
        return [::wa::host $nativeCommand $dialog $control $x $y $width $height $text {*}$args]
    }
}
unset ::wa::native::controlName

proc ctrlAddListItem {dialog control number text args} {
    if {[llength $args] == 3} {
        set parameters [::wa::native::parameters [lindex $args 2] 2]
        set args [lreplace $args 2 2 $parameters]
    }
    return [::wa::host ctrlAddListItem $dialog $control $number $text {*}$args]
}

proc request {target id body replyId {binding reply}} {
    set parameters [::wa::native::parameters $body]
    set reply [::wa::host request [::wa::native::identifier $target] [::wa::native::identifier $id] [::wa::native::identifier $replyId] {*}$parameters]
    bind-message $reply $binding
    return ""
}

proc notice {target id body} {
    set parameters [::wa::native::parameters $body]
    return [::wa::host notice [::wa::native::identifier $target] [::wa::native::identifier $id] {*}$parameters]
}

proc command {target id body} {
    set parameters [::wa::native::parameters $body]
    return [::wa::host command [::wa::native::identifier $target] [::wa::native::identifier $id] {*}$parameters]
}

proc message {target id body} {
    set parameters [::wa::native::parameters $body]
    return [::wa::host message [::wa::native::identifier $target] [::wa::native::identifier $id] {*}$parameters]
}

proc queue-msg {target id body} {
    set parameters [::wa::native::parameters $body]
    return [::wa::host queue-msg [::wa::native::identifier $target] [::wa::native::identifier $id] {*}$parameters]
}

proc load-method {handle} {
    set ::methodId_[thread_id] $handle
    return [::wa::host load-method $handle]
}

# The native execute/load-method registrations share the same source-returning
# handler 0x446390. The calling Tcl code decides when and where to evaluate it.
proc execute {handle} {
    set ::methodId_[thread_id] $handle
    return [::wa::host execute $handle]
}

proc method-handle {noid method} { return [::wa::host method-handle $noid $method] }
proc resource {subcommand args} { return [::wa::host resource $subcommand {*}$args] }
proc thread {script} { return [::wa::host thread $script] }
proc kill {} { return [::wa::host kill] }
proc delay {milliseconds} { return [::wa::host delay $milliseconds] }
proc waitBits {noid flags {milliseconds 0}} { return [::wa::host waitBits $noid $flags $milliseconds] }
proc block {} { return [::wa::host block] }
proc unblock {} { return [::wa::host unblock] }
proc blockstat {} { return [::wa::host blockstat] }
proc getVirtualObject {requestedNoid classNumber} {
    set ::lastVONoid [::wa::host getVirtualObject $requestedNoid $classNumber]
    uplevel 1 [list set lastVONoid $::lastVONoid]
    return $::lastVONoid
}

# Recovered WA catch stores a numeric completion code in its third argument.
# This replacement lives in the safe child; the master keeps standard Tcl catch.
rename catch ::wa::native::tclCatch
proc catch {script args} {
    set count [llength $args]
    if {$count > 2} { error "usage: catch script ?resultVar? ?statusVar?" }
    if {$count == 0} {
        set status [uplevel 1 [list ::wa::native::tclCatch $script]]
    } else {
        set status [uplevel 1 [list ::wa::native::tclCatch $script [lindex $args 0]]]
    }
    if {$count == 2} { uplevel 1 [list set [lindex $args 1] $status] }
    if {$status == 1 && [info exists ::errorInfo]} {
        set ::errorInfo_[thread_id] $::errorInfo
    }
    return $status
}

# Linked globals are refreshed from NativeSession when scenes/state change.
# Defaults only fill missing values; they do not overwrite supplied login state.
foreach {name value} {
    PlayerActor 0 PlayerFlags 0 PlayerPermLevel 0 PlayerPermFlags 0 IgnoreScope 0
    EnableFadeOuts 1 EnableFrameSkip 1 ClientArch 0 ClientVer 0 ClientDebug 0
    $TclDebugOn 0
} {
    if {![info exists ::$name]} { set ::$name $value }
}
unset name value

# Browser bridge interface

The bridge defaults to loopback and connects to WorldsAway.app at `http://127.0.0.1:8080`. Set `WORLDSAWAY_BACKEND_URL` or `--launcher-url` to use another backend. Public hosting requires an exact HTTPS `publicOrigin`; hosted login and registration are restricted to that server-configured backend. It verifies Host and Origin, rejects cross-site API requests, and uses an HttpOnly SameSite=Strict session cookie. The browser never receives the launcher password or native world ticket. Closing/replacing a session clears its retained password and ticket.

The application requires Node.js 22+ and Tcl 8.6+. From the project root, run `npm ci` and `npm run build`. Then `npm run tcl:setup` verifies and builds the official pinned Tcl 8.6.16 source into `.runtime/tcl-8.6.16/` using a C compiler, `make` and `tar`. No system installation or npm runtime package is required. The interpreter runs in a separate process with an isolated safe child; launcher credentials and native login tickets are not passed into its environment/globals.

`createBridgeServer(options)` exports `start()`, `close()`, `baseUrl`, `server`, `resources`, and `sessions`. Options include `port`, `host` (loopback, or `0.0.0.0` with `publicOrigin`), `publicOrigin`, `clientDir`, `staticDir`, `resources`, `launcherUrl`, and `tcl`. Programmatic `tcl` options include `executable` (absolute path to a coroutine-capable Tcl 8.6+ interpreter), `requestTimeout` and `effectTimeout`. Without an explicit executable, the locally built `.runtime/tcl-8.6.16/bin/tclsh8.6` is used. Example: `createBridgeServer({tcl:{executable:'/absolute/path/to/tclsh8.6'}})`.

Import the compiled bridge from `dist/server/index.js`. The default static directory is `dist/public`; the default cache directory is `assets/`, overridable with `ALTAWAY_CLIENT_DIR` or `clientDir`. An absent default cache is supported: native schemas and artwork arrive during connection. Supplying an invalid explicit cache path produces a configuration error.

The CLI equivalent is `npm start -- --tclsh /absolute/path/to/tclsh8.6`; `--port`, `--launcher-url` and `--client-dir` remain available. `npm start -- --help` lists the options.

| Endpoint | Request | Response |
| --- | --- | --- |
| GET `/api/config` | — | Version, launcher defaults, `backendName`, `registrationEnabled`, schema/cache counts |
| GET `/api/worlds?url=BASE` | Directory base URL | `{worlds:[{name,loginUrl,executable,flags,archive}]}` |
| POST `/api/login` | `{launcherUrl,account,password,avatar?,world?}` | `{sessionId,state}` and session cookie |
| POST `/api/register` | `{account,password,avatar,launcherUrl?}` | HTTP201 `{created,sessionId,state}` and session cookie; creates an account plus its first avatar, then enters that avatar |
| POST `/api/login` | `{mode:"direct",host,worldPort,rpcPort,account,token,avatar?,region?}` | Same; optional `transport:"wstunnel",wsurl,tunnelPrefix` |
| POST `/api/login` | `{connectionFile:"[Message]..."}` | Same using a fresh native handoff |
| POST `/api/reconnect` | `{avatar?,region?}`; existing session cookie | Fresh launcher ticket and reentry using retained in-memory credentials; preserves session ID and SSE |
| POST `/api/enter` | `{avatar,region?}` | `{state}` |
| POST `/api/action` | `{noid,id,fields}` or `{noid,messageId,values}` | `{sent:true,seq}`; success/failure arrives through state/history |
| POST `/api/avatars` | `{action:"create",name}` | WorldsAway HTTP create for recognized local/hosted servers; native new-name entry for other compatible worlds |
| POST `/api/logout` | `{}` | `{loggedOut:true}` |
| GET `/api/state` | Session cookie | Current state, or disconnected empty state |
| GET `/api/events` | Session cookie | SSE `event: state`, including current state immediately |
| GET `/api/classes` | Optional session cookie | `{summary,classes:[{classNumber,name,capacity,fields,schema,requests}],messages:[{messageId,fields,schema}]}` |
| GET `/api/asset?name=FILE&version=UINT32` | Optional session cookie | Filename bytes; stale local versions trigger native RPC |
| GET `/api/resource?id=UINT32` | Optional session cookie | Raw MAG resource bytes, with `x-resource-version` |
| GET `/api/tcl/status` | Session cookie | Tcl model: runtime status/version, tasks, logs, effects and local visual overrides |
| POST `/api/tcl/run` | `{script,noid?}`; defaults target to current actor | `{taskId}`; actual Tcl runs asynchronously |
| POST `/api/tcl/method` | `{noid,messageId,fields?}` | `{taskId}` for a recovered client method, not a direct wire request |
| POST `/api/tcl/presentation` | `{noid,which?,ad?}`; `which` defaults to 1; `ad` may contain current `imageURL`, `choreState`, `colorMap` | `{taskId}` for original Banner method 5625 |
| POST `/api/tcl/reply` | `{id,value?,error?,overrides?}`; `id` is the pending browser effect ID | `{accepted:boolean}`; resumes/rejects the waiting host RPC |
| POST `/api/tcl/callback` | `{dialogId,script?}` or `{dialogId,command:{noid,id,fields?}}` | `{taskId}`; executes a callback for a retained native dialog |
| POST `/api/tcl/cancel` | `{taskId?}`; omit ID to cancel/reset all world scripts | `{cancelled:true}` |

The Tcl POST endpoints require an entered, connected avatar. A returned `taskId` means execution started; completion, cancellation, result and error arrive in `state.tcl.tasks`/logs. It does not establish that a world transaction succeeded. `GET /api/tcl/status` requires an existing session and can also describe an idle or starting runtime.

State is `{status,avatar,avatars:[{name,busy}],capacity,newAvatarAllowed,actorNoid,objects,region,history,resources,revision,error,worldName,permissions,canReconnect,sceneNeedsRefresh,sceneWarning,tcl}`. Each object is `{noid,classNumber,className,fields}`. `region` is object NOID0. Each history entry is `{seq,time,type,noid,id,messageId,fields,values,requestId?,requestNoid?,requestSeq?}`. Binary contents vectors are decoded into objects; history records their byte count. History is bounded to the latest 300 messages/requests.

The Tcl model contains `enabled`, `generation`, `status`, `version`, bounded `tasks` and `logs`, `effects`, `overrides`, `virtualObjects`, and `blockCount`. A task has an ID, target NOID, label, status, timestamps and a bounded result/error. A browser effect is `{id,seq,name,args,context,status}`. The browser dispatches already evaluated `args` through `TclVisualHost`, then replies with its value or error. `overrides` is an array of `{noid,fields}` containing local client visual state, not fabricated server notices or authoritative transaction results. The bridge validates and applies these updates before resolving the RPC. SSE state carries subsequent task/effect changes.

Dialog effects retain dimensions, title, style and typed controls, including values, selection, visibility/enabled state and either Tcl script or native-message callbacks. User interaction updates the retained browser model. A callback starts Tcl in the dialog's object context, and subsequent `dialogGetValue`/control queries obtain those values through host RPC. A script's normal completion leaves its dialogs available; explicit cancellation closes that task's dialogs and stops its visual jobs. Region/avatar/session changes reset the execution generation. The UI's **Toolbar → Tcl editor...** uses these same endpoints.

The session requests resource cursor zero, so a complete resource bootstrap is requested instead of legacy patch deltas. Full native resource16/17/18 updates are bounded, assembled and validated, then class/message schemas are rebuilt. Announced count/byte totals are progress estimates in the native client; mismatches are retained as informational progressMismatch state. Every individual resource must still complete exactly, and independent resource-count, update-byte and per-resource limits apply. All recovered message encodings are available through the native action endpoint. Server success remains distinct from merely sending an action.

Direct TCP and the legacy Haskell wstunnel binary-WebSocket transport are implemented for both world sessions and filename RPC. Directory `w` entries post `ws=true`; the received `wsurl` is used with the upstream Haskell path `/wstunnel/tcp/HOST/PORT`, and RPC is remapped through the native world port as in the shipped launcher. WSS uses the Node runtime's certificate validation. This transport is compatible with the Haskell generation, not the newer incompatible Rust wstunnel v7+ protocol. Sources: [Haskell Tunnel.hs](https://raw.githubusercontent.com/erebe/wstunnel/haskell/src/Tunnel.hs), [Types.hs](https://raw.githubusercontent.com/erebe/wstunnel/haskell/src/Types.hs), [Main.hs](https://raw.githubusercontent.com/erebe/wstunnel/haskell/app/Main.hs).

Recovered Tcl and executable server notices 119/2135/5324 run through `NativeTclSession` and the real interpreter. The native bootstrap/libraries, per-thread message bindings, extended `catch`, requests/replies, linked player globals, object/class fields, virtual objects, cached text resources and extended strings have explicit bindings. Native object method 52 initialization is lazy and guarded per object/class/generation; Document long-string fields initialize before use. `lstring` provides recovered `set`, `var`, `get`, `del` and `compare` operations with scoped checked handles and Windows-1252/C-string semantics. Handles are resolved before native string request encoding and browser text/control use. Cached type 6 labels are read as text; HTTP(S) `openURL` effects are displayed as clickable world links.

The browser supplies queued choreography, frame/displacement updates, sound, balloons and native dialog controls through asynchronous effects. Tcl procedures, including Banner presentations, execute their actual control flow and callbacks. Browser JavaScript never evaluates Tcl callback text as JavaScript. The safe interpreter has no direct process, filesystem or socket primitives; native requests use the existing session and strict codec. Explicit TypeScript reducers remain responsible for the existing authoritative object-update paths, including decoded vectors and core movement/inventory/appearance notices.

This real Tcl path does not establish complete native-client parity. Uncommon `spot-*` APIs, native CEL-handle producers, file-chooser equivalents and additional chore opcodes/wait flags remain bounded gaps; unsupported bindings report errors. See [the project limitations](../README.md#limitations) for the published scope. Native avatar deletion has no recovered operation and returns an explicit error.

Region101 contents vectors are zero-RLE compressed. Incremental vectors delivered through Tcl `unpackContents`, such as materialization2006, are raw length-prefixed records. The browser validates raw incremental vectors first and also admits the local compatibility server's compressed variant. The native evidence is `0x447be0 -> 0x447b70 -> 0x442300` for direct field-to-record unpacking and `0x440db0 -> 0x486de0 -> 0x442300` for Region101 decompression. Malformed vectors preserve the previous object map and active TCP connection, report numeric diagnostics, and permit reconnection. One failed vector may be retained only in process memory for diagnosis; it is never returned by the API.

# Architecture

The browser loads compiled ES modules from `dist/public`. Its same-origin HTTP
and server-sent events APIs connect to the Node bridge, which owns each player's
native TCP or WebSocket connection and in-memory state. No framework or npm
runtime dependency is required by the compiled application.

```text
Browser UI → HTTP/SSE bridge → native TCP / WebSocket tunnel → world server
                  ↓
             Tcl process
         safe child interpreter
```

`public/types.ts` describes browser objects, events, action fields, menus, and
controller contracts. `server/types.ts` describes native sessions and Tcl tasks.
World schemas determine dynamic field names at runtime. `native/classes.ts`
validates and encodes those fields; `native/protocol.ts` bounds framed input;
`native/resources.ts` admits read-only MAG/WSRES cache entries; `native/world.ts`
decodes bounded zero-RLE contents vectors.

`server/session.ts` maintains connections, request/reply tracking, resource
versions, and world state. `server/reducers.ts` applies native updates. Tcl
scripts use explicit host bindings in `server/tcl-session.ts` and the safe
interpreter worker. Browser callbacks are data sent through that bridge.

The server starts with an empty cache when no cache path is configured. A world
can supply bootstrap resources during login. To reuse an existing cache, supply
a directory containing `mag/` and `wsres/` with `ALTAWAY_CLIENT_DIR` or
`--client-dir`. Explicit invalid caches report an error. No source archive
contains original resources, accounts, world databases, or runtime downloads.

`npm run build` typechecks and emits TypeScript to `dist/`, then copies authored
HTML/CSS/SVG, Tcl worker files, and any separately supplied Windows button PNGs.
`npm run release:prepare` checks the build,
runs portable tests, and exports source through a positive allowlist. The
generated `SOURCE_MANIFEST.json` records every source file's SHA-256, and the
archive has a separate SHA-256 file.

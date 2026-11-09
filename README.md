# Browser Client

An independent TypeScript browser client for WorldsAway-compatible worlds. It
combines a classic desktop-style interface, native image and sound decoders, a
Node.js TCP/WebSocket bridge, and a safe Tcl interpreter. The world server
remains authoritative for accounts, permissions, inventory, and transactions.

This project is based on the WorldsAway server protocol circa 1995, from the
original WorldsAway service available on CompuServe and owned by Fujitsu. The
original artwork from that era is used with permission from Fujitsu.

**Live demo: [worldsaway.app](https://worldsaway.app)** — try the browser client
connected to the companion WorldsAway.app server.

The authored code is available under the [MIT license](LICENSE). Original game
clients, artwork, fonts, sounds, and world scripts are supplied separately and
retain their owners' rights; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Quick start

Requirements:

- **Node.js 22 or newer** and npm.
- A **Tcl 8.6 interpreter** for world scripts. `npm run tcl:setup` downloads and
  builds the pinned official **8.6.16** release, so it needs network access, a
  C compiler, `make`, and `tar`. On macOS, install the Xcode Command Line Tools;
  on Linux, install the distribution's C build tools.
- A running compatible world server. The default is the companion
  **WorldsAway.app** server at `http://127.0.0.1:8080`. Set up that repository,
  including its separately supplied resource pack or cache, before signing in.

From this project's root:

```sh
npm ci
npm run tcl:setup
npm run build
npm start
```

Keep the process running and open **http://127.0.0.1:4173**. Choose
**File → Connect**, select **WorldsAway.app**, load the world list, and sign in
or select **Create account**. A fresh local server with demo seeding enabled
provides **demo / demo** and the **Demo** avatar. Start the world server in a
separate terminal; starting this client runs only the UI and its bridge.
[AltAway](https://altaway.xyz/) is also available in the local selector.

To select a different compatible backend when starting the bridge:

```sh
npm start -- --launcher-url http://127.0.0.1:8180
```

Check that the bridge is running with `curl http://127.0.0.1:4173/healthz`.
This endpoint checks the bridge process; signing in also requires a reachable
world server and its advertised native connection ports.

## Optional client resources

The application starts without a local resource cache. Compatible worlds can
supply their bootstrap resources during login. To use an existing cache you are
entitled to use, point to the directory containing `mag/` and `wsres/`:

```sh
npm start -- --client-dir /path/to/AltAway --port 4174
```

`ALTAWAY_CLIENT_DIR` selects the same cache. An explicit missing or invalid cache
reports an error. Caches are read only; received resources and session state stay
in process memory. Original cache files and proprietary UI extracts are excluded
from the source distribution. The interface uses system fonts and loads the
original Windows button images when they are supplied locally; otherwise it
uses authored SVG controls.

To use the Windows client's toolbar and speech buttons, extract the images from
a `wa32.exe` you are entitled to use, then rebuild:

```sh
npx tsx scripts/asset-toolbar.ts /path/to/wa32.exe
npm run build
```

The extraction writes `public/native-icons/`. The build copies only the known
button PNGs and their image states into `dist/public/native-icons/`. These
optional images are also included when building a Docker image from that local
tree. They remain ignored by Git and excluded from `release:prepare` source
archives; the executable, cache, fonts, and other extracts are not bundled.

## Tcl runtime

Tcl installs locally under `.runtime/tcl-8.6.16/` after verifying the source
archive's pinned SHA-256. It does not modify the system interpreter. To use an
existing compatible interpreter:

```sh
npm start -- --tclsh /absolute/path/to/tclsh8.6
```

## Connecting and creating accounts

The browser needs the Node bridge because browsers cannot open native TCP
sockets. Static-only hosting is insufficient. The compiled application has no
npm runtime dependencies and no frontend framework.

To create an account, open **File → Connect → Create account**, enter an
account name, password and confirmation, and the name of your first avatar.
Choose **Create account & enter**. The backend creates the account and initial
avatar atomically, then the browser signs in and enters that avatar. Duplicate
names and invalid values appear in the dialog; correct them and submit again.

Account names accept 1–24 ASCII letters, numbers, dots, underscores or hyphens.
Passwords accept 1–24 printable ASCII characters. Avatar names accept 1–29
ASCII letters, numbers, spaces, dots, underscores or hyphens and start with a
letter or number. These bounds match the native server protocol. Passwords and
confirmations are cleared after success or closing the dialog and are never
retained in browser storage. Only the account name and connection choices are
remembered.

The connection dialog also offers **AltAway** and a server-address field in
local mode. Account creation is offered only for WorldsAway.app servers with
registration enabled. Hosted clients use their configured backend and may
register there; destination overrides remain blocked in hosted mode. An empty
client cache is supported: the server supplies schemas and assets during login.

## Configuration

Pass CLI flags after `npm start --`, or export environment variables before
starting the process. CLI flags take precedence over the corresponding
environment variables. [.env.example](.env.example) is a reference template;
the application does **not** load `.env` files automatically.

| Environment variable | CLI flag | Default / purpose |
| --- | --- | --- |
| `PORT` | `--port` | `4173`; bridge HTTP port |
| `HOST` | `--host` | `127.0.0.1` locally; `0.0.0.0` when a public origin is configured |
| `WORLDSAWAY_BACKEND_URL` | `--launcher-url` | `http://127.0.0.1:8080`; backend directory and account API |
| `ALTAWAY_PUBLIC_ORIGIN` | `--public-origin` | Unset locally; exact HTTPS origin for public hosting |
| `ALTAWAY_CLIENT_DIR` | `--client-dir` | `assets/` under the project root; optional cache containing `mag/` and `wsres/` |
| `TCLSH` | `--tclsh` | `.runtime/tcl-8.6.16/bin/tclsh8.6` under the project root |

Run `npm start -- --help` after building to see the available CLI options.

## Development and verification

```sh
npm run typecheck       # Strict TypeScript checking
npm run build           # Emit ESM and copy static/Tcl files and supplied buttons
npm run check           # Types, build, UI references, and static assets
npm test                # Build and run portable loopback/synthetic tests
npm run dev             # Build and watch compiled server files
npm run release:prepare # Checks + portable tests + allowlisted source archive
```

After editing TypeScript, run `npm run build` to refresh browser and server code.
`dev` watches compiled server files; it does not compile TypeScript on save.
Tests requiring the actual Tcl interpreter report a skip when it is absent;
CI installs it so those tests execute. Portable tests require no public service,
credentials, original client resources, or sibling directories.

The source distribution contains the self-contained portable suite and supported
build and asset tools. Local research scripts, resource corpus tests, and sibling
projects are excluded; no sibling checkout is needed to build or start this client.

## Project structure

| Directory | Responsibility |
| --- | --- |
| `public/` | TypeScript UI, rendering, audio, menus, controllers, HTML/CSS/SVG |
| `server/` | Same-origin HTTP/SSE bridge, native sessions, safe Tcl workers |
| `native/` | Self-contained frame, schema, cache, and contents-vector codecs |
| `scripts/` | TypeScript build, Tcl setup, release, and optional resource tools |
| `tests/portable/` | Synthetic and loopback regression tests for clean checkouts |
| `docs/licenses/` | Preserved upstream license terms |

See [architecture](docs/architecture.md), the [bridge API](server/API.md),
[contributing](CONTRIBUTING.md), and the [security policy](SECURITY.md).

## Features

- Native TCP and legacy wstunnel WebSocket connections through the Node bridge.
- WorldsAway.app account registration with first-avatar creation and automatic entry, plus account login, avatar selection, and additional avatar creation when the backend allows it.
- A fixed 512 × 288 world viewport, transcript, context menus, tool windows,
  directional movement, smooth walking, looping native artwork, moods, gestures,
  and ghost states. Animated heads, animals and props use their supplied default
  choreography and retain the original sprite timing.
- Native indexed image/cel decoding, palettes, attachment slots, seat metadata,
  AIFF sound decoding, and version-aware resource retrieval.
- Inventory and nested containers, speech/ESP/mail, travel, banks, vending,
  documents/pages/binders, homes, pets, and builder request forms.
- A catalog of 204 gameplay requests, with native numeric/text validation and
  compatible receiver selection. Request coverage does not establish full
  behavioral parity with an original client.
- Real Tcl control flow, host bindings, script-created dialogs, callbacks,
  queued choreography, cancellation, and bounded task execution in a safe
  child interpreter in a separate process.

Double-click the scene to walk; arrow keys move while the canvas has focus.
Click an object for its context menu. Enable sound and interact with the page
to unlock browser audio. Passwords and launcher tickets are not persisted in
browser storage. Launcher credentials are retained only in bridge memory while
needed for avatar management and cleared when the session closes.

Use **Edit → Preferences → Animate world** to control animation. The initial
setting follows the system's reduced motion preference; saving Preferences
remembers your choice on this device. Walking redraws at the browser's refresh
rate while sprite poses advance on the native 175 ms clock. Idle scenes use the
native redraw cadence. Completed gestures and scripted chores return to the
resulting state's default animation.

## Hosting

Build the standalone image from this directory:

```sh
docker build -t browser-client .
docker run --rm -p 8080:8080 \
  -e ALTAWAY_PUBLIC_ORIGIN=https://client.example.com \
  -e WORLDSAWAY_BACKEND_URL=https://world.example.com \
  browser-client
```

Put the container behind an HTTPS reverse proxy for the exact configured
origin. It runs as an unprivileged user on port 8080 and exposes `/healthz`.
Replace both example URLs with your client and backend addresses. The reverse
proxy must preserve the public `Host` header and allow long-lived server-sent
event responses without buffering. Use `npm start` for ordinary local
development without an HTTPS proxy.

The bridge defaults to loopback. Public hosting requires `HOST=0.0.0.0` and an
exact HTTPS `ALTAWAY_PUBLIC_ORIGIN`. Set `WORLDSAWAY_BACKEND_URL` to the world server HTTP origin; hosted login, registration, and directory access stay pinned to this server-configured backend. Local mode also supports direct native connections and `.iv` input
through the bridge API. See the configuration table above and
[.env.example](.env.example).

Use one running process/replica and disable sleeping: sessions and native sockets
live in process memory, so replacing the process disconnects connected players.
A deployment does not include a game server, account data, or original resources.
To provide a cache, mount it read only and set `ALTAWAY_CLIENT_DIR` accordingly.

HTTPS protects the browser-to-bridge hop. A direct native TCP connection retains
the backend's original transport properties. See [SECURITY.md](SECURITY.md).

## Preparing a public repository

```sh
npm run release:prepare
```

This produces `release/browser-client-0.3.0/`, a `.tar.gz` source archive,
and its SHA-256 file. The staged directory is the intended public repository
root. Its `SOURCE_MANIFEST.json` records per-file hashes. The exporter uses a
positive allowlist and checks selected inputs for common private-key/token and
personal-path patterns. It excludes original resources, UI extracts, research
screenshots, deployment metadata, local tests, logs, credentials, runtime
binaries, and sibling projects. This scan is a release safeguard, not a proof
that arbitrary future additions are secret-free.

Use that staged directory or extracted archive when initializing the public
repository. Do not publish the containing reverse-engineering workspace. No
remote repository is created by the preparation command. `private: true` in
`package.json` prevents accidental npm registry publication; it does not
restrict use of the MIT-licensed source. CI builds on Node 22 and 24, installs
Tcl, runs the portable suite, and uploads the source archive.

## Limitations

This is a compatibility implementation under active development. Full original
client parity has not been established. Uncommon native attachment/CEL-handle
operations, file chooser behavior, some wait flags/chore opcodes, and every
device-specific presentation still need verification. Unsupported Tcl bindings
report errors. The native numeric binding for `MESSAGE_npcGiveTo_request`
remains unresolved and is not guessed. No native avatar-deletion operation was
recovered. Some original malformed resources are rejected by bounded decoders.

Local fixture tests establish the authored implementation's behavior. They do
not establish public-world economy, staff, private-home, or player acceptance.
Use appropriate accounts and obtain the world operator's authorization for
live testing.

## Troubleshooting

- **The page is missing or changes do not appear:** run `npm run build` after
  installing dependencies and after editing TypeScript. `npm run dev` watches
  the compiled server; it does not compile source changes automatically.
- **World discovery or sign-in fails:** confirm the backend is running and the
  configured URL is correct. The bridge must reach the backend HTTP service
  and the world/RPC addresses advertised by it. The companion server listens
  on HTTP `8080`, world TCP `1701`, and RPC `1702` by default.
- **Tcl cannot start:** run `npm run tcl:setup`, or set `TCLSH` to an absolute
  path to a compatible Tcl 8.6 interpreter. A successful Node build does not
  install Tcl.
- **An explicitly configured cache is rejected:** check that the selected
  directory contains a compatible `mag/` and `wsres/` cache. Omit the setting
  to let the world supply resources during login.
- **Hosted requests return 403:** check that the reverse proxy preserves the
  request host and that `ALTAWAY_PUBLIC_ORIGIN` exactly matches the HTTPS
  origin used by the browser.

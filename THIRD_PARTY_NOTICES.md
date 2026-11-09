# Third-party notices and asset boundaries

The MIT license applies to the authored browser client, bridge, protocol codecs,
tests, and tools in this source distribution. It does not relicense original
client software, artwork, fonts, sound recordings, scripts, trademarks, or
world content obtained separately from a compatible service.

## Tcl

The optional Tcl runtime is built from the official Tcl 8.6.16 source release.
The download is verified against a pinned SHA-256 in `scripts/setup-tcl.ts`.
Tcl is distributed under its own BSD-style terms, reproduced in
[docs/licenses/Tcl-license.terms](docs/licenses/Tcl-license.terms).
Docker images include that license and Tcl's installed library files.

## Original client resources

The original WorldsAway artwork from circa 1995 is used with permission from
Fujitsu.

MAG/WSRES caches, Windows executable files, extracted toolbar icons, native
fonts, original Tcl resources, and screenshots of original world content are
not part of the open-source export. Supply caches you are entitled to use via
`ALTAWAY_CLIENT_DIR` or `--client-dir`; these resources retain their owners'
rights. Received world resources are processed in memory during a session.

Locally supplied Windows toolbar and speech button PNGs may be copied into a
built application or Docker image from `public/native-icons/`. This is optional
and does not add those images to the MIT-licensed source distribution or change
their owners' rights. The extraction tool reads a separately supplied
`wa32.exe`; the executable itself is not included in the application build.

The authored renderer contains numeric palette lookup values and protocol
constants used for interoperability. These do not grant rights to any images,
branding, or service. This project is an independent compatibility client and
does not claim affiliation with or endorsement by a world operator.

## Development tools

TypeScript, tsx, esbuild, and Node type definitions are development dependencies.
Their license files are provided in their installed npm packages. They are not
bundled into the browser or required by the compiled Node server. The exact
dependency graph and integrity hashes are recorded in `package-lock.json`.

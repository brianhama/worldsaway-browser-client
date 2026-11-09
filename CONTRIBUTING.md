# Contributing

Use Node.js 22 or newer and npm. Install the locked development dependencies:

```sh
npm ci
npm run check
npm test
```

The browser (`public/`), Node bridge (`server/`), protocol codecs (`native/`),
and development tools (`scripts/`) are TypeScript source. Relative module
imports use `.js` specifiers so the compiled ESM runs directly in Node and the
browser. Keep `strict` enabled and add useful types at API boundaries. Runtime
wire fields are dynamic; validate them before sending requests or allocating
buffers. Never evaluate world scripts as JavaScript.

Use `npm run tcl:setup` to build the checksum-pinned interpreter. Tests requiring
that interpreter report a skip if it is absent. The portable suite uses
synthetic inputs and loopback fixtures; it requires no account, world cache,
or connection to a public server.

Document changes to native behavior with the request/reply involved and a
reproducible synthetic fixture when possible.

Before proposing a change, run `npm run release:prepare`. This checks the code,
runs portable tests, and creates an allowlisted source export. Never commit
passwords, launcher tickets, connection files, server data, personal logs,
deployment state, extracted resources, or runtime binaries.

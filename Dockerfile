FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY public/ public/
COPY server/ server/
COPY native/ native/
COPY scripts/ scripts/
RUN npm run build

FROM node:24-bookworm-slim AS tcl-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates zlib1g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist/scripts/ dist/scripts/
RUN node dist/scripts/setup-tcl.js

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates zlib1g && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TCLSH=/app/.runtime/tcl-8.6.16/bin/tclsh8.6
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist/ dist/
COPY --from=build --chown=node:node /app/server/*.tcl server/
COPY --from=tcl-build --chown=node:node /app/.runtime/tcl-8.6.16/ .runtime/tcl-8.6.16/
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node docs/licenses/ docs/licenses/
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]

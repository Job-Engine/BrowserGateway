# Browser Automation Gateway v2. Multi-stage: compile TS, prune dev deps, run
# compiled output as non-root. Self-hosted Stagehand drives Browserbase REMOTE
# browsers, so no local Chromium. Bundles the 1Password CLI for JIT secrets.

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the `prepare` lifecycle runs `husky` (a devDependency); with
# --omit=dev husky is absent, so the script exits 127 and fails the build.
# Runtime deps need no install scripts, so skipping them is safe here.
RUN npm ci --omit=dev --ignore-scripts

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS opcli
ARG OP_VERSION=2.30.3
ARG OP_ARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -sSfO "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip" \
 && unzip "op_linux_${OP_ARCH}_v${OP_VERSION}.zip" op -d /usr/local/bin

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app
ENV NODE_ENV=production
# ca-certificates: the `op` CLI (a Go binary) verifies TLS against the SYSTEM
# trust store, which node:20-slim ships empty — without this, `op read` fails
# with "x509: certificate signed by unknown authority" against 1Password's API
# and JIT credential resolution dies with AUTH_UNAVAILABLE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=opcli /usr/local/bin/op /usr/local/bin/op
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD \
  node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM triggers the in-process graceful drain (queue finishes in-flight runs).
CMD ["node", "dist/gateway/server.js"]

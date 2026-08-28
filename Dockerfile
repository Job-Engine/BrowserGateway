# Browser Automation Gateway v2. Multi-stage: compile TS, prune dev deps, run
# compiled output as non-root. Self-hosted Stagehand drives Browserbase REMOTE
# browsers, so no local Chromium. Bundles the 1Password CLI for JIT secrets.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the `prepare` lifecycle runs `husky` (a devDependency); with
# --omit=dev husky is absent, so the script exits 127 and fails the build.
# Runtime deps need no install scripts, so skipping them is safe here.
RUN npm ci --omit=dev --ignore-scripts

FROM debian:bookworm-slim AS opcli
ARG OP_VERSION=2.30.3
ARG OP_ARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -sSfO "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip" \
 && unzip "op_linux_${OP_ARCH}_v${OP_VERSION}.zip" op -d /usr/local/bin

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
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

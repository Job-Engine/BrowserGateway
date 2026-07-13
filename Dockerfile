# Browser Automation Gateway
# Self-hosted Stagehand runs against Browserbase's REMOTE browsers, so no local
# Chromium is needed here. The image bundles the 1Password CLI for JIT secret
# resolution via a service account token.

FROM node:20-slim AS base
WORKDIR /app

# 1Password CLI (op). Set OP_VERSION / arch as needed (amd64 shown).
ARG OP_VERSION=2.30.3
ARG OP_ARCH=amd64
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -sSfO "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip" \
 && unzip "op_linux_${OP_ARCH}_v${OP_VERSION}.zip" op -d /usr/local/bin \
 && rm -f "op_linux_${OP_ARCH}_v${OP_VERSION}.zip" \
 && op --version \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src

EXPOSE 8080
# tsx runs the TS entrypoint directly; swap for a built dist/ in production.
CMD ["npx", "tsx", "src/gateway/server.ts"]

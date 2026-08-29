# Agent Browser Studio — headless controller image (REST + MCP + scheduler).
#
# The managed Chromium engine currently publishes macOS arm64 builds. For
# Linux, build the engine with patches/chromium/build-linux.sh and bake it
# into the image (or mount it at /opt/chromium/chrome):
#
#   ./patches/chromium/build-linux.sh ./chromium-src-150 x64
#   docker build --build-arg CHROMIUM_BINARY=./chromium-src-150/out/AgentBrowserRelease/chrome .
FROM golang:1.25-bookworm AS build
# Install Node 22 (for tsc + the Electron toolchain) alongside Go 1.25.
RUN curl -fsSL https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV ELECTRON_DISABLE_GPU=1 \
    AGENT_BROWSER_HEADLESS=1 \
    AGENT_BROWSER_API_PORT=26582
COPY --from=build /app /app
# Linux engine binary is provided at runtime via the compose volume mount
# (./chromium -> /opt/chromium) or by replacing /opt/chromium/chrome. Build it
# with patches/chromium/build-linux.sh. The controller fails closed with a clear
# error if no binary is present (no upstream wrapper fallback).
ENV AGENT_BROWSER_CHROMIUM_BINARY_PATH=/opt/chromium/chrome
# Electron/Chromium runtime shared libraries + fonts on a slim base.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
    libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libx11-xcb1 libxshmfence1 libfontconfig1 libxext6 libglib2.0-0 \
    libgdk-pixbuf-2.0-0 libxss1 libxtst6 libgtk-3-0 fonts-liberation \
    fonts-noto-color-emoji fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*
# Run as the image's non-root `node` user (home /home/node is writable, so the
# app data dir lands there). Chromium child processes still need --no-sandbox:
# containers lack the user namespaces the Chromium sandbox requires — this is a
# container constraint, not a hardening regression (review item AR-8).
RUN mkdir -p /home/node/.config && chown -R node:node /home/node
USER node
EXPOSE 26582 26581
# --no-sandbox is required for Chromium children inside containers (no user
# namespaces); everything else runs unprivileged as `node`.
CMD ["npx", "electron", ".", "--headless", "--no-sandbox"]

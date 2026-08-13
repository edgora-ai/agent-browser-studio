# Agent Browser Studio — headless controller image (REST + MCP + scheduler).
#
# NOTE: the managed Chromium engine currently publishes macOS arm64 builds.
# On Linux, provide a Linux Chromium binary (Windows/Linux production builds
# are tracked in the alignment matrix) and point the controller at it via
# AGENT_BROWSER_CHROMIUM_BINARY_PATH (or drop it into the engine cache root).
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
# Electron/Chromium runtime shared libraries on a slim base.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 libx11-xcb1 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 26582
# --no-sandbox is required when running as root inside a container.
CMD ["npx", "electron", ".", "--headless", "--no-sandbox"]


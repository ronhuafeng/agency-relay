# Development image for agency-relay: a Cloudflare Worker + D1/Durable Objects
# backend plus a React/Tailwind organization console with Playwright browser tests.
#
# Node 26 is a hard requirement: the Vitest suite uses node:sqlite and the Playwright
# console fixture needs Node 26 (see docs/develop/gates.md). All CI workflows pin
# node-version 26.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=26.10.0
ARG PLAYWRIGHT_VERSION=1.63.0

# System packages: build tooling (esbuild/native deps), git/curl, egress Python
# tests, and OpenSSL for the HTTPS browser fixture. Playwright's own OS libraries
# are installed by `playwright install --with-deps` below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        xz-utils \
        unzip \
        build-essential \
        pkg-config \
        python3 \
        openssl \
    && rm -rf /var/lib/apt/lists/*

# Node 26 under /usr/local/node26. Cursor injects its own Node (v22) via /exec-daemon
# ahead of /usr/local/bin on PATH, so a /etc/profile.d prepend makes Node 26 win in
# the login shells that run install/start/terminals and agent commands. ENV PATH
# covers non-login contexts.
RUN mkdir -p /usr/local/node26 \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
       | tar -xJ -C /usr/local/node26 --strip-components=1
ENV PATH=/usr/local/node26/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/ms-playwright
RUN printf 'export PATH=/usr/local/node26/bin:$PATH\nexport PLAYWRIGHT_BROWSERS_PATH=/usr/local/ms-playwright\n' \
      > /etc/profile.d/zz-agency-relay.sh \
    && chmod 0755 /etc/profile.d/zz-agency-relay.sh

# pnpm pinned to package.json "packageManager" (pnpm@10.28.2), installed globally so
# every user resolves it without a per-user corepack cache.
RUN npm install -g pnpm@10.28.2

# Playwright browsers (chromium + webkit) and their OS dependencies, pinned to the
# @playwright/test version in package.json, into a shared world-readable path.
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium webkit

USER ubuntu

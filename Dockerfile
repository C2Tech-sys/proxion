# syntax=docker/dockerfile:1

# Proxion -- a modern, open-source web console for Proxmox VE.
# Multi-stage build: install workspace deps once, build every package, then
# assemble a minimal, non-root runtime image containing only the built
# server (with its production dependencies copied in, not symlinked back
# into the monorepo) and the built web app's static assets.

ARG NODE_VERSION=24-alpine

# `--platform=$BUILDPLATFORM`: the dependency install and the TypeScript/Vite build run on
# the builder's own architecture even when the target is another one (a multi-arch release
# builds linux/amd64 and linux/arm64). Everything they produce is architecture-independent --
# the server's production dependency tree contains no native modules -- and only the small
# `runtime` stage below is assembled per target platform. Without this, the whole Node build
# ran under QEMU emulation for arm64 and took hours.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS base
# Pin pnpm to the version in package.json's "packageManager" field via corepack,
# so the image always builds with the exact pnpm the workspace was authored against.
RUN corepack enable
WORKDIR /app

# --- deps: install the full workspace (all packages, dev deps included --
# the build stage needs tsc/vite/etc). Copying only manifests first keeps
# this layer cached across source-only changes. ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/pve-api/package.json packages/pve-api/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile

# --- build: compile the web app (Vite -> apps/web/dist), the server
# (tsc -> apps/server/dist), and the pve-api/core packages (tsc -> packages/*/dist),
# then assemble a self-contained, production-only deployment of @proxion/server
# into /app/server -- `pnpm deploy` copies its workspace dependencies
# (@proxion/pve-api, @proxion/core) in as real files rather than leaving the plain
# `node_modules/@proxion/pve-api -> ../../../packages/pve-api` symlinks that a
# normal `pnpm install` produces (which only resolve inside the monorepo). ---
FROM deps AS build
COPY . .
RUN pnpm build && \
    pnpm deploy --prod --filter @proxion/server \
        --config.inject-workspace-packages=true \
        --config.node-linker=hoisted \
        /app/server

# --- runtime: just the deployed server + the built web assets. ---
FROM node:${NODE_VERSION} AS runtime

ARG PROXION_VERSION=0.1.0
LABEL org.opencontainers.image.title="Proxion" \
      org.opencontainers.image.description="A modern, open-source web console for Proxmox VE" \
      org.opencontainers.image.source="https://github.com/C2Tech-sys/proxion" \
      org.opencontainers.image.url="https://github.com/C2Tech-sys/proxion" \
      org.opencontainers.image.documentation="https://github.com/C2Tech-sys/proxion/blob/main/docs/deploy.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${PROXION_VERSION}"

ENV NODE_ENV=production \
    PORT=3080 \
    HOST=0.0.0.0 \
    PROXION_WEB_DIST=/app/web/dist \
    PROXION_DATA_DIR=/app/data

WORKDIR /app

# Non-root runtime user with a fixed, host-portable numeric uid/gid.
# The official node image already ships an unprivileged `node` user as uid/gid 1000.

COPY --from=build --chown=1000:1000 /app/server ./server
COPY --from=build --chown=1000:1000 /app/apps/web/dist ./web/dist
# Per-user data (preferences); mount a named volume here to persist it across container
# recreates -- see docker-compose.example.yml's `proxion_data` volume. Owned by uid 1000 (the
# runtime user below) so it doesn't need a fixup or run as root just to write into it.
RUN mkdir -p /app/data && chown 1000:1000 /app/data

USER 1000:1000

EXPOSE 3080

# Shell form (not hadolint's preferred JSON array) is required here to
# expand $PORT and to fall back to a non-zero exit on failure.
# hadolint ignore=DL3025
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server/dist/index.js"]

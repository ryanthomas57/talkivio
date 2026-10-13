# syntax=docker/dockerfile:1.7
#
# Talkivio backend image. ONE image, three process roles selected by command:
#   api      node --enable-source-maps dist/main.js     REST + widget assets (GATEWAY_SEPARATE=true moves sockets out)
#   gateway  node --enable-source-maps dist/gateway.js  Socket.IO /realtime/v1 on GATEWAY_PORT (default 4001)
#   worker   node --enable-source-maps dist/worker.js   outbox publisher, BullMQ jobs, timers, email
#   seed     node dist/seed.js                          local fixtures only (refuses NODE_ENV=production)
#
# Targets:
#   runtime (default, last stage)  minimal production image, non-root, read-only-rootfs friendly
#   migrate                        one-shot: role bootstrap + `prisma migrate deploy` as the owner role
#
# Build context: repository root.   docker build -f infra/docker/api.Dockerfile --target runtime .
# Build args are NON-SECRET metadata only (GIT_SHA, BUILD_TIME, VERSION, SOURCE_URL). Runtime secrets are injected
# as environment/secret mounts at deploy time, never baked into layers.

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

# ───────────── runtime-base: OS packages shared by every stage ─────────────
FROM ${NODE_IMAGE} AS runtime-base
# openssl: Prisma engine platform detection (debian-openssl-3.0.x); tini: PID 1 signal forwarding/reaping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl tini \
 && rm -rf /var/lib/apt/lists/*

# ───────────── base: build toolchain (pnpm pinned to package.json "packageManager") ─────────────
FROM runtime-base AS base
ARG PNPM_VERSION=10.9.0
ENV CI=true \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN npm install -g "pnpm@${PNPM_VERSION}" \
 && pnpm config set store-dir /pnpm/store

# ───────────── deps: locked install (cache keyed on manifests + lockfile only) ─────────────
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/widget/package.json apps/widget/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=talkivio-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@talkivio/api..." --filter "@talkivio/widget..."

# ───────────── build: shared -> widget -> api (prisma generate + nest build) ─────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/widget apps/widget
COPY apps/api apps/api
COPY infra/postgres infra/postgres
RUN pnpm --filter @talkivio/contracts build \
 && pnpm --filter @talkivio/widget build \
 && pnpm --filter @talkivio/api build \
 && test -f apps/api/dist/main.js && test -f apps/api/dist/gateway.js && test -f apps/api/dist/worker.js \
 && test -f apps/widget/dist/loader.js

# ───────────── deploy: production-only node_modules + generated Prisma client ─────────────
FROM build AS deploy
RUN --mount=type=cache,id=talkivio-pnpm-store,target=/pnpm/store \
    pnpm --filter @talkivio/api deploy --prod --legacy /out \
 && cd /out \
 && /repo/apps/api/node_modules/.bin/prisma generate --schema prisma/schema.prisma \
 && rm -rf src test tsconfig.json tsconfig.build.json nest-cli.json dist/.tsbuildinfo

# ───────────── migrate: one-shot migration job (owner credentials live ONLY here) ─────────────
FROM build AS migrate
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/repo/infra/postgres/migrate.sh"]

# ───────────── runtime (default target) ─────────────
FROM runtime-base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    GATEWAY_PORT=4001 \
    WIDGET_DIST_DIR=/app/widget-dist
# Files stay root-owned and read-only for the runtime user (works with read_only: true + tmpfs /tmp).
COPY --from=deploy /out /app
COPY --from=build /repo/apps/widget/dist /app/widget-dist
USER node
EXPOSE 4000 4001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
# Liveness only (process is serving). Orchestrators should gate traffic on /health/ready.
# HEALTHCHECK_PORT selects the gateway port (4001) for the gateway role; the worker has no HTTP listener
# (disable the check for the worker role, see docker-compose.yml).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTHCHECK_PORT||process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG VERSION=0.0.0-dev
ARG SOURCE_URL=unknown
LABEL org.opencontainers.image.title="talkivio-api" \
      org.opencontainers.image.description="Talkivio API, realtime gateway and worker (select role by command)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}"

# syntax=docker/dockerfile:1.7
#
# Talkivio dashboard image (apps/dashboard, Next.js `output: 'standalone'`).
# Build context: repository root.   docker build -f infra/docker/dashboard.Dockerfile .
#
# Build-time variables (NOT secrets — they end up in the bundle or routes manifest):
#   API_INTERNAL_URL        server-side rewrite target for /api/v1/* (Next evaluates rewrites() at
#                           build time, so this is baked into the image; see README "Containers").
#   NEXT_PUBLIC_BRAND_NAME, NEXT_PUBLIC_REALTIME_ORIGIN
#                           public by design (NEXT_PUBLIC_* is inlined into the browser bundle).
# Never pass credentials as build args: they persist in image history.

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS base
ARG PNPM_VERSION=10.9.0
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g "pnpm@${PNPM_VERSION}" \
 && pnpm config set store-dir /pnpm/store

FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/widget/package.json apps/widget/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=talkivio-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@talkivio/dashboard..."

FROM deps AS build
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_BRAND_NAME=Talkivio
# Empty = same origin as the dashboard (the reverse proxy routes /realtime/* to the gateway).
ARG NEXT_PUBLIC_REALTIME_ORIGIN=
ENV API_INTERNAL_URL=${API_INTERNAL_URL} \
    NEXT_PUBLIC_BRAND_NAME=${NEXT_PUBLIC_BRAND_NAME} \
    NEXT_PUBLIC_REALTIME_ORIGIN=${NEXT_PUBLIC_REALTIME_ORIGIN}
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @talkivio/contracts build \
 && mkdir -p apps/dashboard/public \
 && pnpm --filter @talkivio/dashboard build \
 && if [ ! -f apps/dashboard/.next/standalone/apps/dashboard/server.js ]; then \
      echo "Unexpected Next.js standalone layout (expected .next/standalone/apps/dashboard/server.js):" >&2; \
      find apps/dashboard/.next/standalone -maxdepth 3 -name server.js >&2; exit 1; \
    fi

FROM runtime-base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /repo/apps/dashboard/public ./apps/dashboard/public
# The only runtime-writable path (image optimisation / fetch cache); mount a tmpfs here when the
# root filesystem is read-only.
RUN mkdir -p apps/dashboard/.next/cache && chown node:node apps/dashboard/.next/cache
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]

ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG VERSION=0.0.0-dev
ARG SOURCE_URL=unknown
LABEL org.opencontainers.image.title="talkivio-dashboard" \
      org.opencontainers.image.description="Talkivio agent and admin dashboard (Next.js standalone)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}"

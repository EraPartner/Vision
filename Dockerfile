# ============================================================
# Stage 1: Build the React frontend
# ============================================================
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS frontend-builder

WORKDIR /app

# Copy workspace manifests so bun can resolve the workspace graph.
# bun.lock* matches both text (bun.lock) and binary (bun.lockb) lockfile formats.
# Only MANIFESTS go before `bun install` — workspace:* deps resolve from
# package.json files alone (bun symlinks node_modules/@vision/* to packages/*,
# whose sources land after the install layer). Copying full packages/ or
# i18n/source here would bust the dependency layer on every source/locale edit.
COPY package.json bun.lock* ./
COPY apps/frontend/package.json ./apps/frontend/
# node-backend manifest is required here: bun workspaces resolve all members
# at install time, so `bun install --frozen-lockfile` fails if any workspace
# package.json declared in the root is missing — even though stage 1 only
# builds the frontend.
COPY apps/node-backend/package.json ./apps/node-backend/
COPY packages/shared-utils/package.json ./packages/shared-utils/
COPY packages/types/package.json ./packages/types/
RUN bun install --frozen-lockfile

# Workspace sources + locale inputs after the install layer (cache-friendly).
COPY packages ./packages
COPY i18n/source ./i18n/source
COPY scripts/generate-locales.js ./scripts/generate-locales.js

# Copy frontend source and build
COPY apps/frontend/ ./apps/frontend/
RUN node scripts/generate-locales.js
# VITE_DEVTOOLS=true enables the dev-only observability panel in the built bundle.
# Set via docker-compose.dev.yml build args; omitted in production so the panel
# is tree-shaken by Vite's dead-code elimination.
ARG VITE_DEVTOOLS=false
ENV VITE_DEVTOOLS=${VITE_DEVTOOLS}
RUN bun run --filter vision-frontend build

# ============================================================
# Stage 2: Production backend
# ============================================================
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app

# Install system dependencies:
#   - Python/Alembic for DB migrations
#   - Chromium (Alpine-native, musl-linked) for Puppeteer PDF rendering
#     Puppeteer's bundled Chrome is a glibc x86_64 binary and cannot run on
#     Alpine (musl) or ARM64 hosts. We skip the bundled download and use the
#     distro package instead.
RUN apk upgrade --no-cache && \
    apk add --no-cache python3 py3-pip chromium && \
    python3 -m venv /venv && \
    . /venv/bin/activate && \
    pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir alembic psycopg2-binary python-dotenv sqlalchemy-utils

# Copy and make entrypoint executable
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install backend production dependencies. Backend depends on @vision/types
# (workspace:*), so install from the monorepo root with the full workspace graph.
# Manifests only before install (see stage 1 note); package sources follow.
COPY package.json bun.lock* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/node-backend/package.json ./apps/node-backend/
COPY packages/shared-utils/package.json ./packages/shared-utils/
COPY packages/types/package.json ./packages/types/
# Skip Puppeteer's bundled Chromium download — we use the Alpine system package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN bun install --frozen-lockfile --production

# Workspace package sources — the node_modules/@vision/* symlinks created by
# the install above resolve into these paths at runtime.
COPY packages ./packages

# Copy backend source and built frontend
COPY apps/node-backend/src/ ./apps/node-backend/src/
COPY --from=frontend-builder /app/dist ./dist

# Copy Alembic migration files and config
COPY config/alembic.ini ./config/
COPY alembic/ ./alembic/

ENV NODE_ENV=production
ENV ENVIRONMENT=production
# Path to the Alpine-installed Chromium binary used by Puppeteer.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
# Alembic installed in /venv by the Python layer above; backend's in-process
# runMigrations() shells out via this path instead of relying on $PATH.
ENV ALEMBIC_BIN=/venv/bin/alembic

# Hand /app and /venv to the built-in `bun` user (UID 1000) so the runtime
# can read code, write the attachments volume, and exec the Python venv
# without root. Compose sets `user: "1000:1000"` to match.
# Pre-create the attachments dir so the named volume inherits bun ownership
# on first mount (Docker copies the image dir's perms onto an empty volume).
RUN mkdir -p /app/data/attachments /app/.vision-cache && chown -R bun:bun /app /venv

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/health || exit 1

USER bun

# Run entrypoint (which runs migrations then starts the backend)
ENTRYPOINT ["/entrypoint.sh"]

# ============================================================
# Stage 1: Build the React frontend
# ============================================================
FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app

# Copy workspace manifests so bun can resolve the workspace graph.
# bun.lock* matches both text (bun.lock) and binary (bun.lockb) lockfile formats.
# packages/ must be copied before install so workspace:* deps (@vision/types) resolve.
COPY package.json bun.lock* ./
COPY apps/frontend/package.json ./apps/frontend/
# node-backend manifest is required here: bun workspaces resolve all members
# at install time, so `bun install --frozen-lockfile` fails if any workspace
# package.json declared in the root is missing — even though stage 1 only
# builds the frontend.
COPY apps/node-backend/package.json ./apps/node-backend/
COPY packages ./packages
COPY i18n/source ./i18n/source
COPY scripts/generate-locales.js ./scripts/generate-locales.js
RUN bun install --frozen-lockfile

# Copy frontend source and build
COPY apps/frontend/ ./apps/frontend/
RUN node scripts/generate-locales.js
RUN bun run --filter vision-frontend build

# ============================================================
# Stage 2: Production backend
# ============================================================
FROM oven/bun:1-alpine

WORKDIR /app

# Install Python and Alembic for database migrations
RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /venv && \
    . /venv/bin/activate && \
    pip install --no-cache-dir alembic psycopg2-binary python-dotenv sqlalchemy-utils

# Copy and make entrypoint executable
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install backend production dependencies. Backend depends on @vision/types
# (workspace:*), so install from the monorepo root with the full workspace graph.
COPY package.json bun.lock* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/node-backend/package.json ./apps/node-backend/
COPY packages ./packages
RUN bun install --frozen-lockfile --production

# Copy backend source and built frontend
COPY apps/node-backend/src/ ./apps/node-backend/src/
COPY --from=frontend-builder /app/dist ./dist

# Copy Alembic migration files and config
COPY config/alembic.ini ./config/
COPY alembic/ ./alembic/

ENV NODE_ENV=production
ENV ENVIRONMENT=production
# Alembic installed in /venv by the Python layer above; backend's in-process
# runMigrations() shells out via this path instead of relying on $PATH.
ENV ALEMBIC_BIN=/venv/bin/alembic

EXPOSE 3002

# Run entrypoint (which runs migrations then starts the backend)
ENTRYPOINT ["/entrypoint.sh"]

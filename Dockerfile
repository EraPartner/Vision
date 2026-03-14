# ============================================================
# Stage 1: Build the React frontend
# ============================================================
FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app

# Copy workspace manifests so bun can resolve the workspace graph.
# bun.lock* matches both text (bun.lock) and binary (bun.lockb) lockfile formats.
COPY package.json bun.lock* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/node-backend/package.json ./apps/node-backend/
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

# Install backend production dependencies only
COPY apps/node-backend/package.json apps/node-backend/bun.lockb* ./apps/node-backend/
RUN cd apps/node-backend && bun install --frozen-lockfile --production

# Copy backend source and built frontend
COPY apps/node-backend/src/ ./apps/node-backend/src/
COPY --from=frontend-builder /app/dist ./dist

ENV NODE_ENV=production
ENV ENVIRONMENT=production

EXPOSE 3002

# Use bun instead of node: bun's JS runtime starts faster and uses less memory
# than stock Node.js for ESM entry points.
CMD ["bun", "run", "apps/node-backend/src/main.js"]

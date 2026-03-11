# ============================================================
# Stage 1: Build the React frontend
# ============================================================
FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app

# Copy workspace manifests so bun can resolve the workspace graph
COPY package.json bun.lockb* ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/node-backend/package.json ./apps/node-backend/
RUN bun install --frozen-lockfile

# Copy frontend source and build
COPY apps/frontend/ ./apps/frontend/
RUN bun run --filter vision-frontend build

# ============================================================
# Stage 2: Production Node.js backend
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

CMD ["node", "apps/node-backend/src/main.js"]

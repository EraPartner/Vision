# ============================================================
# Stage 1: Build the React frontend
# ============================================================
FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app

# Install root dependencies (Vite, React, etc.)
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Copy only what Vite needs to build
COPY index.html ./
COPY config/ ./config/
COPY apps/frontend/ ./apps/frontend/

RUN bun run build

# ============================================================
# Stage 2: Production Node.js backend
# ============================================================
FROM oven/bun:1-alpine

WORKDIR /app

# Install backend production dependencies only
COPY apps/node-backend/package.json apps/node-backend/bun.lockb* ./apps/node-backend/
RUN cd apps/node-backend && bun install --frozen-lockfile --production

# Copy backend source
COPY apps/node-backend/src/ ./apps/node-backend/src/

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/dist ./dist

ENV NODE_ENV=production
ENV ENVIRONMENT=production

EXPOSE 3002

CMD ["node", "apps/node-backend/src/main.js"]

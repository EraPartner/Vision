---
title: Setup Guide
type: guide
status: active
date: 2026-04-21
updated: 2026-04-29
tags: [guide, setup, development, local, phase-1, docker-compose, onboarding]
description: Complete setup instructions for local development
aliases: [setup-guide, installation, getting-started, local-dev]
related_code: [[package.json]]
---

# Setup Guide

This guide covers setting up Vision for local development.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh/) | Latest | Package manager and runtime |
| [Docker](https://www.docker.com/) | Latest | Required for local database workflow |
| [Node.js](https://nodejs.org/) | 20+ | Required for Electron packaging |

## Quick Start

### 1. Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd Vision

# Install dependencies
bun install
```

### 2. Environment Configuration

```bash
# Copy the example environment file
cp .env .env.local

# Edit .env.local with your settings
# Key variables:
# - DATABASE_URL: PostgreSQL connection string
# - VITE_API_URL: Frontend API URL (default: http://localhost:3002)
```

### 3. Database Setup

#### Option A: Using Docker (Recommended)

```bash
# Start the full stack (db + app with automatic migrations)
bun run docker:dev
```

Startup flow runs automatically via `docker-entrypoint.sh`:
1. Waits for PostgreSQL to be ready
2. Runs `alembic upgrade head` to bootstrap or migrate the schema
3. Starts the backend application
4. After backend start, non-blocking startup tasks run in background (cache warming, price provider refresh, Kinesis history sanitization)

**Note:** As of 2026-04-29, `docker-compose.dev.yml` no longer declares `vision_postgres_data_dev` as `external: true`. The volume is now auto-created by Docker Compose on first run — no manual setup needed. This fixes the "external volume not found" error on clean checkouts.

**Database schema:** As of Phase 1 (2026-04-21), Alembic is the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). The legacy `schemaInit.js` has been deleted. Fresh databases are bootstrapped by running `alembic/versions/0001_initial_database_schema.py`, which creates all 27 tables, enums, indexes, and triggers in a single baseline migration.

If you are testing clean-slate startup repeatedly, prefer:

```bash
bun run docker:clean:reset
```

This recreates the clean Postgres volume before boot.

### 4. Start Development Server

```bash
# Run both backend and frontend
bun run dev
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3002

## Development Commands

### Root Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Run both backend and frontend |
| `bun run build` | Production build (generates locales) |
| `bun run build:dev` | Development build |
| `bun run lint` | ESLint on frontend |
| `bun run test` | Run all backend tests |
| `bun run test:watch` | Watch mode for tests |

### Database Commands

| Command | Description |
|---------|-------------|
| `bun run db:upgrade` | Run Alembic migrations |
| `bun run db:revision` | Create new migration |

### Docker Commands

| Command | Description |
|---------|-------------|
| `bun run docker:dev` | Start dev environment |
| `bun run docker:dev:down` | Stop dev environment |
| `bun run docker:dev:rebuild` | Rebuild containers |

## Project Structure

```
Vision/
├── apps/
│   ├── frontend/          # React frontend
│   │   └── src/
│   │       ├── components/  # UI components
│   │       ├── contexts/    # React contexts
│   │       ├── pages/       # Page components
│   │       └── hooks/       # Custom hooks
│   └── node-backend/     # Express API
│       └── src/
│           ├── routes/      # API endpoints
│           ├── services/   # Business logic
│           ├── repositories/ # Data access
│           └── middleware/  # Express middleware
├── alembic/
│   └── versions/          # Database migrations
├── config/                # Shared configuration (alembic.ini)
├── docker-entrypoint.sh   # Docker startup script (runs migrations)
├── i18n/                  # Localization files
├── docs/                  # Knowledge base
└── packaging/electron/    # Electron desktop app
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `VITE_API_URL` | Frontend API URL | http://localhost:3002 |
| `PORT` | Server port | 3002 |
| `LOG_LEVEL` | Logging level | info |
| `CORS_ORIGINS` | Allowed CORS origins | http://localhost:5173 |

## Running Tests

### Backend Tests

```bash
# Run all tests
bun run test

# Watch mode
bun run test:watch

# Run specific test file
bun vitest run src/path/to/test.test.js

# Run specific test by name
bun vitest run --test-name-pattern="testName"
```

### Frontend Tests

Tests for the frontend use React Testing Library. See [[docs/testing/index|Testing Documentation]] for details.

## Troubleshooting

### Database Connection Issues

```bash
# Check if db container is running
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db

# Verify database connection
psql $DATABASE_URL -c "SELECT 1"
```

### Port Already in Use

```bash
# Find process using port 3002
lsof -i :3002

# Kill the process
kill -9 <PID>
```

### Migration Issues

```bash
# Check current migration status
bun run db:current

# View migration history
bun run db:history

# Reset to a specific migration
bun run db:stamp <revision>
```

## Next Steps

- Read [[docs/guides/deployment|Deployment Guide]] for production setup
- Read [[docs/guides/contributing|Contributing Guide]] to start contributing
- Explore [[docs/features/index|Features Documentation]]

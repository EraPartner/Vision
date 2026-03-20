---
title: Setup Guide
type: guide
description: Complete setup instructions for local development
date: 2026-03-18
tags: [guide, setup, development, local]
related_code: [[package.json]]
---

# Setup Guide

This guide covers setting up Vision for local development.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh/) | Latest | Package manager and runtime |
| [PostgreSQL](https://www.postgresql.org/) | 18+ | Database (or use Docker) |
| [Docker](https://www.docker.com/) | Latest | Optional, for database/containerized dev |
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

Migrations run automatically via `docker-entrypoint.sh` which:
1. Waits for PostgreSQL to be ready
2. Runs Alembic migrations
3. Starts the backend

#### Option B: Local PostgreSQL

```bash
# Setup local PostgreSQL
bun run db:setup

# Run migrations
bun run db:upgrade
```

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
| `bun run db:setup` | Setup PostgreSQL |
| `bun run db:start` | Start PostgreSQL |
| `bun run db:stop` | Stop PostgreSQL |
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
# Check if PostgreSQL is running
bun run db:start

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

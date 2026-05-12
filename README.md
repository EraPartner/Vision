# Vision

<p align="center">
  <strong>Self-hosted personal finance for people who care about privacy, clarity, and control.</strong><br/>
  Track transactions, plan cash flow, manage investments, and chat with your data — all on your own infrastructure.
</p>

<p align="center">
  <a href="https://github.com/EraPartner/Vision/actions/workflows/ci.yml"><img src="https://github.com/EraPartner/Vision/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only" /></a>
  <img src="https://img.shields.io/badge/Frontend-React%2018%20%2B%20TypeScript-61DAFB" alt="Frontend: React + TypeScript" />
  <img src="https://img.shields.io/badge/Backend-Node.js%20(Express)-339933" alt="Backend: Node.js + Express" />
  <img src="https://img.shields.io/badge/Runtime-Bun-black" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1" alt="Database: PostgreSQL" />
  <img src="https://img.shields.io/badge/Desktop-Electron-47848F" alt="Desktop: Electron" />
  <img src="https://img.shields.io/badge/i18n-EN%20%7C%20NL-success" alt="Languages: EN | NL" />
</p>

---

## Why Vision?

Most finance apps trade your privacy for convenience. Vision gives you both:

- **Privacy-first** — your financial data never leaves your environment
- **Self-hosted** — run on Docker Compose or as a native Electron desktop app
- **Complete** — transactions, budgeting, portfolio analytics, Belgian tax, AI chat, and net worth in one place
- **Developer-friendly** — TypeScript/React + Node.js/Express in a clean Bun monorepo with an OpenAPI spec

---

## Features

### 💳 Transactions & Imports

- Import CSV exports from **Belfius, Revolut, KBC, SABB, Wise, ING, BNP Paribas**, your own Vision backup, or a **generic CSV mapper**
- Fast filtering, search, and pagination via a materialized aggregations layer
- Deduplication, categorization rules, and recurring pattern detection
- Transaction splits and manual entry
- Attachments per transaction
- Export to CSV or Vision backup format

### 📅 Budgeting & Planned Payments

- Categories and recipients with rules, merging, and exclusions
- Planned/recurring payments with forecasting and execution history
- Dashboard widgets for account-level visibility and cash position tracking
- Saved chart configurations

### 📈 Portfolio & Net Worth

- Track **stocks, crypto, real estate, savings, bonds**
- Price providers: **Yahoo Finance**, **Binance**, **Kinesis**, and **custom JSON endpoints**
- Currency conversion via ECB with fallback rate sources
- Net worth and performance over time with portfolio snapshots
- Market lookup and watchlist for decision support
- PDF report export (portfolio + tax summary)

### 🤖 AI Chat

- Local AI assistant powered by **Ollama** — no data sent to third-party LLMs
- Query your transactions, categories, and financial data in natural language
- Tool-augmented responses with structured result cards

### 🧩 Product Experience

- Modern UI built on Radix UI / shadcn patterns + Tailwind CSS
- English and Dutch (`nl`) localization
- Offline-resilient — online status detection gates market queries, disables refresh controls gracefully
- Secure backup/restore with AES-256-GCM encryption (per-backup salt)
- Desktop app via Electron with Docker-managed backend

---

## Quick Start

### Option A — macOS Desktop (recommended for end users)

The `install.sh` script sets up everything from scratch — Homebrew, Docker Desktop, Bun, dependencies, and a `.app` launcher:

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
./install.sh
```

After installation, double-click the `Launch Vision.command` shortcut or run:

```bash
bun run electron:prod
```

> Docker Desktop must be running. On first launch, Vision generates `.env` with a secure random password automatically.

### Option B — Docker Compose (any platform)

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
cp .env.example .env

# Generate a secure password and set it in both fields in .env
openssl rand -hex 32

docker compose up -d
```

Open `http://localhost:3002` in your browser.

```bash
docker compose down        # stop
docker compose down -v     # stop and remove all data
```

### Option C — Development mode

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
bun install
cp .env.example .env       # edit as needed

bun run docker:dev         # start Postgres + backend via Compose
bun run dev                # start frontend + backend in watch mode
```

| Service | URL |
|---------|-----|
| Frontend | `http://localhost:5174` |
| Backend API | `http://localhost:3002` |

---

## For Developers

### Monorepo Layout

```text
Vision/
├── apps/
│   ├── frontend/               # React 18 + TypeScript + Vite
│   │   └── src/
│   │       ├── features/       # Feature modules (transactions, categories, imports, ai-chat…)
│   │       ├── components/     # Shared UI components
│   │       ├── hooks/          # Custom React hooks
│   │       ├── stores/         # Client state (Zustand)
│   │       └── locales/        # Generated i18n files (en, nl)
│   └── node-backend/           # Express API (Bun runtime)
│       └── src/
│           ├── routes/         # REST endpoints
│           ├── services/       # Business logic, price providers, bank adapters
│           ├── repositories/   # Data access layer
│           ├── integrations/   # Ollama AI client
│           └── middleware/     # Auth, logging, error handling
├── packages/
│   └── types/                  # Shared TypeScript types (generated from openapi.yaml)
├── packaging/
│   └── electron/               # Desktop wrapper
├── alembic/                    # PostgreSQL migrations
├── i18n/source/                # i18n source files → compiled to apps/frontend/src/locales/
├── scripts/                    # Locale generation, validation, sync tooling
├── docs/                       # Obsidian knowledge base (ADRs, API docs, feature specs)
├── openapi.yaml                # REST API contract (source of truth for types)
└── config/                     # Alembic config
```

### All Scripts

```bash
# Development
bun run dev                  # frontend + backend in watch mode (concurrent)
bun run backend              # backend only

# Building
bun run build                # production frontend build (generates locales first)
bun run build:dev            # dev-mode frontend build
bun run preview              # preview production build
bun run dist                 # build + package Electron .app

# Linting
bun run lint                 # frontend ESLint
bun run lint:backend         # backend ESLint

# Testing
bun run test                 # backend Vitest suite
bun run test:frontend        # frontend Vitest suite
bun run test:all             # backend + frontend (concurrent)
bun run test:coverage        # frontend coverage report
bun run test:watch           # backend watch mode

# Database (Alembic / PostgreSQL)
bun run db:upgrade           # apply all pending migrations
bun run db:downgrade         # revert one migration
bun run db:current           # show current revision
bun run db:history           # show migration history
bun run db:stamp             # stamp DB at head without running migrations
bun run db:revision          # create a new autogenerate migration

# Docker
bun run docker:dev           # start Compose dev stack
bun run docker:dev:down      # stop dev stack
bun run docker:dev:rebuild   # rebuild and restart dev stack
bun run docker:clean         # start clean Compose stack (fresh build)
bun run docker:clean:down    # stop clean stack
bun run docker:clean:reset   # wipe volumes + restart clean stack
bun run docker:logs          # tail app logs

# Electron
bun run electron:dev         # desktop dev mode
bun run electron:prod        # desktop production mode
bun run electron:clean       # desktop with clean Compose override

# i18n
bun run generate-locales     # compile i18n source → locale files
bun run validate-locales     # check locale completeness
bun run sync-nl              # sync Dutch locale from English source

# Types
bun run generate:types       # regenerate TypeScript types from openapi.yaml
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Radix UI, shadcn/ui, TanStack Query, TanStack Table |
| Backend | Node.js (Bun runtime), Express |
| Database | PostgreSQL 18 (Alpine), Alembic migrations |
| Desktop | Electron |
| AI | Ollama (local LLM) |
| Testing | Vitest (frontend + backend) |
| Packaging | Docker Compose, GitHub Actions release workflow |
| API spec | OpenAPI 3.x (`openapi.yaml`) |

### Bank Import Adapters

| Adapter | File |
|---------|------|
| Belfius | `belfius.js` |
| Revolut | `revolut.js` |
| KBC | `kbc.js` |
| ING | `ing.js` |
| BNP Paribas Fortis | `bnp.js` |
| SABB | `sabb.js` |
| Wise | `wise.js` |
| Vision backup | `vision.js` |
| Generic CSV mapper | `generic.js` |

### Price Providers

| Provider | Asset class |
|----------|------------|
| Yahoo Finance | Stocks, ETFs, indices |
| Binance | Crypto |
| Kinesis | Precious metals (gold, silver) |
| Custom JSON endpoint | Any asset via configurable URL + path |

---

## Configuration

Copy `.env.example` to `.env` and fill in the required values.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | ✓ | DB password for Compose setup |
| `LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` (default: `warn`) |
| `ENABLE_LOGGING` | — | Toggle logging output (`true` / `false`) |

> The Electron launcher generates `.env` automatically on first run with a securely randomized password. You only need to create it manually for Docker-only deployments.

---

## API

The full REST API is documented in [`openapi.yaml`](openapi.yaml). TypeScript types are generated from it:

```bash
bun run generate:types   # → apps/frontend/src/types/generated.ts
```

Endpoint categories: transactions, categories, recipients, imports, investments, portfolio, planned payments, splits, attachments, saved charts, aggregations, reports, market lookup, watchlist, settings, admin, AI chat.

---

## Contributing

1. Fork and create a feature branch from `main`
2. Write tests first (the project follows TDD) — run `bun run test:all` before opening a PR
3. Run `bun run lint` and `bun run lint:backend` to catch style issues
4. Open a pull request with a clear summary and rationale

When adding new adapters, endpoints, or env vars, update `openapi.yaml`, regenerate types, and update the relevant docs in `docs/`.

---

## Releases

Tag-driven releases (`vX.Y.Z`) trigger GitHub Actions to build and push release artifacts (container images + Electron packages) and publish a GitHub Release.

Workflow: `.github/workflows/release.yml`

---

## Security & Privacy

- Never commit real `.env` files or secrets
- Keep your deployment private and access-controlled
- Backups are encrypted with AES-256-GCM (per-backup random salt)
- Dependency and container images should be reviewed and updated regularly
- AI chat uses a local Ollama instance — no financial data leaves your network

---

## License

Licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE).

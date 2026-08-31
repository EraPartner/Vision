# Vision

<p align="center">
  <strong>Self-hosted personal finance for people who care about privacy, clarity, and control.</strong><br/>
  Track transactions, plan cash flow, manage investments, and chat with your data — all on your own infrastructure.
</p>

<p align="center">
  <a href="https://github.com/EraPartner/Vision/actions/workflows/ci.yml"><img src="https://github.com/EraPartner/Vision/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only" /></a>
  <img src="https://img.shields.io/badge/Frontend-React%2019%20%2B%20TypeScript-61DAFB" alt="Frontend: React + TypeScript" />
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
- Desktop app via Electron with bundled PostgreSQL 18 and a native Bun backend

---

## Quick Start

### Option A — macOS Desktop (recommended for end users)

Install the release DMG. The application contains PostgreSQL 18, the migration
runner, the Bun backend, the production frontend, and the browser used for PDF
reports. Neither Docker Desktop nor a running Homebrew PostgreSQL service is
required.

To build the same application from source, first provide Bun, Node.js, a
PostgreSQL 18.6 distribution from Postgres.app or Homebrew, and a Python build
environment containing the pinned requirements and PyInstaller 6.22.2. The
PostgreSQL service does not need to be started. Then run:

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
./install.sh
```

After installation, open **Vision** from `/Applications/Vision.app`:

```bash
open /Applications/Vision.app
```

Vision creates a private, loopback-only database under its macOS application-data
directory on first launch. See
[`docs/guides/native-macos-runtime.md`](docs/guides/native-macos-runtime.md) for
data migration and rollback.

For a fully isolated application with deterministic synthetic data, build and install
**Vision Demo**:

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
```

Vision Demo uses its own bundled native PostgreSQL runtime below
`~/Library/Application Support/Vision Demo/native/vision_demo`. It does not require Docker and
cannot access the real Vision database. Restore its canonical dataset with
`bun run demo:reset-native`, then quit and reopen the Demo app.

Both macOS installers build the production frontend in a private temporary directory and remove
that staging directory on exit. They do not depend on, reuse, or clear the repository's shared
`dist` directory.

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
docker compose down        # stop without deleting data volumes
```

### Option C — Development mode

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
bun install
bun run native:prepare     # one-time native PostgreSQL/migration/PDF payload
bun run dev                # start private PostgreSQL, backend, and frontend
```

`native:prepare` needs PostgreSQL 18.6 build files and the pinned Python build
dependencies, but it never starts the external PostgreSQL service. Docker
development remains available explicitly through `bun run docker:dev`.

| Service     | URL                                                         |
| ----------- | ----------------------------------------------------------- |
| Frontend    | `http://localhost:8080` (auto-picks next free port if busy) |
| Backend API | `http://localhost:3002`                                     |

---

## For Developers

### Monorepo Layout

```text
Vision/
├── apps/
│   ├── frontend/               # React 19 + TypeScript + Vite
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
│   ├── shared-utils/           # Pure helpers (money, slugify, downsample) shared by backend + frontend
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
bun run native:prepare       # one-time private PostgreSQL/migration/PDF payload
bun run dev                  # private PostgreSQL + watched backend + Vite
bun run backend              # backend only; requires an explicit database config

# Building
bun run build                # production frontend build (generates locales first)
bun run build:dev            # dev-mode frontend build
bun run preview              # preview production build
bun run dist                 # build + package Electron .app
bun run demo:reset-native    # request a canonical synthetic Demo reset on next launch

# Linting & types
bun run lint                 # frontend ESLint
bun run lint:backend         # backend ESLint
bun run typecheck            # frontend TypeScript typecheck

# Testing
bun run test                 # backend Vitest suite
bun run test:db              # backend suite with a private temporary PostgreSQL 18
bun run test:frontend        # frontend Vitest suite
bun run test:all             # backend + frontend (concurrent)
bun run test:coverage        # frontend coverage report
bun run test:watch           # backend watch mode
bun run test:e2e             # frontend Playwright end-to-end tests
bun run test:e2e:visual      # frontend visual-regression tests

# Database (Alembic / PostgreSQL)
bun run db:upgrade           # apply all pending migrations
bun run db:downgrade         # destructive maintenance only; never run on live data
bun run db:current           # show current revision
bun run db:history           # show migration history
bun run db:stamp             # expert recovery only; does not run migrations
bun run db:revision          # create a new autogenerate migration
bun run db:index-stats       # report index usage stats
bun run db:precision-drift   # check for numeric precision drift
bun run quotes:densify       # backfill/densify asset price history

# Docker
bun run docker:dev           # start Compose dev stack
bun run docker:dev:down      # stop dev stack
bun run docker:dev:rebuild   # rebuild and restart dev stack
bun run docker:clean         # start clean Compose stack (fresh build)
bun run docker:clean:down    # stop clean stack
bun run docker:clean:reset   # DESTROYS the synthetic clean volume; never real data
bun run docker:logs          # tail app logs

# Electron
bun run electron:dev         # native desktop with isolated development data
bun run electron:prod        # native desktop production shell
bun run electron:docker      # explicit optional Docker provider
bun run electron:clean       # destructive synthetic Docker clean provider only

# i18n
bun run generate-locales     # compile i18n source → locale files
bun run sanitize-locales     # sanitize locale files without recompiling
bun run validate-locales     # check locale completeness
bun run sync-nl              # sync Dutch locale from English source

# Types & API
bun run generate:types       # regenerate TypeScript types from openapi.yaml
bun run check-endpoint-matrix # verify docs endpoint matrix matches openapi.yaml
```

### Tech Stack

| Layer     | Technology                                                                                    |
| --------- | --------------------------------------------------------------------------------------------- |
| Frontend  | React 19, TypeScript, Vite, Tailwind CSS, Radix UI, shadcn/ui, TanStack Query, TanStack Table |
| Backend   | Node.js (Bun runtime), Express                                                                |
| Database  | PostgreSQL 18.6 native bundle or optional PostgreSQL 18 Compose service; Alembic migrations   |
| Desktop   | Electron                                                                                      |
| AI        | Ollama (local LLM)                                                                            |
| Testing   | Vitest (frontend + backend)                                                                   |
| Packaging | Native Electron DMG/ZIP, optional Docker Compose, GitHub Actions release workflow             |
| API spec  | OpenAPI 3.x (`openapi.yaml`)                                                                  |

### Bank Import Adapters

| Adapter            | File         |
| ------------------ | ------------ |
| Belfius            | `belfius.js` |
| Revolut            | `revolut.js` |
| KBC                | `kbc.js`     |
| ING                | `ing.js`     |
| BNP Paribas Fortis | `bnp.js`     |
| SABB               | `sabb.js`    |
| Wise               | `wise.js`    |
| Vision backup      | `vision.js`  |
| Generic CSV mapper | `generic.js` |

### Price Providers

| Provider             | Asset class                           |
| -------------------- | ------------------------------------- |
| Yahoo Finance        | Stocks, ETFs, indices                 |
| Binance              | Crypto                                |
| Kinesis              | Precious metals (gold, silver)        |
| Custom JSON endpoint | Any asset via configurable URL + path |

---

## Configuration

Native Vision generates database credentials in its restricted application-data directory. Do not
create a database URL for the packaged app. Copy `.env.example` to `.env` only for Docker Compose
or source-development provider keys and overrides.

| Variable            | Required       | Description                                           |
| ------------------- | -------------- | ----------------------------------------------------- |
| `DATABASE_URL`      | Docker/custom  | PostgreSQL connection string                          |
| `POSTGRES_PASSWORD` | Docker Compose | Database bootstrap password                           |
| `LOG_LEVEL`         | No             | `debug` / `info` / `warn` / `error` (default: `warn`) |
| `ENABLE_LOGGING`    | No             | Toggle logging output (`true` / `false`)              |

> The native Electron provider writes `runtime.env` with restrictive permissions and separate
> administrator, migration-owner, and application credentials. The optional Docker provider keeps
> its existing `.env` contract.

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

# Vision

<p align="center">
  <strong>Self-hosted personal finance for people who care about privacy, clarity, and control.</strong><br/>
  Track transactions, plan cash flow, manage investments, and prepare your Belgian taxes, all on your own Mac.
</p>

<p align="center">
  <a href="https://github.com/EraPartner/Vision/actions/workflows/ci.yml"><img src="https://github.com/EraPartner/Vision/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only" /></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20(Apple%20Silicon)-black" alt="Platform: macOS (Apple Silicon)" />
  <img src="https://img.shields.io/badge/Frontend-React%2019%20%2B%20TypeScript-61DAFB" alt="Frontend: React + TypeScript" />
  <img src="https://img.shields.io/badge/Backend-Express%20on%20Bun-339933" alt="Backend: Express on Bun" />
  <img src="https://img.shields.io/badge/Database-SQLite-003B57" alt="Database: SQLite" />
  <img src="https://img.shields.io/badge/i18n-EN%20%7C%20NL-success" alt="Languages: EN | NL" />
</p>

---

## What is Vision?

Vision is a desktop finance manager. It imports your bank exports, categorizes and analyses your
spending, tracks your portfolio and net worth, and computes Belgian personal income tax. Your
data lives in one SQLite database file in the app's own data folder on your Mac. There is no
database server.

- **Private by default.** No account and no cloud service. AI chat and investigations run on a
  local Ollama model ([AI data access](docs/security/ai-data-access.md)).
- **One app.** Transactions, budgets, planned payments, forecasts, investments, research, and tax
  in one place.
- **Built to last.** A strict TypeScript monorepo with an OpenAPI contract, a SQLite schema
  under versioned migrations, and tests against a real database.

Vision is a native macOS app for Apple Silicon. There are no Windows, Linux, or browser builds
([ADR-219](docs/adr/219-minimal-electron-shell-hardening.md)).

---

## Features

### 💳 Transactions and imports

- CSV import from **Belfius, Revolut, KBC, SABB, Wise, ING, BNP Paribas Fortis**, a Vision
  backup, or a **generic CSV mapper**
- Deduplication, categorization rules, transfer detection between your own accounts, splits,
  tags, attachments, and bulk actions across many rows at once
- Accounts with running balances and reconciliation
- Export to CSV or the Vision backup format

### 📅 Budgeting and planning

- Categories and recipients with rules, merging, and exclusions
- Planned and recurring transactions with execution history
- Cash-flow forecast from planned transactions or statistical methods, with confidence bands
- Statistics: year-over-year comparisons, pivot tables with drill-through, a Sankey flow chart,
  rolling averages, and saved custom charts
- Analysis workspace over approved datasets, with saved analyses and scheduled monitors

### 📈 Portfolio and net worth

- Stocks, ETFs, crypto, precious metals, real estate, savings, and bonds
- Price providers: **Yahoo Finance**, **Binance**, **Kinesis**, and **custom JSON endpoints**
- Currency conversion from stored rates (ECB, with open.er-api for currencies ECB does not publish)
- Daily net-worth snapshots and performance over time
- Portfolio statement import, market lookup, watchlist, and research dossiers

### 🇧🇪 Belgian tax

- Personal income tax calculator with regional rules, deductions, and cadastral income
- Portfolio tax tracking (including the Reynders rule)
- The server computes all tax figures ([ADR-217](docs/adr/217-belgian-tax-figures-on-the-server.md))

### 🤖 AI chat

- Local assistant on **Ollama** that answers questions about your transactions and categories
  with tool-backed result cards

### 🧩 App

- English and Dutch
- PDF reports for finances, portfolio, and tax
- Backup and restore, with optional AES-256-GCM encryption (per-backup random salt)
- In-app updates for the packaged app, with a backup and rollback path

Feature details live in [`docs/features/`](docs/features/index.md).

---

## Quick start

### Install the macOS app

Install the release DMG. It contains Bun, the migrations, the backend and the frontend, and uses
the SQLite library that ships with macOS. PDF reports print with the desktop app's own Electron
Chromium.

Vision creates its database, `database/vision.sqlite3`, under its macOS application-data
directory on first launch. See
[`docs/guides/native-macos-runtime.md`](docs/guides/native-macos-runtime.md) for the data layout
and rollback.

**Coming from Vision 2.0?** Its data was in PostgreSQL, which this version does not read. Convert a
Vision 2.0 backup with `bun run transition:v2 -- <backup file>` from a checkout of commit
[`dd4cc71`](https://github.com/EraPartner/Vision/tree/dd4cc71), the last one with the transition
script.

### Build the app from source

You need Bun and Node.js. No database server is needed.

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
./install.sh
open /Applications/Vision.app
```

### Try the demo

**Vision Demo** is a separate app with deterministic synthetic data. It uses its own database
below `~/Library/Application Support/Vision Demo/database/` and cannot reach the real Vision
database.

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
bun run demo:reset-native   # restore the canonical dataset, then reopen the Demo app
```

Both installers build the frontend in a private temporary directory and do not touch the
repository's `dist` directory.

### Development mode

```bash
bun install --frozen-lockfile
bun run dev              # watched backend on its own development database + Vite
```

| Service     | URL                                                    |
| ----------- | ------------------------------------------------------ |
| Frontend    | `http://127.0.0.1:8080` (picks the next port if taken) |
| Backend API | `http://localhost:3002`                                |

More setup detail: [`docs/getting-started.md`](docs/getting-started.md).

---

## Architecture

```mermaid
flowchart LR
  subgraph Electron["Electron shell (macOS)"]
    UI["React 19 frontend<br/>TanStack Query"]
  end
  UI -- "REST (openapi.yaml)" --> API["Express backend on Bun<br/>routes → services → repositories"]
  API -- "Kysely" --> DB[("SQLite file<br/>in-process, app data folder")]
  API --> Ext["Price, FX and research providers"]
  API --> AI["Ollama (local)"]
```

- **The server computes, the browser displays.** Totals, FX conversion, gains, forecasts, and tax
  are computed by the backend ([ADR-216](docs/adr/216-server-owned-domain-calculations.md)).
- **Database access** goes through Kysely with types generated from the migrated schema
  ([ADR-226](docs/adr/226-kysely-query-builder.md)).
- **Migrations** are numbered `.sql` files in `db/migrations/`, applied on boot in one
  transaction, after an automatic copy of a database that already holds data
  ([ADR-263](docs/adr/263-sqlite-replaces-postgresql.md)).
- **Ids, currency codes and money are branded types**
  ([ADR-220](docs/adr/220-branded-ids-currency-codes-and-money.md)).

Read more in [`docs/architecture/`](docs/architecture/index.md) and the
[ADRs](docs/adr/).

### Monorepo layout

```text
Vision/
├── apps/
│   ├── frontend/          # React 19 + TypeScript + Vite (features/, components/, hooks/, stores/)
│   └── node-backend/      # Express API on Bun (routes/, services/, repositories/, integrations/)
├── packages/
│   ├── shared-utils/      # Pure helpers shared by backend and frontend (money, CSV, Belgian tax engine)
│   └── types/             # Shared TypeScript types and branded ids
├── packaging/electron/    # Desktop shell and native runtime
├── db/migrations/         # SQLite migrations
├── i18n/source/           # Locale sources, compiled to apps/frontend/src/locales/
├── scripts/               # Repository tooling (locales, checks)
├── config/                # Shared tool configuration
├── docs/                  # Obsidian knowledge base (ADRs, features, guides, reference)
└── openapi.yaml           # REST API contract
```

### Tech stack

| Layer    | Technology                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, Radix UI, shadcn/ui, TanStack Query |
| Backend  | Express on Bun, Zod, decimal.ts                                               |
| Database | SQLite (system library, 3.39 or later) with Kysely                            |
| Desktop  | Electron, Apple Silicon DMG and ZIP                                           |
| AI       | Ollama (local)                                                                |
| Testing  | Vitest, with backend tests against real SQLite database files                 |
| API spec | OpenAPI 3 (`openapi.yaml`)                                                    |

---

## Development

### Common scripts

```bash
# Run
bun run dev                  # watched backend on its own development database + Vite
bun run electron:dev         # desktop shell with isolated development data

# Check
bun run lint                 # frontend, backend and projects ESLint + import boundaries (depcruise) + dead code (knip)
bun run lint:backend         # backend ESLint
bun run typecheck            # frontend; typecheck:backend, typecheck:packages, typecheck:electron for the rest
bun run check                # every lint, typecheck and test gate in sequence

# Test
bun run test                 # backend Vitest suite
bun run test:frontend        # frontend suite with live API contracts against a temporary database
bun run test:all             # backend + frontend suites

# Database
bun run db:migrate           # apply pending migrations
bun run db:status            # list applied and pending migrations
bun run db:new -- <name>     # create db/migrations/NNNN_<name>.sql
bun run db:codegen           # regenerate the Kysely database types

# API and locales
bun run generate:types       # regenerate apps/frontend/src/types/generated.ts from openapi.yaml
bun run check-endpoint-matrix # check docs/reference/api-endpoint-matrix.md against openapi.yaml
bun run validate-locales     # check en/nl key parity

# Package
bun run dist                 # build and package the Electron app
```

The full list, with what each script needs, is in
[`docs/reference/scripts.md`](docs/reference/scripts.md).

### Configuration

The packaged app chooses its own database file and keeps its settings in a restricted
`runtime.env` in its application-data directory. Do not set a database path for it.

For source development, copy `.env.example` to `.env` only when you need provider API keys or
overrides. The template documents every optional setting (database file, logging, Ollama,
AI web research, research providers). See
[`docs/reference/environment-variables.md`](docs/reference/environment-variables.md).

### Contributing

1. Create a branch from `main`.
2. Write tests at stable boundaries: API contracts, real SQLite state, and pure domain
   functions ([ADR-215](docs/adr/215-behaviour-boundary-tests.md)).
3. Run `bun run lint`, `bun run lint:backend`, `bun run typecheck`, and the relevant tests.
4. Use Conventional Commits. `main` requires signed commits, linear history, and a passing
   `CI Complete` check.
5. When you change an endpoint, update `openapi.yaml`, regenerate types, and update the endpoint
   matrix. When you change behaviour, update `docs/`.

See [`docs/guides/contributing.md`](docs/guides/contributing.md) and
[`docs/guides/cicd-pipelines.md`](docs/guides/cicd-pipelines.md).

### Coding agents

[`AGENTS.md`](AGENTS.md) is the shared guide for coding agents. Claude Code also gets edit-time
checks, a read-only SQLite MCP server, a TypeScript navigation MCP server, and structural
search with `bun run search:ast`
([ADR-227](docs/adr/227-claude-code-static-analysis-aids.md),
[ADR-228](docs/adr/228-typescript-navigation-mcp.md)).

---

## Releases

Pushing a `vX.Y.Z` tag runs [`release.yml`](.github/workflows/release.yml), which builds the Apple
Silicon app and DMG and publishes a GitHub Release. It does not re-run the test suites: the tagged
commit must be on `main` with a passing `CI Complete` check. It re-runs the secrets scan and
dependency audits on the release tree before packaging.

---

## Security and privacy

- Your data stays in one SQLite file in Vision's data folder on your Mac. No database server
  listens on any port.
- Never commit real `.env` files or secrets.
- The Electron shell runs with context isolation and the sandbox on, and Node integration off.
- Backups can be encrypted with AES-256-GCM (per-backup random salt).
- Ollama runs locally by default. If you point it at a remote endpoint, that endpoint receives
  your prompts and tool results.

See [`docs/security/`](docs/security/).

---

## License

Licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE).

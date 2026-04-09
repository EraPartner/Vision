# Vision

<p align="center">
  <strong>Self-hosted personal finance for people who care about privacy, clarity, and control.</strong><br/>
  Track transactions, plan cash flow, and manage investments — all on your own infrastructure.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only" /></a>
  <a href="https://github.com/EraPartner/Vision/releases"><img src="https://img.shields.io/github/v/release/EraPartner/Vision" alt="Latest release" /></a>
  <a href="https://github.com/EraPartner/Vision/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/EraPartner/Vision/release.yml?label=release" alt="Release workflow status" /></a>
  <a href="https://github.com/EraPartner/Vision/stargazers"><img src="https://img.shields.io/github/stars/EraPartner/Vision?style=social" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/Frontend-React%2018%20%2B%20TypeScript-61DAFB" alt="Frontend: React + TypeScript" />
  <img src="https://img.shields.io/badge/Backend-Node.js%20(Express)-339933" alt="Backend: Node.js + Express" />
  <img src="https://img.shields.io/badge/Runtime-Bun-black" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1" alt="Database: PostgreSQL" />
  <img src="https://img.shields.io/badge/Desktop-Electron-47848F" alt="Desktop: Electron" />
  <img src="https://img.shields.io/badge/i18n-EN%20%7C%20NL-success" alt="Languages: EN | NL" />
</p>

---

## Why Vision?

Most finance apps trade convenience for privacy. Vision gives you both:

- **Privacy-first**: your financial data stays in your environment
- **Self-hosted**: run it locally with Docker Compose or the Electron desktop flow
- **Practical**: transactions, budgeting, planning, portfolio analytics, and net worth in one app
- **Developer-friendly**: modern TypeScript/React frontend + Node/Express backend in a Bun monorepo

---

## Feature Highlights

### 💳 Transactions & Imports
- Import CSV data from **Belfius, Revolut, KBC, SABB, Wise**, plus a **generic CSV mapper**
- Fast filtering, categorization, deduplication, and recurring pattern detection
- Manual transaction entry when you need quick edits

### 📅 Budgeting & Planned Payments
- Categories and recipients with rules and exclusions
- Planned/recurring payments with forecasting and execution history
- Dashboard widgets for account-level visibility and cash position tracking

### 📈 Portfolio & Net Worth
- Track **stocks, crypto, real estate, savings, bonds**
- Monitor net worth and performance over time
- Use market lookup/watchlist features for portfolio decision support
- Currency conversion with ECB and fallback exchange-rate sources

### 🧩 Product Experience
- Modern UI built on Radix/shadcn patterns + Tailwind
- English and Dutch localization
- Desktop mode via Electron

---

## Quick Start

Choose your preferred run mode:

### Option A — Desktop app (end users, production flow)

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
bun install
bun run electron:prod
```

Notes:
- This is the recommended end-user flow.
- Docker Desktop must be installed/running.
- On first launch, Vision can generate missing local runtime config (like `.env`) automatically.

### Option B — Desktop app (development flow)

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
bun install
bun run electron:dev
```

Useful variants:

```bash
bun run electron:clean  # start with clean compose override
bun run dev             # frontend+backend web development flow (non-Electron)
```

### Option C — Docker Compose (self-hosted stack)

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
cp .env.example .env

# Generate a secure password and use it in both POSTGRES_PASSWORD and DATABASE_URL
openssl rand -hex 32

docker compose up -d
```

Open: `http://localhost:3002`

Stop services:

```bash
docker compose down
```

Remove all persisted data:

```bash
docker compose down -v
```

---

## For Developers

### Monorepo Layout

```text
Vision/
├── apps/
│   ├── frontend/       # React 18 + TypeScript + Vite
│   └── node-backend/   # Express API (Bun runtime)
├── packaging/
│   └── electron/       # Desktop wrapper
├── alembic/            # DB migrations
├── docs/               # Obsidian-style knowledge base
└── scripts/            # Tooling and local DB helpers
```

### Local Development Setup

```bash
git clone https://github.com/EraPartner/Vision.git
cd Vision
bun install

# Local Postgres helpers
bun run db:setup
bun run db:start

cp .env.example .env
# edit .env as needed

bun run dev
```

Default dev URLs:
- Frontend: `http://localhost:5174`
- Backend API: `http://localhost:3002`

### Core Scripts

```bash
bun run dev            # Frontend + backend (watch)
bun run build          # Production frontend build
bun run build:dev      # Development-mode build
bun run lint           # Frontend lint
bun run test           # Backend Vitest suite

bun run db:setup       # Initialize local PostgreSQL
bun run db:start       # Start local PostgreSQL
bun run db:upgrade     # Apply Alembic migrations

bun run docker:dev     # Compose dev stack
bun run docker:logs    # Tail app logs

bun run electron:dev   # Desktop mode (dev)
bun run electron:prod  # Desktop mode (prod)
```

---

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Radix UI, TanStack Query/Table
- **Backend:** Node.js (Bun runtime), Express, PostgreSQL
- **Desktop:** Electron
- **Testing:** Vitest (backend)
- **Packaging/Deploy:** Docker Compose + GitHub Actions release workflow

---

## Configuration

Key environment variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | DB password for compose setup |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `ENABLE_LOGGING` | Toggle logging output |

Use `.env.example` as your starting point.

---

## Contributing

Contributions are welcome.

1. Fork and create a feature branch from `main`
2. Implement your changes with tests where relevant
3. Run checks locally (`bun run lint`, `bun run test`, build commands)
4. Open a pull request with a clear summary and rationale

If you’re adding new adapters, endpoints, or env vars, update relevant docs and examples.

---

## Releases

Tag-driven releases (`vX.Y.Z`) trigger GitHub Actions to build/push release artifacts (including container images) and publish a GitHub Release.

Primary workflow: `.github/workflows/release.yml`

---

## Security & Privacy

- Do not commit real `.env` files or secrets
- Keep your deployment private and access-controlled
- Review dependency and container updates regularly

Vision is designed for self-hosting and local control of financial data.

---

## License

Licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE).

# Vision

A self-hosted, privacy-first personal finance manager. All your financial data stays on your machine — no cloud sync, no third-party access, no subscriptions.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20(tested)-lightgrey)
![Languages](https://img.shields.io/badge/EN%20%7C%20NL-i18n-green)

> **Platform note:** Vision is primarily developed and tested on **macOS (Apple Silicon)**. The Docker Compose path should work on Linux and Windows, but those platforms are not actively tested.

---

## Features

### Transactions
- **Transaction management** — Import, categorize, filter, and search all your bank transactions
- **Bank CSV import** — Dedicated adapters for Belfius, Revolut, KBC, SABB, Wise, and a fully configurable generic CSV format
- **Manual entry** — Create transactions directly from the UI without importing a file
- **Deduplication** — Automatic detection and prevention of duplicate imported transactions
- **Recurring detection** — Automatically identifies recurring transaction patterns

### Budget & Planning
- **Categories & recipients** — Organize transactions with custom categories, payee profiles, hidden categories, and exclusion rules
- **Planned payments** — Track recurring and scheduled payments with cash flow forecasting and execution history

### Investments
- **Investment portfolio** — Stocks, ETFs, crypto, real estate, savings, and bonds with live price feeds
- **Net worth & performance** — Full portfolio overview with performance history tracking
- **Market lookup & watchlist** — Search any ticker or asset and track price targets
- **Exchange rates** — Live and cached rates via ECB XML feed and open.er-api.com, auto-refreshed every 12 hours

### Other
- **Shared expenses** — Split transactions and track who owes you what
- **Statistics & charts** — Rich dashboards with customizable saved charts
- **Bilingual UI** — English and Dutch (Nederlands)
- **Desktop app** — macOS native app via Electron with auto-updates

---

## Installation

Vision runs as a **macOS desktop app** or as a **Docker Compose stack**.

### Option 1: macOS Desktop App (recommended)

Download the latest `.dmg` from the [Releases](https://github.com/EraPartner/Vision/releases) page, open it, and drag Vision to your Applications folder.

On first launch, the app automatically sets up its Docker environment.

> **Requirements:** macOS (Apple Silicon), Docker Desktop installed and running

### Option 2: Docker Compose

> **Requirements:** Docker and Docker Compose

```bash
# 1. Clone the repository
git clone https://github.com/EraPartner/Vision.git
cd Vision

# 2. Create the environment file
cp .env.example .env

# 3. Generate a secure database password and update .env
openssl rand -hex 32
# Paste the output into both POSTGRES_PASSWORD and DATABASE_URL in .env

# 4. Start the stack
docker compose up -d

# 5. Open the app
open http://localhost:3002
```

The app and PostgreSQL database start automatically. Data is persisted in a Docker volume (`postgres_data`) and survives container restarts.

```bash
# Stop the stack
docker compose down

# Stop and remove all data
docker compose down -v
```

---

## Development

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Node.js](https://nodejs.org) 20+
- PostgreSQL running locally (see helper scripts below)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/EraPartner/Vision.git
cd Vision

# 2. Install all dependencies (monorepo)
bun install

# 3. Initialize and start a local PostgreSQL instance (first time only)
bun run db:setup
bun run db:start

# 4. Copy and configure your environment file
cp .env.example .env
# Edit .env and set DATABASE_URL to your local PostgreSQL connection string

# 5. Run frontend + backend in parallel
bun run dev
```

The frontend dev server starts at `http://localhost:5174` and the backend API at `http://localhost:3002`.

### Available Scripts

| Script | Description |
|---|---|
| `bun run dev` | Start frontend + backend in watch mode |
| `bun run build` | Production build (frontend + backend) |
| `bun run test` | Run backend test suite (Vitest) |
| `bun run test:watch` | Run Vitest in watch mode |
| `bun run backend` | Start only the backend |
| `bun run db:setup` | Initialize local PostgreSQL instance |
| `bun run db:start` | Start local PostgreSQL |
| `bun run db:stop` | Stop local PostgreSQL |
| `bun run db:status` | Check PostgreSQL status |
| `bun run docker:build` | Build Docker image locally |
| `bun run docker:up` | Start Docker Compose stack |
| `bun run docker:down` | Stop Docker Compose stack |
| `bun run docker:logs` | Tail app container logs |
| `bun run electron:dev` | Start desktop app in development mode |
| `bun run electron:clean` | Start desktop app with a clean stack |

### Project Structure

```
Vision/
├── apps/
│   ├── frontend/          # React + TypeScript SPA (Vite)
│   └── node-backend/      # Express REST API (Node.js / ESM)
│       └── tests/         # 30 Vitest test files
├── packaging/
│   └── electron/          # macOS desktop wrapper (Electron)
├── scripts/
│   └── db/                # Local PostgreSQL helper scripts
├── alembic/               # Legacy database migration history
├── Dockerfile             # Multi-stage production build
├── docker-compose.yml     # Production stack
└── .env.example           # Environment variable reference
```

### Backend Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `POSTGRES_PASSWORD` | — | Database password (required in Docker) |
| `PORT` | `3002` | HTTP server port |
| `SERVER_HOST` | `127.0.0.1` | Bind address |
| `LOG_LEVEL` | `warn` | Logging level (`debug`, `info`, `warn`, `error`) |
| `ENABLE_LOGGING` | `true` | Toggle structured logging |
| `CORS_ORIGINS` | `localhost:5174,localhost:8080` | Allowed CORS origins (comma-separated) |
| `DB_POOL_SIZE` | — | PostgreSQL connection pool size |
| `EXTERNAL_DATABASE` | `false` | Skip local PostgreSQL management (set to `true` in Docker) |
| `ENABLE_RESET_DB` | `false` | Enable admin endpoint to wipe the database |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript 5, Vite 7 |
| UI | shadcn/ui (Radix UI), Tailwind CSS 3 |
| Charts | Recharts 2 |
| Data fetching | TanStack Query 5 |
| Tables | TanStack Table 8 + Virtual 3 |
| Forms | React Hook Form 7 + Zod |
| Backend | Node.js (ESM), Express 4 |
| Runtime / package manager | Bun |
| Database | PostgreSQL 18 |
| Market data | yahoo-finance2, CoinGecko, Kraken |
| Currency data | ECB XML feed, open.er-api.com |
| Desktop | Electron 41, electron-builder |
| Containerization | Docker Compose (multi-arch: amd64 + arm64) |
| Testing | Vitest |

---

## Supported Bank Formats

| Bank | Format |
|---|---|
| Belfius | CSV export |
| Revolut | CSV export |
| KBC | CSV export |
| SABB | CSV export |
| Wise | CSV export |
| Generic | CSV (configurable column mapping) |
| Manual | Direct entry via the UI |

---

## Contributing

Contributions are welcome. Here are a few guidelines to keep things consistent:

### Getting Started

1. Fork the repository and create a branch from `main`.
2. Follow the [Development](#development) setup instructions above.
3. Make your changes and write or update tests where relevant.
4. Run the test suite before submitting: `bun run test`
5. Open a pull request with a clear description of what changed and why.

### Guidelines

- **Backend tests:** The backend has a Vitest suite covering services, repositories, and routes. New backend logic should include tests.
- **Code style:** The frontend uses ESLint. Run `bun run lint` inside `apps/frontend` before committing.
- **Commits:** Keep commits focused and use clear, descriptive messages.
- **New bank adapters:** CSV adapters live in `apps/node-backend/src/services/` and follow the existing adapter pattern. Include at least one unit test with a real-world-shaped sample CSV.
- **Environment variables:** Any new env vars should be documented in both `.env.example` and the table in this README.

### Reporting Issues

Please open a GitHub issue with:
- A clear description of the problem or feature request
- Steps to reproduce (for bugs)
- Your platform and Vision version

---

## License

[AGPL-3.0](LICENSE) — You are free to use, modify, and self-host this software. If you distribute a modified version, you must release the source under the same license.

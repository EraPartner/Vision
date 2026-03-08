# Financial Transaction Manager - Node.js Backend

A Node.js/Express port of the Python/FastAPI backend. Connects to the **same PostgreSQL database** and exposes the **same REST API**.

## Architecture

```
apps/node-backend/
├── src/
│   ├── main.js                          # Express app entry point (mirrors main.py)
│   ├── config/
│   │   ├── config.js                    # Settings management (mirrors config/config.py)
│   │   └── logger.js                    # Structured logging (mirrors config/logging_config.py)
│   ├── database/
│   │   └── connection.js                # PostgreSQL pool (mirrors database/connection.py)
│   ├── repositories/
│   │   ├── transactionRepository.js     # Transaction data access
│   │   ├── categoryRepository.js        # Category data access
│   │   ├── recipientRepository.js       # Recipient data access
│   │   ├── plannedTransactionRepository.js  # Planned transaction data access
│   │   └── infoRepository.js            # Statistics data access
│   └── routes/
│       ├── transactions.js              # /api/transactions (mirrors api_routes_transactions.py)
│       ├── categories.js                # /api/categories (mirrors api_routes_categories.py)
│       ├── recipients.js                # /api/recipients (mirrors api_routes_recipients.py)
│       ├── plannedTransactions.js       # /api/planned-transactions
│       ├── info.js                      # /api/info (mirrors api_routes_info.py)
│       ├── admin.js                     # /api/admin (mirrors api_routes_admin.py)
│       └── importRoutes.js              # /api/import (stub - use Python backend)
├── package.json
└── README.md
```

## Quick Start

```bash
cd apps/node-backend
npm install
npm run dev
```

The server starts on `http://localhost:3002` by default (same port as Python backend).

## Configuration

Set via environment variables or `.env.local` file in the `apps/node-backend/` directory:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/financial_transactions` | PostgreSQL connection string |
| `PORT` | `3002` | Server port |
| `HOSTNAME` | `localhost` | Server host |
| `CORS_ORIGINS` | `http://localhost:5174` | Allowed CORS origins |
| `ENVIRONMENT` | `development` | Environment name |

## Differences from Python Backend

1. **No CSV Import** - The import functionality (bank adapters, deduplication) is complex and Python-specific. Use the Python backend for imports.
2. **No HATEOAS Links** - Links arrays are returned empty (`[]`). The frontend doesn't use them.
3. **No Alembic** - Database migrations are still managed by the Python backend's Alembic setup.
4. **No SQLAlchemy** - Uses raw SQL via `pg` (node-postgres) for direct, readable queries.

## Running Alongside Python Backend

You can only run one backend at a time on port 3002. To switch:

```bash
# Stop Python backend, start Node.js:
cd apps/node-backend && npm run dev

# Or vice versa:
cd apps/backend && ./venv/bin/python main.py
```

Both backends are fully compatible with the frontend - just point to the same port.

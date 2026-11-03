# Vision Node Backend

The Express backend is Vision's production application service. It provides the REST API,
SQLite persistence, imports, portfolios, planning, reports, attachments, backups, admin tools,
and integrations used by the React frontend.

## Normal development

Start from the repository root:

```bash
bun install --frozen-lockfile
bun run dev
```

This starts the backend in watch mode on its own development SQLite database, and Vite. The
backend creates and migrates the database file when it starts; no database server is involved.
PDF reports are printed by the Electron shell, not the backend. See
[`docs/guides/native-macos-runtime.md`](../../docs/guides/native-macos-runtime.md).

To run only the backend, set `VISION_DATABASE_PATH` to a database file (development defaults to
`./data/vision.sqlite3` under `apps/node-backend`), then run:

```bash
bun run --filter 'financial-transaction-manager-node' dev
```

The backend only binds to loopback: it exits at startup when `SERVER_HOST` is not
`127.0.0.0/8`, `::1` or `localhost`, and it answers only requests whose `Host` names a loopback
address with its own port (ADR-233).

## Configuration

Backend source development uses the environment layering defined in ADR-080:

1. `apps/node-backend/.env.local` for local connection and port overrides;
2. the repository `.env` for shared provider keys and optional manual backend settings; and
3. real process environment values, which take precedence.

Packaged native Vision does not depend on these checkout files. Electron generates a restricted
`runtime.env` in the application-data directory with separate administrator, migration-owner, and
least-privilege application roles.

The authoritative variable inventory is
[`docs/reference/environment-variables.md`](../../docs/reference/environment-variables.md).

## Database migrations

`db/migrations/` holds the schema. `0001_baseline.sql` is the full schema; each later
`NNNN_name.sql` is one migration, and an optional `NNNN_name.down.sql` makes it reversible.
`src/database/migrate.ts` applies them with Kysely's migrator and records them in
`public.kysely_migration`:

```bash
bun run db:migrate                                   # apply pending migrations
bun run apps/node-backend/scripts/db-migrate.ts status
bun run apps/node-backend/scripts/db-migrate.ts new <name>
bun run apps/node-backend/scripts/db-migrate.ts down # only with a .down.sql
```

The migrator uses `DATABASE_URL_MIGRATIONS` when set, otherwise `DATABASE_URL`. Native startup
runs the same migrator automatically.

## Focused checks

```bash
bun run lint:backend
bun run test

# From apps/node-backend for one file or test name:
bun vitest run src/path/to/test.test.js
bun vitest run --test-name-pattern="name"
```

Database-backed tests run against real SQLite database files: the run migrates one template
database in a temporary directory and every test file gets its own copy, so `bun run test` needs
no other setup.

The root [`AGENTS.md`](../../AGENTS.md) and repository documentation define the current development
and safety contract.

## License

Vision is licensed under AGPL-3.0-only. See [`LICENSE`](../../LICENSE).

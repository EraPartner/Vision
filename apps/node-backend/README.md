# Vision Node Backend

The Express backend is Vision's production application service. It provides the REST API,
PostgreSQL persistence, imports, portfolios, planning, reports, attachments, backups, admin tools,
and integrations used by the React frontend.

## Normal development

Start from the repository root:

```bash
bun install
bun run native:prepare
bun run dev
```

This starts Vision's private PostgreSQL 18.6 development cluster, the backend in watch mode, and
Vite. It does not require Docker or a running Homebrew PostgreSQL service. The native preparation
step needs PostgreSQL 18.6 build files, the pinned Python migration build environment, and the
pinned Chrome Headless Shell download. See
[`docs/guides/native-macos-runtime.md`](../../docs/guides/native-macos-runtime.md).

To run only the backend, provide a real `DATABASE_URL` and, for schema changes,
`DATABASE_URL_MIGRATIONS`, then run:

```bash
bun run --filter 'financial-transaction-manager-node' dev
```

The backend binds to loopback in native mode. A non-loopback deployment without
`ADMIN_AUTH_TOKEN` fails closed unless the operator explicitly acknowledges an external network
boundary.

## Configuration

Backend source development uses the environment layering defined in ADR-080:

1. `apps/node-backend/.env.local` for local connection and port overrides;
2. the repository `.env` for shared provider keys and optional Docker settings; and
3. real process environment values, which take precedence.

Packaged native Vision does not depend on these checkout files. Electron generates a restricted
`runtime.env` in the application-data directory with separate administrator, migration-owner, and
least-privilege application roles.

The authoritative variable inventory is
[`docs/reference/environment-variables.md`](../../docs/reference/environment-variables.md).

## Database migrations

Alembic remains the single source of schema definition, but writes must go through Vision's
guarded JavaScript runner because it preflights `alembic_version.version_num` as `VARCHAR(64)`:

```bash
bun run db:upgrade
```

Do not use bare `alembic upgrade`, stamp, reset, or downgrade against live data. Native startup and
Docker startup both invoke the same underlying migration runner automatically.

## Focused checks

```bash
bun run lint:backend
bun run test

# From apps/node-backend for one file or test name:
bun vitest run src/path/to/test.test.js
bun vitest run --test-name-pattern="name"
```

Database-backed tests use the repository's disposable PostgreSQL 18 harness. It prefers installed
native tools and does not start the Homebrew service; Docker remains an optional fallback:

```bash
bun run test:db
```

The root [`AGENTS.md`](../../AGENTS.md) and repository documentation define the current development
and safety contract.

## License

Vision is licensed under AGPL-3.0-only. See [`LICENSE`](../../LICENSE).

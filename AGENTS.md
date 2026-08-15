# AGENTS.md — Vision

Canonical guidance for coding agents working in this repository. Tool-specific adapters may add
integration details, but must not duplicate or override the shared project contract here. If
`AGENTS.local.md` exists, read it before work because it contains host-only setup.

## Project

Vision is a self-hosted financial transaction manager. It supports transaction CRUD,
categorization, multi-bank CSV imports, portfolios, Belgian tax, planned and recurring
transactions, and English/Dutch localization. License: AGPL-3.0-only.

The Bun-workspaces monorepo uses React 19, TypeScript, Vite, Tailwind and Radix on the frontend;
Node/Bun, Express and PostgreSQL on the backend; Vitest for backend tests; and Electron for the
desktop app.

| Workspace | Path |
|---|---|
| `vision-frontend` | `apps/frontend/` |
| `financial-transaction-manager-node` | `apps/node-backend/` |

Use `bun run --filter '<workspace>' <script>` for filtered commands.

## Start with project knowledge

Before changing code, search `docs/` for the relevant architecture decision, contract, feature,
and convention. Treat docs as intent and code as current behavior; resolve conflicts explicitly.

- Architectural change: read `docs/adr/`. ADRs are append-only; supersede with a new ADR.
- Route change: read `docs/reference/api-endpoint-matrix.md`. `openapi.yaml` defines the operation
  set.
- Entry points: `docs/index.md`, `docs/common-tasks.md`, `docs/architecture/index.md`,
  `docs/reference/code-patterns.md`, and `docs/reference/scripts.md`.

## Commands

```bash
bun install
bun run dev
bun run build
bun run lint
bun run lint:backend
bun run typecheck
bun run test
bun run test:frontend
bun run check
# from apps/node-backend:
bun vitest run src/path/to/x.test.js
bun vitest run --test-name-pattern="name"
```

Use the repository skills in `.agents/skills/` for database migrations, localization, releases,
and documentation synchronization.

## Conventions

- Backend: ES2022+ ESM and `async`/`await`. Use `undefined`, not `null`, for optional values.
  Prefer functions over classes. Add comments only when they explain non-obvious intent.
- Frontend: strict TypeScript; interfaces for props and state; Zod input validation; `@/*` maps to
  `apps/frontend/src/*`; functional components and hooks; React Query for server state; Tailwind
  and `class-variance-authority` for variants. Prefix intentionally unused values with `_`.
- Never commit or print secrets or personal financial information. Use `.env.local` only.
- Validate inputs with Zod on the frontend and server-side validation on the backend. Use
  least-privilege database users, rate-limit public endpoints, and audit new dependencies.
- Keep changes focused. Do not mix unrelated cleanup into a task.

## Required synchronization

- Before any direct `docs/` edit, read `docs/AGENTS.md`. Update affected pages with behavior
  changes and use the `update-vision-docs` skill for non-trivial changes.
- API change: update the route documentation and endpoint matrix; state whether it is breaking.
- Localization change: use the `i18n` skill and finish with `bun run validate-locales`.
- Schema change: use the `db-migrations` skill; create a migration and rollback plan, but do not
  apply it to user data without approval.
- Packaging, Electron, or compose change: follow the nested `packaging/AGENTS.md` rules and verify
  the packaged compose copy.

## Verification

Scale checks to risk:

- Isolated edit: targeted test and lint.
- Cross-module change: targeted tests, workspace lint, and typecheck.
- Security, persistence, migration, or destructive change: tests, lint, typecheck, build, and
  focused safety checks.
- Destructive or irreversible command: explain the exact effect and get confirmation first.

Finish with changed files, checks run, skipped checks, residual risk, and follow-ups.

## Key paths

| Path | Purpose |
|---|---|
| `apps/frontend/src/` | React frontend |
| `apps/node-backend/src/main.js` | Backend entry point |
| `alembic/versions/` | Database migrations |
| `config/` | Shared tool configuration |
| `i18n/source/` | Locale source files |
| `apps/frontend/src/locales/` | Generated locales |
| `packaging/electron/` | Desktop shell |
| `docs/` | Obsidian knowledge base |
| `.devcontainer/` | Hardened development sandbox |

Commit directly to `main`; do not create a branch unless the user asks.

At the end of a substantial work session, summarize the work as an Obsidian note in `docs/` for
the project vault. Follow `docs/AGENTS.md` and use the `update-vision-docs` skill for the note.

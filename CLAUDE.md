# CLAUDE.md — Vision

Agent guide and the single source of truth for working in this repo. Host-specific setup (the
devcontainer config-sync step, the Vision Demo app used for visual review) lives in the gitignored
`CLAUDE.local.md` alongside this file.

## Project

Vision = self-hosted financial transaction manager: transaction CRUD, categorization,
bank CSV imports (multi-adapter), portfolio tracking, Belgian tax, planned/recurring
transactions, i18n (en/nl). License AGPL-3.0-only.

Stack: React 19 + TypeScript + Vite + Tailwind + Radix (frontend) · Node/Bun + Express +
PostgreSQL (backend) · Vitest (backend tests) · Electron (desktop). Bun-workspaces monorepo:

| Workspace | Path |
|---|---|
| `vision-frontend` | `apps/frontend/` |
| `financial-transaction-manager-node` | `apps/node-backend/` |

Filtered runs: `bun run --filter '<workspace>' <script>`.

## Before any task

1. **Search the `docs/` KB first.** It is the authoritative source for architecture
   decisions, API contracts, feature specs, and conventions. `docs/` = intent, code = truth —
   confirm against actual code before acting.
2. Check `docs/adr/` before any architectural change (ADRs are append-only — supersede with a
   new one, never rewrite).
3. Check `docs/reference/api-endpoint-matrix.md` (164 API operations; authoritative count in `openapi.yaml`) before adding or changing routes.

Entry points: `docs/index.md` (KB home) · `docs/common-tasks.md` (task quick-ref + commands) ·
`docs/architecture/index.md` (stack, workspaces, patterns) · `docs/reference/code-patterns.md`
(canonical patterns) · `docs/reference/agent-navigation-map.md` · `docs/reference/scripts.md` (all `bun run` scripts).

### `docs/` map

`adr/` decisions · `features/` specs · `architecture/` stack & patterns · `api/` REST contracts ·
`components/` React docs · `guides/` how-tos · `reference/` patterns, data model, env, scripts ·
`integrations/` bank adapters & price providers · `security/` · `performance/` · `testing/` ·
`i18n/` · `diagrams/` (PlantUML) · `templates/` · `glossary.md` · `troubleshooting.md`.

## Commands

```bash
bun install                       # deps
bun run dev                       # backend + frontend
bun run build                     # prod build (generates locales first)
bun run lint                      # ESLint (frontend)
bun run test                      # backend tests (vitest)
# single test (from apps/node-backend):
bun vitest run src/path/to/x.test.js
bun vitest run --test-name-pattern="name"
```

i18n, DB-migration, and release/packaging workflows live in `.claude/skills/`
(`i18n`, `db-migrations`, `release`) and load on demand.

## Conventions (project-specific)

- **Backend (Node/Bun):** ES2022+ ESM, `async/await` throughout. **Never use `null` — use
  `undefined`** for optional values. Prefer functions over classes. No comments unless necessary.
- **Frontend (TS/React):** strict mode; interfaces for props/state; Zod for input validation;
  path alias `@/*` → `apps/frontend/src/*`; functional components + hooks; React Query
  (`@tanstack/react-query`) for server state; Tailwind + `class-variance-authority` for variants.
  Lint: `no-unused-vars` warn (prefix `_` to suppress).
- **Docs:** conventions load path-scoped from `.claude/rules/docs.md` when touching `docs/**`.

Domain terms (full glossary: `docs/glossary.md`): Transaction (− expense / + income) ·
Category (`GENERAL:DETAIL`, e.g. `FOOD:GROCERIES`) · Recipient · Planned Transaction
(future-dated, optionally recurring) · Bank Adapter (per-bank CSV parser) · Split · Portfolio.

## After code changes

Update the affected `docs/` pages before finishing, via the `vision-kb-updater` subagent
(`.claude/agents/vision-kb-updater.md`): new or changed endpoints →
`docs/reference/api-endpoint-matrix.md` plus the route's `docs/api/` doc; behavior changes → the
feature doc; bump frontmatter dates. After i18n changes run `bun run validate-locales`.

## Git

Commit directly to `main` — don't create a branch.

## Gotchas (don't relearn these the hard way)

- **Migrations are not auto-run:** create with `bun run db:revision -- "msg"`, ship a rollback
  plan, let the user apply.
- Packaging/Electron/compose sync rules (incl. the v1.0.2 data-loss gotcha) load path-scoped from
  `.claude/rules/packaging.md` when touching those files.

## Verification (scale to risk)

- low (isolated edit) = targeted test + lint · medium (cross-module) = targeted tests + workspace
  lint · high (security / migration / destructive) = tests + lint + build/typecheck + focused
  security checks.
- API/contract change → update `docs/api/` + endpoint matrix, note breaking vs non-breaking.
- DB/schema → Alembic migration + rollback + blast-radius note.
- Destructive/irreversible → explicit plan + user confirmation before running.

Keep scope tight (don't fold unrelated cleanup into a task — log follow-ups instead). Exclude
build artifacts, `node_modules/`, `.env*`/secrets, and `.git/` internals unless the task needs them.
Finish with: changed files, checks run, residual risk, follow-ups.

## Key paths

| Path | What |
|---|---|
| `apps/frontend/src/` | React frontend |
| `apps/node-backend/src/` (`main.js`) | backend + entry |
| `alembic/versions/` | DB migrations |
| `config/` | shared tsconfig/vite/eslint/tailwind |
| `i18n/source/` → `apps/frontend/src/locales/` | i18n |
| `packaging/electron/` (`main.js`) | desktop shell |
| `docs/` | KB (Obsidian vault) |
| `.env.local` (gitignored) | env vars — see `docs/reference/environment-variables.md` |
| `.devcontainer/` | hardened dev sandbox — see its `README.md` |
| `TODO.md` | backlog |

## Workflow

- **New feature / architectural decision:** state scope + assumptions before coding; record decisions
  as a new ADR in `docs/adr/` following `docs/adr/template.md` (append-only).
- **Hard bug:** read `docs/adr/` + `docs/features/` before the code — understanding *why* a thing is
  the way it is usually finds the root cause faster than reading code cold.
- **Session end:** summarize the session's work as an Obsidian note in `docs/` for the vault.

## Security

Secrets only in `.env.local` (gitignored) — never commit or log tokens/PII. Validate all inputs
(Zod frontend + server-side). Least-privilege DB users. Rate-limit public endpoints. Audit new
dependencies before adding.

## When stuck

`docs/troubleshooting.md` → `docs/reference/error-codes.md` → ask the user rather than guess.

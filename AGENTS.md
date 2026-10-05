# AGENTS.md — Vision

Canonical guidance for coding agents working in this repository. Tool-specific adapters may add
integration details, but must not duplicate or override the shared project contract here. If
`AGENTS.local.md` exists, read it before work because it contains host-only setup.

The global working agreement applies (signing, publication, safety); this file lists
project-specific rules only.

## Project

Vision is a self-hosted financial transaction manager. It supports transaction CRUD,
categorization, multi-bank CSV imports, portfolios, Belgian tax, planned and recurring
transactions, and English/Dutch localization. License: AGPL-3.0-only.

The Bun-workspaces monorepo uses React 19, TypeScript, Vite, Tailwind and Radix on the frontend;
Node/Bun, Express and PostgreSQL on the backend; Vitest for backend tests; and Electron for the
desktop app.

| Workspace                            | Path                     |
| ------------------------------------ | ------------------------ |
| `vision-frontend`                    | `apps/frontend/`         |
| `financial-transaction-manager-node` | `apps/node-backend/`     |
| `@vision/shared-utils`               | `packages/shared-utils/` |
| `@vision/types`                      | `packages/types/`        |

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
# database (Python Alembic toolchain from config/requirements.txt; needs DATABASE_URL):
bun run db:migrate            # upgrade to head through the app's migration runner
bun run db:check              # single Alembic head plus migration-fidelity run on a test database
bun run db:check-destructive  # flag destructive operations in migrations
# from apps/node-backend:
bun vitest run src/path/to/x.test.js
bun vitest run --test-name-pattern="name"
```

Use the repository skills in `.agents/skills/` for database migrations, localization, releases,
and documentation synchronization.

## Provider and host behavior

These obligations are tracked here because Codex does not auto-load `AGENTS.local.md` when this
root file exists. `AGENTS.local.md` may add machine-specific convenience, but it cannot weaken or
replace these rules.

- On the EraPartner macOS host, browser-driven visual review uses the native Vision Demo app and
  synthetic data, never the real financial stack. Launch it with
  `open "/Applications/Vision Demo.app"` and rebuild it with `./install-demo.sh` after relevant
  code changes. Discover its persisted random backend port from `appPort` in the Demo settings,
  then check `/health`. Its PostgreSQL cluster is isolated below
  `~/Library/Application Support/Vision Demo/native/vision_demo`; it uses only the bundled native
  runtime.
- Do not wipe or mutate the Demo database merely to make it boot. Inspect the native Demo logs and
  seed activation state first. When a canonical synthetic reset is intended, use
  `bun run demo:reset-native` and reopen the Demo app. Never apply that workflow to real Vision.
- Charts render lazily. Scroll a chart into view before capturing an in-viewport screenshot.
- For every agent, `bun run typecheck` and the relevant build/test commands are authoritative.
  Do not skip them because editor or Language Server Protocol diagnostics appear clean.

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

Use this documentation sequence:

1. Before implementation, find the relevant intent, contract, and architecture docs.
2. After the implementation diff is stable, but before final verification and commit, evaluate its
   documentation impact. Use the `update-vision-docs` skill whenever a documented surface may have
   changed. Read `docs/AGENTS.md` before editing anything under `docs/`.
3. Update affected docs in the same change. If no update is required, state why in the completion
   report instead of creating a placeholder note.

Documentation is required when a change alters user-visible behavior, an API or schema contract,
configuration or environment behavior, architecture or ownership, an integration, a security
property, packaging or operations, or a documented public interface or code location. It is
usually not required for tests-only changes, formatting, comments, generated-output refreshes, or
internal refactors that preserve behavior, contracts, architecture, and documented paths.

- API change: update `openapi.yaml`, the route documentation, and the endpoint matrix; regenerate
  derived types and state whether the change is breaking.
- Localization change: use the `i18n` skill and finish with `bun run validate-locales`.
- Schema change: use the `db-migrations` skill; create a migration and rollback plan, but do not
  apply it to user data without approval.
- Packaging or Electron change: follow the nested `packaging/AGENTS.md` rules.

## Verification

Scale checks to risk:

- Isolated edit: targeted test and lint.
- Cross-module change: targeted tests, workspace lint, and typecheck.
- Security, persistence, migration, or destructive change: tests, lint, typecheck, build, and
  focused safety checks.

Finish with changed files, checks run, skipped checks, residual risk, and follow-ups.

## Key paths

| Path                            | Purpose                         |
| ------------------------------- | ------------------------------- |
| `apps/frontend/src/`            | React frontend                  |
| `apps/node-backend/src/main.js` | Backend entry point             |
| `alembic/versions/`             | Database migrations             |
| `config/`                       | Shared tool configuration       |
| `i18n/source/`                  | Locale source files             |
| `apps/frontend/src/locales/`    | Generated locales               |
| `packaging/electron/`           | Desktop shell                   |
| `docs/`                         | Obsidian knowledge base         |
| `docs/guides/devcontainer.md`   | Built-in agent sandbox workflow |

When the task authorizes a local commit, commit directly to `main` unless the user asks for a branch.

Create a session note only when a substantial session produces durable context not already captured
in an ADR, feature, reference, or guide. Examples include a multi-stage investigation, a cross-module
delivery, or operational findings needed for later work. Do not create session notes for review-only
work, routine fixes or refactors, formatting, generated-output refreshes, or documentation-only
maintenance unless the user asks for one.

## Claude Code notes

- Claude-specific project skills are exposed under `.claude/skills/`. Their required outcomes must
  stay aligned with the portable skills under `.agents/skills/`.
- Path-scoped compatibility rules live in `.claude/rules/`. The canonical nested guidance remains
  in `docs/AGENTS.md` and `packaging/AGENTS.md`.
- Host-specific Claude setup belongs in the gitignored `CLAUDE.local.md`.
- Use Claude Code's built-in sandbox for agent execution. See `docs/guides/devcontainer.md` for the
  shared agent workflow.

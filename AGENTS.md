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

For one-item TODO backlog work, use `.agents/prompts/implement-next-todo.md`. Its durable version 3
checkpoint is published locally only through the user-run `ga publish-vision-todo` LockBox command.
Regular implementation agents may run its read-only `--fingerprint` and `--check` preflights but
must not launch the publishing workflow themselves.

## Provider and host behavior

These obligations are tracked here because Codex does not auto-load `AGENTS.local.md` when this
root file exists. `AGENTS.local.md` may add machine-specific convenience, but it cannot weaken or
replace these rules.

- In the devcontainer, Codex uses isolated container state. Codex authentication and configuration
  do not synchronize with the host. Never copy `~/.codex/auth.json` into the container. Treat
  changes under container `~/.codex/` as ephemeral and report them before the session ends; tracked
  repository files under `.agents/` and `.codex/` persist through the workspace mount.
- On the EraPartner macOS host, browser-driven visual review uses the Vision Demo app and synthetic
  data, never the real financial stack. Launch it with `open "/Applications/Vision Demo.app"` and
  rebuild it with `./install-demo.sh` after relevant code changes. Discover its persisted random
  port from `appPort` in the Demo settings or Docker, then check `/health`.
- Do not wipe or mutate the Demo database merely to make it boot. If Alembic reports overlapping
  heads, inspect the volume and `alembic_version` rows, identify the stray older stamp, and obtain
  approval before deleting that exact row. A volume wipe is destructive and always requires
  explicit approval.
- Charts render lazily. Scroll a chart into view before capturing an in-viewport screenshot and
  store browser artifacts under `.playwright-mcp/`.
- Codex browser tooling is the supported replacement for Claude's Playwright plugin. There is no
  Codex TypeScript-LSP plugin in this project; `bun run typecheck` and the relevant build/test
  commands are the authoritative diagnostics and must not be skipped because editor diagnostics
  appear clean.

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
| `.agents/prompts/implement-next-todo.md` | Resumable one-item TODO workflow and publication handoff |

Commit directly to `main`; do not create a branch unless the user asks.

Create a session note only when a substantial session produces durable context not already captured
in an ADR, feature, reference, or guide. Examples include a multi-stage investigation, a cross-module
delivery, or operational findings needed for later work. Do not create session notes for review-only
work, routine fixes or refactors, formatting, generated-output refreshes, or documentation-only
maintenance unless the user asks for one.

## Cloud sessions

Run `bash .codex/cloud/setup.sh` as the Codex cloud environment setup command. Use only disposable,
non-production database credentials in cloud environment variables. Cloud sessions cannot validate
the macOS Electron package, host Demo app, Apple Container isolation, or hardware-backed signing;
report those checks as skipped and leave them for a local session. In cloud sessions, do not
publish with shell Git commands, configure Git credentials, or create a pull request with `gh`.
The platform-managed **Open pull request** action may create a pull request, and the connected
GitHub integration may update the same branch for pull-request-linked follow-ups. When the user
explicitly requests it, that integration may merge the pull request after all required checks and
approvals pass and no blocking review remains. Do not use an admin bypass or directly update a
default or protected branch outside that approved merge.

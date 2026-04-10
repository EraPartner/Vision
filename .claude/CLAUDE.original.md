# Vision — Claude Code Context

**Vision** is a self-hosted financial transaction management application. It covers transaction CRUD, categorization, bank CSV imports (multi-adapter), portfolio tracking, Belgian tax calculations, planned/recurring transactions, and i18n (en/nl).

The `docs/` directory is an Obsidian knowledge base — the authoritative source for architecture decisions, API contracts, feature specs, and conventions.

> For detailed agent workflow rules and subagent assignment matrix, see **[AGENTS.md](AGENTS.md)**.

---

## Mandatory Behaviors

> These apply to every task, no exceptions.

1. **Obsidian skill first** — Use the `obsidian` skill (`obsidian:obsidian-markdown`, `obsidian:obsidian-cli`) for all vault reads, writes, and searches. Raw `Read`/`Grep`/`Glob` on `docs/` is a fallback only when the skill cannot cover the operation. The skill preserves wikilink integrity, frontmatter, and cross-references that raw file access breaks.

2. **KB updater last** — After any code change, invoke the `vision-kb-updater` agent before marking the task complete. This is mandatory, not optional.

---

## Before Starting Any Task

1. Read `docs/index.md` for project overview and quick-reference links
2. Check `docs/adr/` for decisions relevant to the area you're changing — ADRs are append-only, never rewrite one
3. Check `docs/features/` for the feature spec in scope
4. Check `docs/reference/api-endpoint-matrix.md` (108 endpoints) before adding new routes
5. Verify against actual code — docs reflect intent, code is source of truth

---

## Knowledge Base Structure

```
docs/
├── adr/            ← Architecture Decision Records — read before architectural changes
├── features/       ← Feature specs (transactions, portfolio, tax, imports, i18n…)
├── architecture/   ← System diagrams and layer overviews
├── api/            ← REST endpoint contracts
├── components/     ← React component docs
├── guides/         ← How-to guides (setup, adding endpoints, adding pages, contributing)
├── reference/      ← Code patterns, data model, env vars, query patterns
├── integrations/   ← Bank adapters, price providers, currency conversion
├── security/       ← Security policies
├── performance/    ← Performance optimizations
├── testing/        ← Test strategies
├── i18n/           ← Localization docs
├── diagrams/       ← 23 PlantUML architecture diagrams
├── templates/      ← Templates for ADRs, features, endpoints, components
├── index.md        ← KB home — start here
├── common-tasks.md ← Task-oriented quick reference
└── glossary.md     ← Terminology and aliases
```

**Key entry points:**
- `docs/index.md` — main KB index
- `docs/common-tasks.md` — task-oriented quick reference (start here if you know what you want to do)
- `docs/glossary.md` — terminology with aliases
- `docs/reference/agent-navigation-map.md` — navigate by feature, layer, or task
- `docs/reference/code-patterns.md` — canonical implementation patterns

---

## Architecture

### Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS + Radix UI |
| Backend | Bun + Express + PostgreSQL |
| Desktop | Electron (`packaging/electron/`) |
| Testing | Vitest (backend) |
| Package manager | Bun workspaces |
| Migrations | Alembic (Python `venv/`) |

### Monorepo Workspaces

| Workspace | Path | Filter name |
|-----------|------|-------------|
| Frontend | `apps/frontend/` | `vision-frontend` |
| Backend | `apps/node-backend/` | `financial-transaction-manager-node` |

```bash
bun run --filter 'vision-frontend' <script>
bun run --filter 'financial-transaction-manager-node' <script>
```

### Key Patterns

- React Query for all server state — never duplicate into client stores
- Zod for input validation on the frontend
- `tailwind-merge` + `clsx` + `class-variance-authority` for styling
- i18n: locale sources in `i18n/source/`, generated into `apps/frontend/src/locales/` — never hardcode UI strings
- Database migrations via Alembic — never auto-apply; let the user run them

---

## Code Style

**Backend (JS/ESM):**
- ES2022+, ESM modules — no CommonJS
- `async/await` for all async code
- **Never `null`** — use `undefined` for optional values
- No comments unless genuinely non-obvious
- Prefer functions over classes

**Frontend (TypeScript):**
- Strict mode — `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Path alias `@/*` → `apps/frontend/src/*`
- Functional components + hooks only — no class components
- PascalCase components, camelCase functions/hooks
- `_` prefix to suppress unused-variable lint warnings

**Both:**
- No error handling for impossible cases — trust framework guarantees
- Validate only at system boundaries
- Delete removed code cleanly — no backwards-compat shims
- Tests must not be modified to pass — fix the underlying code
- Never add docstrings or comments to code you didn't change

---

## Commands

```bash
# Development
bun run dev                         # Frontend + backend concurrently

# Build
bun run build                       # Production build (generates locales first)
bun run build:dev                   # Development build

# Testing
bun run test                        # Run all backend tests (Vitest)
bun run test:watch                  # Watch mode

# Single backend test
cd apps/node-backend && bun vitest run src/path/to/test.test.js
bun vitest run --test-name-pattern="testName"

# Linting
bun run lint                        # ESLint on frontend

# i18n (run validate-locales after any i18n change)
bun run generate-locales            # Generate locale files from source
bun run validate-locales            # Validate locale file integrity
bun run sync-nl                     # Sync Dutch (nl) with English (en)
bun run sanitize-locales            # Remove unused keys

# Database (requires venv/)
bun run db:upgrade                  # Run Alembic migrations
bun run db:downgrade                # Rollback last migration
bun run db:revision                 # Create new autogenerate migration
bun run db:current                  # Show current migration state
bun run db:history                  # Show migration history

# Docker
bun run docker:dev                  # Start dev environment
bun run docker:dev:down             # Stop dev environment
bun run docker:dev:rebuild          # Rebuild containers
bun run docker:logs                 # Tail app logs

# Electron desktop
bun run electron:dev                # Desktop app (dev compose)
bun run electron:prod               # Desktop app (production compose)
bun run electron:clean              # Desktop app (clean compose)
```

---

## Key Files

| Purpose | Path |
|---------|------|
| Backend entry | `apps/node-backend/src/main.js` |
| Frontend source | `apps/frontend/src/` |
| Database migrations | `alembic/versions/` |
| Shared config | `config/` (tsconfig, vite, eslint, tailwind) |
| i18n sources | `i18n/source/` |
| Locale output | `apps/frontend/src/locales/` |
| Env vars | `.env.local` (gitignored) |
| KB home | `docs/index.md` |
| Code patterns | `docs/reference/code-patterns.md` |
| API endpoint matrix | `docs/reference/api-endpoint-matrix.md` |
| Open backlog | `TODO.md` |

---

## Documentation Conventions

- Every doc has YAML frontmatter: `title`, `type`, `date`, `tags`, `description`
- Internal links use wiki-link format: `[[docs/path/to/file]]`
- ADRs are append-only — never rewrite a past decision; add a new one that supersedes it
- After adding a feature/endpoint: update the relevant index doc and `docs/reference/api-endpoint-matrix.md`
- After any i18n change: run `bun run validate-locales`

---

## Active Work

| Area | Docs | Status |
|------|------|--------|
| Portfolio performance | `docs/features/portfolio.md` | Active — snapshots, per-class breakdowns |
| Chart tooltips | `docs/features/views.md` | Active — visual tooltip improvements |
| Transactions infinite scroll | `docs/features/transactions.md` | Bug — needs virtual/windowed scroll |
| i18n | `docs/i18n/index.md` | Active — nl/en, missing keys |
| Belgian tax | `docs/features/belgian-tax.md` | Active |
| Planned transactions | `docs/features/plannedTransactions.md` | Active |

Open backlog: see `TODO.md`.

---

## Workflow Reference

**New feature or non-trivial task:**
> Read `docs/index.md`, the relevant ADRs in `docs/adr/`, and the related feature doc in `docs/features/`. Tell me what you understand about what I'm building and ask the three most important questions before we write any code.

**Significant architectural decision:**
> Write an ADR in `docs/adr/` following `docs/templates/adr.md`. Document: what was decided, why, alternatives considered, and when to revisit.

**Hard bug:**
> Before reading code, check `docs/adr/` for decisions related to the affected system and `docs/features/` for the feature spec. Understanding *why* the code is shaped the way it is often unlocks the root cause.

**Session end:**
> Summarize what was built, what decisions were made, and what context would be useful for future sessions. Format as an Obsidian note for the vault.

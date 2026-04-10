# Vision — Claude Code Context

**Vision** = self-hosted financial transaction manager. Covers transaction CRUD, categorization, bank CSV imports (multi-adapter), portfolio tracking, Belgian tax, planned/recurring transactions, i18n (en/nl).

`docs/` = Obsidian KB — authoritative source for architecture decisions, API contracts, feature specs, conventions.

> Agent workflow rules + subagent matrix: **[AGENTS.md](AGENTS.md)**.

---

## Mandatory Behaviors

> Every task. No exceptions.

1. **Obsidian skill first** — Use `obsidian` skill (`obsidian:obsidian-markdown`, `obsidian:obsidian-cli`) for all vault reads/writes/searches. Raw `Read`/`Grep`/`Glob` on `docs/` = fallback only when skill can't cover it. Skill preserves wikilink integrity, frontmatter, cross-references — raw access breaks these.

2. **KB updater last** — After any code change, invoke `vision-kb-updater` agent before marking complete. Mandatory.

---

## Before Starting Any Task

1. Read `docs/index.md` — project overview + quick-reference links
2. Check `docs/adr/` for decisions in scope — ADRs append-only, never rewrite
3. Check `docs/features/` for feature spec in scope
4. Check `docs/reference/api-endpoint-matrix.md` (108 endpoints) before adding routes
5. Verify against actual code — docs = intent, code = truth

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
- `docs/common-tasks.md` — task quick reference (start here if you know what you want)
- `docs/glossary.md` — terminology + aliases
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
- Zod for input validation on frontend
- `tailwind-merge` + `clsx` + `class-variance-authority` for styling
- i18n: locale sources in `i18n/source/`, generated into `apps/frontend/src/locales/` — never hardcode UI strings
- DB migrations via Alembic — never auto-apply; let user run them

---

## Code Style

**Backend (JS/ESM):**
- ES2022+, ESM — no CommonJS
- `async/await` everywhere
- **Never `null`** — use `undefined` for optional values
- No comments unless genuinely non-obvious
- Functions over classes

**Frontend (TypeScript):**
- Strict mode — `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Path alias `@/*` → `apps/frontend/src/*`
- Functional components + hooks only — no class components
- PascalCase components, camelCase functions/hooks
- `_` prefix suppresses unused-variable lint

**Both:**
- No error handling for impossible cases — trust framework guarantees
- Validate only at system boundaries
- Delete removed code cleanly — no compat shims
- Never modify tests to pass — fix the code
- Never add docstrings/comments to unchanged code

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

- Every doc: YAML frontmatter with `title`, `type`, `date`, `tags`, `description`
- Internal links: wiki-link format `[[docs/path/to/file]]`
- ADRs append-only — never rewrite past decisions; add new one that supersedes
- After adding feature/endpoint: update relevant index doc + `docs/reference/api-endpoint-matrix.md`
- After i18n change: run `bun run validate-locales`

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

Open backlog: `TODO.md`.

---

## Workflow Reference

**New feature / non-trivial task:**
> Read `docs/index.md`, relevant ADRs in `docs/adr/`, related feature doc in `docs/features/`. State understanding of what's being built. Ask three most important questions before writing code.

**Significant architectural decision:**
> Write ADR in `docs/adr/` following `docs/templates/adr.md`. Document: decision, rationale, alternatives considered, when to revisit.

**Hard bug:**
> Before reading code, check `docs/adr/` for decisions in affected system + `docs/features/` for feature spec. Understanding *why* code is shaped as it is often unlocks root cause.

**Session end:**
> Summarize: what was built, decisions made, context useful for future sessions. Format as Obsidian note for vault.
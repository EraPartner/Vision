# Vision — Claude Code Context

This repo is simultaneously a **codebase** and an **Obsidian knowledge base**. The `docs/` folder is the vault. Claude Code has direct file-system access to all of it.

> **Obsidian interactions must use the `obsidian` skill.** Any time you read from, write to, or query the vault — including reading feature docs, writing ADRs, or updating notes — invoke the skill via `/obsidian` (e.g. `obsidian:obsidian-markdown`, `obsidian:obsidian-cli`). Do not use raw file reads/writes for vault content when the Obsidian skill covers the operation.

> For detailed agent workflow rules, subagent assignments, build commands, and code style, see **[AGENTS.md](AGENTS.md)**.

---

## Vault Structure

| Folder | Purpose |
|--------|---------|
| `docs/adr/` | Architecture Decision Records — **read before any architectural change** |
| `docs/features/` | Feature specifications per area (transactions, portfolio, tax, imports…) |
| `docs/architecture/` | System diagrams and layer overviews |
| `docs/api/` | REST endpoint contracts |
| `docs/components/` | React component docs |
| `docs/guides/` | How-to guides (setup, adding endpoints, adding pages, contributing) |
| `docs/reference/` | Code patterns, data model, env vars, algorithms, query patterns |
| `docs/integrations/` | Bank adapters, price providers, currency conversion |
| `docs/security/` | Security policies |
| `docs/performance/` | Performance optimizations |
| `docs/testing/` | Test strategies |
| `docs/i18n/` | Localization docs |
| `docs/diagrams/` | All 23 PlantUML architecture diagrams |
| `docs/templates/` | Templates for new ADRs, features, endpoints, components |

**Key entry points:**

- `docs/index.md` — main knowledge base index
- `docs/common-tasks.md` — task-oriented quick reference
- `docs/glossary.md` — terminology (check if a term is ambiguous)
- `docs/reference/agent-navigation-map.md` — navigate by feature, layer, or task

---

## My Development Conventions

- Functional patterns over classes (frontend and backend)
- Backend: ES2022+, ESM modules, `async/await`, never `null` (use `undefined`)
- Frontend: React functional components + hooks, Zod for validation, React Query for server state
- Tailwind CSS with `tailwind-merge` + `clsx`; use `class-variance-authority` for variants
- Every significant architectural decision goes into `docs/adr/` using `docs/templates/adr.md`
- Wiki-links in docs use `[[docs/path/to/file]]` format; always include frontmatter (`title`, `type`, `date`, `tags`, `description`)
- i18n keys are kept in sync via `bun run generate-locales` — never hardcode UI strings

---

## How to Use This Vault

**Before starting any session on a feature or bug:**
> Read the relevant note in `docs/features/` and any ADRs in `docs/adr/` related to the area. Tell me what you understand about what I'm building and ask the three most important clarifying questions before writing any code.

**Before making an architectural decision:**
> Check `docs/adr/` for past decisions on the topic. Explain how your suggestion aligns with or intentionally overrides previous decisions.

**When we make a significant technical decision together:**
> Write a decision note following `docs/templates/adr.md` and place it in `docs/adr/`. Include: what we decided, why, alternatives considered, and when to revisit.

**At the end of a significant work session:**
> Summarize what we built, what decisions we made, and what context would be useful for future sessions. Format it as an Obsidian note I can drop into the vault.

**When debugging a hard problem:**
> Before reading code, check `docs/adr/` for decisions related to the affected system, and `docs/features/` for the feature spec. Use that context to inform your diagnosis—understanding *why* the code is shaped the way it is often unlocks the root cause.

---

## Active Features / Current Work

| Area | Docs | Status |
|------|------|--------|
| Portfolio performance | `docs/features/portfolio.md` | Active — performance snapshots, per-class breakdowns |
| Chart tooltips | `docs/features/views.md` | Active — visual tooltip improvements |
| Transactions infinite scroll | `docs/features/transactions.md` | Bug — needs virtual/windowed scroll (see TODO.md) |
| i18n | `docs/i18n/index.md` | Active — nl/en, missing keys (see TODO.md) |
| Belgian tax | `docs/features/belgian-tax.md` | Active |
| Planned transactions | `docs/features/plannedTransactions.md` | Active |

**Open backlog items:** see `TODO.md` in repo root.

---

## Technical Preferences

- **Language**: TypeScript (frontend), JavaScript ESM (backend)
- **Framework**: React 18 + Vite (frontend), Bun + Express (backend)
- **Database**: PostgreSQL + Alembic migrations (Python venv)
- **Package manager**: Bun workspaces
- **Testing**: Vitest (backend); React Testing Library (frontend)
- **Desktop**: Electron wrapper (`packaging/electron/`)
- **i18n**: Custom locale pipeline — source files in `i18n/source/`, generated into `apps/frontend/src/locales/`
- Prefer editing existing files over creating new ones
- Do not add error handling for impossible cases — trust framework guarantees
- Never commit secrets; `.env.local` is gitignored

---

## Knowledge Base Conventions

- **After any code changes, invoke the `vision-kb-updater` agent before considering the task complete.** This is mandatory.
- **Always use the `obsidian` skill for vault operations** — reading notes, writing ADRs, updating feature docs, querying the graph. Use `obsidian:obsidian-markdown` for note reads/writes and `obsidian:obsidian-cli` for vault commands. Raw file tools are a fallback only when the skill cannot cover the operation.
- ADRs are append-only — never rewrite a past decision, add a new one that supersedes it
- Use `docs/reference/code-patterns.md` as the canonical source for implementation patterns
- Check `docs/reference/api-endpoint-matrix.md` (108 endpoints) before adding new routes
- Run `bun run validate-locales` after any i18n changes

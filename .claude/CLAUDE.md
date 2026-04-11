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
├── architecture/   ← Stack, monorepo workspaces, key patterns → index.md
├── api/            ← REST endpoint contracts
├── components/     ← React component docs
├── guides/         ← How-to guides (setup, adding endpoints, adding pages, contributing)
├── reference/      ← Code patterns, data model, env vars, scripts, query patterns
├── integrations/   ← Bank adapters, price providers, currency conversion
├── security/       ← Security policies
├── performance/    ← Performance optimizations
├── testing/        ← Test strategies
├── i18n/           ← Localization docs
├── diagrams/       ← 23 PlantUML architecture diagrams
├── templates/      ← Templates for ADRs, features, endpoints, components
├── index.md        ← KB home — start here
├── common-tasks.md ← Task-oriented quick reference + commands
└── glossary.md     ← Terminology and aliases
```

**Key entry points:**
- `docs/index.md` — main KB index
- `docs/common-tasks.md` — task quick reference + all CLI commands
- `docs/architecture/index.md` — stack, workspaces, key patterns
- `docs/reference/scripts.md` — all `bun run` scripts
- `docs/reference/code-patterns.md` — canonical implementation patterns
- `docs/reference/agent-navigation-map.md` — navigate by feature, layer, or task

---

## Key Files

| Purpose | Path |
|---------|------|
| Backend entry | `apps/node-backend/src/main.js` |
| Frontend source | `apps/frontend/src/` |
| DB migrations | `alembic/versions/` |
| i18n sources | `i18n/source/` → output `apps/frontend/src/locales/` |
| Env vars | `.env.local` (gitignored) |
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

**New feature:** Read `docs/index.md` → relevant ADRs → feature doc. State understanding, ask three key questions before writing code.

**Architectural decision:** Write ADR in `docs/adr/` following `docs/templates/adr.md`.

**Hard bug:** Check `docs/adr/` + `docs/features/` before reading code — understanding *why* unlocks root cause.

**Session end:** Summarize as Obsidian note for vault.
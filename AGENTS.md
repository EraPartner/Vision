# AGENTS.md - Vision Project Guidelines

File: guidelines for agentic coding agents in this repo.

## Quick Start

1. **Read docs first** — Search Obsidian KB (`docs/`) before touching code
2. **Follow conventions** — Match existing patterns; no new ones
3. **Write tests** — All new features and bug fixes need test coverage
4. **Update docs** — Call `vision-kb-updater` after every code change
5. **Commit when asked** — Never commit unless user explicitly requests it

## Agent Usage Rules

### Subagent-Only Usage

Agents are **specialized subagents** — each has strict, narrow purpose. Main agent must delegate to correct subagent per task. Never use agent outside defined scope:

**Invocation rule:** For `vision-kb-updater` only, invoke directly as custom subagent (`subagent_type: "vision-kb-updater"` from `.opencode/agent/vision-kb-updater.md`). Do **not** load via Awesome instruction loaders/search. Keep standard loading for all other agents/instructions.

| Agent                        | Use For                                                          | Do NOT Use For                           |
| ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `senior-feature-engineer`    | Implementing new features, fixing bugs                           | Code review, refactoring, tests, commits |
| `refactoring-expert`         | Restructuring code, removing duplication, applying patterns      | New features, bug fixes, analysis, tests |
| `code-improvement-suggester` | Read-only code review, quality analysis, improvement suggestions | Actual code changes, refactoring, tests  |
| `test-generator`             | Writing unit/integration/e2e tests                               | Implementation, refactoring, analysis    |
| `intelligent-commit-writer`  | Creating git commits                                             | Git log, status, branches, pushing       |
| `vision-kb-updater`          | Updating documentation after code changes                        | Code changes, analysis, any non-doc work |
| `explore`                    | Fast codebase exploration, finding files/patterns                | Code modification                        |

### Knowledge Base Workflow

**Before any code changes or architectural decisions, agents MUST learn codebase:**

1. **Search Obsidian KB first** via Obsidian MCP tools:
   - `mcp-obsidian_obsidian_simple_search` — Full-text search across all docs
   - `mcp-obsidian_obsidian_complex_search` — Query by tags, paths, frontmatter
   - `mcp-obsidian_obsidian_list_files_in_dir` — List docs in specific folder
   - `mcp-obsidian_obsidian_get_file_contents` — Read specific doc files

2. **Check relevant docs** — See **Knowledge Base** section below for full structure. Key entry points:
   - `docs/common-tasks.md` — Task-oriented quick reference (start here if you know what to do)
   - `docs/glossary.md` — Terminology with aliases and search tips
   - `docs/getting-started.md` — New developer onboarding map
   - `docs/adr/` — Architecture Decision Records (read before architectural changes)
   - `docs/api/` — API docs (check before creating/modifying endpoints)
   - `docs/features/` — Feature docs (understand existing behavior)
   - `docs/guides/` — How-to guides and patterns
   - `docs/reference/` — Code patterns, scripts, environment variables

3. **Cross-reference with code:**
   - After learning from docs, verify against actual code files
   - Use `explore` subagent for fast pattern matching in code
   - Use `read` and `glob` tools for specific file inspection

4. **Update after changes:**
   - Call `vision-kb-updater` subagent after completing code changes
   - Keeps docs in sync with implementation

**Rationale:** KB contains architectural decisions, API contracts, feature specs, system diagrams. Skipping leads to duplicated work, inconsistent patterns, broken contracts.

## Project Overview

Vision: financial transaction management app with:

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- **Backend**: Node.js (Bun) + Express + PostgreSQL
- **Testing**: Vitest (backend)
- **Package Manager**: Bun
- **Desktop**: Electron (see `packaging/electron/`)
- **License**: AGPL-3.0-only

### Monorepo Structure

Bun workspaces monorepo, two packages:

| Package                              | Path                 | Description                |
| ------------------------------------ | -------------------- | -------------------------- |
| `vision-frontend`                    | `apps/frontend/`     | React frontend application |
| `financial-transaction-manager-node` | `apps/node-backend/` | Node.js backend API        |

For filtered commands, use workspace names:

```bash
bun run --filter 'vision-frontend' <script>
bun run --filter 'financial-transaction-manager-node' <script>
```

## Terminology

See `docs/glossary.md` for complete glossary with aliases and search tips. Key terms:

- **Transaction**: Financial record (negative = expense, positive = income).
- **Category**: Label in `GENERAL:DETAIL` format (e.g., `FOOD:GROCERIES`).
- **Recipient**: Person or entity on a transaction (payee or payer).
- **Planned Transaction**: Future-dated transaction, optionally recurring.
- **Import**: Bringing transaction data from external bank CSV files.
- **Export**: Generating CSV of transaction data.
- **Portfolio**: Collection of investments (stocks, crypto, real estate, savings, bonds).
- **Split**: Division of transaction amount among multiple recipients.
- **Bank Adapter**: Code parsing a specific bank's CSV format.

## Build Commands

### Root Commands (from workspace root)

```bash
# Install dependencies
bun install

# Development
bun run dev              # Run both backend and frontend concurrently

# Build
bun run build            # Production build (generates locales first)
bun run build:dev        # Development build
bun run preview          # Preview production build

# Linting
bun run lint             # ESLint on frontend

# Testing
bun run test             # Run all backend tests (vitest)
bun run test:watch       # Watch mode for backend tests
```

### Running a Single Test (Backend)

```bash
# From apps/node-backend directory
bun vitest run --test-name-pattern="testName"
bun vitest run src/path/to/test.test.js
```

### Locales / i18n

```bash
bun run generate-locales       # Generate locale files from source
bun run sanitize-locales       # Sanitize locale files (remove unused keys)
bun run sync-nl                # Sync Dutch (nl) translations with English (en)
bun run validate-locales       # Validate locale file integrity
```

### Database Commands

Requires Python venv with Alembic installed (`venv/`).

```bash
bun run db:upgrade       # Run Alembic migrations
bun run db:downgrade     # Rollback last migration
bun run db:current       # Show current migration state
bun run db:history       # Show migration history
bun run db:stamp         # Stamp database at a specific revision
bun run db:revision      # Create new autogenerate migration
```

### Docker Commands

```bash
# Development
bun run docker:dev           # Start dev environment with Docker
bun run docker:dev:down      # Stop dev environment
bun run docker:dev:rebuild   # Rebuild and restart containers

# Clean (fresh database)
bun run docker:clean         # Start with clean state
bun run docker:clean:down    # Stop clean environment
bun run docker:clean:reset   # Reset volumes and rebuild

# Utilities
bun run docker:logs          # Tail app container logs
```

### Electron Desktop

```bash
bun run electron:dev     # Desktop app with dev Docker compose
bun run electron:prod    # Desktop app with production compose
bun run electron:clean   # Desktop app with clean compose
```

## Code Style Guidelines

### TypeScript (Frontend)

- **Strict mode** enabled in `tsconfig.json`
- Interfaces for props, state, component definitions
- Union types for component variants and states
- Path alias: `@/*` maps to `apps/frontend/src/*`
- Enable `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Validate inputs with Zod

### JavaScript/Node.js (Backend)

- **ES2022+** features, ESM modules
- `async/await` for all async code
- **Never use `null`** — use `undefined` for optional values
- Prefer functions over classes
- No comments unless absolutely necessary
- Keep code simple and maintainable

### React Components

- Functional components with hooks as default
- PascalCase for components, camelCase for functions/variables
- Custom hooks for reusable stateful logic
- Single responsibility principle
- Proper prop validation with TypeScript
- React Query (`@tanstack/react-query`) for server state

### Styling

- Tailwind CSS with `tailwind-merge` and `clsx`
- `class-variance-authority` for component variants
- Mobile-first responsive design

### ESLint Rules

- `@typescript-eslint/no-unused-vars`: warn (prefix with `_` to suppress)
- `react-refresh/only-export-components`: warn
- `react-hooks/rules`: enforced

### Error Handling

- Error Boundaries for component-level errors
- Proper error states in data fetching
- Handle async errors in effects and event handlers
- Meaningful error messages to users

## Existing Agent Instructions

Load from Awesome MCP server via `awesome-copilot_load_instruction` **before** writing code in relevant area:

- `nodejs-javascript-vitest.instructions.md` — Load before writing backend code
- `reactjs.instructions.md` — Load before writing frontend React components
- `performance-optimization.instructions.md` — Load when working on performance-critical paths

## Important Patterns

### Database Migrations (Alembic)

- Located in `alembic/versions/`
- Create migrations with: `bun run db:revision -- "message"`
- Test migrations locally before committing
- Provide rollback plan for schema changes
- Don't execute migrations automatically; let users handle that

### Testing Guidelines

- Write tests for all new features and bug fixes
- Cover edge cases and error handling
- Never modify original code to ease testing
- Vitest for backend unit/integration tests

### API Design

- RESTful endpoints in Express
- Proper HTTP status codes
- Validate inputs with Zod on frontend

## Key File Locations

| Path                            | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `apps/frontend/src/`            | React frontend source                            |
| `apps/node-backend/src/`        | Node.js backend source                           |
| `apps/node-backend/src/main.js` | Backend entry point                              |
| `alembic/versions/`             | Database migrations                              |
| `config/`                       | Shared config (tsconfig, vite, eslint, tailwind) |
| `i18n/`                         | Localization files                               |
| `docs/`                         | Project knowledge base (Obsidian vault)          |
| `docs/diagrams/`                | PlantUML UML diagrams                            |
| `docs/architecture/`            | Architecture documentation                       |
| `docs/reference/`               | Code patterns, scripts, environment variables    |

## Knowledge Base

Docs KB in `docs/` — designed for Obsidian and AI agent usage.

### Structure

- `docs/index.md` — Main entry point with dataview queries
- `docs/getting-started.md` — New developer onboarding
- `docs/common-tasks.md` — Task-oriented quick reference
- `docs/glossary.md` — Terminology and search tips
- `docs/adr/` — Architecture Decision Records (ADRs)
- `docs/api/` — API documentation
- `docs/guides/` — How-to guides
- `docs/features/` — Feature documentation (Portfolio, Tax, Imports, etc.)
- `docs/integrations/` — External service integrations
- `docs/security/` — Security documentation
- `docs/performance/` — Performance documentation
- `docs/i18n/` — Localization
- `docs/components/` — Frontend components
- `docs/testing/` — Testing documentation
- `docs/diagrams/` — PlantUML UML diagrams
- `docs/architecture/` — Architecture documentation with embedded diagrams
- `docs/reference/` — Code patterns, scripts, error codes, environment variables

### Knowledge Base Maintenance

**After any code changes, agents MUST call `vision-kb-updater` subagent** (`.opencode/agent/vision-kb-updater.md`). Keeps docs in sync. Updater will:

1. Identify what changed based on modified files
2. Update existing docs to reflect changes
3. Create new docs for new features/endpoints
4. Add code links `[[path/to/file.js]]`
5. Update frontmatter dates
6. Update UML diagrams if relevant

**Mandatory** — all agents call KB updater before finishing.

## Environment Variables

- Copy `.env` to `.env.local` for local dev
- `VITE_API_URL` — Backend API URL (defaults to `http://localhost:3002`)
- See `docs/reference/environment-variables.md` for complete reference

## Security Guidelines

- **Never commit secrets** — Use `.env.local` (gitignored) for all credentials
- **Never log sensitive data** — No API keys, tokens, passwords, or PII in logs
- **Validate all inputs** — Zod on frontend, server-side validation on backend
- **Least privilege** — DB users get minimal required permissions
- **Rate limit public endpoints** — Protect against abuse
- **Audit dependencies** — Check for vulnerabilities before adding packages

## When Stuck

If docs and code unclear:

1. Check `docs/troubleshooting.md` for known issues
2. Search `docs/reference/error-codes.md` for error context
3. Ask user for clarification rather than guessing

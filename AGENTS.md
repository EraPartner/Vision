# AGENTS.md - Vision Project Guidelines

This file provides guidelines for agentic coding agents working in this repository.

## Project Overview

Vision is a financial transaction management application with:

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- **Backend**: Node.js (Bun) + Express + PostgreSQL
- **Testing**: Vitest (backend), React Testing Library (frontend)
- **Package Manager**: Bun
- **Desktop**: Electron (see `packaging/electron/`)

## Terminology

- **Transaction**: A financial record that represents an income or expense.
- **Category**: A label that can be assigned to transactions for organizational purposes, of the format "GENERAL:DETAIL".
- **Recipient**: The person or entity associated with a transaction, such as a payee or payer.
- **Planned Transaction**: A transaction that is scheduled to occur in the future, with a specified date and amount (possibly recurring).
- **Import**: The process of bringing transaction data from external sources, such as bank statements (always csv), into the application.
- **Export**: The process of generating a file (csv) that contains transaction data from the application, which can be used for backup or analysis purposes.
- **Portfolio**: A collection of investments including stocks, crypto, real estate, and savings.

## Build Commands

### Root Commands (from workspace root)

```bash
# Install dependencies
bun install

# Development
bun run dev              # Run both backend and frontend

# Build
bun run build            # Production build (generates locales)
bun run build:dev        # Development build

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

### Database Commands

```bash
bun run db:setup         # Setup PostgreSQL
bun run db:start         # Start PostgreSQL
bun run db:stop          # Stop PostgreSQL
bun run db:upgrade       # Run Alembic migrations
bun run db:revision      # Create new migration
```

### Docker Commands (Development)

```bash
bun run docker:dev       # Start dev environment with Docker
bun run docker:dev:down   # Stop dev environment
bun run docker:dev:rebuild # Rebuild containers
```

### Deployment

- **Electron**: Desktop app in `packaging/electron/`. Run with `bun run electron:dev` or `bun run electron:prod`
- **Docker**: Production deployment via `docker compose` with `docker-compose.yml`

## Code Style Guidelines

### TypeScript (Frontend)

- **Strict mode** enabled in `tsconfig.json`
- Use interfaces for props, state, and component definitions
- Use union types for component variants and states
- Path alias: `@/*` maps to `apps/frontend/src/*`
- Enable `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`

### JavaScript/Node.js (Backend)

- **ES2022+** features, ESM modules
- Use `async/await` for all asynchronous code
- **Never use `null`** — use `undefined` for optional values
- Prefer functions over classes
- No comments unless absolutely necessary
- Keep code simple and maintainable

### React Components

- Functional components with hooks as default
- PascalCase for components, camelCase for functions/variables
- Use custom hooks for reusable stateful logic
- Follow single responsibility principle
- Implement proper prop validation with TypeScript
- Use React Query (`@tanstack/react-query`) for server state

### Styling

- Tailwind CSS with `tailwind-merge` and `clsx`
- Use `class-variance-authority` for component variants
- Follow mobile-first responsive design

### ESLint Rules

- `@typescript-eslint/no-unused-vars`: warn (prefix with `_` to suppress)
- `react-refresh/only-export-components`: warn
- `react-hooks/rules`: enforced

### Error Handling

- Implement Error Boundaries for component-level errors
- Use proper error states in data fetching
- Handle async errors in effects and event handlers
- Provide meaningful error messages to users

## Existing Agent Instructions

These instructions are loaded from the Awesome MCP server using `awesome-copilot_load_instruction`:

- `nodejs-javascript-vitest.instructions.md` - Backend code standards
- `reactjs.instructions.md` - Frontend React standards
- `performance-optimization.instructions.md` - Performance (optimisation) guidelines

## Important Patterns

### Database Migrations (Alembic)

- Located in `alembic/versions/`
- Create migrations with: `bun run db:revision -- "message"`
- Always test migrations locally before committing
- Provide rollback plan for schema changes
- Don't execute migrations automatically; let the users handle that

### Testing Guidelines

- Write tests for all new features and bug fixes
- Cover edge cases and error handling
- Never modify original code to make testing easier
- Use `@testing-library/react` for component tests

### API Design

- RESTful endpoints in Express
- Use proper HTTP status codes
- Validate inputs with Zod on frontend

## Key File Locations

| Path | Description |
|------|-------------|
| `apps/frontend/src/` | React frontend source |
| `apps/node-backend/src/` | Node.js backend source |
| `apps/node-backend/src/main.js` | Backend entry point |
| `alembic/versions/` | Database migrations |
| `config/` | Shared config (tsconfig, vite, eslint, tailwind) |
| `i18n/` | Localization files |
| `docs/` | Project knowledge base (Obsidian vault) |
| `docs/diagrams/` | PlantUML UML diagrams |
| `docs/architecture/` | Architecture documentation |

## Knowledge Base

The project has a documentation knowledge base in `docs/` designed for Obsidian and AI agent usage.

### Structure

- `docs/index.md` - Main entry point with dataview queries
- `docs/adr/` - Architecture Decision Records (ADRs)
- `docs/api/` - API documentation
- `docs/guides/` - How-to guides
- `docs/features/` - Feature documentation (Portfolio, Tax, Imports, etc.)
- `docs/integrations/` - External service integrations
- `docs/security/` - Security documentation
- `docs/performance/` - Performance documentation
- `docs/i18n/` - Localization
- `docs/components/` - Frontend components
- `docs/testing/` - Testing documentation
- `docs/diagrams/` - PlantUML UML diagrams
- `docs/architecture/` - Architecture documentation with embedded diagrams

### Using the Knowledge Base

AI agents should:

1. **Read existing ADRs** before making architectural decisions
2. **Check API docs** for existing endpoints before creating new ones
3. **Use Obsidian MCP tools first** - Search the knowledge base before reading code files directly
4. **Query with Dataview** - The vault supports dataview queries for finding relevant docs

### Searching the Knowledge Base

Use the Obsidian MCP tools to search:

- `mcp-obsidian_obsidian_simple_search` - Full-text search
- `mcp-obsidian_obsidian_complex_search` - Query by tags, paths, etc.
- `mcp-obsidian_obsidian_list_files_in_dir` - List docs in a folder

### Knowledge Base Maintenance

**After completing any code changes, agents MUST update the knowledge base:**

- Use the local `vision-kb-updater` agent (`.opencode/agent/vision-kb-updater.md`)
- This ensures docs stay in sync with implementation
- The updater will:
  1. Identify what changed based on modified files
  2. Update existing docs to reflect changes
  3. Create new docs for new features/endpoints
  4. Add code links `[[path/to/file.js]]`
  5. Update frontmatter dates
  6. Update UML diagrams if relevant - See KB updater for diagram update guidelines

**This is mandatory** - all agents should call the KB updater before finishing their run.

## Environment Variables

- Copy `.env` to `.env.local` for local development
- `VITE_API_URL` - Backend API URL (defaults to `http://localhost:3002`)

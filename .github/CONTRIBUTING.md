# Contributing to Vision

Thanks for your interest in Vision — a self-hosted financial transaction manager
(AGPL-3.0-only). This file is the quick start; the **authoritative, in-depth guide lives
in the knowledge base** at [`docs/guides/contributing.md`](docs/guides/contributing.md).

## Quick start

```bash
bun install            # install workspace dependencies
bun run dev            # backend + frontend
bun run test           # backend tests (vitest)
bun run lint           # ESLint (frontend)
bun run typecheck      # strict TypeScript, both workspaces
```

Install the secrets-scanning pre-commit hook before your first commit:

```bash
git config core.hooksPath .githooks
brew install gitleaks   # the hook skips gracefully if gitleaks is absent
```

See [ADR-050](docs/adr/050-ci-supply-chain-security-tooling.md) for why.

## Ground rules

- **Read the KB first.** `docs/` is the source of truth for architecture, API contracts, and
  conventions. Start at [`docs/index.md`](docs/index.md). Check
  [`docs/adr/`](docs/adr/) before any architectural change (ADRs are append-only — supersede,
  never rewrite) and [`docs/reference/api-endpoint-matrix.md`](docs/reference/api-endpoint-matrix.md)
  before adding or changing routes.
- **Conventional Commits.** `type(scope): subject` — `feat`, `fix`, `docs`, `style`,
  `refactor`, `test`, `chore`.
- **Code style** (enforced by ESLint + `.editorconfig`):
  - Backend (Node/Bun): ES2022+ ESM, `async/await`, **never `null` — use `undefined`**,
    prefer functions over classes, 2-space indent.
  - Frontend (TS/React): strict mode, interfaces for props, Zod for input validation,
    React Query for server state, `@/*` path alias, 4-space indent.
- **Keep scope tight.** Don't fold unrelated cleanup into a change — log follow-ups in
  [`TODO.md`](TODO.md) instead.
- **Update docs with code.** New/changed endpoints → the endpoint matrix + the route's
  `docs/api/` doc; behavior changes → the feature doc. Run `bun run validate-locales` after
  i18n changes.

## Before opening a PR

- [ ] Tests pass (`bun run test`) and lint is clean (`bun run lint`)
- [ ] Types check (`bun run typecheck`)
- [ ] No leftover `console.log` / debug code
- [ ] Affected `docs/` pages updated
- [ ] Database changes ship an Alembic migration **and** a rollback plan (migrations are
      not auto-run — see [`.claude/skills/db-migrations`](.claude/skills/))

## Reporting bugs & requesting features

Use the GitHub issue templates. For **security vulnerabilities, do not open a public
issue** — follow [`SECURITY.md`](SECURITY.md).

Full workflow, testing patterns, and type-safety rules:
[`docs/guides/contributing.md`](docs/guides/contributing.md).

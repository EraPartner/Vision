# REVIEW.md — pre-change checklist for Vision

Run before proposing, committing, or pushing a change. Encodes the review knowledge that
otherwise lives in the maintainer's head so review catches issues automatically — the *why*
behind each item is in `CLAUDE.md` (Conventions, Verification, Security) and `docs/`.

## Secrets & safety

- [ ] No real secrets staged: `.env`, `.env.local`, `.env.production` stay gitignored; only
      `.env.example` (placeholders) is tracked. No tokens/PII in code or logs.
- [ ] gitleaks passes on the staged diff (`gitleaks git --staged -c config/gitleaks.toml .`);
      the `secrets-scan` CI job and the `.githooks/pre-commit` hook both gate on it.
- [ ] No files >1 MB staged (pre-commit blocks them; `ALLOW_BIG_FILES=1` only if truly intended)
      and no leftover merge-conflict markers.

## Correctness & invariants

- [ ] Backend: **no `null` — use `undefined`**; ES2022+ ESM `async/await`; functions over classes.
- [ ] All inputs validated with **Zod** (frontend *and* server-side).
- [ ] ADRs in `docs/adr/` are **append-only** — supersede with a new ADR, never rewrite.
- [ ] DB schema change → Alembic migration is **reversible** (CI round-trips `downgrade -1` →
      `upgrade head`); ship a rollback plan; migrations are user-applied, not auto-run.
- [ ] Route/API change → `docs/reference/api-endpoint-matrix.md` + the `docs/api/` doc updated,
      count matches `openapi.yaml` (`bun run check-endpoint-matrix`), and `generated.ts`
      regenerated (`bun run generate:types`). Note breaking vs non-breaking.
- [ ] i18n change → `bun run generate-locales`; en/nl key parity holds; committed locale TS is in sync.
- [ ] Compose edit → named volumes in `docker-compose.yml` match
      `packaging/electron/resources/docker-compose.yml` (the v1.0.2 data-loss guard).

## Tests & validation

- [ ] `bun run lint` and `bun run lint:backend` — ESLint clean (frontend + backend).
- [ ] `bun run typecheck` (frontend strict) and `cd apps/node-backend && bunx tsc -p tsconfig.check.json`.
- [ ] `bun run test` (backend vitest) and `bun run test:frontend` — scale depth to risk per CLAUDE.md.
- [ ] `bun run validate-locales` and `bun run check-endpoint-matrix` pass.
- [ ] High-risk (security / migration / destructive) also: `bun run build`. One-shot: `bun run check`.
- [ ] CI (workflow **CI**, required check **CI Complete**) expected green; `.githooks/pre-push`
      mirrors the cheap jobs locally.

## Hygiene

- [ ] Signed commit (SSH Secure Enclave key; `commit.gpgsign`/`tag.gpgsign` on) — don't bypass hooks.
- [ ] Conventional Commit message `type(scope): subject` (enforced by `.githooks/commit-msg`);
      commit to `main` directly (no feature branch).
- [ ] Behavior changed → affected `docs/` pages updated (via `vision-kb-updater`); scope kept tight,
      follow-ups logged rather than folded in.

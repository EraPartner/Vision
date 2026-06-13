<!--
Thanks for contributing to Vision! Keep PRs focused — one logical change per PR.
See CONTRIBUTING.md and docs/guides/contributing.md.
-->

## Summary

<!-- What does this PR do, and why? Link related issues with "Closes #123". -->

## Type of change

- [ ] `fix` — bug fix
- [ ] `feat` — new feature
- [ ] `refactor` — no behavior change
- [ ] `perf` — performance
- [ ] `docs` — documentation only
- [ ] `chore` / `ci` / `test` — tooling, build, or tests

## Checklist

- [ ] Tests pass (`bun run test`) and lint is clean (`bun run lint`)
- [ ] Types check (`bun run typecheck`)
- [ ] Conventional Commit title (`type(scope): subject`)
- [ ] No leftover `console.log` / debug code
- [ ] Affected `docs/` pages updated (feature docs, `docs/api/`, endpoint matrix)
- [ ] i18n: new strings added to `i18n/source/` and `bun run validate-locales` passes

## Architecture & data

- [ ] No architectural change — **or** a new ADR is added under `docs/adr/` (append-only)
- [ ] No API change — **or** `docs/api/` + `docs/reference/api-endpoint-matrix.md` updated
      (note breaking vs. non-breaking)
- [ ] No schema change — **or** an Alembic migration **and rollback plan** are included
      (migrations are not auto-run)

## Verification

<!-- How did you test this? Commands run, manual steps, screenshots for UI changes. -->

## Residual risk & follow-ups

<!-- Known limitations, anything deferred, blast radius. -->

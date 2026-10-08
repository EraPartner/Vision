---
title: "ADR-191: Backend source is fully strict TypeScript; the checkJs gate retires"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, type-safety, typescript, backend, checkjs, ratchet, adr-186]
description: "With apps/node-backend/src/main.ts converted, backend source has no JavaScript left. The loose checkJs program, its noImplicitAny ratchet and baseline, and the ambient express/pg/multer shims are removed, and the strict tsconfig.json is the backend's only type-check program. Amends ADR-186."
aliases: [adr-191, retire backend checkjs, type-safety phase 2f]
---

# ADR-191: Backend source is fully strict TypeScript; the checkJs gate retires

## Status

Accepted. Final step of phase 2 of the type-safety plan. Amends
[[docs/adr/186-backend-strict-typescript|ADR-186]].

## Date

2026-10-08

## Context

[[docs/adr/186-backend-strict-typescript|ADR-186]] kept `tsconfig.check.json` (loose checkJs), the
`noImplicitAny` ratchet (`scripts/checkjs-ratchet.js` and its baseline) and the ambient
`src/types/thirdPartyModules.d.ts` shims for as long as JavaScript remained in
`apps/node-backend/src`. Phase 2f converts the last file, the `main.js` entry point, to `main.ts`.
After that the legacy program has no JavaScript to check, and the baseline was already empty.

## Decision

- `apps/node-backend/src/main.ts` is the backend entry point. Package scripts, the Electron native
  runtime, its development and payload scripts, and the CI native-stack helper start it by that
  path. Bun runs it directly; no build step is added.
- `tsconfig.check.json`, `tsconfig.check.strict.json`, `scripts/checkjs-ratchet.js`,
  `scripts/checkjs-ratchet-baseline.json` and `src/types/thirdPartyModules.d.ts` are removed.
- `apps/node-backend/tsconfig.json` (strict) is the only backend type-check program. The backend
  `typecheck` script, the `Type Check (Backend)` CI job and the release workflow run only it.
- Backend tests stay JavaScript and are not type-checked until phase 3 converts them, as before.

## Consequences

- One program checks all backend source, so a type change only has to satisfy strict mode.
- `tsconfig.json` includes only `src/**/*.ts`. A new `.js` file under `src` would not be type-checked,
  so new backend source is written in TypeScript.
- The structural Express and `pg` types in `src/types/express.ts` and `src/types/rows.ts` were
  written for the legacy program. They remain valid and can be replaced with the real `@types`
  types in a later change.

## Related

- [[docs/adr/186-backend-strict-typescript|ADR-186]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/index|All ADRs]]

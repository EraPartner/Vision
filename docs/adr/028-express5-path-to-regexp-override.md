---
title: ADR-028 - Express 5 Compatibility: path-to-regexp Override
type: adr
status: Accepted
date: 2026-04-21
tags: [adr, backend, dependencies, express, routing, phase-1]
description: Override path-to-regexp to ^8.2.0 to enable Express 5 router (router@2.2.0) compatibility; legacy Express 4 version 0.1.13 lacks .match() method required by Express 5
aliases: [adr-028, express5-compat, path-to-regexp-override]
---

# ADR-028: Express 5 Compatibility: path-to-regexp Override

## Status
Accepted

## Date
2026-04-21

## Context

Vision's backend is transitioning to Express 5 as part of Phase 1 (performance/architecture sweep). Express 5's router implementation (`router@2.2.0`) requires `path-to-regexp@>=8.0.0` to gain access to the `.match()` method, which validates and extracts path parameters from incoming requests.

The previous root `package.json` specified `path-to-regexp` only implicitly through its dependents (e.g., Express 4, which brings `path-to-regexp@0.1.13`). This legacy version:

- Does not export a `.match()` function
- Throws `TypeError: pathRegexp.match is not a function` at the first route registration when Express 5 router tries to call it

**Error reproduction:**
```
TypeError: pathRegexp.match is not a function
  at /app/node_modules/router/index.js:XXX
```

This blocks Express 5 router initialization on startup.

## Decision

Add explicit `path-to-regexp@^8.2.0` overrides to `package.json` `overrides` and `resolutions` blocks:

```json
{
  "overrides": {
    "path-to-regexp": "^8.2.0",
    ...other overrides
  },
  "resolutions": {
    "path-to-regexp": "^8.2.0",
    ...other resolutions
  }
}
```

This ensures:
1. Any transitive dependency requesting `path-to-regexp` receives the v8.2.0+ implementation with `.match()` support.
2. The constraint is enforced at both npm (via `overrides`) and Yarn/Bun (via `resolutions`).
3. The legacy v0.1.13 chain is never selected during dependency resolution.

Regenerate `bun.lock` after the change to ensure all transitive paths point to v8.2.0.

## Consequences

### Positive

- Unblocks Express 5 router initialization and route registration.
- Explicit, version-agnostic override ensures future dependents (e.g., new libraries) automatically pull the correct version.
- No code changes required; router behavior is transparent.
- Both npm and Bun resolution mechanisms are covered.

### Negative

- `path-to-regexp@8.2.0` has a slightly larger bundle footprint (~2–3 KB) than v0.1.13 (~1 KB), but negligible in server context.
- If any dependency explicitly pins a `path-to-regexp@0.1.x` range in its range specifier (e.g., `~0.1.0`), the override may trigger resolution conflicts. Mitigated by choosing a permissive range (`^8.2.0`).

## Related

- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]] — backend structure assuming Express 5
- [[docs/reference/environment-variables|Environment Variables Reference]] — no env vars required for this fix
- `[[apps/node-backend/src/main.js]]` — entry point that registers Express 5 routes
- `package.json` `overrides` and `resolutions` blocks

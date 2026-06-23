---
title: ADR-076 React 19 Upgrade
type: decision
status: Accepted
date: 2026-06-13
tags: [frontend, react, upgrade, concurrent-rendering]
description: Upgrade the frontend from React 18 to React 19 (^19.2.6) to stay on the supported release channel and access concurrent rendering improvements, the new JSX transform, and the Actions API.
aliases: [adr-076, react-19, react upgrade]
---

# ADR-076: React 19 Upgrade

## Status
Accepted

## Date
2026-06-13

## Context

ADR-001 selected React 18 as the frontend library. React 19 has since reached general availability and is now the supported release channel. The upgrade brings several improvements relevant to this project:

- **Concurrent rendering improvements** — refined scheduling and transitions reduce jank on data-heavy pages (transactions virtual table, portfolio snapshot views).
- **Better Suspense** — Suspense boundaries integrate more cleanly with React Query's `suspense` mode, enabling simpler loading-state patterns.
- **New JSX transform** — the automatic JSX runtime is the default; no per-file `import React` needed.
- **Actions API** — `useActionState` and `useFormStatus` simplify form submission flows, a candidate for future refactoring of the planned-transaction and import forms.
- **`use()` hook** — reads a Promise or Context inline, unblocking future simplification of async data patterns.

Remaining on React 18 means tracking a maintenance-mode branch and eventually losing security patch coverage.

## Decision

Upgrade the frontend dependency to React 19 (`^19.2.6`) and the matching `react-dom`, `@types/react`, and `@types/react-dom` packages. The version is already reflected in `apps/frontend/package.json`.

No immediate code rewrites are required at upgrade time. New React 19 APIs (Actions, `use()`) are opt-in and will be adopted incrementally in future tasks.

## Consequences

### Positive

- Stays on the supported release channel; security patches continue to arrive.
- Access to the Actions API and improved Suspense for future form and data-loading refactors.
- The new JSX transform is the default; boilerplate `import React` lines can be removed over time.
- `@tanstack/react-query` v5 and Zustand v5 (already in use) are compatible with React 19.

### Negative

- React 19 removes legacy APIs: string refs, the legacy `ReactDOM.render` API, and the legacy Context API (`childContextTypes`/`getChildContext`). Any remaining usage must be removed before the upgrade compiles cleanly.
- `react-router-dom` v7 (already in use) requires React 18+ — React 19 is compatible, but the router's own upgrade changelog must be reviewed for any API changes that compound with the React 19 upgrade.

### Neutral

- `@testing-library/react` v16 supports React 19; no test-harness changes needed.
- Radix UI component packages track React peer deps broadly (`^18 || ^19`) — existing UI primitives remain compatible.

## Related

- [[docs/adr/001-technology-stack|ADR-001: Technology Stack]] — original React 18 selection
- [[docs/adr/index|All ADRs]]

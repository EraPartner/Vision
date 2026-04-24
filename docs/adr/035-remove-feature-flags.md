---
title: ADR-035 - Remove Feature Flags
type: adr
status: Accepted
date: 2026-04-24
tags: [adr, backend, frontend, feature-flags, admin, simplification]
description: Remove the runtime-toggleable feature flag system entirely. All features are always enabled. Supersedes ADR-033.
aliases: [adr-035, remove-feature-flags]
supersedes: "[[docs/adr/033-runtime-toggleable-feature-flags]]"
related_code:
  - alembic/versions/0011_drop_feature_flags.py
---

# ADR-035: Remove Feature Flags

## Status
Accepted — supersedes [[docs/adr/033-runtime-toggleable-feature-flags|ADR-033]]

## Date
2026-04-24

## Context
ADR-033 introduced a runtime-toggleable feature flag system backed by the `feature_flags` PostgreSQL table. In practice, all features (AI chat, aggregations v2) were enabled in every deployment and no flags were ever toggled off. The system added maintenance surface (DB table, backend service/repo/routes, frontend page, i18n keys, sidebar nav entry, admin overview card) without delivering value. The concept of "disabled by default" features is contrary to the product direction where all functionality is always on.

## Decision
Remove the feature flag system in its entirety:

- **DB**: Alembic migration `0011_drop_feature_flags` drops the `feature_flags` table (history intact via `0002_feature_flags`).
- **Backend**: Delete `featureFlagRepository.js`, `featureFlagService.js`, and the three admin routes (`GET /api/admin/feature-flags`, `GET /api/admin/feature-flags/:key`, `PATCH /api/admin/feature-flags/:key`).
- **Frontend**: Delete `AdminFeatureFlagsPage.tsx`; remove the route, sidebar nav item, API client functions, overview card, and all i18n keys (`admin.flags.*`, `nav.adminFeatureFlags`, `admin.overview.featureFlags`, `admin.overview.flagsEnabled`).

All previously flag-gated features (AI chat, aggregations v2) remain enabled unconditionally — their enabling condition is now the presence of their configuration, not a DB flag.

## Consequences

**Positive**
- Eliminates ~500 lines of code across backend, frontend, and tests.
- Admin UI is simpler: overview has 3 cards instead of 4; sidebar has no Feature Flags entry.
- No risk of a feature being accidentally disabled via the flag UI.

**Negative**
- No runtime toggle mechanism exists. Disabling a feature requires a code change and redeploy.

**Neutral**
- Alembic migration history is preserved (`0002_feature_flags` → `0011_drop_feature_flags`).
- ADR-033 is preserved as historical record.

## Related
- [[docs/adr/033-runtime-toggleable-feature-flags|ADR-033 — original feature flags decision]]
- [[docs/adr/index|All ADRs]]

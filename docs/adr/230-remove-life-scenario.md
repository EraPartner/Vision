---
title: "ADR-230: Remove the Life scenario panel"
type: adr
status: accepted
date: 2026-10-20
tags:
  [
    adr,
    research,
    forecast,
    portfolio-projection,
    settings,
    migration,
    retirement,
    adr-081,
  ]
description: "Accepted on 2026-10-20 by Tor. Vision removes the Life scenario panel from the Portfolio Forecast page, its saved `life_scenarios` setting and the `lifeScenarioPrepare` and `lifeScenarioCompare` presentation kinds. Migration 0003 deletes the stored setting row. The portfolio forecast endpoint, including its contribution schedule and goal month, is unchanged. This is a breaking API change."
aliases: [adr-230, remove life scenario, remove income interruption scenario]
related_code:
  [
    "db/migrations/0003_remove_life_scenarios.sql",
    "db/migrations/0003_remove_life_scenarios.down.sql",
    "apps/node-backend/src/routes/settings.ts",
    "apps/node-backend/src/services/research/presentationService.ts",
    "apps/frontend/src/pages/research/PortfolioForecastPage.tsx",
  ]
---

# ADR-230: Remove the Life scenario panel

## Status

Accepted on 2026-10-20 (decision by Tor). No earlier ADR introduced the
panel, so this ADR supersedes none. The Monte Carlo forecast of
[[docs/adr/081-research-analytics-forecasting|ADR-081]] stays in force.

## Date

2026-10-20

## Context

In September 2026 the Portfolio Forecast page gained a Life scenario panel. It compared the
portfolio forecast against a three-month income interruption. The user entered a baseline monthly
surplus, the monthly income lost, a planned monthly portfolio contribution and an optional savings
goal amount and month. The panel saved up to 50 named definitions in the `life_scenarios` setting
and ran two seeded forecasts for each comparison. Shared helpers in
`packages/shared-utils/src/research/forecastScenario.ts` prepared the two inputs and checked that
both forecasts used the same market inputs. The stateless presentation endpoint exposed the same
helpers as the `lifeScenarioPrepare` and `lifeScenarioCompare` kinds.

Tor decided the panel is not wanted and asked for its complete removal.

## Decision

Remove the Life scenario feature entirely.

- **Frontend.** `LifeScenarioPanel` and its test are deleted, and `PortfolioForecastPage` no longer
  renders the panel. The 31 `research.lifeScenario.*` strings are removed from the English and
  Dutch sources and the generated locales.
- **Shared code.** `packages/shared-utils/src/research/forecastScenario.ts` and its golden test are
  deleted.
- **API.** `POST /api/research/presentation` no longer accepts the `lifeScenarioPrepare` and
  `lifeScenarioCompare` kinds. The OpenAPI schemas `ResearchLifeScenario`,
  `ResearchLifeScenarioForecastInput`, `ResearchLifeScenarioPreparedInput`,
  `ResearchLifeScenarioPrepareResult` and `ResearchLifeScenarioCompareResult` are removed, and the
  snapshot no longer has the `scenario`, `forecastInput`, `goalMonth`, `baseline` and `interrupted`
  fields. The settings API no longer knows `life_scenarios`: it has no validation schema and no
  `[]` read default. The number of operations stays at 299. This is a breaking API change.
- **Schema.** `db/migrations/0003_remove_life_scenarios.sql` deletes the `user_settings` row whose
  key is `life_scenarios`. No table or column changes. `0003_remove_life_scenarios.down.sql` is a
  no-op.

Kept: `POST /api/research/portfolio-forecast` with its `monthly_contribution_schedule` and
`goal_month` fields. They are part of the general forecast contract and are covered by the
projection tests, although the removed panel was their only caller in the app. The forecast
overflow check that lived in the removed route test now lives in
`apps/node-backend/tests/services/portfolioProjection.test.ts`.

## Consequences

- Migrations apply at backend startup, so migration 0003 runs at the next launch after the update.
  Saved scenario definitions are deleted. They are recoverable only from a backup taken before the
  update. Restoring such a backup runs migration 0003 again and deletes the row once more.
- A `PUT` of `life_scenarios`, single or bulk, now returns `400` like any other unknown key. A
  `GET` returns `404` once the row is gone. Reads and deletes of unknown keys remain allowed, so a
  leftover row does no harm.
- A presentation request with a removed kind returns `400 VALIDATION_ERROR`.
- `docs/diagrams/life-scenario-flow.puml` is deleted. The flow visualizer drops the "Save and
  compare income interruption" journey and now lists 75 components and 44 flows.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/081-research-analytics-forecasting|ADR-081]]
- [[docs/features/research|Research Feature]]
- [[docs/api/research|Research API]]
- [[docs/api/settings|Settings API]]
- [[docs/reference/data-model|Data Model]]

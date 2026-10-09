---
title: Cross-Workspace API
type: endpoint
status: active
date: 2026-10-08
updated: 2026-10-08
tags: [api, endpoint, cross-workspace, portfolio, budgeting, cash]
description: Rebalancing and commitment-aware candidate cash cap endpoints.
related_code:
  [
    "apps/node-backend/src/routes/crossWorkspace.ts",
    "apps/node-backend/src/services/commitmentAwareCashService.ts",
    "apps/frontend/src/lib/api/crossWorkspace.ts",
  ]
---

# Cross-Workspace API

The endpoints return the standard Vision response envelope. See [[docs/api/index|API Documentation]] and [[docs/features/portfolio|Portfolio]].

## `POST /api/cross-workspace/commitment-aware-cash`

Request body: `currency` (optional three-letter code, default `EUR`) and `reserveFloor` (optional non-negative number, default `0`; `null` also means `0`). Invalid values, or a body that is not a JSON object, return `400 VALIDATION_ERROR`. The message names the field, for example `reserveFloor: must be a non-negative finite number`.

The response includes `today`, `horizonEnd`, `horizonDays` (90), `currentCash`, `reserveFloor`, `minimumProjectedBalance`, `minimumDate`, `candidateCashCap`, `occurrenceCount`, and explicit `assumptions`. It counts active unexecuted planned bills and bounded recurring occurrences once. It does not include future income, a statistical forecast, or unplanned expenses. When currency conversion is needed, each foreign rate must have a stored date within seven days; otherwise the estimate is unavailable. Static fallback rates cannot silently support a cap. The cap is an estimate, not a guarantee.

## `POST /api/cross-workspace/rebalance`

The request accepts `currency`, `model` or `targetWeights`, and optional `availableCash`. The server clamps the supplied cash cap to the current spendable balance. The body must be a JSON object; an array returns `400 VALIDATION_ERROR`. The other fields stay lenient: a non-string `currency` means `EUR`, and a non-numeric `availableCash` is ignored. It returns `targetWeights`, `actualValues`, `availableCash`, `cashAccounts`, and a per-sleeve `deployment`. This route proposes buys only; it does not execute them.

The Rebalance page obtains the commitment-aware estimate first and supplies the lower of its candidate cap and any custom cap to this route. Direct API callers can still supply their own cap.

## Related

- [[docs/adr/098-cross-workspace-features|ADR-098]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/diagrams/commitment-aware-cash-flow.puml|Commitment-aware Cash Flow]]

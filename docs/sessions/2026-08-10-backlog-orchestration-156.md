---
title: Backlog orchestration session — PR #156
type: session-note
date: 2026-08-10
tags: [backlog, orchestration, todo, url-state, a11y, i18n, percent-formatting, tax-report, release-pipeline]
description: One-session sweep of TODO.md's actionable 🔼 tier — 27 findings closed across URL/navigation state, a11y/mobile robustness, i18n/percent formatting, tax-report correctness, and the release pipeline; 4 new findings filed (3 fixed same-session).
---

# Backlog orchestration — 2026-08-10 (PR #156)

All work on `claude/vision-backlog-orchestration-8kcbsm`, delivered as [[TODO]] finding closures with per-finding stamps. The ⏫ tier was blocked at session start (two look-changing page recompositions awaiting user sign-off, one GitHub-side check, one manual runbook step, WP-C2/C4 needing user-supplied broker CSVs), so the session worked the actionable 🔼 tier plus everything it surfaced.

## Batches landed

1. **URL/navigation state + silent-failure feedback** (7 findings — 9741b7f7, decb062a, 4314079c, e76181b3, c7b2ec5f): `?tab=` deep-linking via new `useTabParam`, `?year=` on the tax routes via `useTaxYearParam` (race-guarded, 6 tests), `/ai-chat` workspace-agnostic, replace-navigation after import commit, URL-backed transactions search+sort, load-more failure toast with retry, attachment-delete failure toast.
2. **A11y / mobile robustness** (8 findings — a0418d0d, 83813026, f92feb15): TabsList overflow-scroll, DialogContent `max-h` cap (covers 12 dialogs), settings-nav phone collapse, icon-button aria-labels, AccordionTrigger `trailing` API un-nesting the import-review combobox (chevron click-forward preserved), Badge `size`/`muted` consolidation, middle-dot separators, destructive-delete confirms.
3. **i18n / formatting** (3 findings — 144ad689): Belgian-tax hardcoded copy onto keys (bracket labels translated at the export boundary via a skip-proof `bracketNumber`), `formatPercent` swept across all 56 toFixed-percent sites (adversarially verified by a second agent; its 4 flagged defects fixed pre-commit), chart month names localized end-to-end.
4. **Tax-report correctness + escaping** (4 findings — f3c7528e, 787b2fb2, f51388b9): the 10,000×/100× rate double-scaling in `belgianRulesSummary.js` (found by the verification pass, pre-existing since April), the WatchlistChartDialog doubled percentage, and two client-controlled-HTML escape gaps in the report sections — each pinned by discriminating tests.
5. **Release pipeline** (4 findings — 0a6bf35d): scan-before-publish via untagged candidate digest + `imagetools` promotion with digest-equality assertion, release-verify gate parity with CI (gitleaks/generated/typecheck/round-trip), the duplicated awk compose guard replaced by `scripts/check-compose-sync.js` (self-tested, pre-push wired), and the `APP_IMAGE_TAG` finding confirmed superseded by `APP_IMAGE_REF` with its one live remnant (`APP_VERSION` env clobber) fixed.

Docs vault synced mid-session (8aace51d): component primitives, hooks, feature-page URL-state notes, i18n changelog; CI/scripts docs updated in-batch by the release work.

## Bookkeeping

Every closed finding is ticked in [[TODO]] with `✅ 2026-08-10 · <sha> (#156)`. One duplicate reconciled (the rate-scaling bug was also sub-item (a) of the "Tax-PDF residues" group — group moved to `partial-f3c7528e`). New findings filed: release-guard follow-ups (trivyignore parity, resources-demo volumes-only guard, promotion ADR), plus three filed-and-fixed same-session.

## Residual risk

- The percent sweep inherits the `exceptZero` rounds-to-zero pitfall and the module-singleton locale staleness from `formatCurrency` — documented in the finding stamps.
- The release-pipeline changes are statically validated only (actionlint, stubbed-docker bash tests, local gate runs); the first real release tag is the live proof of the push-by-digest → promote flow.
- No demo-app visual pass was possible in this environment; the batches were chosen to be visually free, with the two sanctioned deltas (admin ProviderHealth pills, dev-only ApiInspector) noted in their stamps.

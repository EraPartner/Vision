---
title: Completed-item audit — TODO.md backlog
date: 2026-08-10
status: complete
scope: all 727 ticked (- [x]) items in TODO.md, against main @ 899a5220
---

# Completed-item audit — 2026-08-10

Every `- [x]` item in `TODO.md` was re-checked against the current tree to answer one question:
**is the finding actually fixed, and is the defect really gone?**

## Method

- **727** ticked items extracted and clustered by the code area they touch, into 73 batches of 10.
- **Pass 1 — verification.** One reviewer per batch. Each had to *disprove* the tick: find the fixing
  code in the working tree and confirm the described defect can no longer occur, citing `file:line`.
  A commit SHA in the stamp was explicitly **not** accepted as proof on its own.
- **Pass 2 — adversarial.** Every verdict that was not a confident clean FIXED (39 items) went to a
  **second, independent reviewer** told to refute the first — in either direction — and to confirm every
  cited path exists before trusting it.
- **Stamp integrity** was checked mechanically across the whole file, not sampled.
- The clone arrived **shallow**; `git fetch --unshallow` was run first. `TODO.md:16` warns that ancestry
  tests on a shallow clone give false answers, and that warning is load-bearing here — 50 commits were
  visible before, 1752 after.

## Result

| Verdict | Count | Share |
|---|---|---|
| **FIXED** — defect genuinely gone | **691** | 95.0% |
| **PARTIAL** — root fix real, a sub-case the item itself names remains | **26** | 3.6% |
| **NOT_FIXED** — tick refuted | **10** | 1.4% |

**No item was rated high severity.** Every flagged item is medium or low: no security fix, data-integrity
guarantee, or user-facing correctness fix was falsely ticked. The security section (7 items) verified clean.

All 39 adversarial re-checks **agreed** with the first pass. The only corrections were two items whose
first-pass verdicts were dropped; both came back FIXED.

## Reviewer errors caught (not reported as findings)

Three first-pass claims were refuted before reaching this report — worth recording, because they show the
adversarial pass earning its keep:

- **`I133`** (api-endpoint-matrix drift) claimed "no drift check in CI". False: `scripts/check-endpoint-matrix.js`
  is wired into `.github/workflows/ci.yml:299` and `release.yml:172`. Run directly: `in sync: 212 operations`.
- **`I671`** was reported as an unguarded balance-write race citing `routes/accountRoutes.js:238-259` —
  **that file does not exist** (the real one is `routes/accounts.js`), and there is no `PATCH /:id/balance`
  route. `I671` is the account-lifecycle item and is genuinely fixed.
- **`I038`** (stale FX rates) was disputed as PARTIAL; the independent reviewer rejected the claim as
  misattributed. Confirmed FIXED.

## Dominant failure mode

By a wide margin, the flagged items share one shape: **the item's own text enumerated several sites or
sub-cases, and only the first was fixed.** `I070`, `I115`, `I260`, `I276`, `I307`, `I519`, `I520`, `I566`,
`I579`, `I697` all fit it. These are not bad fixes — they are ticks applied to the headline symptom while a
sub-case named in the same finding was left.

Two smaller recurring shapes:

- **Fixed, then undone by later work.** `I226` (`start_interval` reverted 4 days later for Compose
  compatibility, never reinstated behind a version gate), `I578` (`concurrency:` block deleted wholesale by
  #128), `I463` (layering fix decayed when #142 reintroduced a repository→service import no lint rule catches).
- **Mooted by the ADR-108 accounts rewrite.** `I014`, `I015`, `I043`, `I044`, `I074`, `I269`, `I475`, `I491`,
  `I674` — commit `0c404300` deleted the machinery these items patched. The defect cannot occur, but the
  stamped fix code is gone, so several completion notes describe code paths that no longer exist. Only
  `I269` and `I674` are un-ticked (their notes assert live code paths); the rest stay ticked with the
  mechanism noted.
- **Completion note asserts a false fact.** `I520` ("`recipients.js` now uses `Number()`" — the code still
  calls `parseInt`, so `"12abc"` is truncated to `12` and accepted) and `I161` (claims an "exhaustive,
  0-mismatch" SHA sweep, yet the two SHAs it names by hand remain raw).

## Stamp integrity

| Check | Result |
|---|---|
| Items whose `✅ · <sha>` stamps all resolve on `main` | 553 |
| Items carrying ≥1 **dangling** stamp SHA | **97** |
| Distinct unresolvable SHAs | 56 |
| Items with no `✅ <date> · <sha>` stamp at all | 77 |
| Dangling SHAs recoverable via their `(#NN)` PR number | **97 / 97** |

Every dangling SHA is a **pre-squash branch SHA** — exactly the failure `TODO.md:15` warns about. All 97 map
cleanly to a merge commit on `main` via their PR number, so no work is missing; the stamps just cannot be
`git show`n. The backlog item about this (`TODO.md:1059`) is itself stamped `1240a95`, which does not resolve.

**Not repaired here** — it is a mechanical, whole-file rewrite unrelated to verifying the fixes, and folding
it into this audit would bury a 97-line diff inside a verdict change. See follow-ups.

## Follow-ups

1. Re-point the 97 dangling stamps to `<mergesha> (#NN)` (mechanical; mapping already computed).
2. Decide whether the 26 `🔎 partial-audit` items should be un-ticked — by this file's own convention
   (`TODO.md:12`) partials are kept **open**. They are left ticked-and-flagged here rather than flipped
   unasked.
3. `I520` and `I161`: correct the completion notes that assert facts the code contradicts.
4. Add a lint rule banning `repositories/*` → `services/*` imports (`I463`), and refresh the stale
   sanctioned-exception list in `docs/reference/code-patterns.md:497-524`.
5. `I507`: replace the hand-maintained migration stamp in `backup/coverage.js` with something self-updating —
   the same comment drifted again within 10 migrations of being "fixed".

## Full findings

### Refuted — un-ticked (10)

| Sev | Item | TODO.md | Finding | What is actually still true |
|---|---|---|---|---|
| medium | `I226` | 1525 | Demo compose db healthcheck lacks `start_interval` — ~5s of pure idle on every demo warm boot (83% of the meas | packaging/electron/resources-demo/docker-compose.yml and packaging/electron/resources/docker-compose.yml (and root docker-compose.yml) have no start_interval on the db healthcheck; the demo's warm-boot idle wait this item measured (~5s of ~6.8s total) is reproducible again. Impact is scoped to the d… |
| medium | `I438` | 3157 | Five strings separate clauses with a stray spaced period " . " — reads as a rendering bug | All 5 keys in both en.json and nl.json still render the literal ' . ' verbatim; no fix was ever applied despite the ticked checkbox and cited (nonexistent) commit. Additionally scripts/generate-locales.js:41 would strip any middle dot back to a period at build time, so this normalization rule must a… |
| medium | `I459` | 3795 | Half-finished components/→features/ migration leaves two competing feature-location conventions plus a layerin | No directories were moved from components/ to features/ (10 straggler dirs, now with higher file counts, are unchanged); no lint rule bans components/*->features/* imports; the components/onboarding->features/imports layering inversion the finding cited still exists verbatim. Only a documentation wa… |
| medium | `I558` | 4815 | Devcontainer writes platform-specific state into the shared host workspace (node_modules, venv, .env) | The two disruptive sub-issues are unfixed and directly reachable in the current tree: (1) post-create.sh:68-70 still rebuilds ./venv with Linux CPython directly on the bind-mounted workspace on first/broken boot, breaking the host macOS venv/alembic until manually rebuilt; (2) post-create.sh:98 `bun… |
| medium | `I578` | 4951 | `cancel-in-progress: true` also applies to pushes on main, leaving main commits with no CI verdict | ci.yml has zero concurrency control today, not merely the wrong condition — so pushes to main are not literally being auto-cancelled by a shared group (matching the item's narrow symptom does not currently reproduce), but the fix that was supposed to prevent it if concurrency control were ever reint… |
| medium | `I674` | 5773 | Persist the per-account split alongside snapshots + incremental rebuild (filed | The persisted per-account split (portfolio_snapshot_accounts writer in snapshotBuilder.js) and its getNetWorthByAccount/GET /api/info/net-worth/by-account read-path consumer do not exist anywhere in the current working tree — deliberately deleted by 0c404300 as part of ADR-108, which also retired th… |
| low | `I161` | 1065 | Prose SHA back-references rot exactly like the stamps did — 58 distinct / 101 occurrences unreachable from `ma | TODO.md:3766 ('Guard half (2869087)') and TODO.md:4639 ('first seen at head 5549643') remain bare, unmapped SHA references unreachable from origin/main, despite the completion note explicitly asserting both were remapped to bca4b38 (#145) and ce17654 (#137) respectively as part of an 'exhaustive, 0-… |
| low | `I269` | 1808 | `getNetWorthByAccount` replays the entire multi-year snapshot history live, per request, on the event loop | The completion note asserts an active code path (`infoRepositoryNetWorth.js:344` calling `readPersistedAccountSeries`) that does not exist — the entire feature was deleted by 0c404300, two days after the stamp. TODO.md's own line-6846 entry on the identical subject correctly uses a moot/deleted mark… |
| low | `I494` | 4064 | routes/savedCharts.js skips the shared validateIdParam middleware on /:id routes | savedCharts.js's PATCH/DELETE /:id handlers still use the bespoke parseChartId parser instead of the shared validateIdParam middleware used by 11 other route files; the fix's explicit instruction to drop the bespoke parser was not carried out, only its strictness was incrementally improved. |
| low | `I507` | 4264 | backup/coverage.js's verification-stamp comment is stale | coverage.js:22's stamp still says 0080 while the tree is at 0090; no self-updating mechanism exists. The actual table list remains CI-enforced via tests/backup-coverage.test.js, so this is a stale-comment/doc-accuracy defect, not a functional/data-safety one. |

### Partial — sub-case remains (26)

| Sev | Item | TODO.md | Finding | What is actually still true |
|---|---|---|---|---|
| medium | `I029` | 235 | `PATCH`-to-clear silently no-ops on 5 account fields | funding_account_id cannot be cleared (or set) from the UI at all -- no form field exists for it, so the item's own verification note's claim that 'the frontend submit path needs the matching change' for this field is not delivered. This is the item's own explicitly-named sub-case, not reviewer-intro… |
| medium | `I070` | 486 | Cash-flow forecast header is off by a month in timezones behind UTC | PortfolioForecastPage.tsx's research-forecast chart date labels/axis (west-of-UTC only) and forecastMerge.ts's rolling-forecast today-marker vs. point timestamps (same class) are unfixed. Both are named explicitly in the item's own verification note as the same bug class, so this is a described sub-… |
| medium | `I107` | 726 | `sanitizeSnapshotSpikes` breaks the `Σ value_by_account == value` invariant and can falsify real portfolio his | cash_value is never smoothed/reconciled in sanitizeSnapshotSpikes (portfolioMath.js:299-302), so on a detected needle day, stored 'value' (and stocks/crypto/metals) get replaced with a geometric-mean smoothed figure while cash_value keeps the raw, un-smoothed figure it was computed with — breaking v… |
| medium | `I250` | 1685 | Unbounded, unvirtualized row rendering in portfolio import review | No collapse/accordion and no virtualization exist; all rows across all groups are still mounted in the DOM/React tree on import review. Only the paint/layout portion of the cost is mitigated via content-visibility. |
| medium | `I260` | 1745 | VirtualDataTable: every search keystroke re-renders the whole table and re-runs the O(n) row pipeline | No memoized Row component was extracted; the ~25-40 visible virtual rows and their Radix ContextMenu/TagChip subtrees still fully re-render on every search keystroke because VirtualDataTable itself re-renders on setLocalSearchQuery with no row-level memo boundary, exactly as the item's fix list call… |
| medium | `I274` | 1856 | Every transactions-list page load scans the entire filtered set — `COUNT(*) OVER ()` defeats LIMIT top-N even  | getUncategorisedWithCount's total_cte (transactionRepository.js:459-464) still runs a full COUNT(*) over the complete TRANSACTION_JOINS join set on every request to this endpoint, independent of and heavier than the reduced-join uncategorised_rows CTE beside it — unaddressed by fab7a77, which only f… |
| medium | `I276` | 1870 | `recipientId`/`recipientGroupId` filters OR across two tables, defeating `idx_transactions_recipient_id` | recipientGroupId (filterBuilder.js:245-258) still ORs `t.recipient_id` against the joined `r.primary_recipient_id` column (and a second OR'd subquery result) in the same WHERE clause, defeating `idx_transactions_recipient_id` for group-filtered recipient drill-downs exactly as the item describes — o… |
| medium | `I294` | 1998 | Minor render hygiene (grouped) | CategoryPivotTable.tsx still defaults yearFilter to 'all' and renders every period column eagerly for multi-year data (~3-4k <td>s per toggle); neither of the item's two suggested mitigations (default-to-latest-year, column windowing) was applied. |
| medium | `I307` | 2106 | ChatMessageList forces a layout flush (scrollHeight read + scrollTop write) and re-renders every unmemoized Ch | Scroll auto-pin during streaming is still unconditional (ChatMessageList.tsx:60-68) — no 'is pinned to bottom' check was added, so a user who scrolls up mid-stream is still yanked back to the bottom on every chunk, exactly the UX defect the item named. |
| medium | `I463` | 3815 | Layer inversion: 13 repository→service imports, including repos that invoke a transaction-opening service | accountRepository.js:20's currencyConversionService import is an unsanctioned, undocumented repository->service layering violation (post-dates the fix, introduced by #142); no lint rule prevents new repo->service imports; the code-patterns.md exception list is stale re: infoRepositoryNetWorth.js no… |
| medium | `I519` | 4409 | Pagination-helper adoption gap: investmentController hand-rolls three clamp parsers; `validatePagination` in m | parseBulkTransactionsOptions and parseInvestmentTransactionsOptions in investmentController.js still bypass parsePagination with their own divergent clamp bounds (5000/200000 and 1000 respectively), contradicting the completion note's implication that investmentController pagination was unified and… |
| medium | `I520` | 4419 | :id path-param validation drift — five routers bypass `validateIdParam` with weaker hand-rolled checks | recipients.js (patternId), savedCharts.js (parseChartId), research.js (mappings/:id DELETE), and recipientBankAccounts.js (parseAccountId) all still use parseInt-based parsing and silently truncate strings like '12abc' to a valid integer instead of rejecting with 400 — the exact defect the item's fi… |
| medium | `I532` | 4529 | Price-provider seam is the repo's worst shotgun: ~11 hand-maintained touchpoints incl. four copy-paste dispatc | docs/integrations/price-providers.md's own 'Adding a Price Provider' recipe (added by the same fab7a77 stamp that closed this item) describes an architecture superseded a day earlier: step 3 tells a future implementer to extend the removed `if (stale.X.length)` dispatch-block pattern instead of the… |
| medium | `I561` | 4842 | E2E/accessibility CI workflow has been failing on every single nightly run for a month with zero alerting | The workflow is still failing on ~93% of nightly runs through the verification date, for a different (test/app-level, not infra) reason each time it's checked; alerting exists but is not being acted on, so the backlog item's underlying purpose (a trustworthy green nightly signal) is still not achiev… |
| medium | `I579` | 4956 | Dependabot doesn't cover compose-file images or the devcontainer base image | The compose-file image coverage half of the item (root docker-compose.yml:17 and packaging/electron/resources/docker-compose.yml:5,54 postgres/GHCR image pins) is still not scanned by Dependabot: the fix used ecosystem key "docker" instead of "docker-compose" for the packaged-compose entry, and neve… |
| medium | `I697` | 6799 | `funding_account_id` accepts nonexistent ids as a 500, plus self-reference and cycles | Multi-hop funding cycles (A funds B, B funds A, or longer chains) are still accepted silently — assertFundingAccountValid only compares against the single selfId with no ancestor walk. The item's own text explicitly names 'A→B→A chains' as part of the defect; the completion note claims only 'existen… |
| medium | `I718` | 7094 | WP-A3 — Aggregate lifecycle semantics + merge preview endpoint (M) | Multi-hop cycle rejection (the 'cycles' half of '§1 F4 ... reject self-reference + cycles') is not implemented — only single-hop self-reference is checked. No test covers a 2+ hop cycle. This is the same underlying code gap as I697, referenced a second time by this larger work-package item's own acc… |
| low | `I261` | 1751 | `Intl.NumberFormat`/`DateTimeFormat` constructed per formatted value on TaxOverviewPage (and 6 smaller sites)  | RealEstatePage.tsx:38-40 and MarketLookupPage.tsx:131-134 (the latter feeding a chart tick formatter at hover rate) still construct a new Intl.NumberFormat on every formatted value/call; 2 of the item's 7 named sites remain unfixed, though the highest-impact site (TaxOverviewPage) and the Money.tsx… |
| low | `I293` | 1990 | Minor React Query hygiene (grouped) | Categories full-list double-fetch (StatisticsSection.tsx vs useExcludedIds.ts) is still two separate cache entries under two different query keys, not unified into one key/hook as the item explicitly requested. useOllamaStatus backoff (explicitly optional) also not added. |
| low | `I309` | 2131 | InvestmentDetailDialog transactions tab renders every portfolio transaction for the holding unvirtualized | List is still genuinely unbounded (no cap/virtualization) and every dialog-level state change still re-runs React's render for every transaction row (Badge, date formatting, fmt/fmtNum calls) — content-visibility only defers browser paint of off-screen DOM, it does not stop the JS render work the it… |
| low | `I332` | 2323 | Zero CSS containment anywhere — every below-fold dashboard/statistics section is fully laid out and painted on | ChatMessageList.tsx / ChatBubble.tsx (the in-conversation message bubbles the finding explicitly names as a Fix target) never received .cv-auto/.cv-auto-row; only React.memo was added there, a different technique that doesn't defer initial layout/paint for long histories. |
| low | `I352` | 2476 | The copy-pasted "corner orb" decorative gradient appears ~10× in three drifting dialects — one motif, no rule, | NetSummaryCard.tsx:97 still has its own raw, un-tokenized corner-orb gradient outside the CardSheen/.card-sheen system, contradicting the 'all 8 orbs replaced' claim. |
| low | `I524` | 4469 | `docs/reference/data-model.md` has hard drift: a dropped MV, a fictional table, a legacy-only table, and stale | docs/reference/data-model.md still has no ### section for db_editor_audit (0059), provider_api_keys (0043), instrument_provider_map + provider_quota (0042), or cashflow_forecast_accuracy/_mc/_mc_rolling (0012/0013/0016), and the currently-live materialized views (mv_monthly_summary, mv_category_tota… |
| low | `I566` | 4875 | Build context is ~1.2 GB of irrelevant files | venv/, .playwright-mcp/, .claude/, .obsidian/, .github/, and TODO.md — all explicitly named in the item's own text as contributing to the ~1.2GB bloat — are still absent from .dockerignore. The bulk of the bloat (packaging/electron/node_modules + dist) is fixed, so this is a real but low-blast-radiu… |
| low | `I659` | 5709 | D7 — NUMERIC(18,4) is the domain money precision (ADR-060 addendum). One alignment | account_statement_balances table does not exist anywhere in migrations or code (only mentioned in TODO.md/ADR prose as still-open Phase C work); the sibling-column widening is done, but the item's explicit second clause about the new side table being created at (18,4) 'from day one' is unfulfilled b… |
| low | `I687` | 6203 | Two stale file-header comments still describe the removed unified-tax feature (ADR-102, confirmed fully remove | apps/frontend/src/lib/api/crossWorkspace.ts:2-3 still describes the removed unified-tax view as a current feature; the item named this file explicitly and it was never touched. |


_Item ids (`I###`) are audit-local, assigned in file order over the 727 ticked items; the `TODO.md` column is the authoritative locator._

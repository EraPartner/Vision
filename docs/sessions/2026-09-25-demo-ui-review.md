---
title: Demo UI review and simplification
type: session
date: 2026-09-25
updated: 2026-09-26
tags: [session, frontend, accessibility, demo, verification]
description: Computer-use coverage, implemented UI corrections, and remaining acceptance work from the synthetic Demo walkthrough.
---

# Demo UI review and simplification

## Implemented

- Dashboard reminders start compact and expand to show payments in due-date order. Dismiss buttons identify the payment and have larger targets.
- Forecast starts with actual data and one working method, preferring the ensemble. Comparison methods remain available in a keyboard-accessible disclosure. Method and rolling-window controls announce selection.
- Dashboard summary labels say “Latest month”, matching the newest month in the data and its transaction links.
- Transaction detail pencil controls identify their field and have hover/focus tooltips. Empty editable fields, including comments, remain editable.
- Cash-account group subtotals exclude investment holdings, matching the displayed cash balances. Portfolio subtotals retain holdings.
- Initial transaction and recipient loading no longer renders a false empty result. First table rows bypass deferred rendering; recipient sorting retains existing rows.
- Investment transaction history reserves its virtual content height before rows mount, fixing an empty Transactions tab despite a nonzero count.
- Rolling forecast buttons use a static, interpolated translation key for 30, 60, 90, and 180 days in English and Dutch.
- Native desktop bootstrap provisions the restricted Analysis executor; the backend grants approved views after migrations. This fixes the native role/password provisioning gap without giving the migration owner role-administration privileges.

## Computer-use coverage

All interaction used the native **Vision Demo** app and its synthetic dataset. This is a bounded walkthrough, not exhaustive action or accessibility certification.

| Surface          | Actions observed before rebuilding                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard        | Inspected full accessibility tree and visual layout; traced latest-month links and reminder ordering                                                                                 |
| Transactions     | Opened creation dialog; submitted empty form and observed required-field errors; cancelled; searched Netflix (30 results); opened details; entered and cancelled description editing |
| Accounts         | Inspected group totals; opened checking account and ledger; opened reconciliation and cancelled                                                                                      |
| Categories       | Created `DEMO UI REVIEW`, saved description `Synthetic category for UI review`, then deactivated it; all three operations showed success                                             |
| Recipients       | Opened list and creation dialog; cancelled; observed initial false empty state                                                                                                       |
| Statistics       | Opened overview and Categories tab; inspected pivot controls and transaction drill-down links                                                                                        |
| Planned payments | Inspected due strip/list; opened Netflix edit form and cancelled                                                                                                                     |
| Who Owes You     | Opened Sarah Maes details; opened Record payment and cancelled                                                                                                                       |
| Tax overview     | Switched 2026 to 2025; verified year-specific URL and estimated-profile notice                                                                                                       |
| Import / Export  | Opened export-filter disclosure; inspected import disabled state without a file                                                                                                      |
| Portfolio        | Opened overview and Stocks & ETFs; opened ASML details and Transactions tab; closed dialog                                                                                           |

The synthetic category remains inactive in Demo for traceability. No production data was used.

### Resumed walkthrough, September 25–26

- Rebuilt Demo confirmed compact reminders, due-date expansion, latest-month labels, one forecast by default, comparison disclosure and method selection. Accounts cash subtotal is now €68,085.47, matching its displayed balances.
- Transaction details expose field-specific edit labels and focus tooltips. Added `Demo UI verification` to an empty Netflix comment, saved, then cleared and saved again; both operations succeeded and restored the original blank value.
- Net Worth: selected one month; chart changed to 31 days. Its Daily Breakdown intentionally retains independent full-history pagination. A €0.02 account/headline difference is explicitly reported; code uses different rounding aggregation paths, so this alone is not a confirmed valuation bug.
- Crypto: opened transaction form, submitted empty form, observed amount validation, cancelled. Inspected Metals and Savings & Bonds. Property Transactions (2) remained blank after scrolling; this reproduced the investment-history bug fixed above.
- Performance: selected one month and enabled FX-neutral series. Rebalance: computed a synthetic preview successfully; no trade is executed by this view.
- Research: opened Microsoft lookup and Analyst Ratings; selected Microsoft in Compare using keyboard search; inspected Chart Builder; changed Forecast from Parametric to Bootstrap and observed updated projection.
- Analysis: default Category spending template failed with executor authentication. This led to the bootstrap fix above. Monitors: empty submission focused the required Title field. AI chat reports its local model unreachable, so model-dependent actions were not tested.
- Settings: inspected General and Appearance, including high-contrast and colorblind-safe options, without changing preferences.
- CSV export saved successfully through the native save dialog. `/private/tmp/vision-demo-ui-export-20260926.csv.csv` contains 1,051 data rows, 10 columns, and consistent row widths. The doubled extension came from entering a full filename into the native basename field during testing.

## Rebuilt Demo acceptance

The user's September 26 rebuild passed all three pending live checks through computer use:

- Analysis: running the default Category spending template returned result rows without the previous executor authentication error.
- Dashboard: rolling-window buttons display 30, 60, 90, and 180 days. Selecting 30 days updates the selected state, description, URL, and chart (61 categories).
- Real Estate: Appartement Gent's Transactions (2) tab displays both APPRECIATION and BUY rows in the accessibility tree and screenshot.

Remaining broader coverage includes long investment-history scrolling, responsive layouts, full keyboard traversal, file import, research watchlist/dossier mutations, and less-used settings. Destructive workflows and model-dependent actions were not exercised. This work does not establish that every possible action is bug-free.

## Verification

- 22 Accounts integration tests passed.
- 25 transaction-detail tests passed.
- 5 reminder/forecast tests passed.
- 108 shared-table, Recipients, and Transactions tests passed.
- Frontend lint passed with 44 existing warnings; targeted lint passed for changed files.
- Final frontend typecheck and locale validation passed after all implementation changes.
- `install-demo.sh` stopped during dependency installation with `EPERM`, before app replacement.
- Standard production build also failed with `EPERM` replacing existing `dist/assets`, including an escalated retry. Production Vite build passed with fresh output at `/private/tmp/vision-ui-review-20260925-dist`.

- Native packaging with existing dependencies and the verified temporary frontend also failed: the built `vision-alembic` executable could not initialize its sync semaphore (`semctl: Operation not permitted`). The installed Demo app was not replaced.
- Changed documentation has required frontmatter and valid new note links; Reading View and Dataview rendering were not verified. The initial UI changes did not need architecture changes; the later native Analysis fix also updated runtime documentation, the system architecture diagram, and the flow visualizer.
- No Git index, commit, signing, or publication operations were performed.

### September 26 checks

- 20 forecast/investment-detail tests passed, including rolling-window labels/selection and the initially empty virtualizer regression.
- 53 native runtime fixture tests and 4 backend Analysis bootstrap tests passed. These mock PostgreSQL calls; the rebuilt Demo's successful default Analysis query subsequently verified the live execution path.
- Frontend typecheck passed. Frontend lint passed with 44 existing warnings; backend lint passed with 3 existing warnings.
- Locale validation passed for 3,803 keys per language. Fresh-output production Vite build passed at `/private/tmp/vision-ui-review-20260926-dist`.
- Standard frontend test wrapper stopped in its prerequisite build with `EPERM` replacing `dist/assets`, including an escalated retry; focused Vitest tests were run directly instead.
- Demo installer again stopped in dependency installation with `EPERM`. Isolated native smoke could not bind loopback (`listen EPERM`). The user rebuilt successfully; packaged runtime acceptance passed through the live checks above.
- Independent frontend and native bootstrap reviews found no blocking defects. Forecast fallback help was adjusted to say one forecast is shown by default, covering the unavailable-ensemble case.

## Recovery

### September 26 screenshot follow-up

The user clarified that AI investigation and portfolio exposure needed succinct visual explanations,
not merely collapsed text. The AI panel now uses three icon summaries for the selected model,
research access, and local retention, with contextual privacy details. Exposure now shows a
segmented coverage graphic, concise definitions, aligned holding breakdowns, and source/import
details. English and Dutch copy and the two feature documents were synchronized.

- Ten focused tests passed across privacy summaries, AI status, and exposure. A duplicate detail
  paragraph caught by a test was removed; the affected two-test suite then passed.
- Frontend typecheck, locale validation (3,832 keys per language), and frontend lint passed
  (44 existing warnings). The final production build passed with fresh temporary output.
- Independent review corrected misleading automatic-lookup wording for selected-evidence synthesis
  and avoided assuming the configured model runs on the same device.
- The installer remained blocked by dependency-installation EPERM; the user rebuilt Demo.
  Live screenshots verified both redesigned pages. Research-mode explanation updates, selected
  privacy help, exposure sector selection, holding contributions, and source disclosure passed.
  The view was restored to issuer grouping with details closed.
- Model-dependent execution and cloud transmission were not exercised. No architecture or data
  flow changed, so no additional diagrams were needed.

The three pending rebuilt-Demo checks are complete. Preserve the existing synthetic database; do not reset it to work around startup problems.

### September 26 less-used workflows

- Research dossier: created a clearly labelled synthetic dossier with evidence and an Apple
  investment link, saved a second version, and restored version 1 as version 3. The restored
  content and retained history matched expectations. Required-title validation worked.
- Watchlist: added synthetic NVIDIA target 100 USD, inspected 1-month, 1-year, and 6-month
  charts, and changed the target to 105 and then 110. The list refreshed, but the open chart
  retained the old target. Selection now uses the item ID and derives refreshed query data.
- Analysis: monthly cash flow ran, but Save exposed a raw schema error because runtime sorting
  uses `id` while stored definitions require `outputId`. Save, refresh, and reopen now convert
  explicitly at that boundary. The same run exposed DATE values shifting to the previous day
  in Helsinki. A query-scoped PostgreSQL parser now preserves calendar-date strings while
  retaining existing timestamp and numeric handling.
- Dossier monitor: creation, baseline observation, manual unchanged check, and disabling worked.
  The synthetic evidence monitor remains disabled. No dossier or watchlist data was deleted.
- Export: selected one bank account and saved newline-delimited JSON through the native dialog.
  The temporary export contains 39 valid objects and exactly one distinct account.
- Minor copy issue observed in the import reference: literal Markdown around Custom. This is
  not yet corrected. File import, further market paths, and full keyboard traversal remain open.

The three fixes passed 38 focused tests (15 watchlist, 6 saved-analysis service, 5 Analysis page,
and 12 executor tests under Europe/Helsinki), targeted lint, frontend typecheck, and frontend
lint with 44 existing warnings. A fresh-output production build passed at
`/private/tmp/vision-less-used-20260926-dist`. Feature documentation was synchronized; these fixes
restore existing contracts and require no new API operations or architecture diagrams.

Live acceptance of these three fixes is pending the next user rebuild. Verify a sorted monthly
analysis saves, reopens and runs with `YYYY-MM-DD` dates; then change a watchlist target while its
chart remains open and confirm both the target and distance update.

## September 26: complete route audit in progress

The user expanded the task to every route, with implementation of concrete UI improvements.
Current native Demo remains the pre-change build. All new fixes require live acceptance after rebuild.

Walked in this pass:

- Import custom-parser setup; all seven Settings sections.
- Statistics: Overview, Categories, Recipients, Yearly, Flow, and Custom tabs. Created synthetic
  `DEMO UI review — category chart` and verified save. Categories charts were scrolled into view.
- Owes person detail/payment form, Tax five profile steps, Planned timeline/table/history and
  unsaved recurring/loan forms, Categories merge/add previews, Recipients patterns/merge previews.
- Accounts list/detail/reconcile/close previews; Analysis visual builder and advanced controls.
- Portfolio overview, Stocks detail and all 29 history rows, Crypto entry form, Metals,
  Real Estate, Savings, Performance period switch, Net Worth, Rebalance calculation,
  Portfolio Tax adjustment preview, and Portfolio Import initial state.
- Research Home, Markets region/sector filters, Market Lookup fundamentals/analyst/news,
  and provider-mapping preview. Compare exploration is next.

Remaining: Research Compare/Charts/Forecast/Watchlist/Dossiers, AI, monitors, dashboard and
transactions revisit; two dynamic import review routes; six admin routes (temporary Admin Mode
confirmation pending); NotFound cannot be reached through an ordinary navigation link.

Implemented with focused tests so far: import required-label/copy polish; named statistics settings
checkboxes; compact expandable insights; accessible custom-chart forms/actions/plurals;
contextual recipient row actions; workspace preservation on global routes; localized analysis
field/operator controls; honest performance scope/allocation labels; compact rebalance explanation;
and file-first portfolio import with optional columns. Market chart overlapping date labels are
being fixed. Full batch gates, docs synchronization, and rebuilt visual verification remain open.

## Related

- [[docs/index]]
- [[docs/features/views]]
- [[docs/features/cash-flow-forecast]]
- [[docs/features/accounts]]

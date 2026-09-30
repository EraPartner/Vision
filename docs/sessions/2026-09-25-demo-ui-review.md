---
title: Demo UI review and simplification
type: session
date: 2026-09-25
updated: 2026-09-30
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

## September 27 continuation checkpoint

- Demo hit a startup/shutdown race, then opened normally after PostgreSQL completed shutdown.
  This session did not reset its data.
- All 33 ordinary routes excluding import review have been reached across the audit. Compare
  sorting, research chart save, forecast validation, AI unavailable states, dashboard and
  transaction creation/detail/split previews were exercised.
- Rebuilt UI checks passed for compact Insights, file-first portfolio import and keyboard
  disclosure, workspace preservation, dossier collapsed groups and category search.
- Monthly analysis now returns calendar dates, saves and refreshes successfully. Created
  `DEMO UI review — monthly cash flow`. Current dossier list was empty; checked an unsaved draft.
- User requested skipping uploads. Two import-review routes remain untested live; their 35
  integration tests passed. Six admin routes await temporary Admin Mode approval. NotFound
  remains unvisited in native navigation.
- Fixed an unsupported test query option and added context to CSV type-mapping dropdown labels.
  Four feature docs were synchronized. No Git publication was performed by this session.
- Typecheck, locale validation, production build and lint passed (44 existing lint warnings).
  Settings/dossier tests: 2 passed; mapper: 6 passed; import reviews: 35 passed. Scoped lint passed.
  Build output: `/private/tmp/vision-ui-audit-20260927-dist`. Build preceded the final label-only
  mapper edit; its focused tests and lint passed. That label still needs rebuilt verification.

Remaining visual acceptance: market ticks, research chart controls, performance scope and
rebalancing disclosures. Full-route completion also depends on the pending admin decision.

## September 27 action-level pass

Route visits are not action-complete reviews. The following ledger separates inspected paths
from remaining interactions. Mutating financial actions and destructive confirmations have not
been executed merely for coverage. Uploads remain excluded at the user's request.

| Routes                                           | Inspected actions                                                                                     | Remaining coverage                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/`                                              | Reminders, charts, recent rows, account links                                                         | Widget controls, chart drilldowns                  |
| `/transactions`                                  | Add validation/cancel, details, custom split preview, filters/export earlier                          | Bulk actions, row keyboard traversal, tag changes  |
| `/categories`                                    | Tree, add and merge previews                                                                          | Child edit, restricted delete previews             |
| `/accounts`, `/accounts/:id`                     | Add/advanced, reconcile, opening balance, merge target preview, brokerage lot transfer, close preview | Closed visibility, reopen, pagination              |
| `/analysis`                                      | Templates, run, calendar dates, save/reopen/refresh, advanced controls                                | SQL errors, transforms, version history/export     |
| `/analysis/monitors`                             | Both type menus, prior dossier lifecycle, required-field focus                                        | Threshold creation, observations/inbox with data   |
| `/recipients`                                    | Patterns/preview, merge preview, table sort                                                           | Inline cancel, unmerge preview                     |
| `/planned`                                       | Recurrence/loan forms, history, execute/link no-match preview                                         | Detected suggestions, matched-link preview         |
| `/statistics`                                    | Six tabs, custom chart save, Insights toggle                                                          | Chart edit/delete preview, exports/widgets         |
| `/import`                                        | Custom parser and export                                                                              | Saved parser actions; uploads excluded             |
| `/import/:batchId/review`                        | Automated tests                                                                                       | Live skipped: uploads excluded                     |
| `/owes`                                          | Recipient, payment form, recent empty state                                                           | Settlement/deletion confirmations only             |
| `/tax`                                           | Five profile steps, deductions                                                                        | Pension variants, exports/widgets                  |
| `/portfolio`                                     | Exposure dimensions/disclosures, summary                                                              | Broker/currency filters, archive list              |
| `/portfolio/stocks`                              | Details, history, trade edit/cancel, investment edit/cancel, delete preview                           | Archive/restore, alternative trade types           |
| `/portfolio/crypto`, `/portfolio/metals`         | Lists and crypto trade form                                                                           | Asset-specific add/edit details                    |
| `/portfolio/real-estate`, `/portfolio/savings`   | Lists                                                                                                 | Valuation/interest forms and history               |
| `/portfolio/performance`, `/portfolio/net-worth` | Periods, summaries/history                                                                            | Remaining ranges and visual acceptance             |
| `/portfolio/import`                              | File-first screen, format keyboard disclosure                                                         | Saved parser; uploads excluded                     |
| `/portfolio/import/:batchId/review`              | Automated tests                                                                                       | Live skipped: uploads excluded                     |
| `/portfolio/tax`                                 | Manual adjustment preview                                                                             | Year/export/edit/delete preview                    |
| `/portfolio/rebalance`                           | Calculate, reserve, methodology                                                                       | Invalid allocation totals                          |
| `/research`, `/research/markets`                 | Search links, region/sector filters                                                                   | Remaining sorts and empty filters                  |
| `/research/market`                               | Tabs, provider mapping preview                                                                        | Remaining chart ranges and tick verification       |
| `/research/watchlist`                            | Add and target editing earlier                                                                        | Rebuilt target refresh acceptance                  |
| `/research/compare`                              | Two symbols, both tabs, metric sorting                                                                | Remove/max symbols/provider choices                |
| `/research/forecast`                             | Model switch, invalid scenario                                                                        | Valid scenario comparison, horizon/target controls |
| `/research/charts`                               | Save/load, MACD, price/volume, SMA preset, period minimum clamp                                       | Other chart/provider choices, dirty-layout preview |
| `/research/dossiers`                             | Prior versions/restore; rebuilt searchable links                                                      | Unsaved-change/delete previews                     |
| `/ai-chat`                                       | Route/privacy controls, disclosure empty state                                                        | Model execution unavailable; uploads excluded      |
| Six `/admin` routes                              | Source review only                                                                                    | Temporary Admin Mode consent pending               |

New confirmed fixes in progress: Owes label/help associations and contextual action tooltips;
Planned contextual tooltips/status semantics; investment-history action context; keyboard-editable
database cells; simpler monitor empty-state and scheduling presentation. Database UI changes are
source/test verified only until Admin Mode is authorized. Shared shell, Settings, onboarding and
NotFound are tracked separately; prior Settings visits do not prove every setting was exercised.

### Further action coverage and findings

- Portfolio exposure: issuer, sector and country views; direct/fund breakdown and source disclosure.
  Widget chooser inspected without changing preferences.
- Portfolio tax: year action menu and manual adjustments. Optional treatment explanations now
  collapse per investment; field names identify the investment. Hidden invalid fields reopen.
- Categories: child edit validation, merge and restricted/delete confirmation previews. Cancellation
  lost keyboard focus; opener restoration and contextual active-state controls are now implemented.
- Recipients: inline edit/cancel and both merge selection steps. Editors now have contextual names,
  initial focus and cancellation focus restoration. Shared table date editors receive the same care.
- Transactions: bulk tag chooser and empty search, cancellation, CSV export. A one-row synthetic
  CSV was saved to Downloads (193 bytes, header plus one record). Row actions now identify their
  transaction rather than repeating generic names.
- Analysis: reopening saved monthly cash flow exposed blank chart bindings. Missing/stale bindings
  now choose valid axes, valid saved bindings restore, and selectors have labels. First-version
  history previously appeared inert; loading, empty and error feedback are now explicit.
- Compare: AAPL/MSFT, performance and fundamentals, metric sorting and symbol removal.
- Watchlist: Tesla target changed 180 to 181 and restored to 180. Card and open dialog refreshed
  immediately both times. Target editing and row actions now have contextual accessible names.
- Statistics: created `DEMO UI audit — categories`, verified preview/save/reopen, cancelled edit
  and delete confirmation. Add/edit/delete cancellation now restores its opener; successful
  deletion falls back to New chart.
- Planned: expanded recurring suggestions and opened the Netflix suggested match. Selecting its
  transaction enabled Link & Execute and showed the paid date; cancelled without executing.
- Property/savings: confirmed amount-only buy/sell forms incorrectly required hidden units/price.
  Unit validation now applies only to unit-based investments. Appreciation explicitly asks for the
  increase in value, not the property's total value.
- Forecast: valid income-interruption comparison, model controls and blended return. Slider now
  has a name and announces both proportions; selected horizon/simulation choices expose state.
- Market Lookup: one-day range had no provider data; five-day chart rendered with readable
  compact ticks. Native chart was scrolled into view.

All 21 changed test files passed together (263 tests), along with full frontend lint (zero errors,
44 existing warnings), typecheck and locale validation. Independent review found an additional
no-cached-result chart-binding case; preserving axes and guarding delayed history responses added
two regressions. The final Analysis suite (12 tests), typecheck and locale validation passed again.
The first installer invocation lacked dependencies in system Python; using the existing
`.venv-native-build` succeeded. A duplicate Watchlist tooltip import caught by typecheck was
removed before the successful gates. Documentation and diff whitespace checks passed.

The first rebuilt Demo installed successfully and its backend returned healthy. Computer use
then repeatedly timed out reading the replacement window, including after a fresh connection.
The final build including the last Analysis correction also installed successfully. Its installer
waited for the running app to quit; a subsequent fresh computer-use connection still timed out.
The user was asked to unlock the Mac if needed and bring Demo forward. Live acceptance of this
increment remains pending at that concrete computer-use blocker. Admin and upload exclusions
above still apply; this ledger does not claim every possible action combination was executed.

### September 27 resumed live acceptance

The user identified a pending macOS keychain prompt as the startup interruption and completed it.
Computer use then connected normally. No credential was handled by the agent.

Verified in rebuilt Demo:

- Saved monthly analysis renders its chart with named category/value axes; first-version history
  explicitly reports no earlier versions.
- Monitor setup shows the concise empty state. With an eligible count analysis selected, an
  invalid interval inside collapsed Schedule reopens the section and receives native focus.
- Tax adjustments show investment-specific field names and collapsed treatment groups. An invalid
  101% interest portion reopens its group and receives focus; cancelled without saving.
- Recipient inline editing focuses the named first field; Cancel returns to its exact Edit button.
  Category Edit cancellation also restores its opener.
- Transactions expose date/recipient/amount in action names and active state; entering inline
  editing focuses the named date picker. Planned and Owes action names include their payment/split.
- Property Appreciation explicitly labels the increase in value; non-unit Buy has no units helper.
- Forecast slider keyboard adjustment announces 45% historical / 55% forward-looking; horizon
  and simulation selections expose pressed state.
- Custom chart Edit cancellation returns to the correct chart button.
- Metals manual-provider and no-initial-buy drafts work. Bond interest/maturity form inspected;
  typing a maturity date was interrupted by the installer, so that action is not counted as passed.

Two additional backend defects were reproduced/investigated and fixed:

1. Count-only analysis emitted an empty GROUP BY and failed near LIMIT. The compiler now omits
   grouping for whole-dataset aggregates. 24 focused backend tests and scoped lint passed. Live
   final-build count query returned 1051; saved/refreshed `DEMO UI audit — transaction count` for
   monitor validation. No monitor was created.
2. Broker snapshot validation compared values rounded at different aggregation levels and rejected
   a two-cent difference during Demo startup. An internal opt-in raw-value parity check now
   validates conservation before rounding, while preserving public response shape, displayed
   totals and stored account values. Genuine discrepancies still fail before snapshot replacement.
   68 focused tests, backend typecheck and full backend lint passed (37 existing warnings).
   Independent review found no blocking issue. Final rebuilt Demo startup successfully warmed
   portfolio-performance, portfolio-summary and net-worth caches with 2971 snapshots.

Both fixes received documentation updates. Final native Demo build/install, frontend typecheck,
backend lint and whitespace checks passed. No Git publication, file upload, destructive final
confirmation, real financial operation or manual database mutation was performed. The earlier
admin consent and upload exclusions remain; the action matrix records unexercised branches.

## Related

- [[docs/index]]
- [[docs/features/views]]
- [[docs/features/cash-flow-forecast]]
- [[docs/features/accounts]]

## September 27 clarity and consistency pass

The next design pass addresses competing page priorities while retaining the existing visual style.

- AI Chat now separates Chat and Investigation into URL-backed tabs. Hidden panels remain mounted, so switching modes retains drafts and investigation state. Only Chat shows the conversation rail. A visibility-aware transcript scroll effect restores the newest messages when appropriate without moving readers who deliberately scrolled up.
- Statistics places its tabs directly below the header; monthly rhythm, insights, and forecast belong to Overview. Custom Charts and the other sections open directly onto their own content.
- Forecast keeps horizon, contribution, and target visible. Return source, blend, method, and simulation count sit under Forecast assumptions with an always-visible current summary. Collapse preserves inputs and recalculation behavior.
- Independent review found the hidden-transcript scroll regression; the fix and regression coverage landed before the native rebuild.
- Focused checks: AI page 22, transcript scrolling 6, Statistics 25, Forecast 3 tests passed (56 total). Frontend typecheck, full frontend lint (44 existing warnings, zero errors), locale validation, and diff whitespace checks passed. Feature documentation synchronized. Native build and live acceptance are recorded below after completion.

Live acceptance on the rebuilt native Demo: Chat/Investigation tabs and keyboard switching worked; the synthetic investigation question survived switching modes and was cleared afterward. The investigation occupies its own scrollable panel. Statistics Custom Charts renders directly below the tabs with no Overview summary. Forecast starts with collapsed assumptions, expands to its controls, and changing simulations from 1,000 to 500 updates the visible summary and projection; collapsing preserves the 500 setting. Native rebuild/install and backend health passed. Live AI generation remains unavailable because Ollama is offline; draft and scroll lifecycle behavior is covered by focused tests. Uploads and administrator paths remain excluded as previously recorded.

## September 27 full route consistency review

Source review covered all 41 registered routes: 14 Budgeting/shared routes, 12 Portfolio routes, nine Research routes, and six administrator routes. It included Settings, dialogs, empty states, loading/error feedback, and shared navigation. The two import-review routes and six administrator routes remain source/test reviewed only; file uploads were explicitly skipped and Admin Mode was not enabled. Existing native walkthrough evidence above covers the ordinary routes and selected actions, not every possible state or destructive action.

Implemented in this pass:

- Collapsed navigation offers an explicit workspace menu; expanded choices expose selection and keyboard focus.
- Transactions, Recipients, Categories, and Planned Payments use stable, labeled Include inactive switches. Recipients also uses an Uncategorized only switch.
- Analysis closes its template chooser after selection and provides a way to reopen it without losing the draft. Name and source fields have labels, and editor modes expose selection.
- Chart Builder puts series entry first and groups secondary chart options and layout actions. Active scale settings remain visible when options are collapsed.
- Portfolio summary precedes exposure detail. Savings and Real Estate add dialogs offer the appropriate asset types in populated as well as empty states.
- Research search distinguishes no matches from provider failure and hides stale query results during debounce.
- Decimal precision previews follow the selected number format. Import match badges use descriptive, localized labels.

The review found no need to restructure the existing account, dashboard, owes, transaction-import, shared asset-list, performance, net-worth, rebalance, monitor, research-home, markets, watchlist, or dossier workflows in this pass. Portfolio Tax and Life Scenario still merit a separate information-hierarchy pass; their calculations and decision controls were preserved here.

Validation: the earlier seven-file focused run passed 215 tests. The final navigation, import-review, and Chart Builder run passed 39 tests; A further 22 Market Lookup and shareable-URL tests passed. Frontend typecheck and locale validation passed. Full frontend lint passed with 34 warnings and zero errors. Feature guides were synchronized. No architecture, endpoint, schema, or workflow boundary changed, so PlantUML and the flow visualizer did not need edits. Native acceptance follows below.

Native acceptance on the rebuilt Demo passed: backend health; explicit collapsed workspace choices; Chart Builder series-first ordering and disclosure controls; Analysis template selection collapsing to Choose a template; recipient Include inactive on/off state and URL update (restored afterward); portfolio summary before exposure; populated Savings offering only Savings Account/Bond; populated Real Estate opening the property form; and General settings showing European decimal examples. Entry dialogs were dismissed without creating records. The Demo was left on Portfolio Overview. No uploads, administrator activation, or destructive actions were performed. The final portfolio screenshot was distorted by the capture surface, so portfolio ordering is confirmed by the native accessibility tree rather than that image. Documentation frontmatter and diff whitespace checks passed; Obsidian Reading View was not inspected.

## September 27 task-focused follow-up

The user approved the deeper pass on Analysis, Chart Builder, Portfolio Tax, and Life Scenario. Analysis now explains columns, totals/counts, explicit grouping, and rerunning after edits. Chart Builder explains the first comparison steps, moves economic-provider detail behind an expandable label, explains optional overlays, and clarifies assigned axes. Life Scenario groups the monthly financial inputs separately from naming and optional goals; Compare is primary and first, Save secondary, and result guidance explains median projections. Portfolio Tax removes duplicate header totals, uses three main cost cards plus quieter supporting metrics, and groups profile/budget inputs with estimates under a separate heading. Existing calculation caveats and widget identifiers remain intact.

Independent source review caught and corrected two misleading Analysis explanations (automatic grouping and SQL drill-through) and a colour explanation that did not apply to candlesticks. The four focused suites passed 123 tests; the final Life Scenario rerun passed two tests after regrouping inputs. Locale validation and full frontend lint passed (34 warnings, zero errors). Feature documentation was synchronized. Architecture, APIs and data flow did not change, so diagrams and the flow visualizer were not edited. Native rebuild and live acceptance are recorded below.

Final verification: typecheck, locale validation, documentation frontmatter and whitespace checks passed. Demo rebuilt and installed successfully; its persisted port 36962 returned healthy. Native accessibility checks confirmed the new Analysis guidance, Portfolio Tax cost/estimate sections and three main cards, Life Scenario grouped fields and Compare-before-Save action order, and Chart Builder start/overlay/axis guidance with collapsed economic-data details. A usable Life Scenario screenshot confirmed the input grouping. ScreenCaptureKit intermittently failed or returned stale/tiny images despite successful navigation; full visual acceptance of every changed surface is therefore limited. No records or preferences were saved during this acceptance pass. Obsidian Reading View was not inspected.

Additional observation for a separate follow-up: Forecast's five-year chart can crowd full-date x-axis labels at the inspected window size. This belongs to chart tick-density handling and was not changed as part of the four workflow edits.

## September 27 seven-area consistency pass

The user approved all seven improvement areas. Concrete coverage:

| Area                        | Implemented change                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charts and figures          | Shared bottom-axis label thinning based on formatted text width; short month/year Forecast labels with full dates retained in tooltips. No plotted points removed.                                                                 |
| Saved and outdated state    | Chart Builder persistent local-save status, including write failures; Analysis query-change warning until a successful matching rerun; Settings automatic-apply explanation.                                                       |
| Terminology                 | Include paused matches Planned Payments row status; Clear selection distinguishes row selection from filtering.                                                                                                                    |
| Tables and row actions      | Bulk tagging explains why all-matching selection cannot be tagged and how to proceed.                                                                                                                                              |
| Forms and validation        | Whitespace-only recipient/category fields receive linked inline errors and focus, with entered data retained and validation reset for fresh forms. Invalid watchlist targets no longer produce plausible price comparisons.        |
| Loading, empty, unavailable | Failed debt, recipient-detail and watchlist requests have retry feedback rather than claiming empty/settled state; Categories gains retry. Cached debt-detail/watchlist rows remain with a failure message after failed refreshes. |
| Help and tooltips           | Recipient pattern preview has visible action text, discoverable by keyboard and pointer without relying on a native title. Bulk tagging guidance remains visible even though its action is disabled.                               |

Independent review caught validation state persisting across fresh form openings; corrected before rebuilding. Regression coverage includes stale results through failed/successful reruns, watchlist retry, numeric/time/category tick density, whitespace validation, fresh recipient reopening, local-save failure feedback, and invalid target preview. Existing financial and selection behavior is retained. Feature/component documentation is synchronized; no architecture or API boundary changed, so diagrams and the flow visualizer remain unchanged.

Validation: initial focused run had two Chart Builder tests that assumed every status region was a loading indicator. They now query the named Loading region separately from persistence feedback. Subsequent runs passed: 51 tests across Analysis/Chart Builder/Watchlist/name dialogs; 65 tests across chart axes/Chart Builder/target preview/transactions/settings; 102 tests across shared charts/name dialogs/owes/categories; and three Forecast tests. These runs overlap and are not summed as unique tests. Final typecheck, full frontend lint (34 warnings, zero errors), locale parity/usage/drift validation, documentation frontmatter and whitespace checks passed. Month names follow the app language independently of number formatting. Final native acceptance follows below.

Final Demo rebuild and installation passed. The app started successfully and native accessibility inspection confirmed the new Include paused switch on Planned Payments. Further native inspection was blocked by repeated macOS ScreenCaptureKit error -3812, including after reconnecting and resetting computer use. Remaining visual acceptance, including Forecast label spacing, is therefore unverified in the final package; automated behavior checks passed as listed above. No uploads, administrator activation, record creation, destructive actions, or preference changes were performed during this acceptance pass. Network and storage failures were exercised in tests rather than induced in Demo. Obsidian Reading View was not inspected.

## September 27 recovery and form clarity follow-up

The next source and interaction-test review found concrete recovery gaps rather than a need for another visual redesign. Recipients now offers Retry for initial and next-page failures, retaining loaded rows and the failed offset. Monitor rules, target lists, observations and inbox offer Retry; errors no longer also claim empty data. Broker transfer waits for destination accounts and gives retry feedback for either account or lot-preview failure, preserving the explicit Unassigned option after successful loading.

Life Scenario restores saved amounts using the selected number format and can retry saved-definition loading without losing the draft or enabling Save prematurely. Add/Edit investment reject malformed numeric text with linked inline errors and focus before mutation, preserving optional zero values. Initial purchase guidance now accurately asks for total cost and units, with a calculated price; hidden asset/provider numeric fields are omitted rather than silently submitted.

Independent source reviews found no remaining concrete regressions in these changes. Seven focused suites passed 74 tests; final typecheck and full frontend lint passed (34 warnings, zero errors). Locale validation, four affected feature-note frontmatter checks, and whitespace checks passed. An initial worker test invocation used the wrong file-filter paths and found no tests; the corrected workspace invocation passed. Feature documentation was synchronized using the documentation and Obsidian Markdown skills. No architecture, API or data-flow boundary changed, so diagrams and the flow visualizer required no changes. Native acceptance and final supplemental tests follow below.

Supplemental Add/Edit investment coverage passed 32 tests, including exact European decimal submission and switching away from an invalid manual price without sending that hidden value. This overlaps the 74-test run above. Final typecheck passed after those test additions. Demo rebuilt and installed successfully, and its persisted port 36962 returned healthy. Native inspection reached Portfolio and Add Stock and confirmed the new total-cost/units guidance and required markers. Screen capture and accessibility observations intermittently failed or lagged actions; inline-error visual acceptance could not be established reliably. A temporary unsaved form draft was entered, with no Add submission, records, transfers, uploads, or administrator actions. Dismissal was attempted, but the lagging native observation did not confirm closure. Failure paths remain verified by interaction tests, not by disrupting Demo services. Obsidian Reading View was not inspected.

## September 27 comparison, draft and export clarity

A further bounded review addressed seven concrete gaps: dossier selection now protects unsaved edits with the shared discard dialog and reselecting the current dossier is a no-op; Market Lookup range is URL-backed; Compare explains its 100-point baseline and displays the actual valid-price date span beside each symbol's metrics; Exposure percentages follow the selected number format; Full Year report input validates instead of silently substituting the current year; financial export shows the effective statistics exclusion counts while portfolio/tax requests no longer claim those unused filters; and Add account opening-balance errors are inline, linked and focused.

Focused checks passed: 23 tests for dossiers/Market Lookup, 32 for export/account entry, and eight for comparison URL/history and exposure formatting. Initial new assertions used uppercase range labels and an en dash that the locale generator normalizes to a hyphen; corrected assertions passed. Full frontend lint passed with 34 warnings and zero errors, locale validation passed, and seven feature/component notes passed required frontmatter checks. An independent static report/account review found no concrete regressions and verified the financial-only exclusion contract in the report service. Documentation is synchronized; no architecture, API operation or calculation boundary changed, so diagrams and the flow visualizer were unchanged. Final native and typecheck results follow below.

Final typecheck, Demo rebuild/install, backend health on persisted port 36962, locale validation and whitespace checks passed. Native accessibility inspection confirmed localized Exposure percentages (including 1,16% and 4,98%) and the report-year error with Download PDF disabled for an invalid year. The report dialog was cancelled and closure confirmed; no report was downloaded and no records, uploads or administrator actions occurred. Native observations still lagged some actions and one capture failed with ScreenCaptureKit -3811, so the other new workflows rely on the passed interaction tests rather than complete visual acceptance. Obsidian Reading View was not inspected.

## September 27 filter and merge clarity

Amount quick filters now accept the configured decimal format and reject every invalid filled bound. Reversed date ranges explain the error and cannot be applied. Combined filter summaries retain each scope, and amount summaries use the configured number format. Account merging requires a successful preview of the selected pair and a new acknowledgement after either account changes; preview failures offer Retry. Category merging shows its full source path and destination summary. Recipient merge failures show recovery feedback instead of false empty results and preserve selections. Recipient pattern previews invalidate stale requests and results when the draft or matching options change, trim text consistently with Save, and announce the current count.

Focused interaction suites passed 43 tests (21 merge, 10 filter, 12 pattern). Typecheck, locale validation, and frontend lint passed (34 existing warnings, zero errors). Feature documentation was updated; API contracts, architecture, diagrams and the flow visualizer are unchanged. Final package and native acceptance results follow.

Final review also reset account acknowledgement when reopening the dialog or returning to a previously selected source; the six account-merge tests passed again, including that regression. Final typecheck and lint passed. Changed product files are `TransactionSearchSuggestions.tsx`, `FilterBanner.tsx`, `MergeAccountDialog.tsx`, `CategoryMergeDialog.tsx`, `MergeRecipientsDialog.tsx`, and `RecipientPatternsDialog.tsx`, with their focused tests and English/Dutch locale sources and generated output.

The first rebuilt package started successfully and returned healthy on persisted port 36962. Native navigation reached Transactions in the accessibility tree, but screenshots continued to show the earlier Dashboard and search-control observations lagged or failed to change. Therefore this pass does not claim visual acceptance of the new filter or merge states. No merges, records, uploads or administrator actions were submitted. Obsidian Reading View was not inspected.

The final Demo rebuild and installation passed after the additional acknowledgement reset. Whitespace checks passed.

## September 27 application-wide scanning hierarchy

The user supplied Net Worth's asymmetric summary as an example of visual competition and wasted space. Shared StatCard now defaults to quiet secondary emphasis with an explicit primary option. Its labels and icons are restrained, and only linked tiles advertise whole-card interaction. PageHeader, CardTitle, Badge and TableHead use a clearer visual scale; resting frame shadows are reduced. Ordinary Dashboard chart panels, Monthly Rhythm and the planned-payment strip omit repeated corner or color decoration. Dashboard Net Summary and Portfolio Total Value remain deliberate primary surfaces, without whole-card hover motion. Net Worth pairs its total with a single compact asset/liability breakdown instead of three stacked large cards. Values, percentages, freshness, disclosures and operations remain available.

Source coverage includes 37 PageHeader consumers, 12 StatCard consumers, 64 Badge consumers and 65 CardTitle consumers. This is shared presentation coverage, not a claim that every route and action was manually retested. Independent source review found no concrete accessibility or functional regressions and identified stale sheen comments, which were corrected. Existing focus, semantic colors, warnings and chart controls remain. The palette, atmosphere and glass material tiers are preserved. ADR-172 and affected component/feature/architecture docs record the new hierarchy; no architectural boundary or flow changed, so diagrams and the flow visualizer are unchanged.

Verification so far: 45 shared/chart/dashboard tests plus nine Net Worth tests passed; typecheck, locale validation and lint passed (34 existing warnings, zero errors). Six documentation frontmatter checks passed; the new ADR is linked from the index and affected notes. Native screenshot before rebuild confirmed the supplied empty-column problem. Final packaged visual results follow.

The first package rebuilt and installed successfully; Demo health returned 200 on port 36962. A native Dashboard screenshot confirmed quiet supporting cards, simpler badges and reduced header ornament. That inspection caught a nonexistent `font-body` utility leaving metric headings serif; it was corrected to the existing `font-sans` utility, including the planned strip and Monthly Rhythm labels. Eleven relevant tests passed again. Native accessibility confirmed Net Worth's three-row definition list and all values, but screenshots lagged navigation and continued to show Dashboard, so the Net Worth spacing was not yet visually accepted. A final package rebuild follows the font correction.


September 30 completion: the final September 27 package rebuild/install succeeded after the font correction. On resume, Demo returned healthy on its persisted port 36962. Native screenshot and accessibility inspection now both confirm Net Worth's compact three-row breakdown beside the primary total, readable body-font labels, restrained icons and the reduced empty column. The screenshot also preserves the exchange-rate freshness warning and account reconciliation notice. No financial records, uploads or administrator actions were submitted.

The resumed checks passed typecheck, frontend lint (34 existing warnings, zero errors), and 112 tests across shared cards, heading contracts, planned payments and portfolio pages. The first broader run exposed one stale investment test expecting a toast; it now checks the linked inline amount error, focus and absence of a create request. All 112 tests passed after that correction. Previous shared/chart/dashboard and locale checks remain recorded above. This is not a fresh manual test of every route, action, theme or viewport. Obsidian Reading View was not inspected.

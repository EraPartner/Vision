# TODO

Vision's live implementation queue. Priority: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low,
⏬ lowest.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- A completed and independently verified item is removed. Git history, tests, and the merged pull
  request are the completion record; this file is not an archive.
- Put evidence or a blocker on an indented `Tracking:` line. Do not put history in the title.
- Every finding has one owner-sized outcome. A dependency may be named, but unrelated work must be
  a separate item.
- `🔎 verified-present YYYY-MM-DD` means the issue was reproduced on that date.
- `🔎 partial YYYY-MM-DD` means only the stated remainder is open.
- `🔎 decision-needed YYYY-MM-DD` means implementation waits for a product or data decision.
- `🔎 runtime-unverified YYYY-MM-DD` means source work is complete but a live environment check is
  still required.
- `🔎 needs-GitHub-check YYYY-MM-DD` means the current platform state must be read from GitHub.

Run `bun run todo:list` for the concise queue and `bun run todo:check` for ledger hygiene.

## Continuation checkpoint — 2026-09-05

This is the current hand-off point after the complete TODO normalization audit. Do not repeat a
repository-wide audit before selecting work. The queue contains **84 open records and no checked
records**. The records are intentionally independent and fall into these states:

- **38 verified-present**: source work is still required; revalidate the named evidence, then
  implement one item at a time.
- **4 partial**: only the exact remainder in the `Tracking:` line is open; do not redo the part
  already described as complete.
- **15 blocked**: record the stated product, data, or policy decision before writing code.
- **26 runtime-unverified**: source work is complete or substantially complete; perform only the
  named live database, Demo, browser, Electron, or external acceptance check.
- **1 platform-check**: inspect the named GitHub state before changing repository code.

Continue as follows:

1. Run `bun run todo:list -- --state verified` and choose one item by priority and subsystem.
2. Read its `Tracking:` line and source evidence. If it is `decision-needed`, stop and record the
   decision before implementation. If it is `runtime-unverified`, perform the named acceptance
   instead of reopening the implementation audit.
3. Keep one owner-sized outcome per change. Run the focused tests, `bun run todo:check`, and the
   relevant typecheck/lint before removing the item from this file.
4. Remove an item only after its complete stated scope is implemented and independently verified.
   Leave it here when a required external check is unavailable, with the exact blocker on
   `Tracking:`.

Important current hand-off facts:

- Account funding-graph locking, its source-side tests, and the related documentation are already
  implemented in the working tree. The remaining record is the real-PostgreSQL concurrency run;
  the suite covers **PATCH/PATCH, PATCH/merge, and DELETE/PATCH**.
- Portfolio per-broker history is deliberately last. Do not start it before the current-point
  broker surfaces have shipped and soaked.
- The queue includes Demo, real-export, live-database, and GitHub acceptance obligations. These are
  not reopened implementation defects; complete the named acceptance or leave the record open.
- No publication was performed. Inspect the working-tree diff and preserve unrelated changes
  before making the next implementation change.

## Binding constraints

- Keep the rich aurora, glass, jewel-accent, and hover design direction from ADR-105. Visual work
  refines that system; it does not flatten it into generic defaults.
- Use the Vision Demo app with synthetic data for browser and visual acceptance. Never use the real
  financial stack for UI testing.
- Database migrations require a downgrade path and disposable-database proof. Never apply a
  destructive migration or live-data cleanup without the user's explicit approval.
- Portfolio account work follows ADR-108: whole-lot broker tagging, global tax and cost-basis truth,
  and no synthetic trade cash legs.
- Per-broker history stays last. Do not start it before the current-point broker surfaces have
  shipped and soaked.

## Findings

### 🔒 Security and access control

- [ ] **Move existing Electron installations from the bootstrap PostgreSQL superuser to a least-privilege runtime role** 🔼
  - Tracking: 🔎 partial 2026-09-05 (new and opt-in installations split migration and runtime roles; existing Electron installations retain the bootstrap-superuser URL)
  - ↪ _from: Codebase audit 2026-06-30 · backend security_
  - Keep schema migration credentials separate. Prove upgrade, rollback, startup, backup, restore,
    and admin-editor behavior on a disposable existing-install fixture.

### 💶 Financial and data correctness

- [ ] **Define how income-only unassigned portfolio rows affect `fullyAssigned` and the By Account display** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (a null-account dividend can create an Unassigned income-only row while the instrument reports `fullyAssigned: true`)
  - ↪ _from: WP-C4 partitioned-engine adversarial review 2026-08-10_
  - Choose whether income attribution participates in assignment completeness or is displayed as a
    separate non-position row. Pin totals and the UI contract with tests.

- [ ] **Expose missing historical-FX fallback metadata in recipient pivot results** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (choose the API field and user-visible warning shape)
  - ↪ _from: System-recipient and merge-preview adversarial review 2026-08-02_
  - The current identity fallback can add an unrated amount as if it already used the target
    currency. Preserve totals compatibility while making incomplete conversion visible.

- [ ] **Compute cash-forecast P10 and P90 from cumulative simulated paths** ⏫
  - Tracking: 🔎 verified-present 2026-09-05 (the insight sums per-day marginal quantiles, which are not quantiles of the cumulative path)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Treat this as a financial-correctness change. Add deterministic fixtures for both Monte Carlo
    methods and verify the final cumulative distribution directly.

- [ ] **Decide and fix ambiguous locale money parsing across all input surfaces** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05 (`1000,005` currently becomes 1,000,005 and `1.234` becomes 1.23)
  - ↪ _from: Accounts rewrite audit 2026-07-10_
  - Choose locale-aware parsing or explicit parsed-value confirmation, then update the shared parser
    and app-wide tests. Do not fix isolated forms independently.

- [ ] **Warn before year-to-date deduction candidates overwrite annual Belgian tax-profile fields** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (the current-year total is stored with no incomplete-period warning)
  - ↪ _from: Belgian tax pre-fill audit 2026-08-28_
  - Either require explicit acknowledgement for the current year or disable confirmation until the
    period is complete. Keep completed tax years unchanged.

- [ ] **Refactor snapshot sleeve accumulation to a keyed map without changing financial results** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (the repeated sleeve dispatch remains in `snapshotBuilder`)
  - ↪ _from: July 2026 simplification audit · SIMP-50_
  - This is an internal refactor with financial risk. Require parity tests for every sleeve, mixed
    events, and the aggregate snapshot before and after the change.

- [ ] **Preserve pending portfolio-import broker routing when accounts merge** ⏫
  - Tracking: 🔎 verified-present 2026-09-05 (`portfolio_import_batches.account_id` is set null when its selected source account is merged away)
  - ↪ _from: Accounts rewrite post-plan follow-up · import-commit interplay_
  - Choose repoint-to-survivor or block merges with reviewable batches. Pin the merge and later commit
    lifecycle so a reviewed broker batch cannot silently commit as Unassigned.

### ⚡ Performance and scale

- [ ] **Choose a bounded default date window for cold statistics pivot requests** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05 (the cache is complete; changing the all-time default is user-visible)
  - ↪ _from: Performance research 2026-07-02 · reports and aggregations_
  - Preserve exact per-date foreign-exchange conversion. Show the active window in the UI and keep
    an explicit All time option.

- [ ] **Give the `Card` primitive a cheaper default glass tier** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (`card.tsx` still defaults every card to the expensive blur tier)
  - ↪ _from: Frontend performance audit 2026-07-02_
  - Inventory intentional premium cards first. The change needs a Demo before/after visual pass and
    must preserve ADR-105's rich design.

- [ ] **Virtualize or window CategoryPivotTable period columns** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (multi-year data renders every period column eagerly)
  - ↪ _from: Frontend performance audit 2026-07-02_
  - Preserve keyboard navigation, sticky labels, totals, and export behavior. Requires browser
    verification with a long synthetic history.

- [ ] **Measure transaction expression sorts at realistic scale** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-05 (memo, recipient, category, and currency sorts compute expression keys over the candidate set)
  - ↪ _from: Backend performance audit 2026-07-02_
  - Capture `EXPLAIN (ANALYZE, BUFFERS)` and decide whether indexing is justified. File exact index
    work only if the evidence supports it. Keep this separate from pagination or UI sorting.

- [ ] **Replace DB-editor per-page unbounded COUNT plus OFFSET pagination** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (admin-only table browsing still counts the full filtered relation and uses OFFSET)
  - ↪ _from: Backend performance audit 2026-07-02_
  - Define total-count semantics and a keyset cursor contract before changing the UI.

- [ ] **Serve the Insights navigation badge from a cheap persisted undismissed count** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (the badge calls the full insights digest)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Keep the Statistics panel on the full digest. Specify how dismissals and transaction mutations
    update the count.

- [ ] **Apply subscription dismissals before selecting the top five findings** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (server-side capping precedes client-only dismissal filtering)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Depends on the server-visible dismissal contract. The result should refill from lower-ranked
    findings instead of showing fewer than five.

### 🧠 Insights and product semantics

- [ ] **Invalidate the insights digest after transaction mutations** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (`invalidateTransactionData` omits `insightsKeys.digest`)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Pin create, update, bulk update, and delete invalidation behavior without coupling it to the
    persisted badge-count implementation.

- [ ] **Make insight dismissals visible to AI narration** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (server-side digest construction receives no dismissal records)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Filter before tool or pre-call injection so dismissed findings cannot be narrated. Define a
    server-visible persistence boundary rather than trusting client-only state.

- [ ] **Use the immediately preceding charge for subscription price-change comparisons** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (`previousAmount` is currently the all-history median)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Either change the detector to previous-charge semantics or rename the field and copy to say
    historical typical amount. Tests must pin the selected meaning.

- [ ] **Calibrate category-outlier thresholds against representative real histories** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-05 (modified-z 3.5 and the EUR 50 near-zero-MAD floor only have synthetic proof)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Use sanitized representative histories and record false-positive and false-negative tradeoffs.
    Do not tune from one user's data silently.

- [ ] **Label partial-month category comparisons as day 1 through N comparisons** ⏬
  - Tracking: 🔎 verified-present 2026-09-05 (the UI says generic “this month” and “typical”)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Update English and Dutch copy through the i18n workflow. No detector change belongs here.

- [ ] **Define whether the cash insight is a balance forecast or a zero-based net-cashflow forecast** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05 (the service starts at zero while the UI claims projected balance and overdraft risk)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - If it remains a balance forecast, supply the actual cash anchor. Otherwise relabel it and remove
    overdraft claims. Keep the quantile correction in its separate item.

- [ ] **Persist the prior month-end projection used by significant-move detection** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (production always supplies the default null prior projection)
  - ↪ _from: AI insight feature audit 2026-08-28_
  - Define retention and invalidation ownership, then prove that a meaningful forecast change can
    trigger and that ordinary recalculation noise does not.

### 🎨 User interface and accessibility

- [ ] **Run browser accessibility and keyboard-order acceptance for the completed accessibility sweep** ⏬
  - Tracking: 🔎 runtime-unverified 2026-09-05 (source and automated checks are complete; browser interaction was not repeated)
  - ↪ _from: Accessibility audit completion review 2026-08-28_
  - Cover dialogs, menus, tables, skip links, focus return, and reduced motion in the Demo app.

- [ ] **Move all gain/loss card-wash variants behind `TrendHue`** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (four gradient dialects remain outside the declared source of truth)
  - ↪ _from: Visual consistency audit 2026-07-02_
  - Preserve each semantic state while consolidating tokens. Requires a light/dark Demo comparison.

- [ ] **Choose and implement a useful wide-screen layout for `/import`** ⏬
  - Tracking: 🔎 decision-needed 2026-09-05 (the page remains one narrow centered column with large desktop margins)
  - ↪ _from: UI layout audit 2026-07-02_
  - Treat this as look-changing. Specify the secondary content or wider workflow before editing.

- [ ] **Replace raw English AI tool-state errors with localized user-facing messages** ⏬
  - Tracking: 🔎 verified-present 2026-09-05 (tool sub-state errors still expose raw English text)
  - ↪ _from: Copy and loading-state audit 2026-08-28_
  - Keep diagnostic detail in logs. Add English and Dutch keys and error-state tests.

- [ ] **Correct the remaining Dutch AI shortcut verb form** ⏬
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: Copy and loading-state audit 2026-08-28_
  - Use the i18n workflow and limit this item to the one confirmed string.

- [ ] **Provide full-name disclosure for truncated Watchlist entities** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (the remaining truncation gap is Watchlist-specific)
  - ↪ _from: UI truncation audit 2026-08-28_
  - Add an accessible tooltip or equivalent disclosure that works with pointer and keyboard.

### 🏛️ API and architecture

- [ ] **Remove the orphan investment controller-to-repository bypass** 🔼
  - Tracking: 🔎 partial 2026-09-05 (`controllers/` contains one remaining handler that imports repositories directly)
  - ↪ _from: ADR-067 route-boundary audit 2026-08-28_
  - Move orchestration into a service or remove the controller layer. Keep route contracts unchanged.

- [ ] **Canonicalize recurrence wire vocabulary to one `biweekly` spelling** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05 (the wire values include both `bi-weekly` and `biweekly` and the frontend duplicates the enum)
  - ↪ _from: API contract audit 2026-08-28_
  - Define compatibility and migration handling first. Update OpenAPI, generated types, stored data,
    server validation, frontend options, and rollback behavior together.

- [ ] **Standardize body-versus-query precedence for non-GET request parameters** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05 (routes use inconsistent precedence)
  - ↪ _from: API consistency audit 2026-08-28_
  - Inventory affected endpoints, choose one rule, document it, and add conflict-case contract tests.

- [ ] **Stop `validateIdParam` from mutating Express path parameters into numbers** ⏬
  - Tracking: 🔎 decision-needed 2026-09-05 (requires a compatible parsed-id handoff convention)
  - ↪ _from: Middleware consistency audit 2026-08-28_
  - Keep the strict numeric validation. Introduce a typed request-local value or explicit return path
    and migrate consumers in one change.

- [ ] **Generate lazy route declarations and admin wrappers from one route metadata manifest** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (`App.tsx` still duplicates roughly forty lazy declarations and admin wrappers)
  - ↪ _from: July 2026 simplification audit · SIMP-44_
  - Preserve chunk boundaries, route paths, suspense behavior, and admin gating. Verify navigation and
    direct deep links.

- [ ] **Replace duplicated route-query stale times with named cache-policy constants** ⏬
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: July 2026 simplification audit · SIMP-44_
  - This is independent of generating the route manifest. Pin only intentional cache-policy groups.

- [ ] **Extract one shared Visx Cartesian chart frame** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (AreaChart, LineChart, and ComposedChart still duplicate frame behavior)
  - ↪ _from: July 2026 simplification audit · SIMP-13_
  - Preserve scrub, hover, synchronization, responsive bounds, and accessibility. The browser visual
    regression suite is a completion gate.

### 🏦 Accounts and portfolio features

- [ ] **Add Archive and Restore controls for investments with an inactive discovery view** 🔼
  - Tracking: 🔎 partial 2026-09-05 (backend `is_active` rails exist; frontend lifecycle controls and discovery do not)
  - ↪ _from: Feature work · investment lifecycle 2026-07-01_
  - Keep history visible, exclude inactive holdings from current totals, mark inactive records, and
    pin deactivation, filtering, history, reactivation, and query invalidation.

- [ ] **Add a final-transfer or zero-out step before closing an account with residual cash** ⏫
  - Tracking: 🔎 partial 2026-09-05 (aggregate close semantics are complete; the dialog only warns about residual cash)
  - ↪ _from: Accounts rewrite · WP-A3 follow-up_
  - Define transfer versus adjustment semantics and integrate it into the existing close flow.

- [ ] **Default manual trades to a broker without making broker selection mandatory** 🔼
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: ADR-108 implementation plan · WP-C3_
  - Apply instrument's last broker, then last manual-trade broker, then Unassigned. Show a muted
    change affordance and relabel the edit field to Broker.

- [ ] **Add an audited idempotent bulk broker re-tag endpoint** 🔼
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: ADR-108 implementation plan · WP-C3_
  - Use a set-based update over selected lots, return changed counts, preserve cost basis, and add
    authorization, validation, audit, and idempotency tests.

- [ ] **Remember portfolio parser configurations' broker account and disclose routing on review** 🔼
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: ADR-108 implementation plan · WP-C3_
  - Persist one account per file-level parser configuration and show “N trades to Broker” before
    commit. Do not add row-level routing.

- [ ] **Add a one-click per-instrument nudge for Unassigned portfolio lots** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on the bulk re-tag endpoint)
  - ↪ _from: ADR-108 implementation plan · WP-C3_
  - The nudge assigns the whole instrument in one reviewed action and reports the changed count.

- [ ] **Show holdings and broker profit/loss on portfolio account cards** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on accepted C4 parity and assignment UX)
  - ↪ _from: ADR-108 implementation plan · WP-C5_
  - Compose partitioned holdings with ledger cash and provenance on the Accounts hub. Do not
    recompute aggregate truth from per-broker values.

- [ ] **Show holdings and broker profit/loss on portfolio account detail pages** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on accepted C4 parity and assignment UX)
  - ↪ _from: ADR-108 implementation plan · WP-C5_
  - Add the holdings section above the cash ledger on `/accounts/:id` and keep its provenance and
    totals consistent with the hub card.

- [ ] **Add a current-point Net Worth By Account table with a parity footer** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on accepted C4 parity and assignment UX)
  - ↪ _from: ADR-108 implementation plan · WP-C5_
  - Include cash, holdings, total, and Unassigned. Assert that displayed rows sum to the same headline.

- [ ] **Add a Portfolio Overview broker filter with broker subtotals** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on accepted C4 parity and assignment UX)
  - ↪ _from: ADR-108 implementation plan · WP-C5_
  - Filter existing partitioned data client-side and label holdings value and profit/loss accurately.

- [ ] **Render wallet and crypto accounts as holdings-only portfolio accounts** 🔼
  - Tracking: 🔎 verified-present 2026-09-05
  - ↪ _from: ADR-108 implementation plan · WP-C5_
  - Use a distinct Wallet badge and omit cash and Reconcile affordances. Keep them in the Portfolio
    accounts group.

- [ ] **Add portfolio-lot re-tag choices to the account close flow** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on bulk re-tag and current-point read surfaces)
  - ↪ _from: ADR-108 implementation plan · WP-C6_
  - Offer another account or Unassigned, print counts, and prove no cost-basis change. Coordinate
    with the separate residual-cash step in the same dialog.

- [ ] **Add a broker-transfer action that re-tags lots and prints a receipt** 🔼
  - Tracking: 🔎 verified-present 2026-09-05 (depends on the bulk re-tag endpoint)
  - ↪ _from: ADR-108 implementation plan · WP-C6_
  - Reuse the close-flow choice component but keep this as a non-closing action. Assert unchanged
    units, invested capital, and realized profit/loss.

- [ ] **Build forward-only persisted per-broker history after current-point surfaces have soaked** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (implementation is intentionally sequenced after WP-C5 acceptance and soak)
  - ↪ _from: ADR-108 implementation plan · WP-C7_
  - Add a dedicated snapshot-by-account table, writer, endpoint, chart, backup coverage, downgrade,
    and per-date sum invariant. Do not retroactively synthesize history.

- [ ] **Decide whether planned transactions appear in the account ledger and reconcile flow** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (the account detail route currently shows posted transaction rows only)
  - ↪ _from: Accounts rewrite post-plan follow-up · planned account rows_
  - Planned rows must never change the current balance before execution. Define whether they appear as
    a separate forecast section, a filter, or remain outside this surface.

- [ ] **Decide whether the 45-day stale-statement threshold is fixed policy or a user setting** ⏬
  - Tracking: 🔎 decision-needed 2026-09-05 (`driftBadge.ts` exports a fixed 45-day threshold)
  - ↪ _from: Accounts rewrite post-plan follow-up · settings placement_
  - If fixed, record the accepted policy and remove the item. If configurable, define scope and
    placement before adding settings and migrations.

### 🧪 Runtime and external acceptance

- [ ] **Detect pre-existing funding-account cycles in the live database** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-05 (the source guard prevents new API cycles but does not inspect existing data)
  - ↪ _from: Accounts rewrite audit 2026-08-10_
  - Run a read-only recursive query first. If the count is nonzero, open a separate repair decision;
    do not create a migration spec before seeing the actual rows.

- [ ] **Run account-balance migration upgrade and downgrade on disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Verify data preservation and schema parity in both directions. Never use the live database.

- [ ] **Verify an account mutation refreshes the displayed Demo balance immediately** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Drive the mutation through the Demo UI and confirm hub, dashboard, and detail cache updates.

- [ ] **Capture before-and-after EXPLAIN for the stamped-balance probe** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Use representative synthetic scale and retain plans with buffers. This is measurement, not an
    authorization to add an index.

- [ ] **Run the Accounts Demo reconciliation-exit acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Exercise save, cancel, stale statement, correction, and error exits without mutating real data.

- [ ] **Run the Accounts Demo balance-provenance acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Compare hub, dashboard, and detail provenance and values after a reconciliation.

- [ ] **Run the Accounts Demo grouping and subtotal acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Verify group order, account order, subtotal arithmetic, empty groups, and closed-account handling.

- [ ] **Run the Accounts Demo ledger and deep-link acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Exercise `/accounts/:id`, transaction drill-down links, browser back/forward, and missing accounts.

- [ ] **Run the Accounts Demo merge-dialog acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Preview and complete a safe merge, then verify the survivor and reassigned transaction links.

- [ ] **Run the Accounts Demo close-dialog acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Verify residual-cash warning, archive and reactivate behavior, and net-worth exclusion.

- [ ] **Run the Accounts Demo import-disclosure acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Verify account routing disclosure from upload through review and commit.

- [ ] **Run the Accounts Demo new-account-nudge acceptance** 🔺
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: Accounts rewrite acceptance ledger_
  - Verify when the nudge appears, its dismissal behavior, and that it does not recur incorrectly.

- [ ] **Run real-PostgreSQL parity for partitioned broker positions and profit/loss** ⏫
  - Tracking: 🔎 runtime-unverified 2026-09-05
  - ↪ _from: ADR-108 · WP-C4 acceptance_
  - Run every cost-basis method, account-scoped sells, and the re-tag mutation-sensitivity fixture
    with `TEST_DATABASE_URL`.

- [ ] **Run the account funding-graph concurrency suite on real PostgreSQL** ⏫
  - Tracking: 🔎 runtime-unverified 2026-09-05 (two-client PATCH-versus-PATCH and PATCH-versus-merge tests are implemented; local PostgreSQL bootstrap is blocked by sandbox `shmget` policy)
  - ↪ _from: Funding-cycle fix independent review 2026-09-05_
  - Run `bun run test:db tests/services/accountFundingGraphConcurrency.db.test.js` in CI or an
    unrestricted local environment. Remove this item only after both cases execute, not skip.

- [ ] **Verify the deployed `vision-claude-sync` pull function fails closed** 🔽
  - Tracking: 🔎 runtime-unverified 2026-09-05 (installed bytes match the canonical function; a forced real pull failure was not run against the user's Claude state)
  - ↪ _from: Host tooling audit 2026-08-28_
  - Use a safe isolated harness or an approved maintenance window. Confirm the failed pull does not
    overwrite deployed state.

- [ ] **Read the current GitHub nightly E2E and accessibility workflow state and restore it if red** ⏫
  - Tracking: 🔎 needs-GitHub-check 2026-09-05 (the earlier month-long failure claim is stale until current Actions state is read)
  - ↪ _from: CI reliability audit 2026-08-28_
  - Failure alerting already exists. This item closes when the current required run is verified, or
    when a concrete current failure is filed with evidence.

- [ ] **Add or explicitly waive an end-to-end backup and restore journey** 🔼
  - Tracking: 🔎 decision-needed 2026-09-05
  - ↪ _from: Test topology audit 2026-08-28_
  - Define the supported platforms, fixture age, encryption versions, and destructive-test isolation
    before adding the journey.

- [ ] **Run the ADR-088 manual `bank_account` contract drop in an approved maintenance window** ⏫
  - Tracking: 🔎 runtime-unverified 2026-09-05 (code readers are migrated; the live lockstep drop remains user-controlled)
  - ↪ _from: ADR-088 contract-drop runbook_
  - Stop writers, take a fresh backup, prove parity zero, apply the documented write-side and schema
    removal together, run the focused regression set, and retain tested rollback. Requires explicit
    approval for the exact target.

- [ ] **Audit and remove legacy ADR-090 `transfer_source='trade'` rows from the approved live database** ⏫
  - Tracking: 🔎 runtime-unverified 2026-09-05 (source, flag, and endpoint deletions are complete)
  - ↪ _from: ADR-108 · WP-C1 cleanup gate_
  - Count rows and show the count before any deletion. After explicit approval for the exact live
    target, remove only those legacy rows and verify ledger integrity.

- [ ] **Audit and remove legacy ADR-090 trade rows from the Demo database** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (source, flag, and endpoint deletions are complete)
  - ↪ _from: ADR-108 · WP-C1 cleanup gate_
  - Count the synthetic rows first. If cleanup is needed, regenerate the Demo database and boot-check
    it. This never authorizes changes to the live database.

- [ ] **Validate the portfolio import adapter against a real Degiro export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Degiro export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real IBKR export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized IBKR export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Bolero export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Bolero export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Bitvavo export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (requires a user-provided sanitized Bitvavo export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Exercise ADR-109 conversion migration 0087 on PostgreSQL 18** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-05 (local proof used PostgreSQL 16; CI is the intended PostgreSQL 18 environment)
  - ↪ _from: ADR-109 conversion adversarial review 2026-08-02_
  - Run upgrade, data parity, and downgrade against a disposable legacy fixture.

### 🧹 Maintenance and documentation

- [ ] **Decide when to drop ADR-109 legacy rollback relations and helper views** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (`legacy_inh_*`, `*_investments_full`, and pre-0013 snapshots are intentionally retained)
  - ↪ _from: ADR-109 conversion adversarial review 2026-08-02_
  - Define the retention window and backup-coverage note before creating the contraction migration.

- [ ] **Retire ADR-090 transaction schema after live and Demo cleanup** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (`transactions.portfolio_transaction_id`, its partial index, and the `trade` transfer-source value remain)
  - ↪ _from: ADR-108 post-plan contraction follow-up_
  - Start only after both legacy trade-row cleanup items. Remove the retired column and index and
    narrow the transfer-source check. Include backup, downgrade, and disposable-database proof.

- [ ] **Decide whether to contract consumer-less account metadata after portfolio UI soak** 🔽
  - Tracking: 🔎 decision-needed 2026-09-05 (`has_cash_sleeve` remains writable and public after its UI control was removed)
  - ↪ _from: ADR-108 post-plan contraction follow-up_
  - Inventory current consumers and contracts after the portfolio account surfaces soak. `route`,
    `is_brokerage`, and `portfolio_snapshot_accounts` are explicitly out of scope.

- [ ] **Update the close-account flow visualizer to the current archive behavior** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (`docs/flow-visualizer.html` still shows removed ADR-091 move-holding endpoints and services)
  - ↪ _from: Accounts TODO independent audit 2026-09-05_
  - Replace only the stale embedded close-account flow with residual-balance warning, account PATCH,
    server archive and net-worth semantics, and cache invalidation.

- [ ] **Replace the hand-rolled calendar-day difference helper with date-fns** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (ImportReview already uses shared formatting; locale-sensitive formatting and `Intl.RelativeTimeFormat` remain intentional)
  - ↪ _from: July 2026 simplification audit · revised SIMP-05_
  - Replace only `differenceInDays` with the output-equivalent `differenceInCalendarDays` path and
    preserve its pinned local-calendar semantics. Do not migrate the non-equivalent display helpers.

- [ ] **Share the v1 and v2 backup encryption scheme through one parameterized crypto implementation** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (crypto duplication remains across backup bundle and crypto modules)
  - ↪ _from: July 2026 simplification audit · SIMP-52_
  - Data-loss-risk change: require known legacy v1 and v2 fixtures, wrong-passphrase behavior, and
    byte-compatible decrypt proof. Keep restore-process plumbing out of this item.

- [ ] **Consolidate duplicated Docker SQL restore orchestration** 🔽
  - Tracking: 🔎 verified-present 2026-09-05 (`runBundleRestore` and `runRestore` repeat the SQL restore process)
  - ↪ _from: July 2026 simplification audit · SIMP-53_
  - Preserve the current crypto interface, rollback, and temporary-file cleanup. Verify both restore
    entry points in a disposable Electron environment.

- [ ] **Centralize Electron restore credential and environment resolution** ⏬
  - Tracking: 🔎 verified-present 2026-09-05 (restore entry points repeat environment reads and default credential setup)
  - ↪ _from: July 2026 simplification audit · SIMP-53_
  - Keep credential values out of logs and temporary paths. Pin Docker and native resolution without
    changing the existing backup format or restore orchestration.

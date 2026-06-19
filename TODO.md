# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## Account-entity epic — deferred follow-ups

> The cross-workspace account-entity epic landed across **ADRs 088–099** (account entity, typed
> model, cash sleeve + trades-as-transfers, per-account positioning, liabilities, net worth = Σ
> accounts, drift reconciliation, brokerage import design, dividend/FIRE, portfolio×research,
> cross-workspace surfaces, sidebar IA). The items below are the pieces deliberately **parked
> during implementation** — each is independently shippable. Logged 2026-06-18.

### Account foundation (ADR-088)

> ⏸️ **Deliberately not done in the 2026-06-18 pass** — irreversible + requires a production
> dual-write-soak verification that can't be performed from a coding session. Left for a manual,
> supervised run.

- [ ] ⏫ **Contract phase — drop the `bank_account` string.** Currently dual-written (string +
      `account_id` via the migration-0051 trigger). Removing the string is **out-of-band, manual,
      and irreversible** — do it only after a dual-write soak confirms
      `count(*) WHERE bank_account IS NOT NULL AND account_id IS NULL = 0`, the coupled read/write
      code is off the string, **and `mv_bank_balances` is redefined on `account_id`** (it still
      groups by `bank_account` today). Migration `0055` is intentionally a no-op; `0056` is the
      recovery. Not a chain migration (the app auto-runs `upgrade head`).

- [x] 🔼 **Full ADR-095 fan-out.** ✅ 2026-06-19 — verified the "remaining surface" is in fact built
      (this note was stale, logged before migrations 0057/0060 landed):
      - **Mixed-row staging** — migration `0060` adds `portfolio_import_batches.is_brokerage` +
        `portfolio_import_staging_rows.route`; `0057` adds the batch `account_id`. `validate.js`
        populates `route` ('cash' | 'portfolio') per row via `classifyBrokerageRow`; `commit.js`
        fans out cash rows + ADR-090 trade legs inline in the staged flow.
      - **Parser kind** — handled by the generic adapter producing `type_raw`, classified at
        validate-time (an equivalent design to a dedicated parser kind; no separate kind needed).
      - **Review UI** — `PortfolioImportPage` has the brokerage toggle + sleeve-account picker;
        `PortfolioImportReviewPage` shows the cash group separately + commits with the account;
        `prepareImport` forces every brokerage batch through staged review.
      Tests green: `brokerageRouting`, `brokerageFanout`, `portfolioImportCommit`, `tradeCashLegService`
      (39 passing). **Optional, not built:** a per-row route *override* in review (flip cash↔trade) —
      currently routing is deterministic from the row kind and shown read-only; unknown kinds error
      and block commit. Open a new item if user-facing reclassification is wanted.

### Cross-workspace UX (ADR-099)

> ⏸️ **Deliberately not done in the 2026-06-18 pass** — requires the running app + a browser
> (Playwright) and human UX judgement; out of scope for the headless implementation pass.

- [~] 🔼 **Runtime nav / UX validation.** ⚠️ 2026-06-19 — walked the **accounts hub** and
      **net-worth / per-account breakdown** on the running demo (Playwright) and fixed three blocking
      bugs found there (hub `drift` crash, `by-account` 500, MV refresh fallback). The remaining two
      surfaces were validated by reading the live sidebar nav (all 3 workspaces) + the route/service
      code; **finding: neither surface is built yet, so there is nothing to make discoverable** —
      validating discoverability is blocked on first building them:
      - **Cash-aware rebalancing** — *no UI surface at all.* `rebalanceDeployment` (and the rest of
        `services/crossWorkspaceAnalytics.js`) is tested but **not imported anywhere** → no route, no
        page, no nav entry in any workspace. ADR-098 (which defines it) is still **Proposed**.
      - **Unified tax view** — *partial, not first-class.* `/tax` (budgeting) already folds portfolio
        taxes into PIT (1-click discoverable), but tax is split across two workspace-siloed pages
        (`/tax` + `/portfolio/tax`); the ADR-098 owner-allocated income+gains+dividends view (and its
        `unifiedTax` core) is unwired. No single cross-workspace tax surface exists.
      **Real follow-up (a build, not a validation):** promote ADR-098 from Proposed and wire the two
      cores to routes + pages + sidebar placement. Needs user sign-off (was out of the approved scope).

- [x] 🔽 **Accounts hub → account transactions.** ✅ 2026-06-19 — double-clicking an account card on
      the accounts hub navigates to `/transactions?bank_account=<account.name>&filter_label=<display>`
      (the dual-write trigger keeps `transactions.bank_account` = `accounts.name`, so the name is the
      filter key). Threaded a `bank_account` URL filter through `TransactionsPage` →
      `useTransactionListData` → list/export queries (the param was already accepted server-side),
      added the filter chip + export wiring, and an `accounts.openTransactions` hint string (en/nl).
      Typecheck + lint + 26 TransactionsPage integration tests green.

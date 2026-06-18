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

### Per-account positioning (ADR-091)

- [x] ⏫ **Per-account holdings breakdown UI.** ✅ 2026-06-18 — `getPortfolioSummary` extended
      with additive `byAccount`; frontend `useAccountPositions` + "Holdings by Account" card in
      `InvestmentDetailDialog`. Parity test locks Σ byAccount == per-investment totals.
- [x] 🔼 **Account picker in the edit-trade dialog.** ✅ 2026-06-18 — `EditPortfolioTxnDialog`
      now has an account selector; PATCH accepts `account_id` (null clears).
- [x] 🔼 **Close-account workflow.** ✅ 2026-06-18 — `CloseAccountDialog`: lists holdings →
      in-specie transfer to another account → archive (`is_active=false`); wired into AccountsPage.
- [x] 🔽 **Partial-move cost-basis option.** ✅ 2026-06-18 — move service + dialog take
      `strategy: 'fifo' | 'proportional'` (proportional = average-cost, splits every lot by the
      same fraction).

### Net worth (ADR-093)

- [x] 🔼 **Per-account net-worth breakdown** — ✅ 2026-06-18 — `useAccountNetWorth` + "By Account"
      table on the net-worth page (cash + holdings + total per in-net-worth account).
- [x] 🔼 **Supersede ADR-064 snapshots natively** — ✅ 2026-06-18 (ADR-100). Holdings now expressed
      as Σ accounts in the live summary with ADR-061 parity tests. The **historical daily series is
      deliberately retained** (no per-account daily holdings snapshot exists; rebuilding it would
      shift the series — see ADR-100 / ADR-093 risk note). Liquid side was already account-native.

### Brokerage import (ADR-095)

- [x] ⏫ **Assign an account on portfolio import.** ✅ 2026-06-18 — migration `0057` adds
      `portfolio_import_batches.account_id`; the review flow has a brokerage-account picker; commit
      stamps it onto every imported lot. (Migration authored, not yet applied.)
- [~] 🔼 **Full ADR-095 fan-out.** ⚠️ 2026-06-18 — **core implemented & tested**: wired the
      previously-dead `brokerageRouting.js` into `brokerageFanout.js` (`planBrokerageFanout` +
      `commitBrokerageFanout`) — routes one statement into cash ledger + trades + ADR-090 cash legs,
      dedups both sides, enforces the double-count guard (a trade's only cash movement is its leg).
      **Remaining surface (not built):** the brokerage parser kind, mixed-row staging, and the
      review UI that feeds this commit core. The dangerous algorithmic part is done; the integration
      layer is the follow-up.

### Portfolio × Research (ADR-097)

- [x] 🔽 **Watchlist "what-if" backtest.** ✅ 2026-06-18 — migration `0058` adds
      `watchlist.added_price` (snapshotted from the live quote at add time); the watchlist page shows
      "Since added {date} +X%" (created_at is the add-date). (Migration authored, not yet applied.)

### Cross-workspace UX (ADR-099)

> ⏸️ **Deliberately not done in the 2026-06-18 pass** — requires the running app + a browser
> (Playwright) and human UX judgement; out of scope for the headless implementation pass.

- [ ] 🔼 **Runtime nav / UX validation.** Walk the new cross-workspace surfaces (accounts hub,
      net-worth/FI projection, cash-aware rebalancing, unified tax view) on the running app
      (Playwright): ≤2-click discoverability, cross-workspace items read as first-class.

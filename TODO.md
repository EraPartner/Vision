# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## Account-entity epic — deferred follow-ups

> The cross-workspace account-entity epic landed across **ADRs 088–099** (account entity, typed
> model, cash sleeve + trades-as-transfers, per-account positioning, liabilities, net worth = Σ
> accounts, drift reconciliation, brokerage import design, dividend/FIRE, portfolio×research,
> cross-workspace surfaces, sidebar IA). The items below are the pieces deliberately **parked
> during implementation** — each is independently shippable. Logged 2026-06-18.

### Account foundation (ADR-088)

- [ ] ⏫ **Contract phase — drop the `bank_account` string.** Currently dual-written (string +
      `account_id` via the migration-0051 trigger). Removing the string is **out-of-band, manual,
      and irreversible** — do it only after a dual-write soak confirms
      `count(*) WHERE bank_account IS NOT NULL AND account_id IS NULL = 0`, the coupled read/write
      code is off the string, **and `mv_bank_balances` is redefined on `account_id`** (it still
      groups by `bank_account` today). Migration `0055` is intentionally a no-op; `0056` is the
      recovery. Not a chain migration (the app auto-runs `upgrade head`).

### Per-account positioning (ADR-091)

- [ ] ⏫ **Per-account holdings breakdown UI.** Backend derives positions per
      `(investment, account)`, but there's no frontend per-account view
      ("AAPL 150 → IBKR 100 · Degiro 50"). The cost-basis math already groups; this is UI only.
- [ ] 🔼 **Account picker in the edit-trade dialog.** `EditPortfolioTxnDialog` has no account
      selector (only the add dialog does) — changing a lot's account is API-only today.
- [ ] 🔼 **Close-account workflow.** Guided liquidate/transfer-positions → archive
      (`is_active=false`). The move-holding feature (`POST /api/investments/:id/move`) is the
      building block; the guided flow isn't built.
- [ ] 🔽 **Partial-move cost-basis option.** The move feature splits boundary lots **FIFO**
      (oldest first). Offer proportional / average-cost lot selection as an alternative if wanted.

### Net worth (ADR-093)

- [ ] 🔼 **Per-account net-worth breakdown** — each account's cash + holdings at market (depends on
      the per-account portfolio summary above).
- [ ] 🔼 **Supersede ADR-064 snapshots natively** — express the persisted daily snapshots + the
      net-worth page as Σ accounts, with **ADR-061 parity tests** locking outputs across the
      cutover. (The live aggregate already equals Σ accounts; this is the snapshot engine.)

### Brokerage import (ADR-095)

- [ ] ⏫ **Assign an account on portfolio import.** Portfolio/brokerage imports leave
      `portfolio_transactions.account_id` **NULL** — `portfolioImportPipeline/commit.js` never sets
      it and there's no account picker in the import flow. Smallest fix: a batch-level brokerage
      account (picker → store on the batch → pass through commit; migration for the column).
- [ ] 🔼 **Full ADR-095 fan-out.** Wire `brokerageRouting.js` (currently **dead code**) so one
      statement splits into cash ledger + trades with the ADR-090 cash legs, deduped on both sides,
      behind the mandatory staged review. The originally-flagged "dangerous" part.

### Portfolio × Research (ADR-097)

- [ ] 🔽 **Watchlist "what-if" backtest.** Store watchlist add-date; "had I bought when I added
      it…". Watchlist CRUD exists; the add-date capture + backtest do not.

### Cross-workspace UX (ADR-099)

- [ ] 🔼 **Runtime nav / UX validation.** Walk the new cross-workspace surfaces (accounts hub,
      net-worth/FI projection, cash-aware rebalancing, unified tax view) on the running app
      (Playwright): ≤2-click discoverability, cross-workspace items read as first-class.

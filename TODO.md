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

- [~] 🔼 **Full ADR-095 fan-out.** ⚠️ 2026-06-18 — **core implemented & tested**: wired the
      previously-dead `brokerageRouting.js` into `brokerageFanout.js` (`planBrokerageFanout` +
      `commitBrokerageFanout`) — routes one statement into cash ledger + trades + ADR-090 cash legs,
      dedups both sides, enforces the double-count guard (a trade's only cash movement is its leg).
      **Remaining surface (not built):** the brokerage parser kind, mixed-row staging, and the
      review UI that feeds this commit core. The dangerous algorithmic part is done; the integration
      layer is the follow-up.

### Cross-workspace UX (ADR-099)

> ⏸️ **Deliberately not done in the 2026-06-18 pass** — requires the running app + a browser
> (Playwright) and human UX judgement; out of scope for the headless implementation pass.

- [~] 🔼 **Runtime nav / UX validation.** ⚠️ 2026-06-19 — walked the **accounts hub** and
      **net-worth / per-account breakdown** on the running demo (Playwright) and fixed three blocking
      bugs found there (hub `drift` crash, `by-account` 500, MV refresh fallback). **Remaining:**
      validate the **cash-aware rebalancing** and **unified tax view** surfaces for ≤2-click
      discoverability and first-class cross-workspace placement.

- [ ] 🔽 **Accounts hub → account transactions.** Double-clicking an account in the accounts hub
      should navigate to that account's filtered transactions.

# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## Cross-workspace feature epic — account entity & spanning features

> Brainstormed 2026-06-18. Features that span the three workspaces (Budgeting · Portfolio ·
> Research), anchored on introducing a real account entity. **The user wants all of these
> regardless of effort.** Ordering reflects dependency (foundation first), not priority or cost.

### Foundation — the account entity

- [ ] 🔺 **Account entity** — replace the implicit `bank_account` TEXT column with a real
      `accounts` table. There is no accounts table today: accounts are free strings and the
      running balance is partitioned by the `bank_account` string. Safe path is expand/contract —
      create `accounts`, backfill one row per distinct string, add a nullable `account_id` FK
      alongside, dual-write, flip reads, drop the string. Blast radius: running-balance ledger,
      import, statistics, transfers (ADR-083), planned transactions. ADR-worthy; unblocks the
      rest of this section.
- [ ] ⏫ **Cash sleeve** — brokerage / crypto-exchange accounts hold spendable or idle cash
      alongside holdings. **Single source of truth per sleeve** — must not be double-counted
      against net-worth "liquid" or a portfolio "savings" asset.
- [ ] ⏫ **Trades = transfers (cash-sleeve plumbing)** — model buy / sell / dividend / fee as
      internal transfers on the cash sleeve, reusing the ADR-083 transfer machinery: buy =
      cash→holding (net-worth-neutral, kept out of "spending"); sell = holding→cash (kept out of
      "income"); dividend = income into the sleeve; fee = spending out of the sleeve. Keeps the
      cash sleeve honest when holdings change; required for brokerage import to balance.

### Account model — attributes & reach (ride on the entity)

- [ ] ⏫ **Account-typed model** — `checking` / `savings` / `brokerage` / `crypto-exchange` /
      `wallet` / `pension` / `liability` as orthogonal flags: type, liquidity class, spendable/
      earmarked, in-net-worth, tax wrapper, owner, multi-currency cash. Same entity, different
      flag combinations. Stress-test types that must all work: brokerage (cash + holdings),
      pensioensparen (locked, deductible, tax-advantaged), crypto wallet (no cash sleeve),
      mortgage (negative, illiquid liability).
- [ ] ⏫ **Per-account positioning / lots** — give `investments` / `portfolio_transactions` an
      account FK (none today — holdings are global). Enables per-account cost basis ("100 AAPL at
      IBKR vs 50 at Degiro") and a real "close this account" workflow.
- [ ] ⏫ **Liabilities as negative accounts** — model a mortgage / loan as an account with
      negative value; net worth = sum of accounts incl. debt, no special-casing. Unifies the
      existing loan schedule into the account model.
- [ ] ⏫ **Balance reconciliation / drift detection** — store an authoritative statement balance
      per account and diff it against the computed running-balance ledger ("drifted €12.40 —
      missing a transaction"). Only possible once accounts have an identity instead of a string.
- [ ] 🔼 **Owner dimension → tax allocation** — me / partner / joint on accounts, feeding the
      Belgian marital quotient.

### Brokerage import

- [ ] ⏫ **Brokerage account import** — unified importer that splits one brokerage statement into
      both `transactions` (cash movements) and `portfolio_transactions` (trades) and links the
      legs. Depends on the account entity + cash sleeve + trades=transfers. **Handle carefully** —
      routing rows to the right target, leg-linking, dedup, and avoiding double-counting are the
      danger areas (this is the "dangerous" part originally flagged).

### Portfolio statistics — descriptive only, NOT budgeting forecast

- [ ] 🔼 **Dividend / coupon income** — projected + realized investment income as a portfolio-level
      statistic. **Must NOT feed Planned Transactions or the cash-flow forecast** — stays
      descriptive, inside the portfolio workspace.
- [ ] 🔼 **FIRE / coverage ratio** — spending run-rate (read from budgeting) vs passive yield,
      shown in portfolio statistics. Reads budgeting numbers; never writes into them.

### Portfolio × Research

- [ ] 🔼 **Watchlist "what-if" backtest** — "had I bought when I added it to the watchlist…"
- [ ] 🔼 **Allocation drift + classic-portfolio benchmarks** — target vs actual weights, plus
      comparison against canonical compositions (60/40, all-weather, three-fund).

### All three workspaces (Budgeting × Portfolio × Research)

- [ ] 🔼 **Net-worth / financial-independence projection** — compose the cash-flow forecast +
      holdings + research market forecast (ADR-081) into a projected net-worth cone with
      confidence bands.
- [ ] 🔼 **Cash-aware rebalancing** — research target weights + portfolio actual weights +
      available budgeting cash → "deploy €X into the underweight sleeve."
- [ ] 🔼 **Unified tax view** — one surface pulling earned income (budgeting) + realized gains
      (portfolio) + dividend income (cash sleeve).

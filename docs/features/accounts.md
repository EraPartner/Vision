---
title: Accounts
type: feature
status: active
date: 2026-07-22
updated: 2026-09-04
tags:
  [
    feature,
    accounts,
    adr-088,
    adr-094,
    adr-105,
    adr-107,
    balances,
    reconciliation,
    ledger,
    running-balance,
    provenance,
    wp-b2,
    wp-b3,
    wp-b4,
  ]
aliases: [accounts-feature, account-hub, account-ledger, bank-accounts]
description: The budgeting accounts surface — grouped hub, per-account ledger route with running balance, balance provenance, drift reconciliation, and account lifecycle (open/edit/merge/close/archive/delete). Rebuilt under ADR-107 as a Glance → Overview → Ledger architecture with one balance definition everywhere.
related_code:
  [
    "apps/frontend/src/pages/AccountsPage.tsx",
    "apps/frontend/src/pages/AccountDetailPage.tsx",
    "apps/frontend/src/features/accounts/",
    "apps/frontend/src/hooks/useAccounts.ts",
    "apps/node-backend/src/routes/accounts.js",
    "apps/node-backend/src/routes/transactions.js",
    "apps/node-backend/src/repositories/transactionRepository.js",
    "apps/node-backend/src/lib/accountBalanceSql.js",
  ]
---

# Accounts

The budgeting accounts surface: every bank/cash/liability entity ([[docs/adr/088-accounts-entity|ADR-088]]), its computed balance, and the workflows for keeping those balances trustworthy. Rebuilt under [[docs/adr/107-accounts-budgeting-ux-remake|ADR-107]] around three questions — _what do I have_ (hub), _is it right_ (ledger + provenance), _how do I fix it_ (reconcile).

## Architecture: Glance → Overview → Ledger

| Level    | Surface                                                                   | Route           |
| -------- | ------------------------------------------------------------------------- | --------------- |
| Glance   | Dashboard `BankBalancesWidget` — same numbers/names/population as the hub | `/`             |
| Overview | Grouped accounts hub                                                      | `/accounts`     |
| Ledger   | Per-account detail with running-balance ledger                            | `/accounts/:id` |

All three render the **same balance definition**: the ADR-094 anchor+delta computed balance (most recent stamped statement balance + active entries after it; plain sum when unstamped). Numeric balances come from `accountBalanceSql.js`'s per-currency lateral helpers; `BALANCE_PROVENANCE_LATERAL` separately supplies the shared statement anchor and post-anchor row count (ADR-118).

The definition is also date-bounded ([[docs/adr/123-effective-date-current-balances|ADR-123]]).
A future-dated transaction stays visible in the ledger, but it does not affect the current balance,
provenance, drift, merge preview, or cross-workspace cash until its `APP_TIMEZONE` date. An account
or currency with only future rows remains visible with a zero current balance.

## The hub (`/accounts`)

- **Groups** (WP-B3, fixed order): _Cash & Savings_ (checking · savings · pension) → _Portfolio accounts_ (brokerage · crypto_exchange · wallet) → _Liabilities_ → _Archived_ (collapsed; any `is_active=false` account regardless of type). Cards sort by display label within a group (`groupAccounts.ts`, unit-tested).
- **Per-group subtotals** convert each account's computed balance to the display currency; the grand **Net cash** line sums active, `in_net_worth` non-portfolio accounts — the same population as the net-worth Liquid + Liabilities figures.
- **Portfolio-type cards** show "Tracked in Portfolio →" instead of a misleading €0,00 ledger balance (real holdings values arrive with the portfolio-accounts-v2 work, [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]]).
- **Card interactions** (WP-B4): the account name and the menu's **View details** item are real links to `/accounts/:id`. The card stays a passive container so its independent Reconcile control and menu do not create nested interaction. The menu also keeps **View transactions** (account-filtered Transactions page) and **Reconcile balance** (only while drift is non-zero). Everything lifecycle-shaped moved to the detail route's header menu.
- The **drift badge** on a card (statement vs computed disagreement, ADR-094) opens the Reconcile dialog directly.
- **Add account** stays in the page header.
- Legacy deep-links `/accounts?account=<id>` forward (replace) to `/accounts/<id>`.

## The ledger route (`/accounts/:id`) — WP-B4

Lazy-loaded like every page (`routePreload.ts` → `App.tsx`). Content:

- **Header**: display name; type · currency · institution subline; archived badge when inactive; a header **actions menu** with _Edit_, _Set opening balance_, _View transactions_, _Merge into…_, _Close account_, _Archive/Restore_, _Delete_ (moved here from the hub cards). Delete on a still-referenced account (409) routes into the close flow, same as the hub used to.
- **Balance card**: the computed balance with its provenance subline (below), the **drift chip** (click → Reconcile dialog), and a **sparkline** of the running-balance series drawn from the ledger rows themselves (most recent ≤100 rows, chronological; green/red/neutral by trend) — no extra endpoint.
- **Holdings placeholder** (portfolio-type accounts only): a muted locked section above the ledger; it is fed with real per-broker holdings later (ADR-108). Portfolio-type accounts also show "Tracked in Portfolio →" instead of a cash balance.
- **Running-balance ledger**: the account's full transaction list, newest first, in a table with Date · Description (recipient + memo) · Category · Amount · **Balance**. Loads 100 rows at a time ("Load more" grows the window).
- **Details card**: type, currency, owner, liquidity, tax wrapper, institution, spendable, in-net-worth.
- Accounts with `has_transactions=false` (portfolio shells) explain that their activity lives in the portfolio, not the ledger.

### Running balance semantics

The ledger queries `GET /api/transactions?account_id=<id>&include_balance=true&sort_by=date&sort_dir=desc`. `include_balance=true` makes the repository add

```sql
SUM(t.amount) OVER (
  PARTITION BY t.account_id, COALESCE(t.currency, 'EUR')
  ORDER BY t.date ASC, t.id ASC
) AS running_balance
```

- The window is **partitioned by account and currency**. Unlike currencies are never added. A NULL legacy currency belongs to the EUR partition. It is **always ordered chronologically**, independent of display sort — each row's `running_balance` is the balance _after_ that transaction.
- It is evaluated over the full filtered set **before** LIMIT/OFFSET, so values stay correct across pages.
- Because the window only sees WHERE-filtered rows, the route never applies a server-side date filter to the ledger — a `start_date` would restate history from zero. The `?since=` narrowing (below) is client-side for exactly this reason.
- The wire field is `running_balance` (present only under `include_balance=true`); it is distinct from the row's stored `balance` column, which is import-pipeline-only (see [[docs/features/transactions|Transactions]]).
- The header sparkline uses only rows in the account's declared currency because one line cannot compare distinct currency balances. The ledger still exposes every row with its own currency and balance.

The full-prefix window and OFFSET pagination are retained deliberately. A
page-local or simple keyset query cannot calculate the same balance without a
separate opening-prefix aggregate, and current ledger latency does not justify
that extra protocol. The repository also retains `SELECT t.*` because
`transactionRepository.getAll()` is a shared enriched-row primitive used by the
HTTP list, tax deduction candidates, and AI expense, insight, and tax tools.
Narrowing it safely requires a consumer audit or a dedicated list projection,
not an assumption based only on the route formatter. Revisit both the
pagination/window shape and full-row projection when production query telemetry
shows a sustained ledger-list p95 above 250 ms, plans spill the running window
to disk, or profiling attributes at least 10% of response time or payload bytes
to unused transaction columns. The replacement must prove byte-equivalent
balances at every page boundary and preserve every internal consumer's required
fields.

### `?since=YYYY-MM-DD` deep-link

`/accounts/:id?since=2026-06-03` narrows the ledger to rows dated on/after the given day (a dismissible banner shows the active narrowing). This is the landing target for the Reconcile dialog's _"Show transactions since {statement date}"_ exit (wired since WP-B1's completion). Rows are compared as plain `YYYY-MM-DD` strings (no local-midnight shift), and Load-more stops once rows older than the cut-off are loaded.

## Balance provenance (WP-B2)

Every rendered current balance carries a muted subline (`useBalanceProvenance`):

- stamped: _"as of {date} bank statement + {n} entries since"_
- unstamped: _"sum of {n} entries"_

fed by `anchor_date` / `post_anchor_count` from the accounts list endpoint. Shown on hub cards, the detail header, the Reconcile dialog's computed row and the dashboard widget.

## Reconcile

The drift badge/chip (`statement_balance − reconcilable_balance`, ADR-094) opens the Reconcile dialog. `computed_balance` is the FX-converted reporting total; `reconcilable_balance` is one native currency partition. The declared `accounts.currency` partition wins whenever it exists, including at exactly zero. Only when it is absent can a sole funded foreign partition act as the compatibility fallback for a mislabelled single-currency account. The badge itself carries the statement's as-of date (_"Drift +€15,50 · statement 03/06/2026"_) and switches from destructive to **warning (amber) tone when the reading is older than 45 days** — an old anchor is age, not breakage (shared `useDriftBadge` helper; same text + tone on the hub cards, the detail header, and the dashboard `BankBalancesWidget` chips, so the surfaces cannot disagree).

If a current exchange rate is missing, `computed_balance` is a partial converted total: the
unsupported partition is excluded, its native amount remains visible on the account card, and the
account, group, and net-cash totals are marked incomplete. Merge previews use the same rule. Vision never
treats an unavailable rate as 1:1 for these account surfaces
([[docs/adr/127-no-synthetic-fx-for-account-totals|ADR-127]]).

The dialog:

- **Fresh statement reading** — an amount + as-of-date input (defaults to today) with a **live drift preview** (`entered − reconcilable balance`, rounded to cents half-away-from-zero for display while each reading stores `NUMERIC(18,4)`). _Save reading_ PUTs the selected currency to `/api/accounts/:id/statement-balances/:currency`; the legacy scalar account fields remain an atomic compatibility projection of the declared-currency row. Raw input is shape-validated before parsing so typos (`12,,3`, `1234..56`) and calendar-invalid ISO dates can never reach PostgreSQL. A reading dated **before today** renders an amber warning — activity after that date is already in the computed balance, so an adjustment would double-count it — with the ledger exit emphasized as the recommended path. On an unanchored account, _Record as opening balance_ also follows a valid fresh amount/date; the stored statement remains the fallback only while no reading draft exists, so an invalid or date-less draft can never silently backfill a different figure.
- **Accept computed balance** — rewrite the stored statement figure to the native reconciliation base (`reconcilable_balance`; no transaction created).
- **Add adjustment transaction** — keep the statement as truth; the server stamps one balancing ledger row.
- **Show transactions since {date}** — deep-links to `/accounts/:id?since={statement date}` (the fresh reading's date when one is entered, else the stored anchor's).

When a fresh reading is entered, both resolutions PUT that currency's reading first so the resolved drift equals the preview; a reading that already matches the ledger (inside the server's half-cent epsilon) is saved without a reconcile call. Resolutions go through `POST /api/accounts/:id/reconcile` and collapse the selected currency's drift to 0. Multi-currency accounts expose Reconcile even when the declared-currency drift is zero, so another currency's reading remains reachable. On new accounts the statement fields no longer appear in the create dialog — a starting figure is recorded via the opening-balance field; invalid non-empty amounts block account creation with localized feedback instead of silently dropping the opening entry. Later statements arrive through Reconcile (edit-Advanced keeps the raw compatibility fields).

## Lifecycle: edit · opening balance · merge · close · archive · delete

All from the detail route's header menu (WP-B4):

- **Edit** — the account form in edit mode (PATCH; emptied fields sent as explicit null to clear).
- **Set opening balance** — seeds/updates the statement anchor so manual/cash accounts get meaningful balances and drift.
- **Merge into…** — repoints transactions/planned/holdings/funding onto a surviving account and deletes the source (irreversible; per-tree cache invalidation via `invalidateAccountRepoint`).
- **Close account** — transfers holdings if any, then archives (`is_active=false`; closed accounts also leave net worth per WP-A3 semantics). **Archive/Restore** toggles listing without the residual-balance flow.
- **Delete** — hard delete; a 409 (still referenced) routes to the close flow instead of dead-ending.

## Transactions-page account filter

The Transactions page's actions bar has an **Account** combobox (`AccountFilterCombobox`) that sets the `account_id` query filter (FK-exact, ADR-088) plus a human-readable `filter_label` for the filter banner; "All accounts" clears it. Archived accounts are listed (their history stays reachable). The page requests `include_balance=true` and shows explicit **Currency** and **Running balance** columns. Balances stay independent per account and currency even in an all-account list.

## Testing

- `apps/frontend/src/pages/__tests__/AccountDetailPage.integration.test.tsx` — header/balance/provenance, running-balance column, header menu verbs, drift chip → Reconcile, Holdings placeholder, `?since=` narrowing + clear, not-found state.
- `apps/frontend/src/pages/__tests__/AccountsPage.integration.test.tsx` — grouped hub, card→route navigation, reduced hub menu, `?account=` forwarding.
- `apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx` — Account filter sets/clears `account_id`.
- `apps/node-backend/tests/routes/transactions.test.js` — `include_balance` threading + `running_balance` on/off the wire.
- `apps/frontend/src/features/accounts/__tests__/groupAccounts.test.ts` — grouping/subtotal/Net-cash math.

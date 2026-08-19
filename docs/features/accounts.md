---
title: Accounts
type: feature
status: active
date: 2026-07-22
updated: 2026-08-19
tags: [feature, accounts, adr-088, adr-094, adr-105, adr-107, balances, reconciliation, ledger, running-balance, provenance, wp-b2, wp-b3, wp-b4]
aliases: [accounts-feature, account-hub, account-ledger, bank-accounts]
description: The budgeting accounts surface — grouped hub, per-account ledger route with running balance, balance provenance, drift reconciliation, and account lifecycle (open/edit/merge/close/archive/delete). Rebuilt under ADR-107 as a Glance → Overview → Ledger architecture with one balance definition everywhere.
related_code: ["apps/frontend/src/pages/AccountsPage.tsx", "apps/frontend/src/pages/AccountDetailPage.tsx", "apps/frontend/src/features/accounts/", "apps/frontend/src/hooks/useAccounts.ts", "apps/node-backend/src/routes/accounts.js", "apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/repositories/transactionRepository.js", "apps/node-backend/src/lib/accountBalanceSql.js"]
---

# Accounts

The budgeting accounts surface: every bank/cash/liability entity ([[docs/adr/088-accounts-entity|ADR-088]]), its computed balance, and the workflows for keeping those balances trustworthy. Rebuilt under [[docs/adr/107-accounts-budgeting-ux-remake|ADR-107]] around three questions — *what do I have* (hub), *is it right* (ledger + provenance), *how do I fix it* (reconcile).

## Architecture: Glance → Overview → Ledger

| Level | Surface | Route |
|-------|---------|-------|
| Glance | Dashboard `BankBalancesWidget` — same numbers/names/population as the hub | `/` |
| Overview | Grouped accounts hub | `/accounts` |
| Ledger | Per-account detail with running-balance ledger | `/accounts/:id` |

All three render the **same balance definition**: the ADR-094 anchor+delta computed balance (most recent stamped statement balance + active entries after it; plain sum when unstamped), served by `accountBalanceSql.js`'s lateral on the accounts list endpoint.

## The hub (`/accounts`)

- **Groups** (WP-B3, fixed order): *Cash & Savings* (checking · savings · pension) → *Portfolio accounts* (brokerage · crypto_exchange · wallet) → *Liabilities* → *Archived* (collapsed; any `is_active=false` account regardless of type). Cards sort by display label within a group (`groupAccounts.ts`, unit-tested).
- **Per-group subtotals** convert each account's computed balance to the display currency; the grand **Net cash** line sums active, `in_net_worth` non-portfolio accounts — the same population as the net-worth Liquid + Liabilities figures.
- **Portfolio-type cards** show "Tracked in Portfolio →" instead of a misleading €0,00 ledger balance (real holdings values arrive with the portfolio-accounts-v2 work, [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]]).
- **Card interactions** (WP-B4): a single click (or Enter/Space on the focused card) navigates to `/accounts/:id`. The card's ⋯ menu is the keyboard/touch-accessible equivalent and keeps exactly the hub-level verbs: **View details**, **View transactions** (account-filtered Transactions page), and **Reconcile balance** (only while drift ≠ 0). Everything lifecycle-shaped moved to the detail route's header menu.
- The **drift badge** on a card (statement vs computed disagreement, ADR-094) opens the Reconcile dialog directly.
- **Add account** stays in the page header.
- Legacy deep-links `/accounts?account=<id>` forward (replace) to `/accounts/<id>`.

## The ledger route (`/accounts/:id`) — WP-B4

Lazy-loaded like every page (`routePreload.ts` → `App.tsx`). Content:

- **Header**: display name; type · currency · institution subline; archived badge when inactive; a header **actions menu** with *Edit*, *Set opening balance*, *View transactions*, *Merge into…*, *Close account*, *Archive/Restore*, *Delete* (moved here from the hub cards). Delete on a still-referenced account (409) routes into the close flow, same as the hub used to.
- **Balance card**: the computed balance with its provenance subline (below), the **drift chip** (click → Reconcile dialog), and a **sparkline** of the running-balance series drawn from the ledger rows themselves (most recent ≤100 rows, chronological; green/red/neutral by trend) — no extra endpoint.
- **Holdings placeholder** (portfolio-type accounts only): a muted locked section above the ledger; it is fed with real per-broker holdings later (ADR-108). Portfolio-type accounts also show "Tracked in Portfolio →" instead of a cash balance.
- **Running-balance ledger**: the account's full transaction list, newest first, in a table with Date · Description (recipient + memo) · Category · Amount · **Balance**. Loads 100 rows at a time ("Load more" grows the window).
- **Details card**: type, currency, owner, liquidity, tax wrapper, institution, spendable, in-net-worth.
- Accounts with `has_transactions=false` (portfolio shells) explain that their activity lives in the portfolio, not the ledger.

### Running balance semantics

The ledger queries `GET /api/transactions?account_id=<id>&include_balance=true&sort_by=date&sort_dir=desc`. `include_balance=true` makes the repository add

```sql
SUM(t.amount) OVER (PARTITION BY t.account_id ORDER BY t.date ASC, t.id ASC) AS running_balance
```

- The window is **partitioned by account** (a running balance is a per-account figure) and **always ordered chronologically**, independent of the display sort — each row's `running_balance` is the balance *after* that transaction.
- It is evaluated over the full filtered set **before** LIMIT/OFFSET, so values stay correct across pages.
- Because the window only sees WHERE-filtered rows, the route never applies a server-side date filter to the ledger — a `start_date` would restate history from zero. The `?since=` narrowing (below) is client-side for exactly this reason.
- The wire field is `running_balance` (present only under `include_balance=true`); it is distinct from the row's stored `balance` column, which is import-pipeline-only (see [[docs/features/transactions|Transactions]]).
- This route is the first frontend consumer of `include_balance` on the JSON list endpoint; the flag previously fed only the CSV export.

### `?since=YYYY-MM-DD` deep-link

`/accounts/:id?since=2026-06-03` narrows the ledger to rows dated on/after the given day (a dismissible banner shows the active narrowing). This is the landing target for the Reconcile dialog's *"Show transactions since {statement date}"* exit (wired since WP-B1's completion). Rows are compared as plain `YYYY-MM-DD` strings (no local-midnight shift), and Load-more stops once rows older than the cut-off are loaded.

## Balance provenance (WP-B2)

Every rendered current balance carries a muted subline (`useBalanceProvenance`):

- stamped: *"as of {date} bank statement + {n} entries since"*
- unstamped: *"sum of {n} entries"*

fed by `anchor_date` / `post_anchor_count` from the accounts list endpoint. Shown on hub cards, the detail header, the Reconcile dialog's computed row and the dashboard widget.

## Reconcile

The drift badge/chip (`statement_balance − computed_balance`, ADR-094) opens the Reconcile dialog. The badge itself carries the statement's as-of date (*"Drift +€15,50 · statement 03/06/2026"*) and switches from destructive to **warning (amber) tone when the reading is older than 45 days** — an old anchor is age, not breakage (shared `useDriftBadge` helper; same text + tone on the hub cards, the detail header, and the dashboard `BankBalancesWidget` chips, so the surfaces cannot disagree).

The dialog:

- **Fresh statement reading** — an amount + as-of-date input (defaults to today) with a **live drift preview** (`entered − computed`, rounded to cents half-away-from-zero for display while `statement_balance` stores `NUMERIC(18,4)` after migration 0088). *Save reading* PATCHes `statement_balance`/`statement_balance_date` through the normal account update path. Raw input is shape-validated before parsing so typos (`12,,3`, `1234..56`) can never pass as money. A reading dated **before today** renders an amber warning — activity after that date is already in the computed balance, so an adjustment would double-count it — with the ledger exit emphasized as the recommended path.
- **Accept computed balance** — rewrite the stored statement figure to the computed one (no transaction created).
- **Add adjustment transaction** — keep the statement as truth; the server stamps one balancing ledger row.
- **Show transactions since {date}** — deep-links to `/accounts/:id?since={statement date}` (the fresh reading's date when one is entered, else the stored anchor's).

When a fresh reading is entered, both resolutions PATCH it first so the resolved drift equals the preview; a reading that already matches the ledger (inside the server's half-cent epsilon) is saved without a reconcile call. Resolutions go through `POST /api/accounts/:id/reconcile` and collapse the drift to 0. On new accounts the statement fields no longer appear in the create dialog — a starting figure is recorded via the opening-balance field; later statements arrive through Reconcile (edit-Advanced keeps the raw fields).

## Lifecycle: edit · opening balance · merge · close · archive · delete

All from the detail route's header menu (WP-B4):

- **Edit** — the account form in edit mode (PATCH; emptied fields sent as explicit null to clear).
- **Set opening balance** — seeds/updates the statement anchor so manual/cash accounts get meaningful balances and drift.
- **Merge into…** — repoints transactions/planned/holdings/funding onto a surviving account and deletes the source (irreversible; per-tree cache invalidation via `invalidateAccountRepoint`).
- **Close account** — transfers holdings if any, then archives (`is_active=false`; closed accounts also leave net worth per WP-A3 semantics). **Archive/Restore** toggles listing without the residual-balance flow.
- **Delete** — hard delete; a 409 (still referenced) routes to the close flow instead of dead-ending.

## Transactions-page account filter

The Transactions page's actions bar has an **Account** combobox (`AccountFilterCombobox`) that sets the `account_id` query filter (FK-exact, ADR-088) plus a human-readable `filter_label` for the filter banner; "All accounts" clears it. Archived accounts are listed (their history stays reachable). This replaced the interim idea of a running-balance column on the Transactions page — running balance lives on the account ledger route only.

## Testing

- `apps/frontend/src/pages/__tests__/AccountDetailPage.integration.test.tsx` — header/balance/provenance, running-balance column, header menu verbs, drift chip → Reconcile, Holdings placeholder, `?since=` narrowing + clear, not-found state.
- `apps/frontend/src/pages/__tests__/AccountsPage.integration.test.tsx` — grouped hub, card→route navigation, reduced hub menu, `?account=` forwarding.
- `apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx` — Account filter sets/clears `account_id`.
- `apps/node-backend/tests/routes/transactions.test.js` — `include_balance` threading + `running_balance` on/off the wire.
- `apps/frontend/src/features/accounts/__tests__/groupAccounts.test.ts` — grouping/subtotal/Net-cash math.

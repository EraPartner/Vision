---
title: "ADR-181: Home, Transactions and New Transaction adopt the design system"
type: adr
status: accepted
date: 2026-10-06
tags:
  [
    adr,
    frontend,
    home,
    dashboard,
    transactions,
    inspector,
    sheet,
    transfers,
    keyboard-shortcuts,
    design-system,
    adr-178,
    adr-179,
    adr-180,
  ]
description: Home opens with a month-to-date hero, a Needs attention list and the money that matters; Transactions gets filter chips, a View menu and a docked inspector in place of the info dialog and per-row icon columns; the add dialog becomes a New Transaction sheet that records expenses, income and transfers and opens from N everywhere on the web.
aliases: [adr-181, home redesign, transactions inspector, new transaction sheet, redesign step 3]
---

# ADR-181: Home, Transactions and New Transaction adopt the design system

## Status

Accepted. Third step of the redesign roadmap that started with
[[docs/adr/178-design-system-role-tokens|ADR-178]],
[[docs/adr/179-primitives-adopt-role-tokens|ADR-179]] and
[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]].

## Date

2026-10-06

## Context

The budgeting dashboard opened with four statistic cards, a bank-balance strip and three
charts, and the only Home-specific action was a *Widgets* button. The question it should answer
first, "how is this month going and what needs me", was spread across pages.

The Transactions page carried its controls as a row above the table (account filter, *Include
inactive* switch, *Add transaction*) and put three icon columns on every row (info, split and
delete) plus a status toggle. Details opened in a modal `TransactionInfoDialog` that hid the
list behind it, and categorising an uncategorised row meant inline-editing a cell or opening
that dialog.

Adding a transaction used a modal form with every field at the same weight, no way to record
income without typing a sign, and no way to record a transfer between two accounts at all
(the API has had a transfer-link endpoint since
[[docs/adr/088-account-entity|ADR-088]]). The desktop app bound ⌘N to the dialog; the web
app had no shortcut and the command palette no action.

The owner's parity rule for the redesign holds: nothing a user can do today may become
impossible, and every moved action must stay reachable. The owner also decided earlier that
expenses render in the text colour with a minus and income in gold with a plus, and that the
delete confirmation stays until Undo restores attachments, splits and planned links.

## Decision

### Home

`DashboardPage` becomes a greeting ("Good morning", with the long date) followed by widgets
that each own one question, in `apps/frontend/src/features/dashboard/`:

| Widget id            | Component                 | Source                                                   | Default |
| -------------------- | ------------------------- | -------------------------------------------------------- | ------- |
| `hero`               | `MonthToDateHero`         | `GET /api/aggregations/average-vs-current` + rest-of-month planned rows | shown |
| `attention`          | `NeedsAttentionList`      | uncategorised count, planned match suggestions, stale accounts (no transaction for 30 days) | shown |
| `netWorth`           | `NetWorthCard`            | `GET /api/info/net-worth`                                | shown   |
| `upcoming`           | `UpcomingPaymentsList`    | `useUpcomingPlannedPayments` (seven-day window, top five) | shown   |
| `accounts`           | `AccountsList`            | active accounts, top six, with balance provenance        | shown   |
| `recentTransactions` | `RecentTransactionsList`  | last five active rows, exclusion toggle                  | shown   |
| `statCards`          | `NetSummaryCard` + `StatCard` ×3 | unchanged                                         | hidden  |
| `bankBalances`       | `BankBalancesWidget`      | unchanged                                                | hidden  |
| `monthlyTrends`, `categoryPie`, `cashflowComparison` | unchanged charts | unchanged                        | shown   |

The hero shows the amount spent since the first of the month, a sentence comparing the
projected total with the six-month average, income so far and the planned money still due in
and out before month end, and a small cumulative line against the typical month. The
endpoint takes no exclusion parameters, so the settings-level exclusions do not apply to the
hero; the charts below it still honour them. Every row in Needs attention, Next 7 days,
Accounts and Recent transactions is a link into the page that handles it; a recent row opens
Transactions with that row selected.

The *Widgets* button becomes a *Customize…* item in a ••• menu next to *Add transaction*.
Widget visibility keeps the `widget_visibility` setting and the `dashboard` page key, so
existing choices survive; the two widgets that are hidden by default stay one switch away.

### Transactions

`TransactionsPage` is rebuilt around a selected row:

- **Toolbar chips** (`TransactionsToolbar`): account, category (tree picker), date (Any, This
  month, Last month, This year; a custom range from the URL or the search suggestions shows as
  its own chip), type (income and expenses, income, expenses) and *Needs category* with its
  live count. The chips write the same URL parameters the page always read, so deep links and
  the filter banner are unchanged.
- **View menu**: *Include inactive* (formerly the switch) and optional columns Tags, Currency,
  Running balance and Status, stored through `useWidgetVisibility` under the page key
  `transactionsColumns`, plus *Reset columns*.
- **Inspector** (`TransactionInspector`): clicking a row, or moving row focus with the arrow
  keys, selects it (`VirtualDataTable` gained `onRowSelect` and `selectedRowKey`, and rows carry
  `aria-selected`). The inspector docks beside the table from 1024px and opens as a sheet
  below that. It carries the recipient, date, account and amount at the top; *Category and
  payee* with the two pickers and two tips (apply the chosen category to the payee's other
  uncategorised rows, or make it the payee's default); *Details* with the same pencil-edit
  fields the dialog had (date, description, amount, currency, bank account, comment) plus the
  read-only balance and id; Tags; Attachments; and a footer with Split, Duplicate, Show all
  from payee, Mark inactive and Delete.
- **Rows**: the info, split and delete icon columns and the status toggle column are gone. The
  recipient cell shows the memo as a subline, the category cell shows the category colour dot
  or *Needs category*, and the account cell shows the account. Inline editing, the context
  menu (Info, Quick Look, Edit in row, Duplicate, Show all from payee, Mark inactive, Delete),
  bulk actions, search suggestions, column sorting and filtering, the filter banner exports
  and infinite scroll are unchanged. Delete keeps its confirmation and its undo toast.

### New Transaction

`AddTransactionDialog` is replaced by `AddTransactionSheet` (a right-hand `Sheet`), opened by
`AddTransactionButton` on Home and Transactions, by `/transactions?new=1`, by the bare `N` key
anywhere in the web app outside inputs and overlays, by the command palette's *New
transaction* action and, on desktop, by ⌘N as before (browsers reserve ⌘N, so the web key is
bare). A segmented control chooses **Expense**, **Income** or **Transfer**; the amount is a
magnitude and the kind supplies the sign, so a typed minus no longer flips an expense into
income. Date is a Today / Yesterday / Other date… chip row with the calendar behind the third.
The primary button names the result (*Add expense*, *Add income*, *Add transfer*) and the
footer hint names the next missing field. A payee's default category fills the category
automatically and says so; the backdated-before-anchor note, the duplicate prompt with *Add
anyway*, the unsaved-changes guard and the focus-first-invalid-field behaviour are kept.

A transfer takes a from and a to account and posts two legs through
`useCreateTransfer`: an outflow on the sending account and an inflow on the receiving one,
each with a recipient named after the counterpart account (created on first use), then links
them with `POST /api/transactions/transfers`. Validation is a Zod discriminated union on the
kind (`addTransactionForm.ts`) so every missing field reports in one pass.

### Left for later steps

The copy pass (EN/NL labels), the Portfolio + Performance merge, Net worth, Import, Planned,
Statistics and the Settings window are the next roadmap steps. Day grouping in the
transactions list, custom date ranges from the date chip, and a per-row transfer badge were
considered and deferred.

## Consequences

**Positive.** Home answers "how is the month going and what needs me" without scrolling.
Categorising a row is one click plus one picker, with the list still visible. Income and
transfers are recorded without sign gymnastics or a second screen. Every action on the three
screens is still reachable, most from more than one place.

**Negative.** The transfer legs reuse the recipient table for the counterpart account name, so
recipient lists gain one row per account used in a transfer. The hero ignores exclusions. Two
former default widgets (summary cards, bank balances) must be switched on by users who relied
on them.

**Neutral.** `AddTransactionDialog`, `TransactionInfoDialog` and `TableActions` are removed with
their tests; `AddTransactionSheet.integration.test.tsx`, `TransactionInspector.test.tsx`,
`TransactionsPage.integration.test.tsx` and `DashboardPage.integration.test.tsx` cover the new
surfaces. The MSW contract for `average-vs-current` now matches the backend shape.

## Related

- [[docs/adr/178-design-system-role-tokens|ADR-178]] — tokens
- [[docs/adr/179-primitives-adopt-role-tokens|ADR-179]] — primitives used here
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] — navigation step
- [[docs/adr/088-account-entity|ADR-088]] — accounts and transfer links
- [[docs/features/transactions|Transactions feature]]
- [[docs/adr/index|All ADRs]]

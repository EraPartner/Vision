---
title: "ADR-183: Portfolio, Net worth, Insights, Import, Planned and Settings adopt the design system"
type: adr
status: accepted
date: 2026-10-06
tags:
  [
    adr,
    frontend,
    portfolio,
    performance,
    net-worth,
    statistics,
    insights,
    import,
    planned,
    settings,
    design-system,
    adr-178,
    adr-179,
    adr-180,
    adr-181,
    adr-182,
  ]
description: The Portfolio overview and the Performance page merge into one Portfolio screen with a period hero, four explained return figures, a holdings list and a stacked allocation bar; Net worth opens with assets and debt as two bars; Statistics is titled Insights with one period control and a ••• menu; Import asks for the file first and gates its button; Planned says Mark as paid, puts row actions in a menu and makes pausing undoable; Settings reads as a sectioned window.
aliases: [adr-183, portfolio merge, insights, import redesign, planned redesign, settings window, redesign step 5]
---

# ADR-183: Portfolio, Net worth, Insights, Import, Planned and Settings adopt the design system

## Status

Accepted. Fifth step of the redesign roadmap that started with
[[docs/adr/178-design-system-role-tokens|ADR-178]],
[[docs/adr/179-primitives-adopt-role-tokens|ADR-179]],
[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]],
[[docs/adr/181-home-transactions-redesign|ADR-181]] and
[[docs/adr/182-ui-copy-plain-words|ADR-182]].

## Date

2026-10-06

## Context

After step 3 the remaining screens still carried the pre-design-system layout: a Portfolio
overview page with six statistic cards and a donut, a separate Performance page with its own
total-value card and period control, a Net worth page that explained percentages of net worth
in a paragraph, a Statistics page with a Select for the window and two header buttons, an
Import card that asked for the bank before the file and let the Import button be clicked
before anything was chosen, a Planned page with an icon-only execute button and three icon
columns per row, and a Settings dialog with a description paragraph, a save hint and a Done
button.

The owner's rules for the redesign hold: adopt the design system completely on every screen
and every dialog it opens, and never cut functionality. Every action that existed must stay
reachable.

## Decision

### Portfolio: one screen

`PortfolioOverviewPage` and `PerformancePage` are replaced by `PortfolioPage` at `/portfolio`.
`/portfolio/performance` redirects there, keeping its query string, and the Wealth section loses
its *Performance* entry (`lib/navigation.ts`).

- **Header**: title *Portfolio*, subtitle "{n} investments · prices as of {time}", a Refresh
  prices icon button, a ••• menu (Export PDF…, Customize…, Import history) and the primary
  *Add investment*.
- **Hero**: the total value, the gain for the chosen period, a segmented period picker (1M, 3M,
  6M, 1Y, 3Y, All; URL `period`, default `all`) and one scrubbable value chart with the
  invested amount dashed. Changing the period changes the hero number, the chart and every
  period-scoped widget. The period gain is derived from the period's snapshots as the value
  change minus the net contributions; *All* uses the live totals.
- **Four figures** with ⓘ explanations: Total return, Per year (since the first transaction
  or snapshot), After inflation (a dash and "Inflation data missing" when there is no
  inflation series) and Realized (a dash and "No sales yet" when nothing was sold).
- **Holdings**: `List` rows with an asset-class glyph, the name, "class · symbol", the value
  and the return; a *Value | Return* sort control; the broker filter; row activation opens the
  detail dialog and a row ••• menu holds Details, Add transaction, Archive (confirmed) and
  Delete (destructive confirmation). The oversold badge, the unassigned-lots nudge and the
  subtotal footer stay.
- **Allocation**: one stacked bar by asset class with amounts and shares and a Rebalance link;
  the donut is gone.
- **Widgets** (page key `portfolio`, ids kept where the meaning is unchanged): ticker,
  exposure, value by class with the FX-neutral switch (URL `fx_neutral`), by broker, relative
  performance, breakdown with heatmap and top and bottom performers, *Gains, income and costs*
  (every component the six cards showed: invested, unrealized, asset gain, currency effect,
  realized, income, fees, taxes), news and archived investments with restore. The `summaryCards`
  id is dropped because the hero and figures are always visible.

### Net worth

The page opens with a hero: the net worth, its monthly change and freshness, and the all-time
change. Below the number two bars read as a subtraction: *Assets* (cash and savings plus
investments, with both amounts in the caption) and *Debt* (liabilities); a zero component shows
a dash instead of a bar. The "% of net worth" shares and their explanation are gone. *By
account* becomes a `List` with the account type as subtitle and an *Assign to an account* link
on the Unassigned row. The chart keeps its period picker, now a segmented control. Extremes,
the daily table, print attributes, the stale-prices banner and the empty state are unchanged.

### Statistics becomes Insights

The navigation label and page title read *Insights* (Dutch *Inzichten*); the route stays
`/statistics`. The window is a segmented control (*Last 24 months* | *All time*, same URL
param), Export PDF… and Customize… live in a ••• menu, the tabs stay. `MonthlyRhythm` labels
the current partial month "so far" and leaves it out of Best month and Worst month.

### Import

The import card asks for the file first, then the bank, then the custom setup when the custom
parser is chosen. The Import button is enabled only when the file, the bank and, for a custom
parser, a valid mapping are present; the footer hint names what is missing. The receipt after a
commit links to the imported rows on Transactions by their date span, because Transactions has
no per-batch filter. The review page gains a legend for its match badges and a *Discard* button
that rolls the batch back through `DELETE /api/import/batches/:id` after a destructive
confirmation.

### Planned

The page is titled *Planned*. Each row carries a worded *Mark as paid* button, a *Paid* badge
linking to the transaction once paid, a *Paused* badge, and a row ••• menu with Edit, Pause or
Resume and Delete; the status toggle column is gone. Pausing and resuming act at once and show
an undo toast. Delete keeps its confirmation because there is no restore endpoint. *Mark as
paid* opens the link dialog retitled "Mark {name} as paid"; the execute route still requires a
transaction, so the dialog explains that one is chosen or created. The add and edit form is a
right-hand sheet whose primary button names the result. *Include paused* is a View menu item
and the payment history sits in the page ••• menu. The empty state names one action.

### Settings window

`DashboardSettingsDialog` keeps its name, its `?settings=<section>` contract and its keyboard
handling but reads as a window: a `List` sidebar of sections, a title bar carrying the section
name (the dialog's accessible name stays *Settings*), no description, save hint or Done button
(the window closes with the X or Escape), and every section rebuilt on Card, List and the type
ramp. Admin and Monitors stay where they are.

### Shared changes

`ChartPeriodSelector` is built on `SegmentedControl` (a radio group). `ExportDialog` accepts a
`null` trigger with `open`/`onOpenChange`; `AddInvestmentDialog` accepts a `trigger`;
`InvestmentDetailDialog` accepts controlled `open`/`onOpenChange`. `ListRow` with `asChild` no
longer renders its child twice.

## Consequences

**Positive.** Portfolio answers "what is it worth and how is it doing" on one screen with one
period. Every action on the six screens is still reachable, most from a worded button or a menu
rather than an icon. Import can no longer be started without a file. Planned actions read in
words and pausing is reversible.

**Negative.** Users who relied on `/portfolio/performance` land on `/portfolio`. The six
Portfolio summary cards are now a widget plus the hero. `TotalValueCard` and
`netContributionSparkline` are no longer used by a page and wait for removal.

**Neutral.** `PortfolioOverviewPage`, `PerformancePage`, `NetWorthByAccountTable` and their
tests are removed; `PortfolioPage.integration.test.tsx`, `NetWorthByAccountList.test.tsx`,
`MonthlyRhythm.test.tsx` and the rewritten Statistics, Import, Planned and Settings tests cover
the new surfaces.

## Related

- [[docs/adr/181-home-transactions-redesign|ADR-181]] — previous screen step
- [[docs/adr/182-ui-copy-plain-words|ADR-182]] — vocabulary used here
- [[docs/adr/125-provisional-latest-portfolio-snapshot|ADR-125]] — provisional snapshot note kept in the hero
- [[docs/features/portfolio|Portfolio feature]], [[docs/features/net-worth|Net worth]],
  [[docs/features/statistics|Insights]], [[docs/features/import|Import]],
  [[docs/features/plannedTransactions|Planned]], [[docs/features/settings|Settings]]
- [[docs/adr/index|All ADRs]]

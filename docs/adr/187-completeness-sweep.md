---
title: "ADR-187: Every remaining screen and dialog adopts the design system"
type: adr
status: accepted
date: 2026-10-07
tags:
  [
    adr,
    frontend,
    design-system,
    accounts,
    categories,
    payees,
    owes,
    tax,
    portfolio,
    research,
    analysis,
    ai-chat,
    admin,
    adr-178,
    adr-179,
    adr-180,
    adr-181,
    adr-182,
    adr-183,
  ]
description: The final redesign step audits every screen and dialog that earlier steps left on the old layout and moves them onto the design system without cutting an action. Money pages, taxes, portfolio assets and imports, research, analysis, AI chat, admin tools and the shared components get PageHeader with one primary action and a ••• menu, List rows with row menus, SegmentedControl and Select instead of raw controls, Alert and EmptyState for states, and undo or confirm per action. Navigation labels read in sentence case.
aliases: [adr-187, completeness sweep, redesign step 6, redesign final]
---

# ADR-187: Every remaining screen and dialog adopts the design system

## Status

Accepted. Sixth and final step of the redesign roadmap that started with
[[docs/adr/178-design-system-role-tokens|ADR-178]],
[[docs/adr/179-primitives-adopt-role-tokens|ADR-179]],
[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]],
[[docs/adr/181-home-transactions-redesign|ADR-181]],
[[docs/adr/182-ui-copy-plain-words|ADR-182]] and
[[docs/adr/183-remaining-screens-redesign|ADR-183]].

## Date

2026-10-07

## Context

Steps 1 to 5 redesigned the primitives, the navigation, Home, Transactions, the copy and the
six most-used screens. Roughly half of the application still sat on the earlier layout: the
Accounts, Categories, Payees and Who owes you pages and their dialogs; the Taxes page, the
tax-profile wizard and Portfolio taxes; the asset pages (stocks, crypto, metals, real estate,
savings, rebalance), the portfolio import flow and every portfolio dialog; the research pages;
the analysis workspace, monitors and AI chat; the admin pages and the table editor; the
onboarding wizard, the devtools and about forty shared components. These surfaces mixed raw
`<button>`, `<select>` and `<details>` elements with ad-hoc Tailwind sizes, palette colours,
`ring-2` focus styles and icon-only row actions, and a few still called `window.confirm`.

The owner's rules for the redesign hold: adopt the design system completely on every screen
and every dialog it opens, and never cut functionality. Every action that existed must stay
reachable, and the UI should read as premium, clean and self-explanatory.

## Decision

Every remaining screen and dialog is moved onto the primitives and conventions of ADR-178 to
ADR-183. The same shape applies everywhere:

- **Page**: `PageShell` and `PageHeader` with the title, an optional subtitle, one primary
  `Button` and a ••• `DropdownMenu` for secondary actions (export, refresh, history, settings).
- **Rows**: `List` and `ListRow` (or a `Table` primitive where columns matter) with a row •••
  menu that holds every per-row action, destructive items last after a separator. Icon-only
  row buttons are gone except where noted below.
- **Controls**: `SegmentedControl` for two to five mutually exclusive options, Radix `Select`
  for longer lists, `Switch` and `Checkbox` for booleans, `Input`, `Textarea` and `Label` for
  fields. Raw `<select>` elements remain only in `PortfolioImportSession` (five, driven by
  tests through `selectOptions`; follow-up) and as hidden file inputs behind a `Button`.
- **States**: `Skeleton` while loading, `Alert` for errors and notices, `EmptyState` with one
  action when a list is empty, `StateBlock` and `PageError` where a page cannot render.
- **Reversibility**: an action with a client-side or server-side restore path acts at once and
  shows an undo toast (category and payee status, chart-builder layout and life-scenario
  deletes); an action without a restore path keeps a destructive confirmation through
  `useConfirmDialog` (deleting analyses, monitors, dossiers, research documents, holdings).
  `window.confirm` is no longer used.
- **Typography and shape**: the type ramp, role tokens, `rounded-chip`/`rounded-control`/
  `rounded-card` and `focus-ring` replace raw sizes, palette colours and `ring-2`. Menu and
  calendar items derive their radius from the card token.

### Per area

- **Accounts, Categories, Payees, Who owes you.** Accounts is a `List` per account type with a
  Net cash card; *Add account* opens a right-hand `Sheet` (the `AddAccountDialog` export name
  stays). Categories and Payees move *Show inactive*, *Expand all* and *Uncategorized only* into
  a View menu, keep URL state, and put Edit, Merge, Match rules, Unmerge, Mark active or
  inactive (undoable) and Delete (confirmed) into row menus. Who owes you lists people as rows;
  the detail puts *Settle all* first, *Export CSV* in the ••• menu and a worded *Record payment*
  button that keeps the payment icon. The split dialog's Equal | Custom choice is a segmented
  control.
- **Taxes.** The year switcher stays a `DropdownMenu` with status badges; Freeze, Mark as
  filed, View history, Export CSV, Export PDF and Customize sit in the ••• menu; *Set up* or
  *Edit tax profile* is the primary. The profile wizard is a `Sheet` with a segmented step
  picker and a progress line. Portfolio taxes shows one hero instead of six cards, with
  *Manual adjustments* as the primary and the profile editor in the menu.
- **Portfolio assets and imports.** Stocks, crypto, metals, real estate and savings share
  `assetPageParts` (hero figures, fact rows, header actions, holding row menu). *Export PDF*
  moves into the header menu, *Import history* is added there, and holding row menus gain
  *Archive* for parity with the Portfolio page. Rebalance's cap checkbox is a `Switch`. The
  import page, session, review and history run on `PageShell` and `Alert`. `TotalValueCard`
  and `netContributionSparkline`, unused since ADR-183, are removed.
- **Research.** Watchlist rows open the chart and carry a ••• menu (Open in Market lookup,
  Remove). Market lookup puts *Add to watchlist* and *Provider mapping* in the header menu.
  Chart builder lists series and indicators as rows with row menus and puts New chart, Copy
  share link and Delete saved layout in the header menu. Dossiers put *Export all* in the menu
  and confirm through `useConfirmDialog`. Forecast and life-scenario pickers are segmented
  controls and selects.
- **Analysis and AI chat.** The workspace's Visual | SQL switch is a segmented control (the
  *Advanced controls* disclosure that hid the SQL button is gone); pickers are selects;
  results, pivots and workbench reports use the `Table` primitive; saved analyses have a row
  menu whose Delete confirms. Monitors list conditions as rows with Check now, Enable or
  Disable and Delete in a row menu. AI chat keeps both modes mounted behind a segmented switch
  so drafts survive switching; the investigation panel is rebuilt on primitives.
- **Admin and shared.** Database maintenance and the table editor move Refresh into the
  header menu and per-row actions into row menus (Run vacuum, Browse rows; Revert changes,
  Mark for deletion). The sidebar's raw buttons become ghost `Button`s with ADR-180 behaviour
  unchanged. `WidgetVisibilityDialog` is a `List` of `Switch` rows; `ShortcutsOverlay`,
  `AttachmentPanel`, `TagInput`, the comboboxes, `VirtualDataTable`, the notifications, the
  onboarding wizard and the devtools adopt the primitives. Devtools copy stays English because
  they are development-only.

### Navigation labels

ADR-182 exempted navigation labels from sentence case. Main carried a mix (*AI Chat*, *Chart
Builder*, *Who Owes You* beside *Net worth*, *Planned*). This step puts every navigation label
and its matching page title in sentence case: *AI chat*, *Chart builder*, *Database
maintenance*, *Exchange rates*, *Market lookup*, *Real estate*, *Research home*, *Savings &
bonds*, *Who owes you*. Proper names (*Belgium*) are unaffected.

### Kept as is, deliberately

Native `<details>` disclosures (forecast assumptions, chart options, dossier link pickers,
template chooser) are restyled, not replaced. `Tabs` stay where they switch genuine content
(Table | Chart | Pivot, detail-dialog tabs). A few raw buttons remain where typography must be
inherited or ARIA roles are fixed: the `TouchDisclosure` trigger, `SymbolSearchResultItem`
(`role="option"`), the virtualized devtools request row, and `VirtualDataTable` header sort,
filter and chip buttons (ARIA grid headers), all on `rounded-chip` and `focus-ring`.
`SegmentedButtons`, `UnsavedChangesContext`, `RequireAdmin` and the step-1 primitives were
already on the design system and are untouched.

## Consequences

**Positive.** Every screen and dialog now reads the same way: one primary action, a menu for
the rest, rows with menus, worded actions, consistent states and shapes. Nothing a user could
do before is gone; several actions became reachable from more places (Archive on asset pages,
Import history on asset pages, Enable or Disable on monitor rows, Revert on table-editor rows).
Deletes without a restore path are now confirmed everywhere, including where `window.confirm`
was used.

**Negative.** Users relearn where a few actions live: export and refresh moved into ••• menus,
per-row icons became menus. Segmented controls with five options truncate on very narrow
panels. Five raw selects remain in the import session until a styled native select or a Radix
test helper exists.

**Neutral.** Twenty-one locale keys that no screen referenced were removed; the row-menu,
confirm and toast strings were added in English and Dutch. `TotalValueCard`,
`netContributionSparkline`, `TaxSummaryCard` and their tests are removed; the rewritten page
and dialog tests cover the new surfaces. The primitive wishes gathered during the sweep
(`ListRow` actions slot, `Button size="xs"`, a `Select` none-sentinel helper, a `Disclosure`
primitive, `SegmentedControl` label prop) are follow-ups, not part of this decision.

## Related

- [[docs/adr/183-remaining-screens-redesign|ADR-183]] — previous screen step
- [[docs/adr/182-ui-copy-plain-words|ADR-182]] — copy rules; navigation-label exception closed here
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] — sidebar behaviour preserved
- [[docs/features/accounts|Accounts]], [[docs/features/categories|Categories]],
  [[docs/features/recipients|Payees]], [[docs/features/belgian-tax|Taxes]],
  [[docs/features/portfolio-tax|Portfolio taxes]], [[docs/features/portfolio|Portfolio]],
  [[docs/features/research|Research]], [[docs/features/analysis-workspace|Analysis workspace]],
  [[docs/features/analysis-monitors|Monitors]], [[docs/features/ai-chat|AI chat]],
  [[docs/features/database-maintenance|Database maintenance]]
- [[docs/adr/index|All ADRs]]

---
title: "ADR-180: One labelled sidebar with sections replaces workspaces"
type: adr
status: accepted
date: 2026-10-06
tags:
  [
    adr,
    frontend,
    navigation,
    sidebar,
    sections,
    workspaces,
    command-palette,
    keyboard-shortcuts,
    electron,
    updates,
    design-system,
    adr-099,
    adr-179,
  ]
description: The three workspaces and their switcher give way to one labelled sidebar whose Money, Wealth and Research sections are visible together and individually hideable; icons-only becomes a remembered choice, the topbar loses its theme and update controls to Settings and the palette, and live counts sit on the rows that need attention.
aliases: [adr-180, sidebar sections, labelled sidebar, workspace removal, navigation redesign]
---

# ADR-180: One labelled sidebar with sections replaces workspaces

## Status

Accepted. Supersedes the workspace layout of
[[docs/adr/099-sidebar-navigation-ia|ADR-099]]; its placement rules for cross-workspace
pages still hold inside the new sections.

## Date

2026-10-06

## Context

[[docs/adr/099-sidebar-navigation-ia|ADR-099]] organised the sidebar as three workspaces
(Budgeting, Portfolio, Research) behind a switcher, each with its own `Overview → … → Tools`
groups, and a small workspace-agnostic top zone. The sidebar opened as an icon rail on every
launch, so the labels, the groups and the switcher were hidden until the user expanded it. Pages
in another workspace were two clicks away and the active workspace was persisted per route.

The UI direction for the redesign asks for an Apple-like sidebar: labelled by default, every
area visible at once so the user hides what they do not use instead of switching, section
headers instead of workspace tabs, and the chrome around the page reduced to what the page
needs. The owner also set a parity rule: nothing a user can do today may become impossible, so
every page that had a sidebar entry keeps one, and every action that moves stays reachable.

The topbar carried a theme dropdown (Light, Dark, System, Schedule with its times) and an
update badge that opened its own dialog. Both duplicated Settings › Appearance and Settings ›
About.

## Decision

### One registry, five sections

`apps/frontend/src/lib/navigation.ts` stays the single source of truth and now describes
sections instead of workspaces:

| Section  | Items                                                                                                                                                                                 | Default  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| top      | Home, Transactions, Accounts, Planned Payments                                                                                                                                        | always   |
| Money    | Categories, Recipients, Statistics, Who Owes You, Taxes, Import / Export                                                                                                              | shown    |
| Wealth   | Portfolio, Net Worth, Stocks & ETFs, Crypto, Metals, Real Estate, Savings & Bonds, Performance, Rebalance, Portfolio taxes, Import portfolio history                                 | shown    |
| Research | Research Home, Markets, Market Lookup, Compare, Chart Builder, Forecast, Watchlist, Dossiers, Analysis workspace, Analysis monitors                                                   | hidden   |
| Admin    | Overview, DB Maintenance, Data Sources, Endpoints, Exchange Rates                                                                                                                     | admin on |

The footer holds AI Chat and Settings. A registry test asserts that every parameterless route
in `appRouteManifest` has exactly one entry, that admin routes live only in the Admin section,
and that every non-admin page is offered by the command palette. Two pages that shared a label
across workspaces are renamed so each label is unique: the budgeting dashboard is **Home**, the
portfolio dashboard is **Portfolio**, and the two tax pages are **Taxes** and **Portfolio
taxes**. All other labels wait for the copy pass.

### Labelled by default, icons-only remembered

The sidebar opens with labels. Collapsing it to the icon rail (⌘B, the collapse button, the
logo, the Electron View menu) is remembered in `localStorage` under
`vision.sidebar.collapsed`; the cookie the primitive used to write is gone. Settings ›
Appearance exposes the same choice as a *Sidebar: Labels / Icons only* row. The sidebar
primitive's page gap now follows the open state, which it did not before: an expanded sidebar
used to cover the page.

Each section header carries a *Hide* / *Show* control; hidden sections are stored under
`vision.sidebar.hiddenSections`, with Research hidden until the user shows it. Landing on a
page inside a hidden section (deep link, palette, go-to key, Electron menu) shows that section
and persists it.

Rows are 30px with the ADR-179 chip radius, primary-coloured icons, and a selection fill of
`primary/12%` (light) or `primary/16%` (dark). Rows with a go-to key show it on hover. Four
rows carry live counts from `NavItemBadge`: Transactions (uncategorised, filled),
Planned Payments (due in the next seven days, filled), Statistics (new insights, quiet) and
Analysis monitors (unread, quiet). The Settings row shows a dot when `useUpdateStatus` reports
an update.

### Chrome moves into Settings and the palette

The topbar keeps the sidebar trigger, the page title, a search button on narrow screens and the
background-query indicator. The theme dropdown is removed: the modes live in Settings ›
Appearance, in the palette's Actions group (Light, Dark, System, Schedule) and in the Electron
View › Appearance submenu, which sends a new `set-theme` menu action. The update dialog and
`UpdateNotification` are removed: the Settings dot and the About section read one shared
`update-status` query (polled every five minutes while visible), and About keeps the install,
check and release-notes actions it already had.

### Keyboard, palette and Electron

Go-to keys are unchanged except Home, which moves from `G D` to `G H`. `[` and `]` cycle Home,
Portfolio and Research as they cycled the workspace roots. The palette groups pages as Money,
Wealth and Research instead of per workspace and no longer switches a workspace before
navigating. The Electron Go menu (⌘1–⌘9) and dock menu keep their routes; their first item is
now titled Home.

The canvas tint follows the route (`data-tint="wealth"` under `/portfolio`, otherwise `money`)
instead of the active workspace.

### Left for later steps

Merging Portfolio and Performance, moving Admin into Settings, the Settings window, the
onboarding wizard and the label copy pass are later steps of the redesign roadmap.

## Consequences

**Positive.** Every page is one click away and visible by name; the user prunes the sidebar
instead of switching modes. Deep links, shortcuts and the Electron menus need no workspace
state. The topbar is quieter and its removed controls are each reachable from at least two
places. Window state (collapsed, hidden sections) survives relaunches without touching the
server-side settings.

**Negative.** With Money and Wealth both shown, the sidebar scrolls on short windows; the
active row scrolls into view on navigation. Anyone used to `G D` must learn `G H`.

**Neutral.** `useWorkspace`, `InsightsNavBadge`, `MonitorInboxBadge` and `UpdateNotification`
are removed with their tests; `AppSidebar.test.tsx`, `NavItemBadge.test.tsx` and a new
`lib/__tests__/navigation.test.ts` cover the sections, the counts and the registry. Twenty-seven
locale keys that only the removed surfaces used are deleted.

## Related

- [[docs/adr/099-sidebar-navigation-ia|ADR-099]] — the workspace layout this supersedes
- [[docs/adr/179-primitives-adopt-role-tokens|ADR-179]] — the primitives the sidebar is built on
- [[docs/adr/072-electron-native-desktop-integration|ADR-072]] — the menu actions extended here
- [[docs/components/layout|Layout components]]
- [[docs/reference/frontend-routes|Frontend routes]]
- [[docs/adr/index|All ADRs]]

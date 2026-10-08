---
title: "ADR-190: The sweep's primitive wishes become shared primitives"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, frontend, design-system, primitives, row-menu, disclosure, select, alert, adr-187]
description: The follow-ups to the completeness sweep extend the shared primitives instead of leaving screen-local copies. ListRow gains an actions slot and a selected state, Button the xs and small icon sizes, menu items a destructive variant, SegmentedControl a label, Alert a role derived from its variant, PageHeader a back control, and the library gains Disclosure, RowMenu and the Select none-sentinel helpers. Every screen and dialog adopts them, and the five native selects in the portfolio import session move to the design-system Select.
aliases: [adr-190, primitives follow-up, redesign follow-ups]
---

# ADR-190: The sweep's primitive wishes become shared primitives

## Status

Accepted. Follow-up to [[docs/adr/187-completeness-sweep|ADR-187]].

## Date

2026-10-08

## Context

ADR-187 moved every remaining screen and dialog onto the design system, and its workers kept a
list of things the primitives could not do: a ••• menu on a row that is itself a button (nested
buttons are invalid, so rows hand-rolled their own `<li>`), a destructive menu item (each screen
repeated the same three classes), a 28px control for dense rows, a labelled segmented control
(every caller wired `aria-labelledby` itself), a styled disclosure (21 files repeated the same
`<details>` summary classes), a "none" item for a Radix `Select` (which rejects empty-string
values), a back control on detail pages, and the ••• trigger itself, built by hand in 24 files.
Five native `<select>` elements also stayed in the portfolio import session because its tests
drove them through `selectOptions`. The portfolio import work merged in the meantime added one
more native select on the same pattern.

## Decision

The shared primitives grow, and every hand-rolled copy is replaced:

- **`ListRow`** takes `actions`, rendered beside the activatable element rather than inside it,
  and `selected`, which tints the row and sets `aria-current="true"`. Master lists (monitors,
  saved analyses, inbox) are `ListRow`s again; row menus on account, holding and watchlist rows
  sit in the `actions` slot, outside the row link or button.
- **`RowMenu`** (`components/shared/RowMenu.tsx`) is the one ••• trigger: ghost for rows and
  cards, `variant="outline"` for page headers, with a required accessible label, `align="end"`,
  propagation stopped, a forwarded ref for focus restore and a `disabled` state.
- **`DropdownMenuItem`** and **`ContextMenuItem`** take `variant="destructive"`.
- **`Button`** adds `xs` (28px), `icon-sm` (32px) and `icon-xs` (28px).
- **`SegmentedControl`** takes `label` and wires `aria-labelledby` itself.
- **`Alert`** derives its live-region role from its variant: `destructive` is an `alert`, every
  other variant a polite `status`, unless `role` is passed. Non-destructive notices no longer
  interrupt screen readers, and tests query them as status regions.
- **`Disclosure`**, **`DisclosureSummary`** and **`DisclosureContent`** wrap a native `<details>`
  with the plain, card and inset looks the sweep repeated. `open`, `onToggle`, ids and refs pass
  through; the element stays a `<details>`, so ADR-187's "restyled, not replaced" rule still holds.
- **`lib/selectValue.ts`** exports `SELECT_NONE`, `toSelectValue` and `fromSelectValue`; local
  sentinels (`NONE`, `NO_AXIS`, `NO_DOCUMENT`) are gone. Combobox item keys that happen to use the
  same string are not Select sentinels and stay.
- **`PageHeader`** takes `back={{ label, to | onClick }}` and renders the ghost back control
  above the title; detail pages (account ledger, import review, table editor, who-owes-you detail)
  stop hand-rolling an arrow button.
- The five native selects in `PortfolioImportSession` (existing batch, per-item policy, per-item
  transfer, scope, session policy) become design-system `Select`s with the same items, disabled
  rules and labels; the session tests drive them through the listbox. The two notes the portfolio
  import work added read in footnote type.

## Consequences

**Positive.** One ••• trigger, one destructive item, one disclosure and one labelled picker
across the application; rows that are links or buttons no longer nest a button; focus restore
and busy states work through the shared trigger. No raw `<select>` remains in the frontend.

**Negative.** Header menus that were hand-rolled with a different trigger (a View menu with
text and icon) stay as they are; `SegmentedButtons` and `ResearchRangeSelector` keep forwarding
their callers' `aria-labelledby`. Disclosure summaries read in body weight rather than the
headline weight a few card sections used.

**Neutral.** No locale keys change. ADR-187's statements that raw selects remain in the import
session and that the primitive wishes are follow-ups are closed by this decision; the ADR itself
is not edited.

## Related

- [[docs/adr/187-completeness-sweep|ADR-187]] — the sweep that listed these wishes
- [[docs/adr/179-primitives-adopt-role-tokens|ADR-179]] — the primitives being extended
- [[docs/components/ui-components|UI Components]], [[docs/components/shared-components|Shared Components]]
- [[docs/adr/index|All ADRs]]

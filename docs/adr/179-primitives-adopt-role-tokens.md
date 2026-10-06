---
title: "ADR-179: Primitives adopt the role tokens"
type: adr
status: accepted
date: 2026-10-06
tags:
  [
    adr,
    frontend,
    design-system,
    primitives,
    focus,
    motion,
    undo,
    accessibility,
    adr-178,
    adr-172,
  ]
description: The shared UI primitives adopt the ADR-178 role tokens with one control height scale, concentric corners, one keyboard focus ring, elevation-backed glass tiers and CSS springs, and gain a segmented control, an inset list, an inspector panel and an Undo toast helper for the screen passes that follow.
aliases: [adr-179, primitives adoption, segmented control, inset list, inspector, undo toast]
---

# ADR-179: Primitives adopt the role tokens

## Status

Accepted

## Date

2026-10-06

## Context

[[docs/adr/178-design-system-role-tokens|ADR-178]] added role-named type, label, corner,
elevation, focus and spring tokens next to the existing vocabulary and left every primitive on
the old one. The UI direction for the redesign asks for the primitives to adopt the tokens first,
so that the screen passes that follow (navigation, Home, Transactions, the dialogs each screen
opens) change layout and copy rather than restyling controls one by one. It also names four
primitives the screens will need and do not have: a page header with a large title and one
toolbar slot, a segmented control, inset list rows and an inspector panel, plus Undo toasts
everywhere ("forgive, don't warn").

Before this change the primitives disagreed on the basics: control heights were 40px for inputs
and 40/36/44 for buttons; corners were `rounded-md`, `rounded-lg` and arbitrary values with no
nesting rule; keyboard focus was a base `:focus-visible` outline that forced a control radius on
every element plus 101 `ring-2 ring-offset-2` call sites; glass tiers hand-wrote their shadows;
the dialog entrance approximated a spring with an overshooting bezier; and motion tokens were
spelled both `duration-fast` and `duration-[var(--duration-fast)]`.

## Decision

The shared primitives in `components/ui/` and the shared composition components in
`components/shared/` adopt the role tokens. Screens are unchanged in layout and copy; they pick
up the new geometry through the primitives.

**Control scale.** Regular controls are 36px tall (`h-9`): Button `default` and `icon`, Input,
Select trigger, Toggle, TabsList, the segmented control. `sm` is 32px (`h-8`) and `lg` is 40px
(`h-10`). The Textarea minimum height is 80px. Raw `<input>` and `<select>` elements that
screens still render follow the same height and `rounded-control` corner.

**Corners nest concentrically.** Controls, inputs, select triggers, tabs triggers and tooltips use
`rounded-control` (10px). Chips, checkboxes and toast buttons use `rounded-chip` (6px). Cards,
tabs lists, alerts, menus, popovers, select content, toasts and lists use `rounded-card` (14px)
with `corner-continuous`. Dialogs, alert dialogs and sheets use `rounded-sheet` (22px) with
`corner-continuous`. A segment inside the segmented control is the control radius minus its 2px
padding.

**One focus ring.** The base `:focus-visible` rule in `index.css` is the `focus-ring` treatment:
a 3px translucent outline in the palette's `--focus-ring-alpha` at 1px offset, full ring colour
under `prefers-contrast: more`, and no `border-radius`, so the ring follows each element's own
shape. Primitives that reset the outline restate it with `focus-ring`. The Tailwind spellings
`focus-visible:ring-2 … ring-offset-2`, `ring-offset-background` and `focus:ring-*` are gone from
`apps/frontend/src`; `primitives.contract.test.ts` keeps them out. Rows that sit inside a clipped
group pull the ring inward with `focus-visible:outline-offset-[-3px]`.

**Elevation through the glass tiers.** `.glass-thin`, `.glass-regular`, `.glass-elevated` and
`.glass-thick` read `--elevation-1` to `--elevation-4` instead of hand-written shadow stacks, in
light and dark. Dialogs no longer add a second shadow on top of their material.

**Springs.** The dialog entrance runs on `--spring-smooth` with its duration; the switch thumb
moves on `--spring-snappy`; the segmented-control pill uses the Framer `springs.snappy` twin. Each
CSS motion token has one spelling (`duration-fast`, `ease-glide`, `duration-spring-snappy`), which
the motion parity test enforces.

**Type roles.** Button, Input, Select, Tabs, menus, Table cells and Label render `type-body`;
Table heads, Badge and Tooltip render `type-footnote`; CardTitle roles are `default` →
`type-title-2`, `sm` → `type-title-3`, `label` → `type-body` medium in `text-label-secondary`;
Dialog, AlertDialog and Sheet titles are `type-title-2`; descriptions are `type-body
text-label-secondary`; toast titles are `type-headline`. PageHeader's title is
`type-large-title`.

**New primitives.**

- `SegmentedControl` / `SegmentedControlItem` (`components/ui/segmented-control.tsx`): Radix
  ToggleGroup in single mode (a `radiogroup` of `radio`s) with one pill that glides between
  segments; a click on the chosen segment is ignored so a choice always exists. `SegmentedButtons`
  keeps its predicate API and renders this control; its variant props are gone.
- `List` / `ListRow` (`components/ui/list.tsx`): an inset grouped list on one card surface with
  hairline dividers; a row takes `leading`, `title`, `subtitle`, `trailing`, `chevron`, and is a
  button when `onActivate` is set or wraps a link with `asChild`.
- `Inspector` and its parts (`components/ui/inspector.tsx`): a non-modal `complementary`
  landmark docked beside a list; focus is not trapped, Escape closes it from inside, screens
  decide its width and whether a phone layout shows the same content in a Sheet.
- `undoToast` (`lib/undoToast.ts`): shows a success toast whose Undo action and ⌘Z share the
  one Undo slot in `lib/undo.ts`; taking either path clears the other, and ⌘Z dismisses the
  toast. Transaction delete uses it.

**Undo rule.** A reversible action happens at once and offers Undo through `undoToast`. A
confirmation dialog stays only where Undo is incomplete; transaction delete keeps its dialog
because Undo does not restore attachments, splits or planned-payment links and the list row does
not show whether the transaction has any ([[docs/features/transactions]]).

## Consequences

**Positive**

- Screens inherit one height, corner, focus and elevation scale; the screen passes change
  composition, not control styling.
- Keyboard focus is one mechanism, so a contrast fix in `--focus-ring-alpha` reaches every
  control.
- Contract tests hold the scale, the focus-ring sweep, the glass-tier elevation mapping, the
  dialog spring and the motion-token spellings (`components/ui/primitives.contract.test.ts`,
  `components/ui/overlay-motion.test.ts`, `lib/__tests__/motionTokenParity.test.ts`).

**Negative**

- Inputs and menus are 4px shorter and dialogs rounder than before; screenshots and visual
  snapshots change everywhere.
- `SegmentedButtons` callers that queried `role="button"` with `aria-pressed` now see
  `role="radio"` with `aria-checked`.

**Neutral**

- The sidebar's own geometry and rings, planned-payment Undo toasts, removal of the delete dialog
  once Undo is complete, and the remaining `text-muted-foreground/<alpha>` call sites belong to
  the later navigation, screen and completeness passes.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/178-design-system-role-tokens|ADR-178: Design-system role tokens]]
- [[docs/adr/172-calm-information-hierarchy|ADR-172: Calm information hierarchy]]
- [[docs/components/ui-components|UI Components]]
- [[docs/components/shared-components|Shared Components]]

---
title: ADR-099 Sidebar / Navigation Information Architecture
type: adr
date: 2026-06-18
tags: [adr, navigation, sidebar, ia, workspaces, accounts, cross-workspace, adr-084, adr-088]
description: Records the navigation IA after the account epic — a minimal workspace-agnostic top zone (AI Chat + Accounts), cross-workspace analytics placed in their most-natural workspace section rather than as new top-level items, and the per-workspace grouping kept intact.
aliases: [sidebar IA, navigation IA, nav layout]
---

# ADR-099: Sidebar / Navigation Information Architecture

## Status
Proposed

## Date
2026-06-18

## Context

The account epic added a workspace-agnostic **Accounts** hub (ADR-088) and a set of
cross-workspace analytics (ADR-098: net-worth projection, cash-aware rebalancing, unified tax),
plus portfolio statistics (ADR-096 dividend/FIRE, ADR-097 allocation drift). Before sprinkling
nav items ad-hoc, the plan called for a deliberate sidebar IA review so the structure stays
intuitive as these land. `AppSidebar.tsx` today has: a top workspace-agnostic zone (AI Chat),
the Budgeting/Portfolio/Research switcher, per-workspace grouped nav, and an admin group.

## Decision

- **Keep the workspace-agnostic top zone minimal: AI Chat + Accounts only.** It is reserved for
  things that genuinely belong to no single workspace and are entities/tools, not analytics.
  Accounts qualifies (it is the spine across all three workspaces); AI Chat already lived there.
- **Cross-workspace analytics live in their most-natural workspace section, not as new top-level
  items** — this avoids nav sprawl and keeps every destination ≤2 clicks (workspace tab → item):
  - Net-worth / FI projection → **Portfolio** (alongside the existing Net Worth view).
  - Cash-aware rebalancing → **Research** (it is research-target-driven).
  - Unified tax view → **Budgeting**, extending the existing `/tax` surface (earned income lives
    there) rather than a new top-level entry.
  - Dividend/coupon income + FIRE coverage (ADR-096) → **Portfolio** statistics.
  - Watchlist backtest + allocation drift (ADR-097) → **Research**.
- **Per-workspace grouping is unchanged**; the new items slot into existing analysis/overview
  groups. The collapsed-rail behavior and workspace-cycle button are untouched.
- **Settings** (ADR-084) remains the home for configuration; nav is for destinations.

Rationale: a top zone that accretes every cross-cutting feature becomes a junk drawer; anchoring
each analytic in the workspace a user is already thinking in keeps the mental model clean, while
the two genuinely global concerns (an AI assistant, the account spine) stay one click from
anywhere.

## Consequences

**Positive**
- Predictable IA: global entities up top; analytics where their data lives; no duplicated nav
  destinations.
- New ADR-096/097/098 surfaces have a defined home before their UIs are built.

**Negative / cost**
- Unified tax spans budgeting + portfolio but is reached via Budgeting — a deliberate trade-off
  (one home, not two) documented here.

**Risks / mitigations**
- *Discoverability* of cross-workspace features inside a workspace → validate ≤2-click reach on
  the running app (Playwright) when the ADR-096/097/098 UIs land (runtime follow-on).
- *Future sprawl* → this ADR is the gate: new cross-cutting analytics default to a workspace
  section unless they are a global entity/tool.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Accounts hub placement]]
- [[docs/adr/084-settings-instant-apply-sidebar|ADR-084: Settings (config home)]]
- [[docs/adr/098-cross-workspace-features|ADR-098: Cross-workspace analytics]]

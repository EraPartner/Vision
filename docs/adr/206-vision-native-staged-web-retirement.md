---
title: "ADR-206: Stage native route authority before web retirement"
type: adr
status: proposed
date: 2026-10-15
tags: [adr, architecture, swift, native-app, phase-4, navigation]
description: "Proposes staged retirement of the retained renderer, beginning with default-off native routing and preserving storage, shared calculations, restore lifetime and the separate real-data switch-over gate."
aliases: [adr-206, staged native web retirement]
---

# ADR-206: Stage native route authority before web retirement

## Status

Proposed. The preparatory routing implementation is opt-in and the SDK keeps the
renderer as route authority. This ADR does not certify phase 3p or phase 4 complete,
authorize real-data migration, or replace the switch-over runbook in
[[docs/adr/205-vision-native-hand-over|ADR-205]].

## Date

2026-10-15

## Context

Native screens now cover the app's routes, Settings, shell overlays and reports.
`ShellRootView` still mounts the retained web content, and
`ShellController.makeShellModel` sends native navigation requests to the renderer.
React Router also owns redirects and history, including Settings' query and close
behavior. Removing the web view before replacing those dependencies would lose
working behaviors and could discard active drafts.

Routing is only one retained dependency. Renderer callbacks still supply narrow
local/session storage operations, source TypeScript financial helpers, and startup
and restore readiness. Those responsibilities need independent replacements and
matching tests before the document can retire.

## Decision

Prepare a native route authority behind an explicit constructor option, preserving
the current renderer authority as the production default. Switch each responsibility
only after its own tests and integration evidence exist; retain the current web
presentation until every remaining load-bearing dependency is accounted for.

### Implemented routing preparation

`NativeNavigationLocation` keeps the validated raw `pathname + search` alongside
the decoded `NativeRoute` used by screens. A navigation or legacy redirect preserves
the exact query spelling, including duplicate pairs, bare parameters, `+` and percent
escape casing. Deliberate query edits serialize with URLSearchParams-style form
encoding. Existing `NativeRoute` callers retain their existing serialization.

`NativeNavigationHistory` owns in-memory push, replace, back and forward operations:

- Push adds a visit and drops the forward branch; replace retains the current entry.
  Repeated and query-only pushes remain visits.
- Path changes retain the intended operation while a native leave guard asks for
  confirmation. Cancelling does not change history; confirmation discards once and
  applies the original push, replace or traversal. Query-only edits keep drafts.
- `/portfolio/performance` resolves to `/portfolio` in the same visit, keeping its raw
  search. Recognized route spelling follows React's case-insensitive, trailing-slash
  matching while retaining dynamic parameter spelling.
- Actual manifest admin pages wait for settings hydration, then resolve to `/` when
  admin mode is off. That redirect discards search, as `RequireAdmin` does. Unknown
  routes under `/admin` remain NotFound. The backend remains the security boundary.
- The first Settings open pushes a query entry. Section changes replace it. Closing
  that owned entry goes back to the exact previous location; closing a direct link
  removes Settings by replacement. Report export query changes replace the entry and
  keep the selected year and unrelated query values.

`NativeShellModel(nativeNavigation: ...)` integrates this authority with its existing
screen lifetimes, report presentation and leave confirmation. It does not send route,
query or Settings actions to `onNavigate`, and ignores renderer route reports once
explicitly opted in. `nil`, the default, retains the current renderer behavior.
`initialRoute` can seed a freshly reconstructed renderer-owned shell during restore
without issuing navigation or starting settings reads in the constructor.
The seed activates report state only on a settings application after renderer
readiness; a newer renderer route report cancels that deferred seed activation.

### Remaining activation gates

The SDK must not supply `nativeNavigation` until the enabled-mode contract tests and
the full native app/package checks pass, and its adapter has an explicit startup
seed, readiness and restore strategy. Initial route ownership cannot race a retained
React `StartupRedirect`. Startup section/last-route persistence, host menu history
dispatch and any renderer-originated route requests need that adapter review.

Storage replacement must preserve existing key allowlists, missing/null/string
semantics, session lifetime, backup registry, accepted-write drains and generation
ownership. Retiring renderer callbacks must keep shared TypeScript financial source
calculations and their input contracts; porting calculations to Swift or adding a
broad arbitrary-code bridge is outside this slice.

Restore must drain accepted actions and establish fresh frontend/onboarding authority
before a delayed reload. Immutable current-page print snapshots remain separate from
PDF export. Removing presentation alone does not meet these gates.

The standard variant remains subject to ADR-205's separate real-data switch-over
sequence. No real data, Keychain item, audit witness or backup folder moves as part
of this routing preparation.

## Consequences

Route semantics can be exercised without making renderer retirement a prerequisite.
The disabled default keeps phase-3p validation independent of the new route owner.
The implementation temporarily supports two explicit authority modes; mixing them in
one SDK session is unsupported. Native history is session-local and does not import
an existing browser history stack. A live handover must deliberately seed or rebuild
history and cannot infer back/forward ownership from route reports alone.

The preparatory route files and shell integration do not yet remove any production
web dependency. Existing architecture diagrams continue to describe the mounted
renderer. Update the diagrams and flow visualizer when the SDK activates a new
ownership relationship, and document the evidence before claiming a gate complete.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native Swift app target]]
- [[docs/adr/205-vision-native-hand-over|ADR-205: Vision Native hand-over]]
- [[docs/reference/native-parity/shell-and-settings|Shell and Settings parity]]
- [[docs/reference/native-parity/agent-handoff|Native continuation handoff]]

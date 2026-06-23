---
title: "ADR-084: Settings dialog — sidebar navigation + instant-apply"
type: adr
status: Accepted
date: 2026-06-18
tags: [adr, architecture, settings, frontend, ux, instant-apply, refactor]
description: Reworks the settings dialog from a 5-tab Save/Cancel form into a sidebar-navigated, instant-apply surface with a shared SettingRow primitive and honest section taxonomy.
aliases: [settings rework, settings sidebar, instant-apply settings]
related_code:
  - apps/frontend/src/components/settings/DashboardSettingsDialog.tsx
  - apps/frontend/src/components/settings/SettingsPrimitives.tsx
  - apps/frontend/src/components/settings/sections/
---

# ADR-084: Settings dialog — sidebar navigation + instant-apply

## Status
Accepted

## Date
2026-06-18

## Context

The settings dialog (`DashboardSettingsDialog`) had grown into a 5-tab form
(`General`, `Appearance`, `Dashboard`, `App`, `Backup`) with a global
**Cancel / Save** footer. Several problems had accumulated:

1. **Muddled taxonomy.** `General` mixed display formatting with unrelated
   behavioral settings (`costBasisMethod` is portfolio, `autoClearPlannedOnMatch`
   is planned-transactions, `startupSection` is launch behavior). `Dashboard`
   actually held *statistics exclusions* (its own scope option is "everywhere").
   `App` was a catch-all (onboarding, updates, AI, research keys, admin, reset-all).
2. **Inconsistent visuals.** The same "labelled control" was rendered three
   different ways across tabs (bare rows with a full-width `Separator` between
   *every* field in `General`; bordered cards elsewhere; button-cards in
   `Appearance`). Toggles were sometimes `Checkbox`, sometimes `Switch`.
3. **Incoherent save model.** The Cancel/Save footer implied everything was
   staged, but `Appearance` theme controls (`setVariant`/`setMode`/…) applied
   **instantly** and persisted regardless of Cancel; research keys and backup
   actions were also immediate; only `General`/exclusions/AI-model/tier were
   staged. "Cancel" was a lie for a chunk of the dialog.

## Decision

Rework the dialog into a **sidebar-navigated, instant-apply** surface.

- **Sidebar navigation** replaces the `TabsList`. A left rail of seven sections
  (icon + label), a scrollable content pane on the right. This scales past the
  cramped 5-across text tabs and gives each concern room to grow.
- **Honest section taxonomy:**
  | Section | Contents |
  |---|---|
  | General | currency, number/decimal/date format, language, start of week, page size |
  | Appearance | theme variant, color mode + schedule, system accent, visual effects, auto-adapt |
  | Statistics | exclusion scope, exclude-hidden, internal transfers, excluded categories/recipients (was "Dashboard") |
  | Behavior | startup section, cost-basis method, auto-clear planned, reset recurring dismissals |
  | AI & Research | Ollama AI chat model, research provider keys |
  | Backup | directory, backup-on-quit, passphrase, run/restore (Electron) |
  | About & Maintenance | updates, onboarding restart, developer/admin mode, reset-all (danger zone) |
- **Instant-apply everything.** The Cancel/Save footer is removed in favor of a
  single **Done** (close) button. Every control writes through its store action
  or API call on change. This is the natural fit for the existing architecture:
  `updateAppSettings`/`updateDashboardSettings` mutate the Zustand store and the
  context providers debounce-persist (500 ms). Theme controls were already
  instant. Reset-all moves into the About danger zone as "Reset to defaults".
- **Shared layout primitives** (`SettingsPrimitives.tsx`): `SettingsSection`
  (title + description), `SettingsGroup` (bordered, hairline-divided card), and
  `SettingRow` (label + hint + control; `row` layout for switches/actions,
  `stack` layout for selects/lists). One visual language for every setting.
- **Self-contained sections.** Each section reads from hooks and writes directly,
  so the orchestrator shrinks from a prop-threading hub to layout + nav. This
  also removes the old "backup settings clobber" guard entirely: only
  `BackupSection` ever writes backup settings, so a save from another section
  can no longer overwrite them.

### Special cases preserved
- **`includeTransfers`** is a server-only aggregation setting with no client
  reader, so its toggle persists via `apiClient.saveSetting` and then
  `queryClient.invalidateQueries()` (optimistic cache update for snappy UI).
  Most other settings flow reactively through the store and query keys, so they
  refresh without explicit invalidation.
- **Visual-effects tier routing** (ADR-075 addendum) is applied inline on change
  instead of on Save: under the auto-adapt cap a pick becomes a session-only
  override; otherwise it writes the synced preference. Toggling auto-adapt clears
  the override (auto reclaims control).
- **Legacy deep-link keys** (`general`/`appearance`/`dashboard`/`app`/`backup`)
  used by the Electron menu bridge and onboarding are mapped onto the new section
  ids (`dashboard`→`statistics`, `app`→`about`), so existing callers keep working.

## Consequences

**Positive**
- Coherent mental model: the save model is now uniform (everything is live), and
  section names match their contents.
- Visual consistency via one `SettingRow` primitive; separators only between groups.
- Less orchestrator complexity (no staged local state, no clobber guard, simpler
  tier logic). Sections lazy-load their own data on first visit.

**Negative / trade-offs**
- No "Cancel to discard" anymore. This matches prior real behavior (theme was
  always instant) but means there is no staged preview/abort. Acceptable for a
  settings surface; destructive actions (restore, reset-all) keep explicit confirms.
- Switching sections unmounts the previous one (transient UI state like search
  inputs resets); React Query cache persists so data does not refetch.

**Neutral**
- i18n: added `settings.done`, `settings.section.*`, and `settings.group.*` keys
  (en + nl). No existing keys changed; the old `settings.save`/`settings.cancel`
  strings remain unused but were left in place.

## Related
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual effects tiers]]
- [[docs/adr/083-internal-transfer-detection|ADR-083: Internal transfer detection]]
- [[docs/features/settings|Settings Feature]]
- [[docs/components/dashboard-settings-dialog|DashboardSettingsDialog]]
- [[docs/adr/index|All ADRs]]

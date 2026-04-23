---
title: ADR-032 - Zustand Unified Settings Store
type: adr
status: Accepted
date: 2026-04-23
tags: [adr, frontend, state-management, zustand, phase-4, settings, context-consolidation]
description: Unified settings state (app, dashboard, theme) under Zustand store; Context Providers become thin wrappers for hydration and persistence side-effects. Eliminates prop drilling and context re-render thrashing via useShallow() slice selection.
aliases: [adr-032, zustand-settings, unified-store]
related_code: 
  - apps/frontend/src/stores/settingsStore.ts
  - apps/frontend/src/contexts/AppSettingsContext.tsx
  - apps/frontend/src/contexts/SettingsContext.tsx
  - apps/frontend/src/contexts/ThemeContext.tsx
  - apps/frontend/src/contexts/SettingsPreloadContext.tsx
---

# ADR-032: Zustand Unified Settings Store

## Status
Accepted

## Date
2026-04-23

## Context

### Previous Architecture (Phase 1–3)

Settings management used a **three-layer Context API stack**:

```
SettingsPreloadContext → SettingsContext → AppSettingsContext
     (preload)              (raw data)        (processed)
```

And separately:
```
ThemeContext (theme variant, mode, schedule)
```

**Problems with this approach:**

1. **Multiple subscriptions** — Components needed to subscribe to multiple contexts (`useSettings()`, `useAppSettings()`, `useTheme()`), causing re-renders whenever any context changed, even if a component only cared about one slice.

2. **Prop drilling** — Settings providers had to be threaded through the component tree in a specific order, and changes to the provider chain required updates across many files.

3. **Mutation risk** — Context state was mutable in some layers, requiring careful shallow cloning to avoid accidental mutations during updates.

4. **Hydration complexity** — Three separate providers had to coordinate hydration from `SettingsPreloadContext`, with no unified way to manage loading states.

5. **Duplicated logic** — Each context had its own update/reset logic, leading to maintenance burden.

### Why Zustand?

Zustand is a minimal state management library (~2 KB gzipped) that:
- **Prevents re-renders on unrelated slice changes** — Using `useShallow()` selector, a component subscribes only to the slices it needs.
- **Eliminates prop drilling** — Hooks access store directly; no provider nesting required.
- **Enforces immutability** — State updates require returning a new object; mutations are impossible.
- **Single source of truth** — All settings state lives in one store with explicit actions.

## Decision

### 1. Create Unified Zustand Store

Location: `[[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]`

```typescript
export const useSettingsStore = create<SettingsStore>((set, get) => ({
  // App settings slice
  appSettings: DEFAULT_APP_SETTINGS,
  updateAppSettings: (updates) => set((s) => ({ appSettings: { ...s.appSettings, ...updates } })),

  // Dashboard settings slice
  dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
  updateDashboardSettings: (updates) => set((s) => ({ dashboardSettings: { ...s.dashboardSettings, ...updates } })),

  // Theme slice
  theme: 'dark',
  themeMode: 'dark',
  themeVariant: 'default',
  themeSchedule: DEFAULT_THEME_SCHEDULE,
  setTheme: (theme) => set({ theme, themeMode: theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
}));
```

### 2. Context Wrappers Become Thin Providers

Keep existing context files (AppSettingsContext, SettingsContext, ThemeContext) but reduce them to **provider-only** roles:

- **AppSettingsProvider** → Wraps useSettingsStore app slice, handles hydration/persistence, exports convenience hook
- **SettingsProvider** → Wraps useSettingsStore dashboard slice, handles persistence
- **ThemeProvider** → Wraps useSettingsStore theme slice, handles DOM effects (CSS class, matchMedia, interval), persistence

Example:
```typescript
export const AppSettingsProvider = ({ children }) => {
  const { appSettings, isLoading, _hydrateAppSettings } = useSettingsStore();

  // Hydration, persistence, re-export hook
  useEffect(() => { /* hydration logic */ }, []);

  return (
    <AppSettingsContext.Provider value={{ appSettings, isLoading }}>
      {children}
    </AppSettingsContext.Provider>
  );
};

// Convenience hook for backward compatibility
export const useAppSettings = () => {
  return useSettingsStore(
    useShallow((s) => ({ appSettings: s.appSettings, isLoading: s.isAppSettingsLoading }))
  );
};
```

### 3. Slice Selection with useShallow()

To prevent re-renders when unrelated slices change, all consumers use `useShallow()`:

```typescript
// Component only cares about app settings
const { appSettings } = useSettingsStore(
  useShallow((s) => ({ appSettings: s.appSettings }))
);

// Component cares about theme
const { theme, setTheme } = useSettingsStore(
  useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme }))
);
```

### 4. Backward Compatibility

- Consumer hooks (`useAppSettings()`, `useSettings()`, `useTheme()`) continue to work and re-export from store
- TypeScript types for AppSettings, DashboardSettings, etc., remain unchanged
- Provider components still handle hydration and persistence

## Consequences

### Positive

- **Eliminated re-render thrashing**: Components subscribing to one slice no longer re-render when unrelated slices change.
- **Improved performance**: Simpler state atom = faster comparisons in shallow equality checks.
- **Unified state**: Single source of truth for all settings; no hidden state or dual mutations.
- **Simpler provider chain**: Zustand store eliminates nesting complexity; Context wrappers are now purely for side-effects.
- **Easier to test**: Store is a pure function; no providers needed in tests (mock store directly).
- **Gradual migration**: Existing code continues to work through Context wrappers while new code can use store directly.

### Negative

- **New dependency**: Zustand ~2 KB gzipped (negligible in practice).
- **Learning curve**: Developers unfamiliar with Zustand need to understand selector patterns and `useShallow()`.
- **Transition period**: Code mixing store access and context hooks requires discipline to keep consistent (mitigated by linting).

### Neutral

- **DOM effects unchanged**: ThemeProvider still handles CSS classes, matchMedia, intervals as before.
- **Hydration flow unchanged**: `SettingsPreloadContext` → Zustand store → Context wrappers → components (same chain, different execution).

## Implementation Timeline

**Phase 4 (2026-04-23):**
- Create `useSettingsStore` with full state shape
- Reduce AppSettingsContext, SettingsContext, ThemeContext to wrappers
- Update all components to use `useShallow()` for slice selection
- Tests verify no re-render on unrelated slice changes

**Future (Phase 5+):**
- Extend store with new settings as needed (user preferences, UI state, etc.)
- Consider extracting long-lived client state (drafts, local filters) into additional stores

## Related

- [[docs/features/settings|Settings Feature Documentation]]
- [[docs/components/hooks#usesettingsstore-phase-4|useSettingsStore Hook Documentation]]
- [[docs/reference/code-patterns#zustand-store-pattern-frontend-phase-4|Zustand Pattern Reference]]
- [[docs/adr/index|All ADRs]]
- [Zustand GitHub](https://github.com/pmndrs/zustand)

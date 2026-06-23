---
title: ADR-072 Electron-Native Desktop Integration (macOS)
type: adr
status: Accepted
date: 2026-06-10
updated: 2026-06-16
tags: [adr, electron, desktop, macos, security, ipc, frontend, accelerator-hardening, before-input-event, did-start-navigation, june-2026]
description: V12 batch — hiddenInset traffic lights, native menu bar + dock menu/badge, CSV drag/open-with import handoff, under-window vibrancy behind the effects toggle, and system-accent theming, all through a new minimal electronAPI bridge with the sandbox posture unchanged. Implementation note (2026-06-11): two post-ship defects fixed — rendererReady reset moved from did-start-loading to did-start-navigation+isSameDocument (eliminates permanent queue jam after React Router navigations), and handleMenuAccelerator on before-input-event bypasses unreliable sandboxed-renderer key-equivalent dispatch for ⌘1-9, ⌘N, ⇧⌘I, ⌃⌘S.
aliases: [adr-072, electron native, electronAPI bridge, vibrancy, system accent]
---

# ADR-072: Electron-Native Desktop Integration (macOS)

## Status
Accepted

## Date
2026-06-10

## Context

The premium pass (ADR-070/071, worklog `docs/sessions/2026-06-10-premium-v3-worklog.md`, item V12) left the Electron shell looking like a website in a frame: default title bar, no native menu bar, no dock integration, and file drops were inert (or worse — Chromium's default is to *navigate to* a dropped file, and the shell's `will-navigate` guard allows `file:` for its error page).

Hard constraints:
- **Security posture is untouchable** (AGENTS.md): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The sandboxed renderer must not gain filesystem access.
- **Vibrancy is high-regression-risk**: the design system paints opaque token backgrounds, so a translucent window either does nothing or breaks contrast. ADR-020's M1 GPU history also applies.
- Headless sessions cannot visually verify any of this; the user validates the built `.app`.

## Decision

### A third, minimal contextBridge surface: `window.electronAPI`
`electronUpdater` and `electronBackup` stay as-is. The new surface (preload.js) carries only platform metadata, one command pair, and event subscriptions that each return an unsubscribe function:
`platform`, `ready()`, `setDockBadge(count)`, `getAccentColor()`, `onAccentColorChanged`, `onMenuAction`, `onCsvOpen`, `onFullScreenChange`.

**Renderer-ready queue protocol**: main never fire-and-forgets to a renderer that may not have mounted listeners yet (dock-menu click on a closed window, Finder open-file at launch). `sendToApp()` queues messages until the renderer invokes `app:renderer-ready`; the flag resets on every `did-start-loading`, so reloads re-handshake. Renderer side is `components/layout/ElectronBridge.tsx` (mounted once in AppLayout, inside SidebarProvider), which attaches all listeners exactly once and routes actions through a ref so React re-renders never tear down IPC subscriptions.

**IPC hygiene**: every renderer-invokable handler validates `event.sender === mainWindow.webContents`; `app:set-badge` clamps to an integer 0–999. No handler accepts a filesystem path from the renderer.

### Window chrome (darwin-only spread in `createWindow`)
`titleBarStyle: 'hiddenInset'` with `trafficLightPosition {x:20, y:20}` (centers the lights in the 56px topbar). The frontend detects the shell via `electronAPI.platform === 'darwin'` → html class `electron-mac`; CSS then insets the topbar 88px left and marks it `-webkit-app-region: drag` (interactive children `no-drag`). Native fullscreen hides the lights, so main pushes enter/leave events and the `electron-fullscreen` class drops the inset.

### Native menu bar + dock
- `Menu.setApplicationMenu` built in `launch()` **after `initI18n()`** — labels come from the same flat i18n JSON the shell dialogs use (`menu.*` keys, en+nl).
- **Go menu mirrors `GO_TO_ROUTES`** (`hooks/useGoToShortcuts.ts`) with ⌘1–⌘9; the lists must be kept in sync by hand (commented at both sites).
- File → New Transaction (⌘N) and Import CSV… (⇧⌘I); App menu Settings… (⌘,); View → Toggle Sidebar (⌃⌘S, the Finder/Mail convention; devtools dev-only); Edit/Window/Help are system roles.
- Menu and dock items send `{action, payload}` over `menu:action`; ElectronBridge maps them to router navigation, the settings dialog, the shortcuts overlay, and `toggleSidebar()`.
- **Dock menu**: New Transaction / Dashboard. **Dock badge**: pushed by the renderer from `UpcomingPaymentsNotification` (it owns the due-payments query *and* the user's dismissals — main has neither), mirroring the visible count; cleared on unmount.
- "New Transaction" works via a new deep link: `/transactions?new=1` opens `AddTransactionDialog`, which strips the param (replace) so back/refresh don't reopen it.

### CSV import handoff — two paths, no sandbox widening
- **Drop anywhere on the window**: handled entirely in the renderer (a dropped `File` is readable without fs access). ElectronBridge swallows all file drops (fixing the navigate-to-file hole), routes `*.csv` through `lib/importHandoff.ts` — a one-slot, 30s-TTL registry in the style of `lib/undo.ts` — and navigates to `/import`; `TransactionImportCard` consumes the slot on mount. In-card dropzones are exempted via a `data-dropzone` ancestor check.
- **Finder "Open With" / dock drop**: main's `open-file` handler reads the file itself (extension whitelist, 25 MB cap) and forwards `{name, content}` over IPC; the renderer reconstructs a `File`. The OS-chosen path never round-trips through the renderer.

### System accent color — an overlay, not a sixth variant
The worklog suggested "theme variant"; implemented instead as a **runtime token overlay** so it composes with all five variants and both modes. A `systemAccent` boolean (persisted inside the existing `theme_settings` blob; Switch in Appearance, rendered only when `isElectronMac()`) makes ThemeContext re-apply `applyThemePalette` and then overwrite `--primary`, `--ring`, `--sidebar-primary` (+ foregrounds) with the converted macOS accent. `lib/accentColor.ts` converts Electron's RRGGBBAA to HSL token components and picks a WCAG-contrast foreground (yellow/green accents get ink, blue/purple get white). Toggling off self-heals because `applyThemePalette` resets every token. Live updates via `AppleColorPreferencesChangedNotification` (the `accent-color-changed` event is Windows-only); an epoch counter discards stale async applications.

### Vibrancy — material always present, translucency opt-in
The window is always created with `vibrancy: 'under-window'` + `visualEffectState: 'followWindow'` — invisible while the page paints opaque pixels, so default rendering is unchanged. Only when **enhancedEffects** (ADR-071's GPU gate) is on does ElectronBridge add the `vibrancy` html class, and one CSS rule makes `body` translucent (`hsl(var(--background) / 0.72)`); body background propagates to the root canvas, so a single rule controls the whole backdrop. Untested visually (headless) — the 0.72 alpha is a starting point for the user's on-device pass, and the class-gate makes revert trivial.

## Consequences

**Positive**: the shell behaves like a Mac app (menu bar with learnable accelerators, dock badge/menu, traffic lights in the chrome, drag-a-CSV-to-import); the file-drop navigation hole is closed; renderer sandbox untouched; every new feature degrades to a no-op in the browser build.

**Negative / risks**:
- `GO_MENU_ROUTES` (main.js) duplicates `GO_TO_ROUTES` (renderer) — manual sync point.
- Vibrancy alpha and traffic-light/topbar geometry are tuned blind; need the user's visual pass on the built `.app`.
- Native menu accelerators (⌘1–9, ⌘N, ⇧⌘I, ⌃⌘S) are discoverable in the menu but not yet listed in the in-app ShortcutsOverlay (deliberate: the overlay was being reworked concurrently in V5-V7; logged as follow-up).
- The Help-menu role search (macOS) only indexes our two custom items.

**Neutral**: `theme_settings` gains an optional `systemAccent` key (older payloads hydrate fine); i18n +11 keys (`menu.*`, `settings.appearance.systemAccent*`).

## Related
- [[docs/adr/071-premium-v3-effects-toggle|ADR-071]] — enhancedEffects toggle this builds on
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] — liquid glass system
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] — Electron GPU budget history
- [[docs/adr/index|All ADRs]]

---

## Implementation Note — Accelerator & Renderer-Ready Bug Fixes (2026-06-11)

Two defects found during end-to-end testing of the packaged app are fixed in `packaging/electron/main.js`. The ADR decision text above stands unchanged; this note records what the original implementation got wrong and how it was corrected.

### Defect 1 — `rendererReady` reset on same-document navigation (root cause of silent queue jam)

**Original code:** `mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; })`

**Problem:** `did-start-loading` fires for *every* navigation, including React Router's `pushState`-based same-document transitions. The renderer only calls `app:renderer-ready` once per document load; after the first client-side route change (e.g., the boot-time route restore), `rendererReady` was permanently set back to `false` and could never be set to `true` again — `pendingAppMessages` accumulated forever. Every subsequent menu bar action, dock menu click, and CSV open-file handoff silently queued and never reached the renderer.

**Fix:** Replaced the listener with:
```js
mainWindow.webContents.on('did-start-navigation', (details) => {
  if (details.isMainFrame && !details.isSameDocument) rendererReady = false;
});
```
`did-start-navigation` exposes `isSameDocument` and `isMainFrame`; the reset now fires only on real document loads and hard reloads. React Router navigations no longer disturb the queue.

### Defect 2 — Sandboxed-renderer accelerators silently swallowed

**Original code:** accelerators (⌘1–⌘9, ⌘N, ⇧⌘I, ⌃⌘S) were declared on menu items via the `accelerator:` field only.

**Problem:** macOS's unhandled-keystroke → native-menu key-equivalent redispatch is unreliable when the sandboxed Electron renderer holds focus. Menu-bar mouse clicks dispatched `menu:action` correctly, but the same items did nothing when pressed via keyboard in the packaged `.app`.

**Fix:** A new `handleMenuAccelerator(event, input)` function is registered on `mainWindow.webContents.on('before-input-event')` inside `createWindow()`. It matches the same chords the menu displays:

| Chord | Match strategy | Action |
|-------|---------------|--------|
| ⌘1–⌘9 | `input.code` (`Digit1`…`Digit9`) — physical key, layout-independent | `menuAction('navigate', route.url)` via `GO_MENU_ROUTES` |
| ⌘N | `input.key === 'n'` | `menuAction('new-transaction')` |
| ⇧⌘I | `input.key === 'i'` + `input.shift` | `menuAction('navigate', '/import')` |
| ⌃⌘S (macOS) / Ctrl+Shift+S (other) | `input.key === 's'` + platform-specific modifiers | `menuAction('toggle-sidebar')` |

`event.preventDefault()` on match suppresses any duplicate native-menu dispatch. Auto-repeat events are skipped. Role items (Reload, Zoom, Copy, …) are untouched.

Using `input.code` for digits ensures ⌘1–⌘9 work positionally on AZERTY and other non-QWERTY layouts without requiring `Shift`.

**Verification:** End-to-end test on the real stack confirmed that after a client-side navigation, ⌘7 navigated to `/portfolio` and ⌘1 to `/`. Real-keyboard validation on a built `.app` (including AZERTY) is still pending (logged in TODO.md).

---

## Implementation Note — Theme-Aware Boot Splash (2026-06-16)

The boot splash (`splashDataUrl()` in `packaging/electron/main.js`, shown immediately on launch before Docker I/O) was a fixed slate (`#0f172a` dark / `#f8fafc` light via `prefers-color-scheme`). It now paints in the **active theme's primary color** — emerald on `default`, purple on `dracula`, etc. The ADR decision text above stands unchanged; this note records the addition.

The splash renders in the main process *before* the backend/DB is up, so it cannot read the DB-persisted `theme_settings`. Instead the renderer mirrors the resolved palette's `primary` / `primary-foreground` (HSL component strings) into the Electron `settings.json` under a new `splashTheme` key whenever the theme/variant/mode changes:

- **Renderer** (`ThemeContext.tsx`): a new effect calls `persistSplashTheme({ background, foreground })` from `lib/api/electron.ts` (no-op outside Electron), sourcing colors from `themes[variant][mode]`.
- **Bridge**: `electronAPI.persistSplashTheme` → `ipcRenderer.invoke('theme:persist-splash', …)`.
- **Main**: the `theme:persist-splash` handler validates the sender and the two color strings, then merges `splashTheme` into `settings.json`. `splashDataUrl()` reads it back via `readSplashTheme()`.

**Security:** both values are interpolated into the splash HTML/CSS, so they are validated on write *and* on read against `HSL_COMPONENTS_RE` (digits/spaces/`%`/dots only, ≤32 chars) — anything else is rejected and the slate fallback is used. The sandbox posture is unchanged.

**Fallback:** the very first launch (before any theme has been persisted) shows the original slate splash with its light/dark variants. Subsequent launches use the persisted palette.

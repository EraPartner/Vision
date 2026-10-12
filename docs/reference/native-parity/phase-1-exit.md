---
title: "Native parity: phase 1 exit checklist"
type: reference
status: active
date: 2026-10-12
updated: 2026-10-12
tags:
  [
    reference,
    swift-rewrite,
    native-parity,
    native-app,
    phase-1,
    shell,
    settings,
    menus,
    preload-bridge,
    adr-204,
    adr-205,
  ]
description: "Where each of the 205 action rows of the shell and settings parity inventory lives in Vision Native at the end of phase 1 (file and symbol, a gap with its reason, or a recorded decision), plus the keyboard shortcuts, the preload bridge methods, the cross-cutting Electron behaviours and the inventory's Gaps and unsure items. 3 action-row gaps (2 native, 1 inherited from Electron), 2 unsure rows and 3 rows by decision."
aliases: [phase 1 exit, native parity exit, phase-1 exit checklist]
---

# Native parity: phase 1 exit checklist

> [!abstract] Summary
> Phase 1 of [[docs/adr/204-vision-native-swift-app-target|ADR-204]] exits when Vision Native has
> feature parity with the Electron shell, backups round-trip both ways and a hand-over ADR exists
> ([[docs/adr/205-vision-native-hand-over|ADR-205]], proposed). This page checks every action row of
> [[docs/reference/native-parity/shell-and-settings|the shell and settings inventory]] against the
> code on the phase 1e branch. Of 205 action rows, 158 run in the hosted frontend unchanged, 39 have
> native code, 3 are cut by decision, 3 are gaps (#203 and #204 in Vision Native, #148 inherited from
> Electron) and 2 are unsure (#67 and #205). The gap count is at the end of the page.

Other parity areas (pages, imports, portfolio, tax, admin) are hosted unchanged in phase 1; their
inventories under [[docs/reference/native-parity/index|the native parity inventory]] become the
checklists of phase 3, when screens move to SwiftUI.

## How to read a line

Each line is `#<row> (<number in its table>) <label> → <where>`. `#<row>` counts the action rows of
the inventory from 1 to 205 in document order.

- **hosted**: the React frontend runs unchanged in `apps/native/VisionNative/WebShell.swift:WebShell`
  (a `WKWebView` that loads the backend origin), so the row lives where the inventory says. The path
  after `hosted:` is the inventory's source, relative to `apps/frontend/src/`. Anything after a
  semicolon is the native dependency of that row.
- **native code**: the file and symbol in `apps/native/` that implements the row. Bridge channels
  are listed in `apps/native/Sources/VisionNativeCore/Shell/BridgeContract.swift:BridgeContract.entries`.
- **by decision**: cut or changed by a recorded decision.
- **gap**: missing in Vision Native, with the reason. **gap (inherited from Electron)**: Electron
  behaves the same way, so parity holds but the behaviour is still wrong.
- **unsure**: needs the check on a Mac named in the line; the numbers refer to
  [the manual checks in apps/native/README.md](../../../apps/native/README.md#manual-checks-on-a-mac).

Every row assumes the WebKit rendering checks of
[[docs/architecture/native-app#Runtime checks on a Mac|native-app, Runtime checks on a Mac]]. A
row is only marked unsure when its behaviour depends on WebKit in a way the inventory names.

## Action rows

### Topbar and layout actions

- #1 (1) Skip to content → hosted: `components/layout/AppLayout.tsx:229`
- #2 (2) Toggle Sidebar → hosted: `components/layout/AppLayout.tsx:262`
- #3 (3) Open command palette → hosted: `components/layout/AppLayout.tsx:268`
- #4 (4) Inline page title → hosted: `components/layout/AppLayout.tsx:327`
- #5 (5) Retry → hosted: `components/shared/ErrorBoundary.tsx:35`
- #6 (6) Reload page → hosted: `components/shared/ErrorBoundary.tsx:39`
- #7 (7) Retry → hosted: `components/shared/PageError.tsx:22`
- #8 (8) Back link/button (label supplied by page) → hosted: `components/shared/PageHeader.tsx:50`
- #9 (9) RequireAdmin gate → hosted: `components/auth/RequireAdmin.tsx:18`
- #10 (10) Drop a .csv anywhere outside a [data-dropzone] → hosted window drop (`ElectronBridge.tsx:136`, WebKit `dataTransfer.files`); a CSV opened with the app (Finder Open With, `open -a`) goes `apps/native/VisionNative/VisionNativeApp.swift:AppDelegate.application(_:open:)` → `apps/native/VisionNative/ShellController.swift:ShellController.openFiles` → `app:csv-opened` (`apps/native/Sources/VisionNativeCore/Shell/CSVHandoff.swift:CSVHandoff`). Mac check 6

### Sidebar (`AppSidebar`)

- #11 (1) Toggle sidebar → hosted: `components/layout/AppSidebar.tsx:103`
- #12 (2) Collapse sidebar → hosted: `components/layout/AppSidebar.tsx:119`
- #13 (3) Search… → hosted: `components/layout/AppSidebar.tsx:131`
- #14 (4) Hide → hosted: `components/layout/AppSidebar.tsx:266`
- #15 (5) Hidden section un-hides on arrival → hosted: `components/layout/AppSidebar.tsx:248`
- #16 (6) Home → hosted: `lib/navigation.ts:60`
- #17 (7) Transactions → hosted: `lib/navigation.ts:67`
- #18 (8) Accounts → hosted: `lib/navigation.ts:74`
- #19 (9) Planned Payments → hosted: `lib/navigation.ts:79`
- #20 (10) Categories → hosted: `lib/navigation.ts:93`
- #21 (11) Payees → hosted: `lib/navigation.ts:99`
- #22 (12) Insights → hosted: `lib/navigation.ts:105`
- #23 (13) Who owes you → hosted: `lib/navigation.ts:112`
- #24 (14) Taxes → hosted: `lib/navigation.ts:117`
- #25 (15) Import & Export → hosted: `lib/navigation.ts:122`
- #26 (16) Portfolio → hosted: `lib/navigation.ts:136`
- #27 (17) Net worth → hosted: `lib/navigation.ts:143`
- #28 (18) Stocks & ETFs → hosted: `lib/navigation.ts:149`
- #29 (19) Crypto → hosted: `lib/navigation.ts:154`
- #30 (20) Metals → hosted: `lib/navigation.ts:159`
- #31 (21) Real estate → hosted: `lib/navigation.ts:164`
- #32 (22) Savings & bonds → hosted: `lib/navigation.ts:169`
- #33 (23) Rebalance → hosted: `lib/navigation.ts:174`
- #34 (24) Portfolio taxes → hosted: `lib/navigation.ts:179`
- #35 (25) Import portfolio history → hosted: `lib/navigation.ts:184`
- #36 (26) Research home → hosted: `lib/navigation.ts:198`
- #37 (27) Markets → hosted: `lib/navigation.ts:204`
- #38 (28) Market lookup → hosted: `lib/navigation.ts:210`
- #39 (29) Compare → hosted: `lib/navigation.ts:215`
- #40 (30) Chart builder → hosted: `lib/navigation.ts:220`
- #41 (31) Forecast → hosted: `lib/navigation.ts:225`
- #42 (32) Watchlist → hosted: `lib/navigation.ts:230`
- #43 (33) Dossiers → hosted: `lib/navigation.ts:235`
- #44 (34) Analysis workspace → hosted: `lib/navigation.ts:240`
- #45 (35) Analysis monitors → hosted: `lib/navigation.ts:246`
- #46 (36) Overview → hosted: `lib/navigation.ts:265`
- #47 (37) Database maintenance → hosted: `lib/navigation.ts:271`
- #48 (38) Data Sources → hosted: `lib/navigation.ts:276`
- #49 (39) Endpoints → hosted: `lib/navigation.ts:281`
- #50 (40) Exchange rates → hosted: `lib/navigation.ts:286`
- #51 (41) AI chat → hosted: `lib/navigation.ts:309`
- #52 (42) Settings → hosted: `components/layout/AppSidebar.tsx:188`; the update dot reads `GET /api/admin/update/check`, the web path, because the native `electronUpdater` has no `checkRelease` (`BridgeScript.swift`, ADR-204 decision 5)

### Banner: Exchange-rate status (`FxStatusBanner`)

- #53 (1) Refresh → hosted: `components/notifications/FxStatusBanner.tsx:97`
- #54 (2) Dismiss → hosted: `components/notifications/FxStatusBanner.tsx:110`

### Banner: Upcoming payments (`UpcomingPaymentsNotification`)

- #55 (1) Count button with chevron (aria-expanded) → hosted: `components/notifications/UpcomingPaymentsNotification.tsx:56`
- #56 (2) Dismiss reminder for {name} → hosted: `components/notifications/UpcomingPaymentsNotification.tsx:116`
- #57 (3) All planned payments → hosted: `components/notifications/UpcomingPaymentsNotification.tsx:131`
- #58 (4) Dismiss all payment reminders → hosted: `components/notifications/UpcomingPaymentsNotification.tsx:146`
- #59 (5) Dock/taskbar badge → `apps/native/VisionNative/ShellController.swift:ShellController.setDockBadge` with `apps/native/Sources/VisionNativeCore/Shell/ShellAppearance.swift:DockBadge.label(for:)` (`app:set-badge`)

### `*` — Page not found (`NotFound`)

- #60 (1) Back to Home → hosted: `pages/NotFound.tsx:34`
- #61 (2) Transactions → hosted: `pages/NotFound.tsx:41`
- #62 (3) Import & Export → hosted: `pages/NotFound.tsx:45`

### Electron startup error page (`assets/error.html`)

- #63 (1) Retry button → `apps/native/VisionNative/LaunchStateView.swift:LaunchStateView` Try again → `apps/native/VisionNative/ShellController.swift:ShellController.launch` (bridge `recovery:retry` → `ShellController.retryLaunch`)
- #64 (2) Open logs folder button → `apps/native/VisionNative/LaunchStateView.swift:LaunchStateView` Open logs → `apps/native/VisionNative/ShellController.swift:ShellController.openLogs` (`recovery:open-logs`)

### Dialog: Command palette (`CommandPalette`)

- #65 (1) ⌘K / Ctrl+K → hosted: `components/shared/CommandPalette.tsx:158`
- #66 (2) Looking up… → hosted: `components/shared/CommandPalette.tsx:213`
- #67 (3) ↵ copy → unsure: hosted `components/shared/CommandPalette.tsx:271`, which copies with `navigator.clipboard.writeText`; whether WebKit allows it on the loopback origin is unverified (Mac check 7)
- #68 (4) {q} → hosted: `components/shared/CommandPalette.tsx:297`
- #69 (5) Payee hit rows (up to 5) → hosted: `components/shared/CommandPalette.tsx:319`
- #70 (6) Up to 5 recently opened pages (localStorage vision.palette.recents)… → hosted: `components/shared/CommandPalette.tsx:337`
- #71 (7) Every Top + Money page (Sidebar rows 6–15) with go-to hints → hosted: `components/shared/CommandPalette.tsx:357`
- #72 (8) Every Wealth page (Sidebar rows 16–25) → hosted: `components/shared/CommandPalette.tsx:357`
- #73 (9) Every Research page plus AI chat (Sidebar rows 26–35, 41) → hosted: `components/shared/CommandPalette.tsx:357`
- #74 (10) Admin pages (Sidebar rows 36–40), no go-to hints → hosted: `components/shared/CommandPalette.tsx:375`
- #75 (11) New transaction → hosted: `components/shared/CommandPalette.tsx:388`
- #76 (12) Light → hosted: `components/shared/CommandPalette.tsx:396`
- #77 (13) Dark → hosted: `components/shared/CommandPalette.tsx:403`
- #78 (14) System → hosted: `components/shared/CommandPalette.tsx:410`
- #79 (15) Schedule → hosted: `components/shared/CommandPalette.tsx:417`
- #80 (16) Settings → hosted: `components/shared/CommandPalette.tsx:424`
- #81 (17) Keyboard shortcuts → hosted: `components/shared/CommandPalette.tsx:434`
- #82 (18) Escape / outside click → hosted: `components/shared/CommandPalette.tsx:196`

### Dialog: Keyboard shortcuts (`ShortcutsOverlay`)

- #83 (1) ? key → hosted: `components/shared/ShortcutsOverlay.tsx:30`
- #84 (2) Close button / Escape → hosted: `components/shared/ShortcutsOverlay.tsx:78`

### Window: Settings (`DashboardSettingsDialog`)

- #85 (1) General → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #86 (2) Appearance → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #87 (3) Insights → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #88 (4) Behavior → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #89 (5) AI & research → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #90 (6) Backup → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #91 (7) About & maintenance → hosted: `features/settings/DashboardSettingsDialog.tsx:189`
- #92 (8) Arrow keys, Home, End → hosted: `features/settings/DashboardSettingsDialog.tsx:100`
- #93 (9) Close button, Escape, browser Back → hosted: `components/layout/AppLayout.tsx:303`

### Section: General (`GeneralSection`)

- #94 (1) Default currency → hosted: `features/settings/sections/GeneralSection.tsx:41`
- #95 (2) Number format → hosted: `features/settings/sections/GeneralSection.tsx:47`
- #96 (3) Decimal places → hosted: `features/settings/sections/GeneralSection.tsx:62`
- #97 (4) Date format → hosted: `features/settings/sections/GeneralSection.tsx:72`
- #98 (5) Language → hosted select plus `apps/native/VisionNative/ShellController.swift:ShellController.setLanguage` → `ApplicationMenu.build` rebuild (`app:set-language`)
- #99 (6) Start of week → hosted: `features/settings/sections/GeneralSection.tsx:100`
- #100 (7) Default page size → hosted: `features/settings/sections/GeneralSection.tsx:111`

### Section: Appearance (`AppearanceSection`)

- #101 (1) Theme variant → hosted: `features/settings/sections/AppearanceSection.tsx:105`
- #102 (2) Sidebar → hosted: `features/settings/sections/AppearanceSection.tsx:133`
- #103 (3) Mode → hosted: `features/settings/sections/AppearanceSection.tsx:148`
- #104 (4) Light from → hosted: `features/settings/sections/AppearanceSection.tsx:166`
- #105 (5) Dark from → hosted: `features/settings/sections/AppearanceSection.tsx:175`
- #106 (6) Use system accent color → hosted switch plus `apps/native/VisionNative/ShellController.swift:ShellController.accentColor` and `ShellController.observeAccentColor` (`app:get-accent-color`, `app:accent-color-changed`)
- #107 (7) settings.appearance.visualEffects select: Reduced / Standard / Enha… → hosted select plus `apps/native/VisionNative/ShellController.swift:ShellController.setVibrancy` (`app:set-vibrancy`, `NSVisualEffectView`)
- #108 (8) Reduce effects on large displays → hosted: `features/settings/sections/AppearanceSection.tsx:222`
- #109 (9) Gain & loss colors → hosted: `features/settings/sections/AppearanceSection.tsx:233`

### Section: Insights (`StatisticsSection`)

- #110 (1) Where exclusions apply → hosted: `features/settings/sections/StatisticsSection.tsx:195`
- #111 (2) Exclude hidden categories → hosted: `features/settings/sections/StatisticsSection.tsx:223`
- #112 (3) Include transfers → hosted: `features/settings/sections/StatisticsSection.tsx:90`
- #113 (4) Search categories… → hosted: `features/settings/sections/StatisticsSection.tsx:272`
- #114 (5) Group checkbox (top-level name) → hosted: `features/settings/sections/StatisticsSection.tsx:326`
- #115 (6) Category checkbox (full path) → hosted: `features/settings/sections/StatisticsSection.tsx:352`
- #116 (7) Search payees… → hosted: `features/settings/sections/StatisticsSection.tsx:409`
- #117 (8) Payee checkbox → hosted: `features/settings/sections/StatisticsSection.tsx:436`

### Section: Behavior (`BehaviorSection`)

- #118 (1) Open app on → hosted: `features/settings/sections/BehaviorSection.tsx:116`
- #119 (2) Cost basis method → hosted: `features/settings/sections/BehaviorSection.tsx:67`
- #120 (3) Auto-clear planned payments → hosted: `features/settings/sections/BehaviorSection.tsx:167`
- #121 (4) Keep services running on quit → `apps/native/VisionNative/ShellController.swift:ShellController.saveServicesSettings` / `loadServicesSettings` (`Shell/SettingsSync.swift`); honoured by `RuntimeSupervisor.shutdown`
- #122 (5) Dividends → hosted: `features/settings/sections/BehaviorSection.tsx:213`
- #123 (6) Interest → hosted: `features/settings/sections/BehaviorSection.tsx:213`
- #124 (7) Fees → hosted: `features/settings/sections/BehaviorSection.tsx:213`
- #125 (8) Taxes → hosted: `features/settings/sections/BehaviorSection.tsx:213`
- #126 (9) Reset dismissed recurring suggestions → hosted: `features/settings/sections/BehaviorSection.tsx:233`

### Section: AI & research (`AiSection`)

- #127 (1) Default model → hosted: `features/settings/AIChatSettingsSection.tsx:65`
- #128 (2) Default OpenAI model → hosted: `features/settings/OpenAiSettingsSection.tsx:43`
- #129 (3) Check again → hosted: `features/settings/AgentCloakDesktopSettingsSection.tsx:109`
- #130 (4) Enable → hosted: `features/settings/AgentCloakDesktopSettingsSection.tsx:119`
- #131 (5) Default answer depth → hosted: `features/settings/AnalysisPreferencesSettings.tsx:46`
- #132 (6) Default benchmark → hosted: `features/settings/AnalysisPreferencesSettings.tsx:86`
- #133 (7) Clear → hosted: `features/settings/AnalysisPreferencesSettings.tsx:91`
- #134 (8) API key password input, placeholder settings.research.placeholder → hosted: `features/settings/ResearchKeysSection.tsx:143`
- #135 (9) Save → hosted: `features/settings/ResearchKeysSection.tsx:155`
- #136 (10) Clear → hosted: `features/settings/ResearchKeysSection.tsx:166`

### Section: Backup (`BackupSection`)

- #137 (1) Browse… → `apps/native/VisionNative/ShellController.swift:ShellController.selectBackupDirectory` (`NSOpenPanel`) then `ShellController.saveBackupSettings`
- #138 (2) Back up when quitting → `apps/native/VisionNative/ShellController.swift:ShellController.saveBackupSettings`; honoured by `ShellController.prepareForQuit` → `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService.runQuitBackup`
- #139 (3) Back up now → `apps/native/VisionNative/ShellController.swift:ShellController.runBackup` → `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService.runBackup`
- #140 (4) Encryption passphrase → hosted: `features/settings/sections/BackupSection.tsx:393`
- #141 (5) Save passphrase → `apps/native/VisionNative/ShellController.swift:ShellController.setBackupPassphrase` → `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService.setPassphrase` → `Backup/BackupCrypto.swift:KeychainPassphraseStore`
- #142 (6) Clear saved passphrase → `apps/native/VisionNative/ShellController.swift:ShellController.setBackupPassphrase` with an empty value removes the Keychain item (`KeychainPassphraseStore`)
- #143 (7) Dismiss → hosted: `features/settings/sections/BackupSection.tsx:455`
- #144 (8) Choose backup file… → `apps/native/VisionNative/ShellController.swift:ShellController.selectRestoreFile` (`NSOpenPanel`, `RestorePathAllowList`)
- #145 (9) Restore now → hosted: `features/settings/sections/BackupSection.tsx:256`

### Section: About & maintenance (`AboutSection`)

- #146 (1) Source code → hosted link; `apps/native/Sources/VisionNativeCore/Shell/NavigationPolicy.swift:NavigationPolicy.decideNewWindow` opens `ShellLinks.repository` in the default browser
- #147 (2) Documentation → hosted link; `apps/native/Sources/VisionNativeCore/Shell/NavigationPolicy.swift:NavigationPolicy.decideNewWindow` opens `ShellLinks.documentation` in the default browser
- #148 (3) Release notes → gap (inherited from Electron): `apps/native/Sources/VisionNativeCore/Shell/NavigationPolicy.swift:NavigationPolicy.decideNewWindow` denies the release `html_url` exactly like Electron's `setWindowOpenHandler`, so the link does nothing in either app (inventory Gaps and unsure)
- #149 (4) Check for updates → hosted: `features/settings/sections/AboutSection.tsx:68`; checks through the web path `GET /api/admin/update/check` because the native `electronUpdater` is empty; nothing can be installed (ADR-204 decision 5)
- #150 (5) Install update → by decision: [[docs/adr/204-vision-native-swift-app-target|ADR-204]] decision 5, no updater; `electronUpdater` is an empty object, so `installShellUpdate` and `preUpdateBackup` return null
- #151 (6) Setup assistant → hosted: `features/settings/sections/AboutSection.tsx:61`
- #152 (7) Admin mode → hosted: `features/settings/sections/AboutSection.tsx:387`
- #153 (8) Reset all settings → hosted: `features/settings/sections/AboutSection.tsx:403`

### Alert: Reset all settings? (`useConfirmDialog`)

- #154 (1) Reset settings → hosted: `features/settings/sections/AboutSection.tsx:156`
- #155 (2) Cancel → hosted: `hooks/useConfirmDialog.tsx:91`

### Alert: Restore this backup? (Settings) (`useConfirmDialog`)

- #156 (1) Restore → hosted button; `apps/native/VisionNative/ShellController.swift:ShellController.isBackupEncrypted` → `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService.isEncrypted`
- #157 (2) Cancel → hosted: `features/settings/sections/BackupSection.tsx:269`

### Alert: Backup is encrypted (`useRestoreBackup`)

- #158 (1) Passphrase input → hosted: `hooks/useRestoreBackup.tsx:221`
- #159 (2) Eye toggle settings.restore.showPassphrase / hidePassphrase → hosted: `hooks/useRestoreBackup.tsx:238`
- #160 (3) Cancel → hosted: `hooks/useRestoreBackup.tsx:262`
- #161 (4) Restore → hosted button; `apps/native/VisionNative/ShellController.swift:ShellController.restoreBackup` → `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService.restore` (native confirmation, audit continuity and `auditStatus`)

### Dialog: Onboarding wizard (`OnboardingWizard`)

- #162 (1) Close → hosted: `features/onboarding/OnboardingWizard.tsx:711`
- #163 (2) Escape / outside click → hosted: `features/onboarding/OnboardingWizard.tsx:682`
- #164 (3) Skip setup → hosted: `features/onboarding/OnboardingWizard.tsx:1386`
- #165 (4) Back → hosted: `features/onboarding/OnboardingWizard.tsx:1381`
- #166 (5) Get started → hosted: `features/onboarding/OnboardingWizard.tsx:1420`
- #167 (6) Next → hosted: `features/onboarding/OnboardingWizard.tsx:1415`
- #168 (7) Go to Home → hosted: `features/onboarding/OnboardingWizard.tsx:1400`
- #169 (8) Finish your import → hosted: `features/onboarding/OnboardingWizard.tsx:1400`
- #170 (9) Restore from backup → hosted card; `apps/native/VisionNative/ShellController.swift:ShellController.selectRestoreFile`
- #171 (10) Suggested category toggle buttons (aria-pressed, all selected by de… → hosted: `features/onboarding/OnboardingWizard.tsx:1115`
- #172 (11) Create {n} categories → hosted: `features/onboarding/OnboardingWizard.tsx:1178`
- #173 (12) Select all → hosted: `features/onboarding/OnboardingWizard.tsx:1205`
- #174 (13) Bank adapter tile buttons (aria-pressed) → hosted: `features/onboarding/OnboardingWizard.tsx:909`
- #175 (14) CSV dropzone → hosted dropzone; a click opens `apps/native/VisionNative/WebShell.swift:WebShell.webView(_:runOpenPanelWith:initiatedByFrame:)`
- #176 (15) Import transactions → hosted: `features/onboarding/OnboardingWizard.tsx:1036`
- #177 (16) Review and finish import → hosted: `features/onboarding/OnboardingWizard.tsx:1022`
- #178 (17) Six feature tiles (onboarding.feature.{transactions,categories,plan… → hosted: `features/onboarding/OnboardingWizard.tsx:1267`
- #179 (18) Set backup location now → hosted: `features/onboarding/OnboardingWizard.tsx:1351`

### Alert: Restore this backup? (onboarding) (`RestoreFromBackupCard`)

- #180 (1) Restore → hosted button; same restore path as #156 and #161 (`apps/native/VisionNative/ShellController.swift:ShellController.restoreBackup`)
- #181 (2) Cancel → hosted: `features/onboarding/RestoreFromBackupCard.tsx:53`

### Menu: Electron application menu (`setupApplicationMenu`)

- #182 (1) About Vision (role) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` About item → `apps/native/VisionNative/ShellController.swift:ShellController.showAboutPanel`
- #183 (2) Settings… → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `MenuAction.openSettings` `⌘,` → `apps/native/VisionNative/ShellController.swift:ShellController.run` → `menu:action`
- #184 (3) Services, Hide, Hide Others, Show All, Quit (roles) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Services, Hide, Hide Others, Show All, Quit → `apps/native/VisionNative/MenuBuilder.swift:MenuBuilder.configure`; Quit runs `apps/native/VisionNative/VisionNativeApp.swift:AppDelegate.applicationShouldTerminate`
- #185 (4) New transaction → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `MenuAction.newTransaction` `⌘N`
- #186 (5) Import CSV… → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `MenuAction.navigate("/import")` `⇧⌘I`
- #187 (6) Close Window (macOS) / Quit (others) role → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `.closeWindow` `⌘W` → `apps/native/VisionNative/ShellController.swift:ShellController.windowShouldClose` (hides the window, like Electron)
- #188 (7) Undo, Redo, Cut, Copy, Paste, Select All (roles) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Edit items → `apps/native/VisionNative/MenuBuilder.swift:MenuBuilder.configure` (AppKit responder actions)
- #189 (8) Toggle Sidebar → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `MenuAction.toggleSidebar` `⌃⌘S`
- #190 (9) layout.light / layout.dark / layout.system / layout.schedule → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.themeModes` → `MenuAction.setTheme`
- #191 (10) Reload (role, always present) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `.reload` `⌘R` → `apps/native/VisionNative/ShellController.swift:ShellController.run` (`webView.reload()`)
- #192 (11) Toggle Developer Tools (role) → by decision: left out; Debug builds are inspectable from Safari's Develop menu ([[docs/architecture/native-app#Menus and dock|native-app, Menus and dock]], phase 1c); Electron shows it only in unpackaged builds
- #193 (12) Actual Size, Zoom In, Zoom Out (roles) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `.resetZoom` / `.zoomIn` / `.zoomOut` → `apps/native/VisionNative/ShellController.swift:ShellController.run` with `Shell/ShellAppearance.swift:PageZoom`
- #194 (13) Toggle Full Screen (role) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` `.toggleFullScreen` `⌃⌘F`; `apps/native/VisionNative/ShellController.swift:ShellController.windowDidEnterFullScreen` sends `window:fullscreen`
- #195 (14) ⌘1 nav.home /, ⌘2 nav.transactions, ⌘3 nav.statistics, ⌘4 nav.categ… → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.goRoutes` `⌘1`…`⌘9` → `MenuAction.navigate`
- #196 (15) Window menu (role: Minimize, Zoom, …) → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Window submenu (`SubmenuRole.window`: Minimize, Zoom, Bring All to Front)
- #197 (16) About {app} → by decision: non-macOS only in Electron; Vision Native is macOS only ([[docs/adr/204-vision-native-swift-app-target|ADR-204]] decision 2) and shows About in the app menu (#182)
- #198 (17) Keyboard Shortcuts → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Help `MenuAction.openShortcuts`
- #199 (18) Source Code → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Help `.openExternal(ShellLinks.repository)` → `apps/native/VisionNative/ShellController.swift:ShellController.run`
- #200 (19) Documentation → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build` Help `.openExternal(ShellLinks.documentation)` → `apps/native/VisionNative/ShellController.swift:ShellController.run`

### Menu: Dock menu (macOS) (`setupDockMenu`)

- #201 (1) New transaction → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.dock` via `apps/native/VisionNative/VisionNativeApp.swift:AppDelegate.applicationDockMenu` → `ShellController.dockMenu`
- #202 (2) Home → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.dock` Home → `MenuAction.navigate("/")`

### Menu: Native text context menu

- #203 (1) Spelling suggestion items → gap: no native text context menu; WebKit's default menu may list spelling guesses, unverified (Mac check 8; native-app, Left for later phases)
- #204 (2) Add to Dictionary → gap: no Add to Dictionary item; WebKit's default Learn Spelling may stand in, unverified (Mac check 8)
- #205 (3) Cut / Copy / Paste / Select All roles → unsure: WebKit's default editing context menu, not overridden in `apps/native/VisionNative/WebShell.swift:WebShell`; whether it offers Select All is unverified (Mac check 8)

## Keyboard shortcuts

The inventory's shortcut table (26 rows) is not part of the 205 action rows. Page shortcuts are
handled by the hosted frontend. `WKWebView` offers a key equivalent to the page first and passes it to
the menu bar only when the page does not handle it, which is the order Electron's
`before-input-event` and menu accelerators give.

- `⌘K`, `⌘,`, `N`, `⌘Z`, `⌘B`, `?`, `G` sequences, `[` / `]`, `Alt+T`, `Esc`, arrow keys in the
  Settings rail and `Enter` in the passphrase field → hosted (sources as in the inventory). `⌘,` is
  also the Settings… menu item (#183); both open Settings on General.
- `⌘N`, `⇧⌘I`, `⌃⌘S` and `⌘1`…`⌘9` → `apps/native/Sources/VisionNativeCore/Shell/ApplicationMenu.swift:ApplicationMenu.build`
  and `ApplicationMenu.goRoutes`; duplicates are checked by `ApplicationMenu.keyEquivalents` in the
  tests.
- Role accelerators (`⌘Q`, `⌘H`, `⌘W`, `⌘R`, zoom, full screen, edit keys) →
  `ApplicationMenu.build` with `apps/native/VisionNative/MenuBuilder.swift:MenuBuilder.configure`.
  Full screen is `⌃⌘F` (Electron's macOS role default), and Zoom In also answers a hidden `⌘=`.

Shortcut gaps: none.

## Preload bridge methods

The inventory's bridge table (36 entries) maps to `BridgeContract.entries`. The user script that
defines the bridges is `apps/native/Sources/VisionNativeCore/Shell/BridgeScript.swift`.

- `electronUpdater.checkRelease`, `installShellUpdate`, `preUpdateBackup` → by decision:
  [[docs/adr/204-vision-native-swift-app-target|ADR-204]] decision 5. `electronUpdater` is an empty
  object so `isElectron()` stays true; the frontend falls back to `GET /api/admin/update/check` and
  hides nothing it cannot install.
- `electronBackup.runBackup`, `selectDir`, `selectFile`, `restoreBackup`, `isEncrypted`,
  `saveSettings`, `loadSettings`, `getEncryptionStatus`, `setPassphrase` →
  `apps/native/VisionNative/ShellController.swift` (`runBackup`, `selectBackupDirectory`,
  `selectRestoreFile`, `restoreBackup`, `isBackupEncrypted`, `saveBackupSettings`,
  `loadBackupSettings`, `backupEncryptionStatus`, `setBackupPassphrase`) over
  `apps/native/Sources/VisionNativeCore/Backup/BackupService.swift:BackupService` (phase 1d).
- `electronAudit.enroll`, `read`, `exportSnapshot`, `exportTransfer`, `importTransfer`, `rotateKey`
  → `ShellController` (`enrollAudit`, `readAudit`, `exportAuditSnapshot`, `exportAuditTransfer`,
  `importAuditTransfer`, `rotateAuditKey`) over
  `apps/native/Sources/VisionNativeCore/Audit/AuditChannels.swift:AuditChannels`, with
  `AuditRuntime`, `AuditAnchor` and `KeychainAuditWitness` (phase 1e).
- `electronServices.saveSettings`, `loadSettings` → `ShellController.saveServicesSettings`,
  `loadServicesSettings`.
- `electronAPI.platform` → `"darwin"` from `BridgeScript`. `ready`, `setDockBadge`, `setLanguage`,
  `setVibrancy`, `getAccentColor`, `persistSplashTheme` → `ShellController.rendererDidBecomeReady`,
  `setDockBadge`, `setLanguage`, `setVibrancy`, `accentColor`, `persistSplashTheme`.
  `onAccentColorChanged`, `onMenuAction`, `onCsvOpen`, `onFullScreenChange` → events sent by
  `ShellController.observeAccentColor`, `run`, `openFiles` and `windowDidEnterFullScreen` /
  `windowDidExitFullScreen`.
- `electronRecovery.retry`, `openLogs` → `ShellController.retryLaunch`, `openLogs`.
- `electronRecovery.onBackendLost`, `onBackendRestored` → gap: subscribable but never fired, because
  the backend health watchdog is not ported. The frontend has no subscriber, so no row depends on
  them.
- Renderer failure reporter → `ShellController.rendererDidFail` (kind, name, source file and line
  only).

Bridge gaps: 2 (`onBackendLost`, `onBackendRestored`), with no frontend caller.

## Cross-cutting Electron behaviour

From the inventory's cross-cutting notes and
[[docs/architecture/native-app#Left for later phases|native-app, Left for later phases]]:

- Persistence and endpoints: unchanged; the frontend talks to the same backend. The localStorage
  keys live in the `WKWebView` data store of the backend origin (`http://localhost:<appPort>`), so
  they survive restarts as long as `appPort` stays the same, as in Electron.
- `electron-mac` class, drag region and full-screen class → `BridgeScript` platform plus
  `native:window-drag` and `window:fullscreen` (`ShellController.startWindowDrag`,
  `windowDidEnterFullScreen`).
- Traffic-light position: gap, AppKit's default position instead of Electron's `{ x: 20, y: 20 }`.
- Vibrancy, system accent, dock badge, external links, CSV handoff: native code (#107, #106, #59,
  #146, #10).
- Backend health watchdog (restart a crashed backend, `backend:lost` / `backend:restored`): gap.
- Renderer-ready watchdog (reload, then the error page, when the page never calls `ready()`): gap.
  The web view is revealed after 3 seconds without `ready()`, and a crashed web content process is
  reloaded twice within 30 seconds before the error page shows.
- Production security headers of `registerSecurityHeaders`: gap. The backend's own headers still
  apply.
- Zoom persistence: gap; the zoom level resets on launch.
- OS notifications: gap. Electron's `notify` in `main.ts` posts a `Notification` for an audit
  status of failed or unavailable, the quit-time backup result (`backup.done`, `backup.failed`),
  recovery from the error page (`app.running`) and quit (`app.stopped`). Vision Native logs these,
  and shows the audit notice as a sheet on the window when the window is visible.

Cross-cutting gaps: 6 (traffic-light position, health watchdog, renderer-ready watchdog, security
headers, zoom persistence, OS notifications).

## Inventory Gaps and unsure: resolved or inherited

1. ADR-180 lists Performance in the Wealth section: inherited. It is a frontend and docs conflict;
   the hosted registry is used.
2. Reload is in every build, not only dev: followed the code. `ApplicationMenu.build` always has
   Reload (#191).
3. `GO_MENU_ROUTES` is not a copy of `GO_TO_ROUTES`: inherited. `ApplicationMenu.goRoutes` copies
   the nine Electron routes (no Markets), and its comment still names
   `hooks/useGoToShortcuts.ts`, like the Electron comment.
4. Audit control in Settings: resolved. The audit UI is the Admin overview's
   `pages/admin/AuditHistoryCard.tsx`; all six `electronAudit` methods work in phase 1e.
5. Release notes link opens nothing: inherited (#148).
6. `menu.addToDictionary` has no locale entry: moot, no such native item (#204 is a gap).
7. `onBackendLost` / `onBackendRestored` have no caller: inherited; never fired in Vision Native.
8. Onboarding restore confirmation is not destructive: inherited (frontend). Both restores also
   pass the native `NSAlert` confirmation, where Cancel is the default button.
9. Closing onboarding completes it: inherited (frontend).
10. "Restart setup wizard" vs "Setup assistant": inherited (docs and frontend).
11. Mobile sidebar sheet closing: moot. The window's minimum width is 800 px, above the `md`
    breakpoint, so the sheet never shows, as in Electron.
12. Classic gain and loss colour hint: inherited (frontend copy).
13. `includeTransfers` and Reset all settings swallow save errors: inherited (frontend).

## Gap count

| Area                    | Rows | Hosted | Native code | By decision | Gaps            | Unsure |
| ----------------------- | ---- | ------ | ----------- | ----------- | --------------- | ------ |
| Action rows             | 205  | 158    | 39          | 3           | 3 (1 inherited) | 2      |
| Keyboard shortcuts      | 26   | 21     | 5           | 0           | 0               | 0      |
| Preload bridge methods  | 36   | -      | 31          | 3           | 2               | 0      |
| Cross-cutting behaviour | -    | -      | -           | -           | 6               | -      |

Total gaps: 11, of which 3 touch an action row (#148, #203, #204). None of them loses data or a
user-facing function that has no other path: #148 is broken in Electron too, and #203 and #204
(spelling suggestions and Add to Dictionary) may be covered by WebKit's default context menu,
which Mac check 8 records. The by-decision rows are the updater (#150, ADR-204 decision 5), the
dev-only Toggle Developer Tools item (#192) and the non-macOS Help › About item (#197).

## Related

- [[docs/reference/native-parity/shell-and-settings|Native parity: shell, menus, dock and bridge]]
- [[docs/architecture/native-app|Vision Native App Architecture]]
- [[docs/adr/204-vision-native-swift-app-target|ADR-204]]
- [[docs/adr/205-vision-native-hand-over|ADR-205]]

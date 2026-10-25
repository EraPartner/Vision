---
title: "Native parity inventory: Admin and developer tools"
type: reference
status: active
date: 2026-10-25
updated: 2026-10-25
tags:
  [
    reference,
    swift-rewrite,
    native-parity,
    admin,
    database-maintenance,
    provider-health,
    exchange-rates,
    devtools,
  ]
description: "Every screen, dialog and action on /admin, /admin/db, /admin/db/:table, /admin/providers, /admin/endpoints and /admin/exchange-rates, plus the admin-mode gate and the floating API inspector devtools."
aliases: [native parity admin and developer tools]
---

# Native parity inventory: Admin and developer tools

> [!abstract] Scope
> Routes: `/admin`, `/admin/db`, `/admin/db/:table`, `/admin/providers`, `/admin/endpoints`, `/admin/exchange-rates`. Source: `apps/frontend/src/pages/admin/`, `apps/frontend/src/pages/DbMaintenancePage.tsx`, `apps/frontend/src/features/admin/`, `apps/frontend/src/components/auth/RequireAdmin.tsx`, `apps/frontend/src/components/shared/AdminErrorState.tsx`, `apps/frontend/src/components/devtools/`. Part of [[docs/reference/native-parity/index|the native parity inventory]] for [[docs/adr/204-vision-native-swift-app-target|ADR-204]].

## Admin mode gate

Admin mode is a persisted boolean `appSettings.adminMode` (default `false`, zod `z.boolean().catch(false)`) in `apps/frontend/src/stores/settingsStore.ts:74`, `:123`, `:196`. It is the only switch that exposes the admin routes, the Admin sidebar section, the Admin command-palette group, and (in non-dev builds) the devtools.

| #   | Where                          | Element                                                                                                                                                                                                                                      | Trigger                                             | What it does                                                                                                                                        | Source                                                                                                                               | Status |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Settings dialog, About section | `settings.app.adminMode` "Admin mode" switch, hint `settings.app.adminModeHint`                                                                                                                                                              | toggle                                              | Writes `adminMode` through `updateAppSettings`; turning it on reveals everything below                                                              | `apps/frontend/src/features/settings/sections/AboutSection.tsx:384`                                                                  | native |
| 2   | Route guard                    | `RequireAdmin` wrapper on every `admin: true` route                                                                                                                                                                                          | navigate to any `/admin/*`                          | Renders nothing while settings load; redirects to `/` (replace) when admin mode is off                                                              | `apps/frontend/src/components/auth/RequireAdmin.tsx:17`, `apps/frontend/src/App.tsx:121`, `apps/frontend/src/lib/routePreload.ts:76` | native |
| 3   | Sidebar                        | `nav.admin` "Admin" section (collapsible) with items `nav.adminOverview` "Overview", `nav.dbMaintenance` "Database maintenance", `nav.adminProviders` "Data Sources", `nav.adminEndpoints` "Endpoints", `nav.exchangeRates` "Exchange rates" | click item                                          | Navigates to `/admin`, `/admin/db`, `/admin/providers`, `/admin/endpoints`, `/admin/exchange-rates`; section is appended only when admin mode is on | `apps/frontend/src/lib/navigation.ts:259`, `apps/frontend/src/components/layout/AppSidebar.tsx:78`                                   | native |
| 4   | Command palette                | `nav.admin` "Admin" group listing the same five pages                                                                                                                                                                                        | select item                                         | Navigates to the page (`goTo(page.url)`); group present only when admin mode is on; admin items have no go-to key hint                              | `apps/frontend/src/components/shared/CommandPalette.tsx:179`, `apps/frontend/src/components/shared/CommandPalette.tsx:375`           | native |
| 5   | App root                       | `DevtoolsGate`                                                                                                                                                                                                                               | admin mode on (or dev / `VITE_DEVTOOLS=true` build) | Lazily mounts `DevtoolsRoot` (floating API inspector, React Query devtools)                                                                         | `apps/frontend/src/App.tsx:75`                                                                                                       | native |

Native mapping: the switch is in `apps/native/Sources/VisionNativeUI/Screens/Settings/NativeSettingsAboutView.swift`; the guard is `NativeNavigationHistory.resolve(_:adminMode:)`; the sidebar and palette groups come from `NavigationRegistry.visibleSections(adminMode:)` and `NativeCommandPaletteModel.pageGroups(adminMode:)`; `ShellRootView` mounts the API inspector overlay only when `settings.adminMode` is on.

### Shared admin error state (`AdminErrorState`)

Used by `/admin/db`, `/admin/db/:table` and `/admin/providers` when their query fails. Source: `apps/frontend/src/components/shared/AdminErrorState.tsx`.

- Destructive alert titled with the page's fallback message and a humanized `apiErrorToMessage` body. There is no authentication variant any more.

Native mapping: `AdminErrorBanner` in `apps/native/Sources/VisionNativeUI/AdminComponents.swift`, used by `DatabaseMaintenanceView`, `TableDataEditorView` and `ProviderHealthView`; it shows `AdminErrorState.title` over `AdminErrorState.body` and has no action.

## Screens

### `/admin` — Admin overview

Component: `apps/frontend/src/pages/admin/AdminOverviewPage.tsx`. Feature doc: [[docs/features/admin-observability|Admin Observability Dashboard]].

**Regions shown:**

- Page header `admin.overview.title` "Admin overview", subtitle `admin.overview.description` "Platform health at a glance." (`apps/frontend/src/pages/admin/AdminOverviewPage.tsx:182`).
- Three summary tiles (skeleton x3 while DB stats load) (`apps/frontend/src/pages/admin/AdminOverviewPage.tsx:191`):
  - `admin.overview.dbSize` "Database size": value `db_size`, sub "N `admin.overview.tables`" (`:211`). Data: `GET /api/admin/database/stats`.
  - `admin.overview.dataSources` "Data sources": "ok / total" providers, sub "N `admin.overview.failing`" or `admin.overview.allHealthy` "All healthy"; ring warn when 1-2 failing, error when 3 or more (`:167`, `:218`). Data: `GET /api/admin/providers/health`.
  - `admin.overview.endpoints` "Endpoints": overall error rate percent + `admin.overview.errorRate`, sub "N `admin.overview.requests`"; warn when above 2 %, error at 10 % or more (`:173`, `:234`). Data: `GET /api/admin/metrics/requests`.
- Audit history card (`AuditHistoryCard`), described below (`apps/frontend/src/pages/admin/AdminOverviewPage.tsx:251`).

**URL state:** none.

| #   | Where      | Element                                                                                       | Trigger       | What it does                                                                                                                                                                  | Source                                                                                                               | Status |
| --- | ---------- | --------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Tiles      | `admin.overview.dbSize` tile (whole card is a link)                                           | click         | Navigates to `/admin/db`                                                                                                                                                      | `apps/frontend/src/pages/admin/AdminOverviewPage.tsx:216`                                                            | native |
| 2   | Tiles      | `admin.overview.dataSources` tile                                                             | click         | Navigates to `/admin/providers`                                                                                                                                               | `apps/frontend/src/pages/admin/AdminOverviewPage.tsx:231`                                                            | native |
| 3   | Tiles      | `admin.overview.endpoints` tile                                                               | click         | Navigates to `/admin/endpoints`                                                                                                                                               | `apps/frontend/src/pages/admin/AdminOverviewPage.tsx:243`                                                            | native |

#### Card: Audit history (`AuditHistoryCard`)

Opened from: always rendered on `/admin`. Source: `apps/frontend/src/pages/admin/AuditHistoryCard.tsx`. Electron-only data path: everything goes through `window.electronAudit` (preload bridge `packaging/electron/preload.ts:163`); in a browser the card shows `admin.audit.unavailable`.

Regions:

- Title `admin.audit.title` "Audit history", description `admin.audit.description` (`apps/frontend/src/pages/admin/AuditHistoryCard.tsx:248`).
- Loading skeleton with sr-only `admin.audit.loading` (`:265`).
- Status line: `admin.audit.unavailable`, `admin.audit.noTrustedAnchor` or `admin.audit.failed` (`:275`).
- Change notice `admin.audit.changed` when a paged read no longer matches the first page (`:318`).
- Verification summary: `admin.audit.verified` "Verified through entry {sequence}" or `admin.audit.partial` "Anchored through entry {anchored}"; `admin.audit.pending` count; `admin.audit.enrollmentCaveat`; `admin.audit.retentionCaveat`; `admin.audit.legacy` counts of older unverified rows (`:325`).
- Entry list (100 per page): "#sequence stream · event", anchor badge `admin.audit.enrollmentBaseline` / `admin.audit.anchor` / `admin.audit.pendingAnchor`, `createdAt`; empty state `admin.audit.empty` (`:370`).
- Export limits note `admin.audit.exportLimit`, and `admin.audit.exportUnavailable` when history exceeds 500 entries (`:455`).
- Transfer explanation `admin.audit.transferExplanation` (`:484`); rotate explanation `admin.audit.rotateExplanation` (`:543`).
- Result notes (polite on success, assertive on failure): `admin.audit.exportSuccess`/`exportFailed`, `transferSuccess`/`transferFailed`, `rotateSuccess`/`rotateFailed` (`:43`); enroll failure `admin.audit.enrollFailed` (`:308`).

Fields:

- Transfer password: password input, label `admin.audit.transferPassword` "Transfer password (at least 16 characters)", `minLength=16`, `maxLength=1024`, `autoComplete=new-password`; cleared after every transfer attempt (`apps/frontend/src/pages/admin/AuditHistoryCard.tsx:490`, `:208`).

| #   | Where                                  | Element                                                                                                                                                | Trigger | What it does                                                                                                              | Source                                                                                      | Status |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 1   | Card header                            | `admin.audit.refresh` "Refresh" button (disabled while busy)                                                                                           | click   | Re-reads the audit chain from the start (`electronAudit.read`, afterSequence 0, limit 100)                                | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:259`                                    | native |
| 2   | No-anchor state                        | `admin.audit.enroll` "Start audit protection" button (only when reason is `no_trusted_anchor` and bridge exists), with `admin.audit.enrollExplanation` | click   | Calls `electronAudit.enroll()`; Electron shows a native warning box (see below); on success reloads                       | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:304`                                    | native |
| 3   | Entry row                              | `admin.audit.details` "Entry details" disclosure                                                                                                       | click   | Expands a JSON block with `hash`, `previousHash`, `payload`                                                               | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:417`                                    | native |
| 4   | Below list                             | `admin.audit.loadMore` "Load more" button (when `hasMore`)                                                                                             | click   | Reads next 100 entries after the last sequence; if the chain head changed, drops the page and shows `admin.audit.changed` | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:448`                                    | native |
| 5   | Export block                           | `admin.audit.export` "Export snapshot" button (disabled when busy or over 500 entries)                                                                 | click   | `electronAudit.exportSnapshot()`; Electron native save dialog, default `vision-audit-snapshot.json`, JSON filter          | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:467`, `packaging/electron/main.ts:1883` | native |
| 6   | Transfer block                         | `admin.audit.transferExport` "Export protected transfer" button (needs password of 16 or more and a loaded page)                                       | click   | `electronAudit.exportTransfer(password)`; native save dialog                                                              | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:512`, `packaging/electron/main.ts:1923` | native |
| 7   | Transfer block                         | `admin.audit.transferImport` "Import protected transfer" button (needs password of 16 or more)                                                         | click   | `electronAudit.importTransfer(password)`; native open dialog (`.vat` filter) then native confirm box; on success reloads  | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:525`, `packaging/electron/main.ts:1963` | native |
| 8   | Rotate block (only with a loaded page) | `admin.audit.rotate` "Rotate audit key" button                                                                                                         | click   | `electronAudit.rotateKey()`; native confirm box; on success reloads                                                       | `apps/frontend/src/pages/admin/AuditHistoryCard.tsx:549`                                    | native |

#### Native alert: Start audit protection (Electron main process)

Opened from: Audit history row 2. Source: `packaging/electron/main.ts:1802`. Title `admin.audit.enrollTitle` "Start audit protection", message `admin.audit.enrollWarning`.

| #   | Where       | Element                                            | Trigger     | What it does                                     | Source                            | Status |
| --- | ----------- | -------------------------------------------------- | ----------- | ------------------------------------------------ | --------------------------------- | ------ |
| 1   | Message box | `admin.audit.enrollConfirm` "Start protection"     | click       | Proceeds with enrollment                         | `packaging/electron/main.ts:1805` | native |
| 2   | Message box | `settings.restore.cancelButton` "Cancel" (default) | click / Esc | Cancels; renderer treats as cancelled (no error) | `packaging/electron/main.ts:1806` | native |

#### Native alert: Import protected transfer (Electron main process)

Opened from: Audit history row 7, after a `.vat` file is chosen. Source: `packaging/electron/main.ts:1980`. Message `admin.audit.transferImportWarning`.

| #   | Where       | Element                                               | Trigger     | What it does         | Source                            | Status |
| --- | ----------- | ----------------------------------------------------- | ----------- | -------------------- | --------------------------------- | ------ |
| 1   | Message box | `admin.audit.transferImportConfirm` "Import transfer" | click       | Imports the transfer | `packaging/electron/main.ts:1983` | native |
| 2   | Message box | `settings.restore.cancelButton` "Cancel" (default)    | click / Esc | Cancels              | `packaging/electron/main.ts:1984` | native |

#### Native alert: Rotate audit key (Electron main process)

Opened from: Audit history row 8. Source: `packaging/electron/main.ts:2032`. Title `admin.audit.rotate`, message `admin.audit.rotateWarning`.

| #   | Where       | Element                                            | Trigger     | What it does                            | Source                            | Status |
| --- | ----------- | -------------------------------------------------- | ----------- | --------------------------------------- | --------------------------------- | ------ |
| 1   | Message box | `admin.audit.rotateConfirm` "Rotate key"           | click       | Rotates the key after full verification | `packaging/electron/main.ts:2035` | native |
| 2   | Message box | `settings.restore.cancelButton` "Cancel" (default) | click / Esc | Cancels                                 | `packaging/electron/main.ts:2036` | native |

### `/admin/db` — Database maintenance

Component: `apps/frontend/src/pages/DbMaintenancePage.tsx`. Feature doc: [[docs/features/database-maintenance|Database Maintenance UI]].

**Regions shown:**

- Page header `dbMaintenance.title` "Database maintenance", subtitle `dbMaintenance.subtitle` (`apps/frontend/src/pages/DbMaintenancePage.tsx:225`).
- Two summary cards: `dbMaintenance.totalSize` "Total DB size" (`db_size`) and `dbMaintenance.tableCount` "Tables" (`apps/frontend/src/pages/DbMaintenancePage.tsx:265`, `:271`).
- `AdminErrorState` with fallback `dbMaintenance.loadError` (`:279`).
- Card `dbMaintenance.tableStats` "Table statistics" with a table: columns `dbMaintenance.col.table`, `col.liveRows`, `col.deadRows` (warning tint above 1000), `col.lastVacuum`, `col.lastAnalyze` (dates via app date format, "—" when null), `col.size`, actions (sr-only `col.actions`) (`apps/frontend/src/pages/DbMaintenancePage.tsx:299`, `:123`). 5 skeleton rows while loading.
- Empty state `dbMaintenance.noTables` (`:340`).
- Footnote `dbMaintenance.statsNote` (`:363`).
- Data: `GET /api/admin/database/stats` (`apps/frontend/src/lib/api/admin.ts:73`).

**URL state:** none.

| #   | Where       | Element                                                                                                          | Trigger | What it does                                                                                                                                                                                             | Source                                                       | Status |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| 1   | Header      | `admin.moreActions` "More actions" menu (icon button)                                                            | click   | Opens dropdown                                                                                                                                                                                           | `apps/frontend/src/pages/DbMaintenancePage.tsx:232`          | native |
| 2   | Header menu | `dbMaintenance.refresh` "Refresh" item (disabled while loading, spinner icon)                                    | select  | Invalidates the DB stats query                                                                                                                                                                           | `apps/frontend/src/pages/DbMaintenancePage.tsx:239`          | native |
| 3   | Header      | `dbMaintenance.vacuumAll` "Vacuum all tables" button; label `dbMaintenance.vacuuming` "Vacuuming…" while running | click   | `POST /api/admin/database/vacuum` with `{table: null}`; no confirmation; toast `dbMaintenance.vacuumSuccess` with `dbMaintenance.allTables`, or `dbMaintenance.vacuumFailed` with error; refreshes stats | `apps/frontend/src/pages/DbMaintenancePage.tsx:252`, `:189`  | native |
| 4   | Table row   | Table name link (monospace)                                                                                      | click   | Navigates to `/admin/db/:table`                                                                                                                                                                          | `apps/frontend/src/pages/DbMaintenancePage.tsx:125`          | native |
| 5   | Table row   | Row menu, label `dbMaintenance.rowMenu` "Actions for {table}"                                                    | click   | Opens dropdown                                                                                                                                                                                           | `apps/frontend/src/pages/DbMaintenancePage.tsx:151`          | native |
| 6   | Row menu    | `dbMaintenance.openTable` "Browse rows"                                                                          | select  | Navigates to `/admin/db/:table`                                                                                                                                                                          | `apps/frontend/src/pages/DbMaintenancePage.tsx:156`          | native |
| 7   | Row menu    | `dbMaintenance.vacuumTable` "Run vacuum" (disabled while any vacuum runs)                                        | select  | `POST /api/admin/database/vacuum` with `{table}`; same toasts with the table name; refreshes stats                                                                                                       | `apps/frontend/src/pages/DbMaintenancePage.tsx:165`          | native |
| 8   | Empty state | `dbMaintenance.refresh` "Refresh" button                                                                         | click   | Invalidates the DB stats query                                                                                                                                                                           | `apps/frontend/src/pages/DbMaintenancePage.tsx:351`          | native |

### `/admin/db/:table` — Table data editor

Component: `apps/frontend/src/pages/admin/TableDataEditorPage.tsx`. Feature doc: [[docs/features/database-maintenance|Database Maintenance UI]] (DB Data Editor section), [[docs/adr/101-db-data-editor|ADR-101]].

**Regions shown:**

- Page header titled with the raw table name, subtitle `dbEditor.subtitle` (`apps/frontend/src/pages/admin/TableDataEditorPage.tsx:506`).
- Warning alert `dbEditor.warning`, plus `dbEditor.warningMatview` for `transactions`, `recipients`, `categories` (`:539`, `:68`).
- Pending bar (only with pending changes): live count `dbEditor.pendingCount` (plural, `tc`) (`:563`); note `dbEditor.lockedWhilePending` (`:591`).
- `AdminErrorState` with fallback `dbEditor.loadError` (`:597`).
- Grid card: fixed-layout table, 3rem action column + 11rem per data column, horizontal scroll; two header rows (sortable column titles with key icon on primary-key columns, then per-column filter inputs); new rows tinted green at the top; deleted rows struck through; dirty cells highlighted; NULL rendered italic "NULL"; booleans as checkboxes; 8 skeleton rows while loading; empty state `dbEditor.empty` "No rows" (`:605`-`:961`).
- Pagination footer: `dbEditor.rowsOnPage` (plural) and `dbEditor.pageNumber` "Page {page}" (`:966`).
- Data: `GET /api/admin/database/tables/:table/rows` (limit 100, cursor, orderBy, dir, filters) (`apps/frontend/src/features/admin/useTableDataEditorData.ts:33`). Placeholder data keeps the previous page while fetching and drives the background-query cue (`:40`).
- Read-only mode when the table has no primary key (`apps/frontend/src/pages/admin/TableDataEditorPage.tsx:358`).

**URL state:** path param `:table` only (`apps/frontend/src/pages/admin/TableDataEditorPage.tsx:325`). Sort, filters and page cursor are component state, not URL.

| #   | Where                                                       | Element                                                                                                                                                 | Trigger                            | What it does                                                                                                                                     | Source                                                                                                                  | Status |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Header                                                      | `dbEditor.back` "Back" link                                                                                                                             | click                              | Navigates to `/admin/db` (guarded by unsaved-changes dialog when pending)                                                                        | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:509`                                                             | native |
| 2   | Header                                                      | `admin.moreActions` "More actions" menu                                                                                                                 | click                              | Opens dropdown                                                                                                                                   | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:512`                                                             | native |
| 3   | Header menu                                                 | `dbEditor.refresh` "Refresh" (disabled while fetching, spinner; native: see Gaps)                                                                       | select                             | Invalidates all cached pages for this table                                                                                                      | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:519`                                                             | native |
| 4   | Header                                                      | `dbEditor.addRow` "Add row" button (disabled when read-only)                                                                                            | click                              | Appends a blank insert row (temp id `new-N`)                                                                                                     | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:531`                                                             | native |
| 5   | Toolbar                                                     | `dbEditor.applyFilters` "Apply filters" button (disabled when pending)                                                                                  | click                              | Turns every non-blank filter draft into a `contains` filter, resets to page 1                                                                    | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:555`, `:481`                                                     | native |
| 6   | Pending bar                                                 | `dbEditor.discard` "Discard changes" button                                                                                                             | click                              | Clears all edits, deletions and new rows (no confirmation)                                                                                       | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:569`                                                             | native |
| 7   | Pending bar                                                 | `dbEditor.preview` "Preview SQL" button (disabled while previewing)                                                                                     | click                              | `POST /api/admin/database/tables/:table/mutate` with `dryRun: true`; on success opens the Review dialog; on error toast `dbEditor.previewFailed` | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:574`, `apps/frontend/src/lib/api/dbEditor.ts:128`                | native |
| 8   | Header row 1                                                | Column title sort button (disabled when pending)                                                                                                        | click                              | Cycles ascending, descending, unsorted; resets to page 1; chevron shows direction, hover hint when unsorted                                      | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:643`, `:489`                                                     | native |
| 9   | Header row 2                                                | Per-column filter input, placeholder `dbEditor.filterPlaceholder` "Filter…", aria label "Filter… {column}" (disabled when pending)                      | type                               | Updates the draft filter for that column                                                                                                         | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:693`                                                             | native |
| 10  | Header row 2                                                | Filter input                                                                                                                                            | Enter                              | Applies filters (same as row 5)                                                                                                                  | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:709`                                                             | native |
| 11  | New row                                                     | Row menu `dbEditor.rowMenu` "Actions for this row"                                                                                                      | click                              | Opens dropdown                                                                                                                                   | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:739`                                                             | native |
| 12  | New-row menu                                                | `dbEditor.discardNewRow` "Discard new row" (destructive)                                                                                                | select                             | Removes that pending insert row                                                                                                                  | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:746`                                                             | native |
| 13  | Existing row                                                | Row menu `dbEditor.rowMenu` "Actions for this row"                                                                                                      | click                              | Opens dropdown                                                                                                                                   | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:816`                                                             | native |
| 14  | Row menu                                                    | `dbEditor.revertRow` "Revert changes to this row" (disabled when read-only, no edits, or marked deleted)                                                | select                             | Drops all staged edits for the row                                                                                                               | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:827`                                                             | native |
| 15  | Row menu                                                    | `dbEditor.deleteRow` "Mark row for deletion" (destructive; disabled when read-only)                                                                     | select                             | Stages a delete (row struck through, cells disabled)                                                                                             | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:861`                                                             | native |
| 16  | Row menu                                                    | `dbEditor.undoDelete` "Undo delete" (shown instead of 15 when marked)                                                                                   | select                             | Unstages the delete                                                                                                                              | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:843`                                                             | native |
| 17  | Cell (text, writable, not PK on existing rows, not deleted) | Cell, tooltip `dbEditor.clickToEdit` "Click to edit" / `dbEditor.readOnlyCol` "Read-only column"; aria label `dbEditor.cellLabel` "{column}, row {row}" | click                              | Opens inline input editor                                                                                                                        | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:277`                                                             | native |
| 18  | Cell                                                        | Focused cell                                                                                                                                            | Enter / Space                      | Opens inline input editor                                                                                                                        | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:264`                                                             | native |
| 19  | Inline editor                                               | Text input (prefilled; objects as JSON)                                                                                                                 | Enter                              | Stages the value and returns focus to the cell                                                                                                   | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:239`                                                             | native |
| 20  | Inline editor                                               | Text input                                                                                                                                              | Escape                             | Reverts the cell's staged value and returns focus                                                                                                | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:245`                                                             | native |
| 21  | Inline editor                                               | Text input                                                                                                                                              | blur                               | Stages the typed value and closes the editor                                                                                                     | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:234`                                                             | native |
| 22  | Boolean cell                                                | Checkbox (disabled when not writable, PK-locked or deleted)                                                                                             | toggle                             | Stages `true`/`false`                                                                                                                            | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:204`                                                             | native |
| 23  | Boolean cell                                                | Checkbox                                                                                                                                                | Escape (when dirty)                | Reverts the staged value                                                                                                                         | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:205`                                                             | native |
| 24  | Dirty cell                                                  | `dbEditor.revertCell` "Revert cell change" icon button                                                                                                  | click                              | Reverts that cell only                                                                                                                           | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:148`                                                             | native |
| 25  | Nullable non-null cell                                      | `dbEditor.setNull` "Set NULL" icon button                                                                                                               | click                              | Stages `null`                                                                                                                                    | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:309`                                                             | native |
| 26  | Footer                                                      | `dbEditor.prevPage` "Previous page" icon button (disabled on page 1, pending, or fetching)                                                              | click                              | Goes back one cursor page                                                                                                                        | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:976`                                                             | native |
| 27  | Footer                                                      | `dbEditor.nextPage` "Next page" icon button (disabled when no more, pending, or fetching)                                                               | click                              | Stores `nextCursor` and advances a page                                                                                                          | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:992`                                                             | native |
| 28  | Page                                                        | Unsaved-changes guard (`useUnsavedChanges(hasPending)`)                                                                                                 | navigate away / reload / close tab | Blocks in-app navigation to another path with the Leave dialog; browser `beforeunload` prompt on unload (native: see Gaps)                       | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:399`, `apps/frontend/src/contexts/UnsavedChangesContext.tsx:102` | native |

#### Dialog: Review pending changes (inline `Dialog` in `TableDataEditorPage`)

Opened from: row 7 above, after a successful dry run. Source: `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:1008`.
Fields: none (read-only). Content: title `dbEditor.previewTitle` "Review pending changes", description `dbEditor.previewDescription`, summary `dbEditor.commitSummary` "{inserts} new rows, {updates} changed rows, {deletes} deleted rows", destructive alert `dbEditor.deleteWarning` when deletes are present, scrollable list of SQL statements each prefixed with its op, or `dbEditor.previewEmpty` "No changes to apply".

| #   | Where  | Element                                                                                                                                                             | Trigger | What it does                                                                                                                                                                                                                | Source                                                                                                                        | Status |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Footer | `dbEditor.cancel` "Cancel"                                                                                                                                          | click   | Closes the dialog, keeps pending changes                                                                                                                                                                                    | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:1056`                                                                  | native |
| 2   | Footer | `dbEditor.commit` "Commit to database" (destructive style when deletes are present; `dbEditor.committing` "Committing…" while running; disabled when no statements) | click   | `POST .../mutate` without dry run (one transaction); on success toast `dbEditor.commitSuccess` with "N `dbEditor.statementsApplied`", refetches table, closes, discards local state; on error toast `dbEditor.commitFailed` | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:1062`, `apps/frontend/src/features/admin/useTableDataEditorData.ts:65` | native |
| 3   | Dialog | Overlay / Esc / close                                                                                                                                               | dismiss | Closes the dialog (`onOpenChange`)                                                                                                                                                                                          | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:1008`                                                                  | native |

#### Alert: Leave this page? (`UnsavedChangesProvider`)

Opened from: row 28 above. Source: `apps/frontend/src/contexts/UnsavedChangesContext.tsx:115`. Title `unsavedChanges.title` "Leave this page?", description `unsavedChanges.description`.

| #   | Where  | Element                                    | Trigger | What it does                                 | Source                                                     | Status |
| --- | ------ | ------------------------------------------ | ------- | -------------------------------------------- | ---------------------------------------------------------- | ------ |
| 1   | Footer | `unsavedChanges.stay` "Stay on page"       | click   | Cancels the navigation (`blocker.reset`)     | `apps/frontend/src/contexts/UnsavedChangesContext.tsx:126` | native |
| 2   | Footer | `unsavedChanges.leave` "Leave and discard" | click   | Continues navigation, pending edits are lost | `apps/frontend/src/contexts/UnsavedChangesContext.tsx:129` | native |

### `/admin/providers` — Data sources

Component: `apps/frontend/src/pages/admin/ProviderHealthPage.tsx`. Feature doc: [[docs/features/provider-health|Provider Health Tracking]].

**Regions shown:**

- Page header `admin.providers.title` "Data sources", subtitle `admin.providers.description` (`apps/frontend/src/pages/admin/ProviderHealthPage.tsx:227`).
- `AdminErrorState` with fallback `admin.providers.loadError` (`:233`).
- Card `admin.providers.tableTitle` "Data source health" with table columns `admin.providers.colProvider` (status icon: check at 0 failures, warning at 1-2, error at 3+, plus label), `colKind` (badge), `colLastSuccess` (date-time or `admin.providers.never` "Never"), `colFailures` (tone badge), `colLastError` (truncated, only when failures above 0), actions (`apps/frontend/src/pages/admin/ProviderHealthPage.tsx:252`, `:87`). 7 skeleton rows while loading.
- Expanded error row: full `last_error` with `last_error_at` (`:155`).
- Data: `GET /api/admin/providers/health` (`apps/frontend/src/lib/api/admin.ts:87`).

**URL state:** none.

| #   | Where        | Element                                                                                                                               | Trigger | What it does                                                                                                                                                                                               | Source                                                             | Status |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| 1   | Provider row | Last-error link button (`aria-expanded`)                                                                                              | click   | Toggles the full-error row below                                                                                                                                                                           | `apps/frontend/src/pages/admin/ProviderHealthPage.tsx:123`         | native |
| 2   | Provider row | `admin.providers.checkNow` "Check now" button (spinner and disabled while that provider probes; probes run concurrently per provider) | click   | `POST /api/admin/providers/:provider/probe`; toast `admin.providers.probeOk` or `admin.providers.probeFail` (with error description), or `admin.providers.probeError` on request failure; refetches health | `apps/frontend/src/pages/admin/ProviderHealthPage.tsx:140`, `:189` | native |

### `/admin/endpoints` — Endpoint liveness

Component: `apps/frontend/src/pages/admin/EndpointLivenessPage.tsx`. Feature doc: [[docs/features/admin-observability|Admin Observability Dashboard]].

**Regions shown:**

- Page header `admin.endpoints.title` "Endpoint liveness", subtitle `admin.endpoints.description` (`apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:86`).
- Card `admin.endpoints.tableTitle` "Route matrix" with table columns `admin.endpoints.colMethod` (colored method chip), `colPath`, `colRequests`, `colErrors`, `colErrorRate` (warning above 2 %, destructive at 10 %+), `colP50`, `colP95` ("—" when no metrics for the route) (`apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:117`, `:160`). 10 skeleton rows while the manifest loads.
- Empty state `admin.endpoints.noMatches` (`:146`).
- Data: `GET /api/admin/endpoints` merged with `GET /api/admin/metrics/requests` by `method:path` (`apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:60`, `apps/frontend/src/lib/api/admin.ts:104`, `:114`).

**URL state:** none.

| #   | Where       | Element                                                                        | Trigger | What it does                                          | Source                                                       | Status |
| --- | ----------- | ------------------------------------------------------------------------------ | ------- | ----------------------------------------------------- | ------------------------------------------------------------ | ------ |
| 1   | Card header | Filter input, placeholder `admin.endpoints.filterPlaceholder` "Filter routes…" | type    | Client-side case-insensitive filter on path or method | `apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:102` | native |

### `/admin/exchange-rates` — Exchange rates

Component: `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx`. Feature doc: [[docs/features/exchange-rates|Exchange Rates]].

**Regions shown:**

- Page header `exchangeRates.title` "Exchange rates", subtitle `exchangeRates.subtitle` (`apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:127`).
- Loading skeleton: two cards and a table placeholder (the fallback view is gone).
- Error: `PageError` with message `exchangeRates.failedToLoad` (`:189`).
- Two summary cards (`apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:191`): `exchangeRates.storedRates` (`total_rates`, sub `storedRatesDesc`), `exchangeRates.latestFetch` (rate date, sub `exchangeRates.fetchedAt` or `exchangeRates.noDataFetched`). The built-in fallback rates and their cards were removed; conversions use stored rates only (ADR-216).
- Rates card: card `exchangeRates.latestEcbRates` "Latest ECB rates" with description `exchangeRates.latestEcbDesc`, or empty state with `exchangeRates.noRates` (`:284`).
- Rates table: `exchangeRates.col.currency`, `col.unitToEur` (6 decimals), `col.eurToUnit` (4 decimals), `col.hundredInEur` (currency formatted) (`apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:49`).
- Data: `GET /api/info/exchange-rates?db_only=true` (shared cache `exchangeRateKeys.all`) (`apps/frontend/src/features/admin/useAdminQueries.ts:59`, `apps/frontend/src/lib/api/info.ts:493`).

**URL state:** none (the `?tab=` parameter went away with the fallback view).

| #   | Where            | Element                                                                                        | Trigger | What it does                                                                                                                                         | Source                                                                                                            | Status |
| --- | ---------------- | ---------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Header           | `exchangeRates.refresh` "Refresh" button (spinner; disabled while refreshing/fetching/loading) | click   | `POST /api/info/exchange-rates/refresh`; invalidates all exchange-rate queries; toast `exchangeRates.refreshSuccess` or `exchangeRates.refreshError` | `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:152`, `:131`                                                 | native |
| 2   | Empty state | `exchangeRates.refresh` "Refresh" button                                                       | click   | Same as row 1                                                                                                                                        | `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:250`                                                         | native |
| 3   | Error state      | `common.retry` "Retry" button                                                                  | click   | Refetches the exchange-rates query                                                                                                                   | `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:195`, `apps/frontend/src/components/shared/PageError.tsx:22` | native |

## Developer tools (floating API inspector)

Not a route. Mounted by `DevtoolsGate` (`apps/frontend/src/App.tsx:75`) when admin mode is on or in dev / `VITE_DEVTOOLS=true` builds. Root: `apps/frontend/src/components/devtools/DevtoolsRoot.tsx`. Copy is hard-coded English (no i18n keys). Feature doc: [[docs/features/dev-observability|Dev Observability]].

**Regions shown:**

- Floating "API" pill bottom-right, pulsing with in-flight count when requests are pending (`apps/frontend/src/components/devtools/InspectorToggle.tsx:10`).
- TanStack React Query Devtools launcher bottom-left (third-party panel) (`apps/frontend/src/components/devtools/DevtoolsRoot.tsx:25`).
- Inspector panel 520x480 bottom-right: header "API Inspector" with "N in-flight" badge or "N requests" (`apps/frontend/src/components/devtools/ApiInspector.tsx:47`).
- Requests tab: virtualized list (200-entry ring buffer, in-flight first) with method (colored), endpoint (red on error), status, duration (warning at 1 s+), "No requests yet" empty state (`apps/frontend/src/components/devtools/RequestList.tsx:111`, `apps/frontend/src/lib/devtools/apiRequestLog.ts:4`).
- Request detail pane: Method, Endpoint, Request ID, Status (tone by class), Duration, Attempt, Error code, Error message (`apps/frontend/src/components/devtools/RequestDetail.tsx:31`).
- Metrics tab: stat cards Total requests, Error rate (errors count), Cache hit ratio, Mutations success/total; "Slow requests (>1 s)" list (top 10); "Top endpoints by call count" with count, p95 and error count (top 10) (`apps/frontend/src/components/devtools/MetricsPanel.tsx:55`).

| #   | Where            | Element                                                 | Trigger | What it does                                                               | Source                                                                                                                   | Status |
| --- | ---------------- | ------------------------------------------------------- | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Floating pill    | "API" toggle button, title "Toggle API Inspector (⌘⇧A)" | click   | Toggles the inspector panel                                                | `apps/frontend/src/components/devtools/InspectorToggle.tsx:19`                                                           | native |
| 2   | Global           | Cmd+Shift+A / Ctrl+Shift+A                              | keydown | Toggles the inspector panel                                                | `apps/frontend/src/lib/devtools/devtoolsHotkey.ts:34`                                                                    | native |
| 3   | Inspector header | "Minimise" icon button                                  | click   | Closes the panel (same as Close)                                           | `apps/frontend/src/components/devtools/ApiInspector.tsx:65`                                                              | native |
| 4   | Inspector header | "Close" icon button                                     | click   | Closes the panel                                                           | `apps/frontend/src/components/devtools/ApiInspector.tsx:76`                                                              | native |
| 5   | Inspector tabs   | "Requests" tab                                          | click   | Shows request list                                                         | `apps/frontend/src/components/devtools/ApiInspector.tsx:93`                                                              | native |
| 6   | Inspector tabs   | "Metrics" tab                                           | click   | Shows metrics panel                                                        | `apps/frontend/src/components/devtools/ApiInspector.tsx:99`                                                              | native |
| 7   | Requests tab     | Filter input "Filter by endpoint or method…"            | type    | Client-side filter on endpoint or method                                   | `apps/frontend/src/components/devtools/RequestList.tsx:121`                                                              | native |
| 8   | Requests tab     | Request row (`aria-pressed` when selected)              | click   | Selects the request and opens the detail pane (list narrows to half width) | `apps/frontend/src/components/devtools/RequestList.tsx:37`, `apps/frontend/src/components/devtools/ApiInspector.tsx:106` | native |
| 9   | Request detail   | "Close request detail" icon button                      | click   | Hides the detail pane                                                      | `apps/frontend/src/components/devtools/RequestDetail.tsx:41`                                                             | native |
| 10  | Metrics tab      | "Reset all metrics" button                              | click   | Resets query metrics and clears the request log                            | `apps/frontend/src/components/devtools/MetricsPanel.tsx:155`                                                             | native |
| 11  | Bottom-left      | React Query Devtools launcher (third-party)             | click   | Opens the TanStack Query devtools panel                                    | `apps/frontend/src/components/devtools/DevtoolsRoot.tsx:25`                                                              | native |

Native mapping: `apps/native/Sources/VisionNativeUI/Components/NativeAPIInspectorView.swift` (`NativeAPIInspectorOverlay`, ⌘⇧A) over `apps/native/Sources/VisionNativeCore/API/NativeAPIInspector.swift` implements the pill, header, Requests/Metrics tabs, filter, detail pane and reset; its Queries tab is the native counterpart of the React Query Devtools panel.

## Keyboard shortcuts

| Key                        | Scope                                 | Action                             | Source                                                       |
| -------------------------- | ------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Cmd+Shift+A / Ctrl+Shift+A | Global, whenever devtools are mounted | Toggle API inspector               | `apps/frontend/src/lib/devtools/devtoolsHotkey.ts:34`        |
| Enter                      | Table editor filter input             | Apply filters                      | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:709`  |
| Enter / Space              | Focused editable table-editor cell    | Open inline editor                 | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:264`  |
| Enter                      | Table-editor inline editor            | Stage value, refocus cell          | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:239`  |
| Escape                     | Table-editor inline editor            | Revert cell, refocus cell          | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:245`  |
| Escape                     | Table-editor boolean checkbox (dirty) | Revert staged value                | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:205`  |
| Esc                        | Review pending changes dialog         | Close dialog                       | `apps/frontend/src/pages/admin/TableDataEditorPage.tsx:1008` |

Admin pages have no go-to shortcuts in the command palette (admin items render without `GoToHint`, `apps/frontend/src/components/shared/CommandPalette.tsx:371`).

## Cross-cutting notes

- The backend is loopback-only with no admin credentials (ADR-233; the admin token card, the Bearer header and the 401/403 alert were removed in #339). The `/admin/*` guard is UX only: hide admin UI unless admin mode is on.
- Audit history is Electron-only: all six bridge calls (`enroll`, `read`, `exportSnapshot`, `exportTransfer`, `importTransfer`, `rotateKey`) live in `packaging/electron/preload.ts:163` with native dialogs in `packaging/electron/main.ts:1787`-`:2045`. Native SwiftUI must reimplement these flows (save/open panels, confirm alerts, keychain-backed audit key).
- Query staleness: DB stats 30 s (60 s on overview), provider health `QUERY_STALE_TIME_MS.FREQUENT`, request metrics 15 s, endpoint manifest 5 min, exchange rates 10 min (`apps/frontend/src/features/admin/useAdminQueries.ts:14`-`:66`). No polling or auto-refresh on any admin page.
- Endpoints used: `GET /api/admin/database/stats`, `POST /api/admin/database/vacuum`, `GET /api/admin/database/tables/:table/schema`, `GET /api/admin/database/tables/:table/rows`, `POST /api/admin/database/tables/:table/mutate` (dry run and commit), `GET /api/admin/providers/health`, `POST /api/admin/providers/:provider/probe`, `GET /api/admin/metrics/requests`, `GET /api/admin/endpoints`, `GET /api/info/exchange-rates?db_only=true`, `POST /api/info/exchange-rates/refresh`.
- The app-wide `FxStatusBanner` (stale/fallback FX warning with its own Refresh) is part of the layout shell, not this area (`apps/frontend/src/components/layout/AppLayout.tsx:286`).
- Shared `RowMenu` (icon dropdown trigger) is used for all header "More actions" and row menus here.

## Gaps and unsure

- unverified: Docs `docs/features/admin-observability.md` say admin mode lives in "Settings → App tab → Developer section" / "DashboardSettingsDialog → AppTab"; code puts the switch in an unlabeled group of `AboutSection` (`apps/frontend/src/features/settings/sections/AboutSection.tsx:369`). `dev-observability.md` says "Settings → About", which matches code.
- unverified: `admin-observability.md` lists four sidebar entries and endpoints `/api/admin/db/stats` and `/api/admin/db/vacuum`; code has five entries (adds Exchange rates) and calls `/api/admin/database/stats` and `/api/admin/database/vacuum`.
- unverified: `database-maintenance.md` "How to open" says double-click a table row; code has no double-click, only the table-name link and the row menu "Browse rows".
- unverified: `database-maintenance.md` says pagination uses `limit`/`offset` and lists many filter ops; the UI uses cursor paging (`nextCursor`) and only ever sends `op: "contains"` filters.
- unverified: `database-maintenance.md` says the commit button is disabled for tables without a primary key; in code the editor disables Add row and row-menu actions, but cells stay clickable/editable (`EditableCell` does not receive `readOnly`), and those edits never produce changes because `rowsByKey` is empty, so the pending bar never appears. Edits look possible but go nowhere.
- unverified: `database-maintenance.md` safety table still mentions a "Raw WHERE clause" mitigation; the code comment says the raw-WHERE box was removed (ADR-101 addendum 2026-07-10).
- unverified: `dev-observability.md` says the Metrics tab top-endpoints table shows p50/p95; code shows count, p95 and error count only.
- Vacuum (all or per table) runs without a confirmation dialog; Discard changes in the editor has no confirmation. Recorded as current behaviour, not a gap, but native should not add or drop confirmations silently.
- `/admin/endpoints` has no error state: a failed manifest or metrics query shows an empty table or the "No routes match your filter." message (`apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:146`). unverified whether intended.
- "Minimise" and "Close" in the API inspector do the same thing (`setInspectorOpen(false)`).
- `dbEditor.rowsOnPage` has both a flat `{n}` string and plural forms in en.json; code uses `tc` (plural) so the `.one`/`.other` forms apply. unverified whether the flat key is still used anywhere.
- `features/admin/` holds only hooks (`useAdminQueries.ts`, `useTableDataEditorData.ts`); no admin components live there.
- React Query Devtools panel contents are third-party and not inventoried.
- Table editor row 28 in Vision Native: the Leave this page? alert holds sidebar clicks, native
  links and shortcuts, the native command palette, the menu bar's Go items and Quit (an `NSAlert`
  with the same strings; Stay on page cancels the quit). In phase 3p,
  `NativeShellModel.activatePaletteAction` sends route selection through the same guarded
  `navigate(to:)` path. A route change initiated independently by the retained web page is still
  outside this native navigation guard; pending changes stay with that table's editor until
  discarded. The macOS interaction gate remains pending.
- Table editor in Vision Native: Refresh (row 3) is also disabled while changes are pending, because a reload could change the staged rows' `__xmin` under the change list; the web page only disables it while fetching. While Preview SQL runs or the Review dialog is open, cell edits, Add row, Discard changes, the row menus and Refresh are disabled, and Commit sends exactly the previewed change list (a list that changed since asks for a new preview with `dbEditor.previewFailed`). Commit is not the dialog's default button.

## Counts

- Screens: 6 (plus the non-route devtools overlay and the admin-mode gate)
- Dialogs/sheets/popovers/menus: 13 (Review pending changes dialog; Leave this page? alert; 3 Electron native audit alerts; DB maintenance header menu and table row menu; editor header menu, new-row menu and existing-row menu; Audit history entry disclosure; API inspector panel; request detail pane)
- Action rows: 89

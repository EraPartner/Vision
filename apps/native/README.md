# Vision Native

Vision Native is the Swift macOS app that replaces the Electron shell in phases
([ADR-204](../../docs/adr/204-vision-native-swift-app-target.md)). Phase 1 hosts the existing
React frontend in a `WKWebView` and runs its own PostgreSQL 18 cluster and backend on synthetic
Demo data in `~/Library/Application Support/Vision Native Demo/` (or `Vision Native/` for the
standard variant). It never reads or changes the Vision or Vision Demo data directories. The
phase 1 hand-over is recorded in
[ADR-205](../../docs/adr/205-vision-native-hand-over.md) (accepted), and
[the phase 1 exit checklist](../../docs/reference/native-parity/phase-1-exit.md) maps every shell
and settings action to its Swift code. Phase 2 puts a native sidebar around the web view and draws
the first screen, Exchange rates, in SwiftUI.

Requirements: an Apple-silicon Mac, Xcode 26 (macOS 26 deployment target) and XcodeGen. XcodeGen
stays the project-file tool (ADR-204 decision 3). The deployment target and the CI runner label
(`macos-26` in `.github/workflows/ci.yml`) are pinned and raised together.

## Layout

| Path                                   | Purpose                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `project.yml`                          | XcodeGen spec for the "Vision Native" app target                               |
| `Config/Signing.xcconfig`              | Signing team from `VISION_NATIVE_TEAM_ID`                                      |
| `VisionNative/`                        | AppKit app, window, menus and the `WKWebView` shell                            |
| `Package.swift`                        | SwiftPM package: `VisionNativeCore`, `VisionNativeUI`                          |
| `Sources/VisionNativeCore/`            | Non-UI logic: runtime supervision, health, override                            |
| `Sources/VisionNativeCore/Shell/`      | Bridge contract and codec, web view policy, menus                              |
| `Sources/VisionNativeCore/Backup/`     | Backup bundles, encryption and restore (phase 1d)                              |
| `Sources/VisionNativeCore/Audit/`      | Audit anchor, Keychain witness, audit bridge (1e)                              |
| `Sources/VisionNativeCore/API/`        | `APIClient` and the generated OpenAPI client (2)                               |
| `Sources/VisionNativeCore/Design/`     | Generated design tokens, `ThemeSelection` (2)                                  |
| `Sources/VisionNativeCore/Navigation/` | Generated sidebar registry, routes, shell model (2)                            |
| `Sources/VisionNativeCore/Screens/`    | Screen models: Rates, Admin, Planned, Import, Transactions, Accounts, Insights |
| `Sources/VisionNativeUI/`              | SwiftUI shell and screens, `Localizable.xcstrings`                             |
| `openapi-operations.txt`               | operationIds the Swift client is generated for                                 |
| `i18n-keys.txt`                        | `i18n/source` keys copied into the String Catalog                              |
| `Tests/VisionNativeCoreTests/`         | Swift Testing tests and `Fixtures/` from Electron                              |
| `Tests/VisionNativeUITests/`           | String Catalog (EN and NL) and SwiftUI layout tests                            |

`VisionNative.xcodeproj`, `VisionNative/Info.plist`, `build/`, `.build/` and
`Config/Local.xcconfig` are generated or local and are gitignored.

## Generate, build and test

Run from the repository root:

```bash
bun run native:generate   # only after changing openapi.yaml, tokens, i18n/source or navigation.ts
brew install xcodegen
xcodegen generate --spec apps/native/project.yml
xcodebuild -project apps/native/VisionNative.xcodeproj -scheme "Vision Native" -configuration Debug CODE_SIGNING_ALLOWED=NO build
swift test --package-path apps/native
```

## Install

`./install-native.sh` prepares the runtime payload (PostgreSQL 18, the compiled backend, Alembic,
Chrome Headless Shell and the synthetic Demo seed) with the same scripts as `install-demo.sh`,
into `apps/native/build/payload/`. It then generates the project, builds Release into
`apps/native/build/`, stages the payload into `Contents/Resources/runtime/` and
`Contents/Resources/demo-seed/` before signing, and copies the app to
`/Applications/Vision Native Demo.app`. `VISION_NATIVE_SKIP_PAYLOAD=1 ./install-native.sh` builds
without a payload; the app then shows how to provide one.

### Variants

One target builds two variants, picked by the build setting `VISION_NATIVE_VARIANT` and read at
launch from `VisionNativeVariant` in `Info.plist`:

| Variant                | App                      | Data directory and runtime id               | PostgreSQL |
| ---------------------- | ------------------------ | ------------------------------------------- | ---------- |
| `demo` (install)       | `Vision Native Demo.app` | `Vision Native Demo/`, `vision_native_demo` | 54332      |
| `standard` (Xcode, CI) | `Vision Native.app`      | `Vision Native/`, `vision_native`           | 54331      |

`./install-native.sh` builds the Demo variant; `VISION_NATIVE_VARIANT=standard ./install-native.sh`
builds the standard one, and `xcodebuild ... VISION_NATIVE_VARIANT=demo` picks the Demo variant in
a manual build. Both run on the synthetic Demo dataset until the phase 4 switch-over (ADR-204). The
bundle id, the Keychain service names and the iCloud backup folder follow the variant (for example
`com.vaultvoyager.vision-native-demo.audit-witness` and `Vision Native Demo/Backups`).

`bun run demo:reset-vision-native` asks Vision Native Demo to restore the canonical seed at its next
launch (quit it first, then reopen it). `bun run demo:reset-native` still resets Electron's Vision
Demo.

Set `VISION_NATIVE_TEAM_ID` to your free personal team id, or put `VISION_NATIVE_TEAM_ID = <id>` in
`apps/native/Config/Local.xcconfig`, for a signature that stays stable between builds. Without
either the build is signed ad-hoc, and the signature changes on every build.

## Runtime

On launch the app takes a single-instance lock, verifies the payload against its `manifest.json`,
creates or reuses its private cluster on `127.0.0.1:54331`, activates the synthetic Demo seed when
it changed, starts the backend on a random loopback port (persisted as `appPort` in
`settings.json`) and loads the frontend once `/health/detailed` is ready. On quit it stops the
backend and PostgreSQL unless "keep services running on quit" is on. Logs are in
`~/Library/Application Support/Vision Native/logs/main.log` and
`native/vision_native/logs/{backend,postgres}.log` below the same folder.

The payload is found in this order:

1. `VISION_NATIVE_RUNTIME_DIR`, an absolute path to a prepared `native-runtime` directory, in
   Debug builds only. A Release build ignores it with a logged warning. The synthetic seed must
   be its `demo-seed` sibling.
2. `Contents/Resources/runtime/` in the app bundle.

Without a payload the window shows the reason and a Retry button. A failed launch stops the
backend it started and keeps PostgreSQL running, so Retry starts a fresh backend.

To run a Debug build against a payload, run `./install-native.sh` once (it leaves `native-runtime/` and `demo-seed/` in
`apps/native/build/payload/`), then set `VISION_NATIVE_RUNTIME_DIR` to
`<repo>/apps/native/build/payload/native-runtime` in the scheme's Run environment (Product > Scheme >
Edit Scheme > Run > Arguments).

## Shell

The window hosts the unchanged React frontend and behaves like the Electron shell
(see [the architecture page](../../docs/architecture/native-app.md#shell-phase-1c)):

- A user script defines the `window.electron*` bridges of `packaging/electron/preload.ts`, backed by
  a `WKScriptMessageHandlerWithReply` named `visionNative`. `Shell/BridgeContract.swift` maps every
  Electron channel to its Swift handler. The updater is not ported (ADR-204 decision 5).
- The web view loads only the backend origin. The repository and documentation links open in the
  default browser, other navigations and new windows are cancelled, and downloads open a save
  panel. A replaced file is swapped in only after its download finished.
- The menu bar, dock menu, dock badge, window frame (`windowBounds` in `settings.json`), hide on
  close, full screen and vibrancy follow `packaging/electron/main.ts`. Menu labels come from
  `i18n/source/{en,nl}.json`, copied to `Contents/Resources/i18n/` by a build phase.
- The launch screen uses the splash palette and shows the runtime status, or the error with Open
  logs and Try again.

## Native navigation and screens (phase 2)

See [the architecture page](../../docs/architecture/native-app.md#native-navigation-and-screens-phase-2).

- `bun run native:generate` regenerates the OpenAPI client (operations listed in
  `openapi-operations.txt`), the design tokens, the String Catalog (keys listed in
  `i18n-keys.txt`) and the sidebar registry. CI fails when the committed files differ.
- The window is a `NavigationSplitView`: a native sidebar from `apps/frontend/src/lib/navigation.ts`
  and a detail column with the web view or a native screen. The page reports its route through
  `electronAPI.routeChanged` (`shell:route-changed`) and hides its own sidebar when
  `electronAPI.nativeNavigation` is set.
- `/` is native once `app_settings` loads (phase 3g part A): the eleven Home widgets, native
  charts with hover and keyboard readouts, balance/forecast range comparisons, exclusion toggles,
  forecast controls and diagnostics, widget customization, inactivity dismissals, and links into
  the native transaction inspector. Add transaction reuses the native sheet and opens its created
  row in Transactions.
- `/statistics` draws all six tabs natively (phase 3g part B): monthly rhythm and charts, category
  metrics and hierarchy pivot with drill links, payee table, yearly totals, Sankey flow, deterministic
  findings, and saved charts with all seven variants and live preview. The PDF menu temporarily
  opens the existing web report dialog with `?export=pdf`; closing restores the native tab/window.
  Financial, portfolio, and tax report options remain available through the shared dialog. This report surface and the Mac review remain phase-3 exit requirements.
- `/tax` is native (phase 3h): the filing masthead, eight configurable widgets, server-computed
  charts and comparisons, household breakdown, deduction review, six-step write-through profile
  sheet, snapshot/freeze/filing/history actions, and CSV export. Tax formulas remain shared
  TypeScript behind the compute/overview/dashboard operations; Swift decodes money as Decimal.
  PDF export opens the shared web dialog with `?export=pdf`, retaining the selected year.
- `/portfolio` and the five asset pages are native (phase 3i): canonical server totals and
  chart data, broker-filtered holdings, ticker/news/exposure, configurable widgets, read-only
  archived details, investment/trade forms, and confirmed lot assignment with complete history.
  Native editors preserve explicit null clears and ambiguous-write retry identities. PDF actions
  retain the shared web dialog on the current route via `?export=pdf`.
- `/portfolio/rebalance` uses the existing TypeScript commitment-aware cash and rebalance
  operations with URL drafts, custom/preset targets, caps, and conditional saved-plan writes.
- `/portfolio/net-worth` renders full daily chart history, account reconciliation and a separate
  newest-first paginated table. Period changes retain the full chart series; stale currency reads
  cannot replace the current values. Full macOS compilation and Demo review remain pending.
- `/portfolio/import` and `/portfolio/import/:batchId/review` are native (phase 3j): maintained
  CSV/XLS/XLSX detection uses a read-only server probe; staging, parser configuration, history,
  mapping, reconciliation and commits retain the existing TypeScript contracts. Native and web
  views share session metadata through the two existing sessionStorage keys, without file bytes.
- `/portfolio/tax` displays authoritative TypeScript costs and fiscal estimates, with the shared
  tax year/profile/snapshot/filing/history/CSV actions and seven widget preferences. Manual costs
  and classifications edit the live year with original CAS baselines, even from historical views.
  Both tax routes validate and mirror the viewed year in the URL after reading the live profile
  and snapshots. Portfolio Tax has no PDF action in the existing app.
- `/admin`, `/admin/providers`, `/admin/endpoints` and `/admin/exchange-rates` are native, in
  admin mode only, and so are `/admin/db` and `/admin/db/:table`; the table editor holds
  navigation and Quit behind a native Leave this page? alert while it has pending changes. The admin token card writes the page's
  `sessionStorage`, and the audit history card uses the native audit channels. Native requests carry the page's admin
  token from `sessionStorage`, read from the web view, and nothing else stores it.
- `/planned` is native in every mode once `app_settings` has loaded (phase 3c). Add payment and
  Edit open the native planned-payment sheet, which holds navigation and Quit behind the Leave this
  page? alert while it has unsaved edits. Mark as paid opens the native transaction picker, the
  match suggestions banner's Review opens it for the first suggestion, and the recurring detection
  panel tracks a pattern as a planned payment or dismisses it (kept on this Mac and in the
  `dismissed_recurring_patterns` setting).
- `/import` and `/import/:batchId/review` are native in every mode once `app_settings` has loaded
  (phase 3d): the bank import card (dropzone, bank source, custom CSV setup and saved parsers,
  detected columns, live progress for built-in banks), Import history, the export card (filters,
  Export CSV or JSON through a save panel) and Setup and reference (supported banks, payees and
  categories from CSV). The review page groups the rows by payee, applies a payee or category to
  every row of a group, and commits or discards the batch. A CSV opened from Finder or the dock, or
  dropped on a native screen, pre-fills the card. A chosen file or an unsaved parser edit holds
  navigation and Quit behind the Leave this page? alert.
- `/transactions` is native in every mode once `app_settings` has loaded (phase 3e): the
  filter toolbar (account, category, date, type, Needs category, View), the filter banner with
  Export CSV or JSON, search with its suggestions, server sort, column filters, resizable columns,
  infinite scroll, inline row editing, the Status toggle, the row context menu, delete with an
  8-second Undo toast (`⌘Z`), the inspector (docked from 1024 points, a sheet below) with its
  category tips, details, tags and attachments, Quick Look (Space), the Add transaction sheet
  (expense, income, transfer), the Split dialog, and the bulk bar with its dialogs (category,
  payee, export, tags, split), mark as internal transfer, include, exclude and delete.
- `/owes` is native in every mode: the total outstanding, the people who owe you, and a person's
  splits with Record payment, Mark as settled, Delete split, Settle all, Export CSV through a save
  panel and Recent transactions.
- `/accounts` and `/accounts/:id` are native in every mode (phase 3f): the hub groups accounts
  into cash, portfolio, liabilities and archived with converted subtotals and Net cash, drift
  chips and holdings; the detail shows the balance card with its sparkline, holdings, upcoming
  planned payments, the ledger with running balances and the `since` banner, and the account
  details. Add and Edit account, Reconcile, Opening balance, Merge, Close (with portfolio lots),
  Transfer lots, Reopen and Delete run natively.
- `/categories` and `/recipients` are native in every mode (phase 3f part B): the category tree
  with Show inactive, Expand all and the Add / Edit, Merge, status (with Undo) and Delete actions;
  the payees table with server search and sort, column filters, infinite scroll, inline edit and
  default category, Add payee, Merge payees (with the rule suggestion), Unmerge, status with Undo,
  Delete and the Match rules dialog. The tag picker shows a failed tag create inline.
- To add a screen: list its operations and keys, run `bun run native:generate`, add a model in
  `Sources/VisionNativeCore/Screens/`, a view in `Sources/VisionNativeUI/`, and a `NativeScreen`
  case for its route. Pass the model to `NativeShellModel` in `ShellController.makeShellModel` and
  show it in `NativeScreenContainer`.

## Backup and restore

Settings > Backup works as in Electron Vision (see
[the architecture page](../../docs/architecture/native-app.md#backup-and-restore-phase-1d)).
`Sources/VisionNativeCore/Backup/` writes and reads the same `.visionbak` and `.visionbak.enc`
bundles, so a backup made by either app restores in the other, and restores the legacy `.sql` and
`.sql.enc` dumps.

- The backup passphrase is `VISION_BACKUP_PASSPHRASE`, else a login Keychain item with the service
  `com.vaultvoyager.vision-native.backup-passphrase`. It is never written to `settings.json`. An
  unsigned rebuild can make macOS ask for the login password before reading it.
- Without a configured directory, backups go to `Vision Native/Backups` in iCloud Drive (not
  Electron's `Vision/Backups`), and the backup on quit is on.
- Restores accept only files chosen in the restore file picker and ask for confirmation first.
  A restore refuses a backup from a newer schema, and one with a numbered schema when this
  install's schema cannot be determined. It pauses the audit closure and checks the restored audit
  history before it commits; when that check fails, a second confirmation offers to restore
  without audit verification, and the audit status then reads unavailable.
- The quit-time backup runs before the services stop, within the 45-second quit limit.

The Swift tests open the Electron Vision 1.0.2 fixture in
`Tests/VisionNativeCoreTests/Fixtures/`, a byte-for-byte copy of
`packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc`.

## Audit history

Admin mode's overview page shows the audit history card, backed by the `electronAudit` channels
(see [the architecture page](../../docs/architecture/native-app.md#audit-anchor-and-keychain-witness-phase-1e)).
`Sources/VisionNativeCore/Audit/` keeps Electron's receipt (`audit-anchor/checkpoint.json`), HMAC
and transfer format, and talks to the backend's `/api/internal/audit` routes with a per-launch
bridge token. The witness is a login Keychain item (`com.vaultvoyager.vision-native[-demo].audit-witness`,
account `latest-checkpoint`), written through the Security framework. The HMAC key in
`audit-anchor/key.enc` is protected as `vn1` under a Keychain wrapping key (`...audit-key`),
instead of Electron's `safeStorage`.

`Tests/VisionNativeCoreTests/Fixtures/audit/` holds a receipt, key, witness value and transfer
written by `packaging/electron/audit-anchor.ts`; its README says how to regenerate them. CI also
checks the other direction: the Swift tests write a plain bundle, an encrypted bundle and an audit
transfer, and the `native-interop` job opens them with the Electron readers.

## Manual checks on a Mac

CI builds and tests the code but cannot run the app. Run these in your own terminal from the
repository root, in order. Each step says what you should see. Use only the Demo apps: none of
these steps touches Electron Vision or its data.

1. **Install.** Run `./install-native.sh`. Expected: the payload is prepared, the build succeeds,
   `codesign --verify --strict` passes and `/Applications/Vision Native Demo.app` is replaced. The
   script prints the Demo reset command at the end.
2. **Launch the Demo.** Run `open "/Applications/Vision Native Demo.app"`. Expected: the splash
   with the Vision mark, then Home with the synthetic Demo data; the menu bar reads "Vision Native
   Demo". `~/Library/Application Support/Vision Native Demo/` exists with
   `native/vision_native_demo/`, and `lsof -nP -iTCP:54332 -sTCP:LISTEN` shows `postgres` on
   `127.0.0.1` only. `~/Library/Application Support/Vision/` is unchanged.
3. **Side by side with Electron Vision Demo.** Open `/Applications/Vision Demo.app` as well.
   Expected: both run (PostgreSQL 54330 and 54332) and neither shows an error.
4. **Backup from Vision Native to Electron.** In Vision Native Demo, Settings > Backup: choose a
   folder, save a passphrase, click Back up now. Expected: a toast with the file name and a
   `vision_backup_<device>_<date>.visionbak.enc` in the folder. In Electron Vision Demo,
   Settings > Backup > Choose backup file, pick that file, Restore now, enter the passphrase.
   Expected: "Restore complete" (Electron may first ask whether to restore without verified audit
   history, because the two Demos' audit checkpoints differ; accept), and the page reloads with the
   data of the Vision Native backup.
5. **Backup from Electron to Vision Native.** Make a backup in Electron Vision Demo and restore it
   in Vision Native Demo the same way. Expected: the native "Restore this backup?" confirmation. When the
   restored audit history does not match this app's own audit checkpoint (expected here), a second
   warning, "Restore without verified audit history?", follows with Cancel as the default; click
   Restore now. Then "Restore
   complete" and the reload. What the Audit history card on the Admin overview shows next depends
   on whether the first Demo launch anchored itself, which is still to be confirmed on the Mac:
   a new cluster whose `legacyUnverified` counts are all zero signs its first checkpoint at launch
   (ADR-161), any other first launch waits for enrolment. Without that first checkpoint, the card
   reports the history as unavailable and offers "Start audit protection" (step 9). With it, the
   restored history no longer reaches the trusted checkpoint, so the card reports that the history
   cannot be verified (failed or unavailable) and offers no enrolment. Note which one you see. A wrong passphrase reopens the prompt
   with "Incorrect passphrase. Try again."
6. **CSV handoff.** Drag a `.csv` file onto the window, outside the import dropzone. Expected: the
   Import page opens with the file selected. Then run `open -a "Vision Native Demo" file.csv`.
   Expected: the same.
7. **Clipboard.** Press `⌘K`, type `2+2`, press Enter. Expected: "Copied to clipboard", and `4` is
   on the clipboard (exit checklist row #67).
8. **Text context menu.** In any text field, type a misspelled word and right-click it. Expected:
   Cut, Copy and Paste. Note whether spelling guesses, Learn Spelling and Select All appear; this
   settles rows #203 to #205 of the exit checklist.
9. **Audit enrolment.** Settings > About & maintenance > Admin mode on. Open the Admin overview.
   If the card offers "Start audit protection" (no first checkpoint, see step 5), click it and
   confirm. If it does not, the first launch anchored itself and enrolment is not needed. In that
   case the recovery restore of step 5 leaves the history unverified (the Demo reset does not
   clear the anchor), and steps 10, 11 and 13 need a verified history: on a first run, do steps 9
   to 13 right after step 3 and the backup steps after them. Which case applies is to be confirmed
   on the Mac. Expected either way, before any recovery restore: the card shows "Verified through
   entry N"; Keychain Access lists `com.vaultvoyager.vision-native-demo.audit-witness` (account
   `latest-checkpoint`) and `com.vaultvoyager.vision-native-demo.audit-key`;
   `Vision Native Demo/audit-anchor/` holds `key.enc` and `checkpoint.json`.
10. **Audit export.** Click "Export snapshot". Expected: a save panel for
    `vision-audit-snapshot.json`, and the file lists the verified entries.
11. **Audit transfer export.** Enter a transfer password of at least 16 characters and click
    "Export protected transfer". Expected: a save panel for `vision-audit-transfer.vat` and a
    success message. A shorter password is refused before any panel opens.
12. **Audit device move from Electron (rehearses ADR-205 step 3.5's alternative).** Import works
    only on the first launch of a new cluster (ADR-161), so use the standard variant, which has its
    own Demo-only directory. In Electron Vision Demo, enrol the audit history if needed, export a
    protected transfer, then click Back up now straight away, with no changes in between. Run
    `VISION_NATIVE_VARIANT=standard ./install-native.sh` and open `/Applications/Vision Native.app`
    for the first time. Turn on Admin mode, click "Import protected transfer", confirm the
    replacement warning, choose the `.vat` file and enter its password. Expected: success. Then
    restore the Electron backup in Settings > Backup. Expected: "Restore complete" without the
    audit recovery question, and the Audit history card shows "Verified through entry N". A wrong
    password fails and leaves the anchor unchanged. If the standard variant was opened before,
    the import is refused with `transfer_target_not_fresh`. Starting it fresh is your call: quit
    the app, remove `~/Library/Application Support/Vision Native/` (it holds only Demo data), and
    delete its two Keychain items, or the next launch finds a witness without local files
    (`anchor_invalid`) and the import is refused again:

    ```bash
    security delete-generic-password -s com.vaultvoyager.vision-native.audit-witness -a latest-checkpoint
    security delete-generic-password -s com.vaultvoyager.vision-native.audit-key -a audit-anchor-key
    ```

    The Demo variant's equivalents, for a fresh Demo directory
    (`~/Library/Application Support/Vision Native Demo/`):

    ```bash
    security delete-generic-password -s com.vaultvoyager.vision-native-demo.audit-witness -a latest-checkpoint
    security delete-generic-password -s com.vaultvoyager.vision-native-demo.audit-key -a audit-anchor-key
    ```

13. **Rotate key.** Click "Rotate audit key" and confirm. Expected: success, and the card still
    shows "Verified through entry N".
14. **Quit backup.** In Settings > Backup, turn on "Back up when quitting" and keep "Keep services
    running on quit" off. Quit with `⌘Q`. Expected: the app quits within 45 seconds, a new bundle
    is in the backup folder, and port 54332 is no longer listening.
15. **Demo reset.** Run `bun run demo:reset-vision-native`, then reopen the app. Expected: the
    canonical Demo data is back (the audit card may then report that the history changed, as in
    Electron Vision Demo; see ADR-205 question 7).
16. **Native sidebar (phase 2).** Expected: the native sidebar lists the web sections with SF
    Symbols and the page shows no sidebar of its own. Clicking an entry opens that page; Back in
    the page moves the highlight with it. View > Toggle Sidebar (`⌃⌘S`) hides the sidebar and the
    page's topbar moves clear of the traffic lights. Switch the app language to Nederlands: the
    sidebar labels change at once.
17. **Exchange rates (phase 2).** Turn on admin mode in Settings, open Admin > Exchange rates.
    Expected: the native screen with three summary cards, Live/Fallback (the URL keeps `?tab`, and
    the tab survives a reload), the rates table and the Refresh button, which spins and shows a
    toast. `⌘K` opens the command palette over the page. Turn admin mode off: the app goes to Home.
18. **Planned payments (phase 3c).** With admin mode off, open Planned. Expected: the native screen
    with the Next 7 days strip, Estimated monthly and the payments table. View > Include paused adds
    `?show_all=true` to the URL and shows paused rows. Pause a row from its ••• menu: a toast with
    Undo appears for 8 seconds and `⌘Z` undoes it (but not while a text field has focus). Delete
    asks first. More actions > Payment history lists the linked transactions. Add payment opens the
    sheet: fill in a name, amount, due date and bank account and save; the row appears with a
    toast. Edit a row: the sheet shows its values, including the bank account. Change a field and
    click another sidebar entry: the Leave this page? alert asks first. Mark a row as paid: pick a
    transaction and click Link and mark as paid; the dialog closes with a toast and the row
    advances. When the likely-matches banner shows, Review opens Mark as paid for its first
    payment. In the recurring detection panel, Track adds a planned payment and Dismiss hides the
    pattern, also after a relaunch.

19. **Transactions (phase 3e part A).** With admin mode off, open Transactions. Expected: the
    native list with the toolbar chips; scrolling loads more rows. Pick an account and a date
    preset: the URL and the filter banner follow, and Back restores the previous filters. Type in
    search: the suggestions open, and Amount equals applies an amount filter. Click a row: the
    inspector docks beside the list (a sheet in a narrow window); ↑/↓ move it, Space opens Quick
    Look and Escape closes it. Change a category in the inspector, edit a field with its pencil,
    add a tag and upload a PDF. Double-click a row to edit it in place and press Enter to save.
    Delete a row from its context menu: the alert asks, the row leaves, and Undo (or `⌘Z`) brings
    it back.

20. **Home (phase 3g part A).** Open Home with admin mode off. Expected: the native greeting,
    spending hero, Needs attention, net worth, upcoming payments, accounts, monthly bars, category
    donut, forecast, and recent transactions. More actions > Customize shows all eleven widgets;
    enable Summary cards and Account balances, close, and revisit Home to confirm persistence.
    In Settings configure an exclusion, return to Home, and toggle exclusions separately on
    Monthly trends, Category distribution, and Recent transactions. Drill through an income or
    spending total, a category/Other/Uncategorised slice, and a recent row; check the filters or
    selected inspector. Scrub the net sparkline, use arrows/Home/End/Escape, and check the latest
    amount returns after release. Hover and drag bank history and forecast to compare dates and
    values. Switch forecast mode, every rolling window, cumulative/daily, With planned, and
    method choices; reopen Diagnostics and check its table and persisted trend. Dismiss and
    restore an inactivity alert. Add a transaction from Home, exercise the unsaved-changes guard,
    save, and confirm Transactions opens the created row. Repeat in Dutch and a narrow window.
    These Mac checks have not been run in the Linux cloud workspace.

21. **Insights (phase 3g part B).** Open Insights and switch Last 24 months/All time and every
    tab; confirm the URL retains `window` and `tab`. Customize, toggle each chart's exclusions,
    scrub Monthly rhythm, and show the 3-month averages. On Categories choose a year and each
    metric, expand ancestors, page month columns, and drill group/child/Uncategorised/total cells.
    On Payees search, filter, sort, and scroll the details table; check the year picker and full
    names in the chart readout. Check yearly totals. On Flow switch years, hover nodes/links, and
    resize the window. Dismiss a deterministic finding. On Custom charts create/edit all seven
    variants with category/payee/tag sources, All sources, date clearing, and yearly bounds;
    verify live preview, Other, save, and delete confirmation. Export PDF opens the existing web
    dialog; exercise its three report types and cancel/download, then confirm the native tab and
    window return. Repeat in Dutch. These Mac checks remain unperformed in the Linux workspace.

## Developer backend override

In Debug builds only, `VISION_NATIVE_BACKEND_URL` skips supervision and loads a backend that is
already running, for example `http://localhost:3002`. The host must be `localhost`, `127.0.0.1` or
`::1`. Other hosts, malformed values and the variable in a Release build are ignored with a logged
reason, and the app starts its own runtime.

22. **Taxes (phase 3h, pending Mac review).** Open Tax in EN and NL and choose live, saved,
    frozen, and filed years. Check masthead status, disclosures, chart hover/keyboard readouts,
    partner columns, trend/comparison, all eight widget switches, and no-income/error states.
    Edit each of the six profile steps; verify backend previews and that closing keeps saved
    edits. Check filed locks, amendment/unfiling, incomplete deduction confirmations and
    dismissal. Exercise snapshot/freeze/filing/history actions and native CSV export. Open PDF
    export, then cancel: the selected `year` must survive and the native screen must return.
    A stale response or a failed year/currency change must not relabel prior tax amounts.

Apps launched from Finder or the Dock do not inherit your shell environment. Set both variables in
the Xcode scheme, or pass them with `open`:

```bash
open --env VISION_NATIVE_RUNTIME_DIR="$PWD/apps/native/build/payload/native-runtime" \
  "<DerivedData>/Build/Products/Debug/Vision Native.app"
```

Tax uses `TaxComputationService` and the OpenAPI compute/overview/dashboard operations.
The TypeScript engine is shared with the web app; Swift displays its results as `Decimal`.
Profile and year actions use existing atomic settings writes with original CAS baselines. The
profile sheet previews unsaved inputs through the backend and persists edits as they are made;
closing flushes pending writes. CSV is native; the PDF dialog remains web. Full macOS build and
Demo visual/keyboard checks remain pending.

23. **Portfolio and asset pages (phase 3i, pending Mac review).** Open the overview and all five
    asset pages in EN/NL and each number/date format. Inspect every widget, broker filter,
    disclosure, ticker pause/offline behavior, exposure import, and chart hover/range/keyboard
    interaction. Open active and archived details, edit/add a trade, test Cancel versus Escape,
    assign unassigned lots after complete history loads, and check ambiguous retry recovery.
    PDF must open on the current route and preserve its parameters when closed.
24. **Rebalance and Net Worth (phase 3i, pending Mac review).** Reload custom/preset/saved
    target URLs, verify commitment-aware caps and CAS conflict handling, and inspect Net Worth
    account totals, full daily series, each period and newest-first table pagination. Change
    currency during a read and period during price refresh; old values must not reappear under
    new labels. Verify offline refresh, fallback notices and retained web printing.

25. **Portfolio Import (phase 3j, pending Mac review).** Compare maintained CSV, original IBKR
    funding XLS/XLSX and supported Saxo XLSX detection with the web view on synthetic files.
    Inspect source identity ambiguity, header/sample preview, broker and transfer routing, custom
    parser save/update/delete, session restoration from staged web metadata, and history rollback.
    Review evidence and scope policies, map unresolved groups, create holdings, repair broker
    routing and commit. Cancel during uploads and simulate lost responses: retain receipts, block
    unverified replay and invalidate the other wealth screens. No file bytes may enter storage.
26. **Portfolio Tax (phase 3j, pending Mac review).** Compare all seven widgets, tax and fee
    breakdowns, unknown dividend conventions and inactive investments against the web app.
    Open historical and frozen years, change currency during reads, and test invalid/missing year
    URLs. Edit live-year manual costs/classifications from a historical view, exercise CAS conflicts
    and lost acknowledgements, and confirm unknown settings survive. Test profile/year actions,
    filing history and CSV export in EN/NL and each number/date format.

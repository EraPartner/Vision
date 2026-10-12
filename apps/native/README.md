# Vision Native

Vision Native is the Swift macOS app that replaces the Electron shell in phases
([ADR-204](../../docs/adr/204-vision-native-swift-app-target.md)). Phase 1 hosts the existing
React frontend in a `WKWebView` and runs its own PostgreSQL 18 cluster and backend on synthetic
Demo data in `~/Library/Application Support/Vision Native Demo/` (or `Vision Native/` for the
standard variant). It never reads or changes the Vision or Vision Demo data directories. The
phase 1 hand-over is proposed in
[ADR-205](../../docs/adr/205-vision-native-hand-over.md), and
[the phase 1 exit checklist](../../docs/reference/native-parity/phase-1-exit.md) maps every shell
and settings action to its Swift code.

Requirements: an Apple-silicon Mac, Xcode 26 (macOS 26 deployment target) and XcodeGen. XcodeGen
stays the project-file tool (ADR-204 decision 3). The deployment target and the CI runner label
(`macos-26` in `.github/workflows/ci.yml`) are pinned and raised together.

## Layout

| Path                               | Purpose                                             |
| ---------------------------------- | --------------------------------------------------- |
| `project.yml`                      | XcodeGen spec for the "Vision Native" app target    |
| `Config/Signing.xcconfig`          | Signing team from `VISION_NATIVE_TEAM_ID`           |
| `VisionNative/`                    | AppKit app, window, menus and the `WKWebView` shell |
| `Package.swift`                    | SwiftPM package with the `VisionNativeCore` library |
| `Sources/VisionNativeCore/`        | Non-UI logic: runtime supervision, health, override |
| `Sources/VisionNativeCore/Shell/`  | Bridge contract and codec, web view policy, menus   |
| `Sources/VisionNativeCore/Backup/` | Backup bundles, encryption and restore (phase 1d)   |
| `Sources/VisionNativeCore/Audit/`  | Audit anchor, Keychain witness, audit bridge (1e)   |
| `Tests/VisionNativeCoreTests/`     | Swift Testing tests and `Fixtures/` from Electron   |

`VisionNative.xcodeproj`, `VisionNative/Info.plist`, `build/`, `.build/` and
`Config/Local.xcconfig` are generated or local and are gitignored.

## Generate, build and test

Run from the repository root:

```bash
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
   complete", the reload, and the Audit history card on the Admin overview reports the history as
   unavailable until you enrol it (step 9). A wrong passphrase reopens
   the prompt with "Incorrect passphrase. Try again."
6. **CSV handoff.** Drag a `.csv` file onto the window, outside the import dropzone. Expected: the
   Import page opens with the file selected. Then run `open -a "Vision Native Demo" file.csv`.
   Expected: the same.
7. **Clipboard.** Press `⌘K`, type `2+2`, press Enter. Expected: "Copied to clipboard", and `4` is
   on the clipboard (exit checklist row #67).
8. **Text context menu.** In any text field, type a misspelled word and right-click it. Expected:
   Cut, Copy and Paste. Note whether spelling guesses, Learn Spelling and Select All appear; this
   settles rows #203 to #205 of the exit checklist.
9. **Audit enrolment.** Settings > About & maintenance > Admin mode on. Open the Admin overview and
   click "Start audit protection" in Audit history. Expected: the card shows "Verified through
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
    the import is refused with `transfer_target_not_fresh`; starting it fresh means removing
    `~/Library/Application Support/Vision Native/`, which holds only Demo data, and is your call.
13. **Rotate key.** Click "Rotate audit key" and confirm. Expected: success, and the card still
    shows "Verified through entry N".
14. **Quit backup.** In Settings > Backup, turn on "Back up when quitting" and keep "Keep services
    running on quit" off. Quit with `⌘Q`. Expected: the app quits within 45 seconds, a new bundle
    is in the backup folder, and port 54332 is no longer listening.
15. **Demo reset.** Run `bun run demo:reset-vision-native`, then reopen the app. Expected: the
    canonical Demo data is back (the audit card may then report that the history changed, as in
    Electron Vision Demo; see ADR-205 question 7).

## Developer backend override

In Debug builds only, `VISION_NATIVE_BACKEND_URL` skips supervision and loads a backend that is
already running, for example `http://localhost:3002`. The host must be `localhost`, `127.0.0.1` or
`::1`. Other hosts, malformed values and the variable in a Release build are ignored with a logged
reason, and the app starts its own runtime.

Apps launched from Finder or the Dock do not inherit your shell environment. Set both variables in
the Xcode scheme, or pass them with `open`:

```bash
open --env VISION_NATIVE_RUNTIME_DIR="$PWD/apps/native/build/payload/native-runtime" \
  "<DerivedData>/Build/Products/Debug/Vision Native.app"
```

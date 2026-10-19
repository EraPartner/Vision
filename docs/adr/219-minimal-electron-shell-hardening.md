---
title: "ADR-219: Minimal macOS Electron shell hardening and v1 backup retirement"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, electron, security, macos, packaging, fuses, sandbox, permissions, power-monitor, native-theme, file-associations, backup, encryption, retirement, adr-040, adr-155]
description: "Accepted on 2026-10-19. The shell is macOS-only. Packaged builds flip Electron fuses before the ad-hoc seal (NODE_OPTIONS and inspect arguments off, embedded asar integrity and asar-only loading on; RunAsNode stays on for the update installer). Permission handlers apply in every profile, every renderer is sandboxed and webviews are refused. The health watchdog pauses during sleep, and logout or shutdown skips the optional backup-on-quit. Native UI follows the Appearance choice. Vision is offered for .csv files in Open With at Alternate rank. The renderer shows a reconnecting banner on backend loss. Retired v1 (AES-256-CBC, static salt) backups are refused; Tor decided this on 2026-10-19. Supersedes ADR-040's v1-readable clause and extends ADR-155."
aliases: [adr-219, electron fuses, minimal electron shell, retire v1 backup encryption]
---

# ADR-219: Minimal macOS Electron shell hardening and v1 backup retirement

## Status

Accepted on 2026-10-19. Tor decided the retirement of v1 backup encryption on the same date.

It supersedes only the clause of
[[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]] that kept the v1 format
(`VISIONENC1`, `VISIONBAK1`) readable indefinitely. ADR-040's v2 format and its other decisions
stay in force. It extends [[docs/adr/155-evidence-led-electron-surface|ADR-155]] with further
narrowing of the shell's capability surface; ADR-155's decisions stay in force.

## Date

2026-10-19

## Context

Vision ships only an Apple Silicon macOS package. The shell still carried branches for Windows
and Linux (a generated taskbar badge overlay in `badge-image.ts`, Linux `setBadgeCount`, non-Mac
menus and the `menu.about` key) that no build could reach. Those branches were removed, so
`packaging/electron/main.ts` now assumes macOS throughout.

Several hardening and integration gaps remained in that shell:

- The packaged Electron binary kept its default fuses. `NODE_OPTIONS` and `--inspect` arguments
  could inject code or attach a debugger to the main process, and nothing bound `app.asar` to the
  signed bundle.
- Permission request and check handlers were registered only in packaged builds, so a
  development profile had Chromium's default permission behaviour.
- Only the main window set `sandbox: true`; nothing refused a `<webview>` that a future change
  might create.
- The health watchdog kept counting failed probes across system sleep, so a slow first probe after
  wake could be reported as a lost backend. On logout or shutdown, an enabled backup-on-quit could
  hold up macOS.
- Native menus and dialogs followed macOS appearance even when the user chose Light or Dark in
  Vision.
- The shell already handled Finder `open-file` for CSVs, but the bundle declared no document
  type, so Vision did not appear in Finder's Open With menu.
- Preload exposed `backend:lost` and `backend:restored`, but no React component subscribed.
- The v1 backup format used AES-256-CBC with a static salt and no authentication. Vision has
  written v2 (AES-256-GCM, per-file salt) since 2026-04-28, and the 1.0.2 release fixture already
  uses `VISIONBAK2`.

## Decision

### Electron fuses (packaged builds)

`packaging/electron/scripts/finalize-native-package.ts` (the electron-builder `afterPack` hook)
flips `ELECTRON_FUSES` through `packager.addElectronFuses` before it applies the ad-hoc
signature. electron-builder's own `electronFuses` step runs after this hook and would break the
seal. The hook fails the build if the packager cannot flip fuses.

| Fuse                                    | Value | Effect                                                     |
| --------------------------------------- | ----- | ---------------------------------------------------------- |
| `EnableNodeOptionsEnvironmentVariable`  | off   | `NODE_OPTIONS` cannot inject code                          |
| `EnableNodeCliInspectArguments`         | off   | `--inspect` arguments cannot attach a debugger to main     |
| `EnableEmbeddedAsarIntegrityValidation` | on    | `app.asar` must match the integrity recorded in the bundle |
| `OnlyLoadAppFromAsar`                   | on    | No loose `app/` directory can replace the shell            |

`RunAsNode` stays on because the native update installer runs as Node
(`ELECTRON_RUN_AS_NODE=1`) after the app exits. Cookie encryption and
`GrantFileProtocolExtraPrivileges` keep Electron's defaults.

### Renderer and session

- `registerSecurityHeaders()` installs the fail-closed permission request handler and the
  origin-scoped permission check handler in every profile, Vision Development included. The
  Content Security Policy and other security response headers stay packaged-only.
- `app.enableSandbox()` sandboxes every renderer, and a `web-contents-created` hook cancels
  `will-attach-webview`.

### Power events

- `powerMonitor` `suspend` pauses watchdog probes; `resume` clears the failure count and lets
  probes continue.
- The macOS `shutdown` event (logout, restart or shut down) makes the following quit skip the
  optional backup-on-quit. Quit still stops the Vision-managed PostgreSQL and backend.

### Appearance

The renderer sends `themeSource` (`"system"`, `"light"` or `"dark"`) with `theme:persist-splash`.
System mode sends `"system"`; Light, Dark and Schedule send the resolved theme. Main sets
`nativeTheme.themeSource` and persists the value in the `splashTheme` settings entry. At launch it
applies the persisted value, or `"system"`, before the window loads.

### Finder Open With

`packaging/electron/electron-builder-base.json` declares a `.csv` file association with role
`Viewer` and rank `Alternate`. Vision appears in Open With but does not claim to be the default
CSV application. The existing `open-file` handoff handles the file.

### Backend connection banner

`BackendConnectionBanner`, shown in `AppLayout`, subscribes to `backend:lost` and
`backend:restored` through `window.electronRecovery`. It shows a localized reconnecting warning
while the backend is lost and invalidates every React Query query when the backend returns. It
renders nothing outside Electron.

### Retire v1 backup encryption

`decryptFile` in `packaging/electron/backup/encrypted-file.ts` reads only v2 (AES-256-GCM). A
file that starts with the retired v1 magic (`VISIONENC1` for raw SQL, `VISIONBAK1` for bundles)
is refused before any decryption with "This backup uses the retired v1 encryption format, which
Vision no longer restores." No plaintext file is written. The v1 key derivation and CBC decoder
are removed.

## Consequences

- An attacker who can set environment variables or launch arguments, or replace files beside
  `app.asar`, can no longer use those routes to run code in the packaged main process. Main-process
  debugging of a packaged build is no longer possible; `bun run electron:dev` runs the unfused
  development binary.
- The fuse flip is checked by the `afterPack` hook's unit tests with a stubbed packager. These
  tests do not inspect a real packaged binary.
- Development profiles now deny renderer permissions as packaged builds do. A development-only
  feature that needs a permission must go through the main process.
- Sleep no longer causes false backend-loss reports. A logout or shutdown never waits for a
  backup; a user who relies on backup-on-quit gets no backup from that quit.
- Native menus, dialogs and vibrancy match Vision's Appearance choice.
- Vision appears in Finder's Open With for CSV files without changing the user's default
  application.
- Backend loss is visible in the app. The banner always shows its own reconnecting text and does
  not display the `message` field of `backend:lost`, so the brief backup-maintenance pause also
  shows "reconnecting".
- **Breaking for v1 backups.** A `.visionbak.enc` or `.enc` file written before v2 can no longer
  be restored by Vision. Because v1 files are still recognised as encrypted, restore first asks
  for the passphrase and then refuses the file. A user who needs one must restore it with an
  older Vision release and create a new backup. Unencrypted backups and all v2 files are
  unaffected.
- Windows and Linux packaging would need the removed platform branches to be added back.

## Related

- [[docs/architecture/electron|Electron architecture]]
- [[docs/security/data-protection|Data protection]]
- [[docs/features/backup-coverage-audit|Backup coverage audit]]
- [[docs/api/health|Health API]]
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron sandbox hardening and recovery]]
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup format v2]]
- [[docs/adr/155-evidence-led-electron-surface|ADR-155: Evidence-led Electron surface]]
- [[docs/adr/index|All ADRs]]

---
title: ADR-023 Update Installer Checksum Verification
type: adr
status: Accepted
date: 2026-04-19
updated: 2026-04-29
tags: [adr, electron, updates, security, supply-chain, checksums, phase-9, install-script, interactive-confirmation]
description: Verify SHA256 of downloaded update installers against sibling .sha256 artifacts on GitHub releases before extraction. (2026-04-29: install.sh now adds interactive checksum confirmation gate via VISION_BREW_INSTALL_AUTO_CONFIRM env var)
aliases: [adr-023, installer checksum, update verification, supply-chain security]
---

# ADR-023: Update Installer Checksum Verification

## Status
Accepted

## Date
2026-04-19

## Context

Vision's Electron auto-updater downloads release artifacts from GitHub and extracts them directly into the app cache. The prior implementation trusted the GitHub redirect chain and HTTPS transport security but did not verify the **integrity** of the downloaded artifact.

**Threat model:**
- Man-in-the-middle attack (despite HTTPS, misconfigured proxy or compromised intermediate)
- Corrupted download (network bit-flip, partial transfer)
- Supply-chain tampering (compromised GitHub Actions secret, stolen release API token)

Without checksum verification, a tampered installer could be extracted and executed without detection.

## Decision

### 1. SHA256 Checksum Artifacts on GitHub Releases

When publishing a release, include a sibling `.sha256` file for each installer:

```
vision-1.0.0.zip          (installer)
vision-1.0.0.zip.sha256   (checksum file)
```

The `.sha256` file contains a single line:

```
a1b2c3d4e5f6... *vision-1.0.0.zip
```

(Standard `sha256sum` format, optionally with leading `*` for binary flag.)

### 2. Checksum Verification Before Extraction

In `packaging/electron/main.js`, function `prepareShellUpdateInstaller()` (or equivalent update path):

```js
async function prepareShellUpdateInstaller(zipPath) {
  const zipName = path.basename(zipPath);
  const sha256Path = `${zipPath}.sha256`;
  
  try {
    // Fetch sibling .sha256 from GitHub release
    const sha256Url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/${zipName}.sha256`;
    const sha256Response = await fetch(sha256Url);
    
    if (!sha256Response.ok) {
      // Sibling absent = best-effort, log warning and skip
      console.warn('[Installer] .sha256 artifact not found; skipping verification');
      // Proceed without checksum (backward compatibility)
      return extractInstaller(zipPath);
    }
    
    const expectedHash = (await sha256Response.text()).split(/\s+/)[0];
    
    // Compute SHA256 of downloaded zip
    const fileBuffer = await fs.promises.readFile(zipPath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    if (expectedHash.toLowerCase() !== actualHash.toLowerCase()) {
      // Mismatch = security event
      await fs.promises.unlink(zipPath); // Clean up
      throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
    }
    
    // Checksum verified; safe to extract
    return extractInstaller(zipPath);
    
  } catch (err) {
    // Log, notify user, abort update
    console.error('[Installer] Verification failed:', err.message);
    throw err;
  }
}
```

### 3. Behavior on Mismatch

- **Mismatch detected:** Delete downloaded file, throw error, abort update
- **Error is caught by caller:** Update fails, user notified to retry or check connection
- **Sibling `.sha256` absent:** Log warning, best-effort proceed (backward compatibility for older releases)
- **Network error fetching `.sha256`:** Treat as absent, proceed with warning

### 4. Logging & Observability

All verification steps logged:
- `[Installer] Fetching checksum from <url>`
- `[Installer] SHA256 verified: <hash>`
- `[Installer] Checksum mismatch: …` (ERROR)
- `[Installer] .sha256 artifact not found; skipping verification` (WARN)

Logs are in `app.getPath('logs')` and available via Electron DevTools if enabled.

## Consequences

### Positive

- **Integrity assurance:** Downloaded installer is verified to match upstream before extraction
- **Supply-chain defense:** Detects tampering, corrupted downloads, and MITM attacks
- **Backward compatibility:** Missing `.sha256` files do not block updates; old releases still work with a warning
- **Best-effort:** Approach assumes `.sha256` is always published going forward but doesn't break if a release is missing it
- **Audit trail:** All verification steps logged for forensic analysis if an issue occurs

### Neutral

- **Extra network call:** Fetching `.sha256` adds ~100ms to update flow; acceptable given the security gain
- **File cleanup:** Mismatched installers are deleted; user must retry; improves security at cost of minor UX friction
- **GitHub dependency:** Relies on GitHub serving `.sha256` artifacts alongside release binaries; GitHub's infrastructure resilience is high

### Negative

- **Requires publisher discipline:** Release workflow must include `.sha256` generation and upload. Can be automated in CI/CD.

## Implementation

### Code Changes

1. **`packaging/electron/main.js`:**
   - Add `crypto.createHash('sha256')` verification to `prepareShellUpdateInstaller()` or update download path
   - Fetch sibling `.sha256` from GitHub release
   - Compute SHA256 of downloaded zip
   - Compare, throw on mismatch, log all steps
   - Best-effort: log warning if `.sha256` absent, proceed

2. **Release workflow (GitHub Actions or local):**
   - After building installer zip, generate checksum:
     ```bash
     sha256sum vision-1.0.0.zip > vision-1.0.0.zip.sha256
     ```
   - Upload both `vision-1.0.0.zip` and `vision-1.0.0.zip.sha256` to release assets

3. **`docs/reference/environment-variables.md`:**
   - Document any new env vars if introduced (e.g., checksum tolerance, skip-verification flag for testing)

### Testing

```bash
# Happy path: checksum matches
# Verify log: "SHA256 verified: <hash>"
# Extraction proceeds

# Sad path: checksum mismatch
# Corrupt downloaded zip (flip a byte)
# Verify log: "Checksum mismatch: expected ..., got ..."
# File deleted, error thrown, update aborted

# Backward compatibility: missing .sha256
# Comment out upload of .sha256 in CI
# Verify log: ".sha256 artifact not found; skipping verification"
# Extraction proceeds (warning logged)
```

## Release Process Impact

**For maintainers:**

1. Build release artifact (e.g., `vision-1.0.0.zip`)
2. Generate checksum: `sha256sum vision-1.0.0.zip > vision-1.0.0.zip.sha256`
3. Upload both files to GitHub release
4. Publish release

Can be automated in GitHub Actions:

```yaml
- name: Generate Checksum
  run: sha256sum vision-1.0.0.zip > vision-1.0.0.zip.sha256

- name: Upload Release Assets
  uses: softprops/action-gh-release@v1
  with:
    files: |
      vision-1.0.0.zip
      vision-1.0.0.zip.sha256
```

## Install Script Enhancement (2026-04-29)

The primary `install.sh` script (for Homebrew setup) now includes an interactive checksum verification gate:

When `VISION_BREW_INSTALL_SHA256` is not set:
1. Script downloads the Homebrew installer
2. Prints the SHA-256 hash to stdout
3. Prompts user: `Continue and execute this installer? [y/N]`
4. Waits for input from `/dev/tty` (interactive terminal)
5. **Only proceeds on explicit `y`, `Y`, `yes`, or `YES`** — aborts on any other input

**Environment Variables:**
- `VISION_BREW_INSTALL_SHA256` — If set, verification is automatic (no prompt); aborts if hash doesn't match
- `VISION_BREW_INSTALL_AUTO_CONFIRM=1` — Skips the interactive prompt for CI/automation (equivalent to answering `yes`)

**Behavior:**
- User is forced to visually inspect the printed hash (opportunity to cross-check against `homebrew.sh` or release notes)
- No silent proceed-on-no-answer — default is abort (safer than default-yes)
- Backward compatible: scripts supplying `VISION_BREW_INSTALL_SHA256` or `VISION_BREW_INSTALL_AUTO_CONFIRM` are unaffected

This addresses the supply-chain risk where an attacker could replace the Homebrew installer without the user noticing the hash changed.

## Related

- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Complements sandbox isolation with integrity verification
- [[docs/security/data-protection|Data Protection Policy]] — Part of supply-chain security posture
- [[docs/architecture/electron-desktop-app|Electron Desktop App Architecture]] — Update flow architecture
- [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038: Dependency Slim Down]] — Parallel supply-chain hardening effort

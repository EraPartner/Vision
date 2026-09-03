"use strict";

// ── Manual shell updater (.zip-only, no blockmaps) ───────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). We intentionally avoid
// electron-updater metadata (latest-mac.yml / blockmaps) and install from the
// unsigned GitHub release ZIP. Mutable main.js state (workDir, useRepoMode,
// isQuitting) plus the localized-dialog/notification seams (t, notify) are
// threaded in via init() so the live values are observed at call time, exactly
// as when this code lived in main.js.

const { app, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { dockerEnv, run } = require("./compose");

// Context threaded from main.js via init():
//   { APP_NAME, IS_DEMO, t, notify, workDir(), useRepoMode(), markQuitting() }
// markQuitting flips main.js's isQuitting flag so the will-quit handler knows
// the installer-driven quit is already underway.
let ctx = {};
function init(context) {
  ctx = context;
}

const MANUAL_UPDATE_CHECK_DELAY_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Overall deadline for the small GitHub API/checksum fetches (the previous
// hand-rolled https.get helpers had no timeout at all and could hang forever).
const GITHUB_FETCH_TIMEOUT_MS = 30 * 1000;

const GITHUB_OWNER = "EraPartner";
const GITHUB_REPO = "Vision";
const UPDATER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

let shellUpdateCheckInFlight = false;
let pendingShellUpdate = null;

function updaterChildEnv(overrides = {}) {
  const env = {};
  for (const key of UPDATER_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function waitForSpawnedChild(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

async function launchPreparedNativeInstaller({
  installerPath,
  installerArgs,
  stopRuntime,
  startRuntime,
  spawnProcess = spawn,
  executable = process.execPath,
}) {
  let runtimeStopped = false;
  try {
    if (stopRuntime) {
      await stopRuntime();
      runtimeStopped = true;
    }
    const child = spawnProcess(executable, [installerPath, ...installerArgs], {
      detached: true,
      stdio: "ignore",
      env: updaterChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    });
    await waitForSpawnedChild(child);
    child.unref();
    return child;
  } catch (error) {
    if (runtimeStopped && startRuntime) {
      try {
        await startRuntime();
      } catch (restartError) {
        error.restartError = restartError;
      }
    }
    throw error;
  }
}

function normalizeVersionTag(version) {
  if (!version) return "";
  const s = String(version).trim();
  return s.startsWith("v") ? s : `v${s}`;
}

function compareVersions(a, b) {
  // Split off pre-release suffix (e.g. "1.2.3-rc.1" → ["1.2.3", "rc.1"])
  const splitPre = (v) => {
    const s = String(v || "").replace(/^v/, "");
    const dash = s.indexOf("-");
    if (dash === -1) return { core: s, pre: null };
    return { core: s.slice(0, dash), pre: s.slice(dash + 1) };
  };
  const { core: ca, pre: prea } = splitPre(a);
  const { core: cb, pre: preb } = splitPre(b);
  const pa = ca.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = cb.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  // Equal numeric cores: pre-release < release (semver §9)
  if (prea && !preb) return -1;
  if (!prea && preb) return 1;
  if (prea && preb) return comparePreRelease(prea, preb);
  return 0;
}

// Semver §11 pre-release precedence: compare dot-separated identifiers left to
// right — numeric identifiers compare numerically (so rc.10 > rc.2, which a
// plain string compare got backwards), numeric < alphanumeric, and when all
// shared identifiers are equal the shorter set has lower precedence.
function comparePreRelease(prea, preb) {
  const idsA = prea.split(".");
  const idsB = preb.split(".");
  const len = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < len; i += 1) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function getCurrentVersionTag() {
  // Read from the Electron package.json (accurate in dev and packaged modes).
  // workDir may be a native payload or a Docker/Compose root. Its package.json
  // is not the Electron app, so do not use it for version detection.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
    );
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return normalizeVersionTag(pkg.version.trim());
    }
  } catch {
    // fall through
  }

  return normalizeVersionTag(app.getVersion());
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function getUpdateMode() {
  if (!app.isPackaged) return "dev";
  if (ctx.runtimeMode && ctx.runtimeMode() === "native") return "native";
  if (ctx.useRepoMode()) return "source";
  return "docker";
}

function writeInstallerScript({
  scriptPath,
  sourceRootPath,
  sourceLaunchPath,
  destRootPath,
  hostPid,
}) {
  const script = [
    "#!/bin/bash",
    "set -euo pipefail",
    `SRC_ROOT=${shellEscape(sourceRootPath)}`,
    `SRC_LAUNCH=${shellEscape(sourceLaunchPath || "")}`,
    `DEST_ROOT=${shellEscape(destRootPath)}`,
    `HOST_PID=${hostPid}`,
    'BAK_DIR="$(dirname "$DEST_ROOT")/.vision_update_bak_$$"',
    'PROTECT_FILE="${BAK_DIR}.protect"',
    "",
    "# Wait until the running app exits before replacing source files.",
    "for i in {1..120}; do",
    '  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi',
    "  sleep 0.5",
    "done",
    "",
    'mkdir -p "$DEST_ROOT"',
    ': > "$PROTECT_FILE"',
    'if [ -d "$DEST_ROOT/.git" ]; then',
    '  git -C "$DEST_ROOT" -c core.quotepath=false ls-files --others --ignored --exclude-standard --directory | sort -u | sed "s#^#P /#" > "$PROTECT_FILE"',
    "fi",
    "",
    "# Snapshot current install for rollback on failure.",
    'rsync -a --exclude ".git" --exclude "node_modules" --exclude "postgres_data" --exclude "packaging/electron/native-runtime" "$DEST_ROOT/" "$BAK_DIR/"',
    "",
    "# Install update — roll back automatically on any error.",
    "rsync_ok=0",
    'rsync -a --delete --filter="merge $PROTECT_FILE" --exclude ".env" --exclude "postgres_data" --exclude ".git" --exclude "node_modules" --exclude "packaging/electron/native-runtime" "$SRC_ROOT/" "$DEST_ROOT/" && rsync_ok=1',
    'if [ "$rsync_ok" -ne 1 ]; then',
    '  echo "ERROR: rsync failed — rolling back from backup" >&2',
    '  rsync -a --delete --filter="merge $PROTECT_FILE" --exclude ".env" --exclude "postgres_data" --exclude ".git" --exclude "node_modules" "$BAK_DIR/" "$DEST_ROOT/" || true',
    '  rm -rf "$BAK_DIR" "$PROTECT_FILE" 2>/dev/null || true',
    "  exit 1",
    "fi",
    'rm -rf "$BAK_DIR" "$PROTECT_FILE" 2>/dev/null || true',
    "",
    "# Strip macOS quarantine from the updated source tree so launch.command",
    "# can be opened without Gatekeeper blocking it (macOS 12+).",
    'xattr -rd com.apple.quarantine "$DEST_ROOT" 2>/dev/null || true',
    "",
    "# Install bun if missing (non-interactive).",
    "if ! command -v bun >/dev/null 2>&1; then",
    '  export BUN_INSTALL="$HOME/.bun"',
    "  curl -fsSL https://bun.sh/install | bash",
    '  export PATH="$BUN_INSTALL/bin:$PATH"',
    "fi",
    "",
    'cd "$DEST_ROOT"',
    "bun install --ignore-scripts",
    "",
    'if [ -n "$SRC_LAUNCH" ] && [ -f "$SRC_LAUNCH" ]; then',
    '  cp "$SRC_LAUNCH" "$DEST_ROOT/launch.command" 2>/dev/null || true',
    '  chmod +x "$DEST_ROOT/launch.command" 2>/dev/null || true',
    "fi",
    "",
    "# Strip quarantine from the launcher scripts specifically before opening.",
    'xattr -d com.apple.quarantine "$DEST_ROOT/packaging/electron/unsigned/launch.command" 2>/dev/null || true',
    'xattr -d com.apple.quarantine "$DEST_ROOT/launch.command" 2>/dev/null || true',
    "",
    'if [ -f "$DEST_ROOT/packaging/electron/unsigned/launch.command" ]; then',
    '  open "$DEST_ROOT/packaging/electron/unsigned/launch.command"',
    "  exit 0",
    "fi",
    "",
    'if [ -f "$DEST_ROOT/launch.command" ]; then',
    '  open "$DEST_ROOT/launch.command"',
    "  exit 0",
    "fi",
    "",
    'cd "$DEST_ROOT"',
    "exec bun run electron:prod",
  ].join("\n");

  fs.writeFileSync(scriptPath, `${script}\n`, { mode: 0o755 });
}

async function readGitHubRelease() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  // No status check, matching the previous implementation: a non-200 GitHub
  // error body still parses as JSON and flows into the "no update asset"
  // handling in the callers.
  return await res.json();
}

function pickSourceLauncherZip(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return (
    assets.find((a) =>
      /vision-source-launcher-.*-arm64\.zip$/i.test(a?.name || ""),
    ) || null
  );
}

function pickNativeAppZip(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return (
    assets.find((asset) =>
      /^Vision-.*-arm64-mac\.zip$/i.test(asset?.name || ""),
    ) || null
  );
}

// Fallback for releases that carry no source-launcher ZIP: send the user to the
// release page so they can update by hand. Every release published before the
// pipeline started building that asset is in this bucket permanently, so this
// path is not hypothetical. Only https://github.com/ URLs from the API response
// are honoured — anything else falls back to the canonical releases page rather
// than handing an unexpected scheme to the OS.
function openReleasePage(htmlUrl) {
  const fallback = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const url =
    typeof htmlUrl === "string" && /^https:\/\/github\.com\//i.test(htmlUrl)
      ? htmlUrl
      : fallback;
  try {
    shell.openExternal(url);
  } catch (err) {
    console.warn("Failed to open release page:", err?.message || err);
  }
  return url;
}

function pickChecksumAsset(release, zipName) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const wanted = `${zipName}.sha256`.toLowerCase();
  return assets.find((a) => (a?.name || "").toLowerCase() === wanted) || null;
}

// fetch follows redirects itself (GitHub asset URLs 302 to a CDN).
async function fetchUrlBody(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}` },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

// ── Container image digest (supply chain) ────────────────────────────────────
// The desktop stack pulls ghcr.io/erapartner/vision by TAG, which a registry can
// repoint at any time. The release pipeline publishes the digest of the image it
// actually pushed as a release asset, so the desktop app can pin to immutable
// content instead. The digest arrives over the GitHub API — a different system
// from the registry — so a compromised registry alone cannot substitute an image.
const IMAGE_METADATA_ASSET = "docker-image-tag.txt";

// Anchored and length-bounded on purpose: this value is written into .env and
// from there into the compose `image:` reference, so anything other than an
// exact sha256 digest must be rejected rather than interpolated.
const IMAGE_DIGEST_PATTERN = /^digest=(sha256:[0-9a-f]{64})\s*$/m;

function pickImageMetadataAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return (
    assets.find(
      (a) => (a?.name || "").toLowerCase() === IMAGE_METADATA_ASSET,
    ) || null
  );
}

/**
 * Resolve the image digest published alongside the latest release.
 *
 * Returns `null` for every failure mode — no release, no asset (every release
 * published before the pipeline started emitting it), a malformed body, or a
 * network error. Callers must treat null as "keep the reference you already
 * have", so a lookup failure never blocks an update or changes what runs.
 *
 * @returns {Promise<string|null>} e.g. `sha256:abc…` (64 hex chars) or null
 */
async function resolveReleaseImageDigest() {
  try {
    const release = await readGitHubRelease();
    const asset = pickImageMetadataAsset(release);
    if (!asset?.browser_download_url) return null;
    const body = await fetchUrlBody(asset.browser_download_url);
    const match = IMAGE_DIGEST_PATTERN.exec(body);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(
      "Image digest lookup failed (non-fatal):",
      err?.message || err,
    );
    return null;
  }
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function parseSha256Body(body) {
  const match = String(body || "")
    .trim()
    .match(/\b([a-fA-F0-9]{64})\b/);
  return match ? match[1].toLowerCase() : null;
}

async function prepareShellUpdateInstaller() {
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const sourceLauncherAsset = pickSourceLauncherZip(release);

  if (!latestVersion) {
    return {
      up_to_date: true,
      error: "Could not determine the latest release version.",
    };
  }

  const releaseInfo = {
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: release?.html_url,
    release_notes: release?.body || "",
    published_at: release?.published_at,
    source_launcher_available: Boolean(
      sourceLauncherAsset?.browser_download_url,
    ),
  };

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { up_to_date: true, ...releaseInfo };
  }

  // Newer release, but it ships no source-launcher ZIP for us to install from.
  // This used to return up_to_date:true, which made the startup prompt reappear
  // every launch and dead-ended both the Settings and notification Install
  // buttons. Tell the caller to send the user to the release page instead.
  if (!sourceLauncherAsset?.browser_download_url) {
    return { up_to_date: false, manual_download: true, ...releaseInfo };
  }

  const tempRoot = path.join(
    app.getPath("temp"),
    `vision_shell_update_${Date.now()}_${process.pid}`,
  );
  const zipPath = path.join(tempRoot, sourceLauncherAsset.name);
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // fetch (unlike the previous bare https.get) follows the 302 GitHub
    // serves for browser_download_url before handing out the CDN asset.
    const download = await fetch(sourceLauncherAsset.browser_download_url, {
      headers: { "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}` },
      signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
    });
    if (download.status !== 200 || !download.body) {
      throw new Error(`Download failed (${download.status})`);
    }
    await pipeline(
      Readable.fromWeb(download.body),
      fs.createWriteStream(zipPath),
    );

    const checksumAsset = pickChecksumAsset(release, sourceLauncherAsset.name);
    if (!checksumAsset?.browser_download_url) {
      throw new Error(
        "No checksum asset found for this release — aborting update to prevent running an unverified installer",
      );
    }
    const body = await fetchUrlBody(checksumAsset.browser_download_url);
    const expected = parseSha256Body(body);
    if (!expected) {
      throw new Error("Checksum file present but could not parse SHA256 hash");
    }
    const actual = await computeFileSha256(zipPath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        "Checksum mismatch — downloaded file may be corrupted or tampered with",
      );
    }

    // Validate ZIP entry paths before extraction to prevent path traversal attacks.
    // zipinfo -1 lists one path per line; any entry escaping extractDir is rejected.
    const zipEntries = await run("zipinfo", ["-1", zipPath], tempRoot, {
      env: dockerEnv,
    }).catch(() => "");
    for (const entry of zipEntries.split("\n")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = path.normalize(trimmed);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new Error(`Unsafe path in update ZIP: ${trimmed}`);
      }
    }

    await run("ditto", ["-x", "-k", zipPath, extractDir], tempRoot, {
      env: dockerEnv,
    });

    const sourceDir = path.join(extractDir, "unsigned", "Vision");
    const sourceLaunchPath = path.join(
      extractDir,
      "unsigned",
      "launch.command",
    );
    const sourcePackageJson = path.join(sourceDir, "package.json");
    if (!fs.existsSync(sourcePackageJson)) {
      throw new Error(
        "Downloaded update ZIP does not contain Vision source files",
      );
    }

    const destRootPath = ctx.workDir() || path.resolve(__dirname, "..", "..");
    const installerPath = path.join(tempRoot, "install-update.command");
    writeInstallerScript({
      scriptPath: installerPath,
      sourceRootPath: sourceDir,
      sourceLaunchPath: fs.existsSync(sourceLaunchPath) ? sourceLaunchPath : "",
      destRootPath,
      hostPid: process.pid,
    });

    return { up_to_date: false, ...releaseInfo, installerPath };
  } catch (err) {
    // Clean up temp dir on any error — on success tempRoot is intentionally kept
    // because installerPath lives inside it and must remain until the user runs it.
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
    throw err;
  }
}

function findVisionApp(root) {
  return (
    [
      path.join(root, "Vision.app"),
      path.join(root, "mac-arm64", "Vision.app"),
      path.join(root, "mac", "Vision.app"),
    ].find((candidate) => fs.existsSync(candidate)) || null
  );
}

async function prepareNativeUpdateInstaller() {
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const asset = pickNativeAppZip(release);
  const releaseInfo = {
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: release?.html_url,
    release_notes: release?.body || "",
    published_at: release?.published_at,
  };
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0)
    return { up_to_date: true, ...releaseInfo };
  if (!asset?.browser_download_url)
    return { up_to_date: false, manual_download: true, ...releaseInfo };

  const tempRoot = path.join(
    app.getPath("temp"),
    `vision_native_update_${Date.now()}_${process.pid}`,
  );
  const zipPath = path.join(tempRoot, asset.name);
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    const download = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}` },
      signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
    });
    if (download.status !== 200 || !download.body)
      throw new Error(`Download failed (${download.status})`);
    await pipeline(
      Readable.fromWeb(download.body),
      fs.createWriteStream(zipPath),
    );

    const checksumAsset = pickChecksumAsset(release, asset.name);
    if (!checksumAsset?.browser_download_url)
      throw new Error("No checksum asset found for the native update");
    const expected = parseSha256Body(
      await fetchUrlBody(checksumAsset.browser_download_url),
    );
    if (!expected) throw new Error("Native update checksum is invalid");
    const actual = await computeFileSha256(zipPath);
    if (actual !== expected)
      throw new Error("Checksum mismatch — native update was not installed");

    const zipEntries = await run("zipinfo", ["-1", zipPath], tempRoot, {
      env: dockerEnv,
    });
    for (const entry of zipEntries.split("\n")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = path.normalize(trimmed);
      if (normalized.startsWith("..") || path.isAbsolute(normalized))
        throw new Error(`Unsafe path in native update ZIP: ${trimmed}`);
    }
    await run("ditto", ["-x", "-k", zipPath, extractDir], tempRoot, {
      env: dockerEnv,
    });
    const sourceAppPath = findVisionApp(extractDir);
    if (!sourceAppPath)
      throw new Error("Downloaded native update does not contain Vision.app");
    const destinationAppPath = path.resolve(
      app.getPath("exe"),
      "..",
      "..",
      "..",
    );
    if (path.basename(destinationAppPath) !== "Vision.app")
      throw new Error("Current native application path is not Vision.app");
    const installerPath = path.join(tempRoot, "native-update-installer.js");
    fs.copyFileSync(
      path.join(__dirname, "native-update-installer.js"),
      installerPath,
    );
    return {
      up_to_date: false,
      ...releaseInfo,
      installerPath,
      installerArgs: [
        "--source-app",
        sourceAppPath,
        "--destination-app",
        destinationAppPath,
        "--host-pid",
        String(process.pid),
      ],
      nativeInstaller: true,
    };
  } catch (error) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
    throw error;
  }
}

async function checkForShellUpdate() {
  // Demo builds must never offer to install the real Vision shell over
  // themselves. setupManualShellUpdater is already gated off for the packaged
  // demo, but the update:check-github IPC still calls this — short-circuit so
  // the demo reports "up to date" instead of surfacing (and later trying to
  // install) the real Vision release ZIP. Also avoids the GitHub round-trip.
  if (ctx.IS_DEMO) {
    return {
      up_to_date: true,
      current_version: getCurrentVersionTag(),
      latest_version: null,
      update_mode: getUpdateMode(),
    };
  }
  const release = await readGitHubRelease();
  const latestVersion = normalizeVersionTag(release?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const sourceLauncherAsset = pickSourceLauncherZip(release);
  const mode = getUpdateMode();

  if (!latestVersion) {
    return {
      up_to_date: true,
      current_version: currentVersion,
      latest_version: null,
      update_mode: mode,
      error: "Could not determine latest release version.",
    };
  }

  return {
    up_to_date: compareVersions(latestVersion, currentVersion) <= 0,
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: release?.html_url,
    release_notes: release?.body || "",
    published_at: release?.published_at,
    source_launcher_available: Boolean(
      sourceLauncherAsset?.browser_download_url,
    ),
    update_mode: mode,
  };
}

async function installPreparedShellUpdate() {
  if (!pendingShellUpdate?.installerPath) {
    if (shellUpdateCheckInFlight) {
      return {
        success: false,
        error: "An update download is already in progress.",
      };
    }
    shellUpdateCheckInFlight = true;
    try {
      const prepared =
        getUpdateMode() === "native"
          ? await prepareNativeUpdateInstaller()
          : await prepareShellUpdateInstaller();
      if (prepared.manual_download) {
        const url = openReleasePage(prepared.html_url);
        return {
          success: false,
          manual_download: true,
          html_url: url,
          version: prepared.latest_version || "",
          error: ctx.t("update.manualDownload"),
        };
      }
      if (prepared.up_to_date || !prepared.installerPath) {
        return {
          success: false,
          error: "No newer shell update is currently available.",
        };
      }
      pendingShellUpdate = prepared;
    } catch (err) {
      return {
        success: false,
        error: err && err.message ? err.message : String(err),
      };
    } finally {
      shellUpdateCheckInFlight = false;
    }
  }

  try {
    const installerPath = pendingShellUpdate.installerPath;
    const latestVersion = pendingShellUpdate.latest_version || "";
    // Revalidate before committing to quit: the bundle may have been prepared
    // arbitrarily long ago. If the OS purged the temp dir, the old flow set
    // isQuitting and quit anyway — the spawn failed silently and the app
    // exited with no update and no error.
    if (!fs.existsSync(installerPath)) {
      pendingShellUpdate = null;
      return {
        success: false,
        error:
          "The downloaded update is no longer available. Please check for updates again.",
      };
    }
    // Best-effort recheck: don't install a stale bundle when a newer release
    // shipped since it was prepared. Offline recheck failures fall through —
    // the existing (verified-present) bundle still installs.
    try {
      const recheck = await checkForShellUpdate();
      if (
        recheck?.latest_version &&
        compareVersions(recheck.latest_version, latestVersion) > 0
      ) {
        pendingShellUpdate = null;
        return {
          success: false,
          error: `A newer version (${recheck.latest_version}) is available. Please check for updates again.`,
        };
      }
    } catch (_) {
      /* offline — proceed with the prepared bundle */
    }
    if (pendingShellUpdate.nativeInstaller) {
      await launchPreparedNativeInstaller({
        installerPath,
        installerArgs: pendingShellUpdate.installerArgs,
        stopRuntime: ctx.stopRuntime,
        startRuntime: ctx.startRuntime,
      });
    } else {
      spawn("open", [installerPath], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    ctx.markQuitting();
    setImmediate(() => app.quit());
    return { success: true, version: latestVersion };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function setupManualShellUpdater() {
  setTimeout(async () => {
    try {
      const update = await checkForShellUpdate();
      if (update.up_to_date || !update.latest_version) return;

      const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: [ctx.t("update.download"), ctx.t("update.later")],
        defaultId: 0,
        cancelId: 1,
        title: ctx.t("update.availableTitle", { app: ctx.APP_NAME }),
        message: ctx.t("update.versionAvailable", {
          version: update.latest_version,
        }),
        detail: ctx.t("update.detailDownload"),
      });

      if (response !== 0) return;

      ctx.notify(ctx.t("update.downloading"));
      const prepared =
        getUpdateMode() === "native"
          ? await prepareNativeUpdateInstaller()
          : await prepareShellUpdateInstaller();
      if (prepared.manual_download) {
        openReleasePage(prepared.html_url);
        ctx.notify(ctx.t("update.manualDownload"));
        return;
      }
      if (prepared.up_to_date || !prepared.installerPath) return;
      pendingShellUpdate = prepared;

      const { response: restartNow } = await dialog.showMessageBox({
        type: "info",
        buttons: [ctx.t("update.restartNow"), ctx.t("update.later")],
        defaultId: 0,
        cancelId: 1,
        title: ctx.t("update.readyTitle", { app: ctx.APP_NAME }),
        message: ctx.t("update.versionDownloaded", {
          version: prepared.latest_version,
        }),
        detail: ctx.t("update.detailRestart"),
      });

      if (restartNow === 0) {
        await installPreparedShellUpdate();
      }
    } catch (err) {
      console.warn(
        "Manual shell updater failed (non-fatal):",
        err?.message || err,
      );
    }
  }, MANUAL_UPDATE_CHECK_DELAY_MS);
}

module.exports = {
  init,
  GITHUB_OWNER,
  GITHUB_REPO,
  getUpdateMode,
  checkForShellUpdate,
  installPreparedShellUpdate,
  setupManualShellUpdater,
  resolveReleaseImageDigest,
  pickNativeAppZip,
  updaterChildEnv,
  launchPreparedNativeInstaller,
  writeInstallerScript,
};

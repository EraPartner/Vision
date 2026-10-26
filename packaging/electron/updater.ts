// ── Manual shell updater (.zip-only, no blockmaps) ───────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). We intentionally avoid
// electron-updater metadata (latest-mac.yml / blockmaps) and install the
// packaged Vision.app from the GitHub release ZIP. A development (unpackaged)
// run has no in-app installer (ADR-218): it reports update_mode "source" and
// sends the user to the release page. Mutable main.js state plus the localized
// dialog/notification seams (t, notify) are
// threaded in via init() so the live values are observed at call time, exactly
// as when this code lived in main.js.

import { app, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appRoot } from "./paths";

export type UpdateMode = "native" | "source";

type TranslationVars = Record<string, string | undefined>;

// Context threaded from main.js via init():
//   { APP_NAME, IS_DEMO, t, notify, markQuitting(), stopRuntime(), startRuntime() }
// markQuitting flips main.js's isQuitting flag so the will-quit handler knows
// the installer-driven quit is already underway.
export interface UpdaterContext {
  APP_NAME: string;
  IS_DEMO: boolean;
  t(key: string, vars?: TranslationVars): string;
  notify(body: string): void;
  markQuitting(): void;
  stopRuntime(): Promise<unknown>;
  startRuntime(): Promise<unknown>;
}

let ctx: Partial<UpdaterContext> = {};
export function init(context: Partial<UpdaterContext>): void {
  ctx = context;
}

// main.js always provides these seams; a missing one fails like the direct
// ctx.<name>() call it replaces.
function missingContext(name: string): TypeError {
  return new TypeError(`ctx.${name} is not a function`);
}

function t(key: string, vars?: TranslationVars): string {
  if (!ctx.t) throw missingContext("t");
  return ctx.t(key, vars);
}

function notify(body: string): void {
  if (!ctx.notify) throw missingContext("notify");
  ctx.notify(body);
}

function markQuitting(): void {
  if (!ctx.markQuitting) throw missingContext("markQuitting");
  ctx.markQuitting();
}

const MANUAL_UPDATE_CHECK_DELAY_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Overall deadline for the small GitHub API/checksum fetches (the previous
// hand-rolled https.get helpers had no timeout at all and could hang forever).
const GITHUB_FETCH_TIMEOUT_MS = 30 * 1000;

export const GITHUB_OWNER = "EraPartner";
export const GITHUB_REPO = "Vision";
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

type JsonRecord = Record<string, unknown>;

/** Release metadata copied from the GitHub API response as-is. */
interface ReleaseInfo {
  current_version: string;
  latest_version: string;
  html_url: unknown;
  release_notes: unknown;
  published_at: unknown;
}

type ReadyUpdate = ReleaseInfo & {
  up_to_date: false;
  installerPath: string;
  installerArgs: string[];
};

type PreparedUpdate =
  | (ReleaseInfo & { up_to_date: true })
  | (ReleaseInfo & { up_to_date: false; manual_download: true })
  | ReadyUpdate;

export interface ShellUpdateCheck {
  up_to_date: boolean;
  current_version: string;
  latest_version: string | null;
  html_url?: unknown;
  release_notes?: unknown;
  published_at?: unknown;
  update_mode: UpdateMode;
  error?: string;
}

export interface ShellUpdateInstallResult {
  success: boolean;
  error?: string;
  manual_download?: boolean;
  html_url?: string;
  version?: string;
}

/** The part of a spawned child process the native installer launch uses. */
export interface SpawnedInstaller {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

let shellUpdateCheckInFlight = false;
let pendingShellUpdate: ReadyUpdate | null = null;

// Property reads on parsed JSON: non-objects carry no fields.
function fieldsOf(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function errorMessage(error: unknown): unknown {
  return fieldsOf(error)?.message;
}

export function updaterChildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of UPDATER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  { timeout = 120_000 }: { timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: updaterChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `${command} exited ${code ?? `after ${signal}`}`,
        ),
      );
    });
  });
}

function waitForSpawnedChild<T extends SpawnedInstaller>(child: T): Promise<T> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

export async function launchPreparedNativeInstaller({
  installerPath,
  installerArgs,
  stopRuntime,
  startRuntime,
  spawnProcess = spawn,
  executable = process.execPath,
}: {
  installerPath: string;
  installerArgs: readonly string[];
  stopRuntime?: (() => Promise<unknown>) | undefined;
  startRuntime?: (() => Promise<unknown>) | undefined;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => SpawnedInstaller;
  executable?: string;
}): Promise<SpawnedInstaller> {
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
        (error as { restartError?: unknown }).restartError = restartError;
      }
    }
    throw error;
  }
}

function normalizeVersionTag(version: unknown): string {
  if (typeof version !== "string" || version === "") return "";
  const s = version.trim();
  return s.startsWith("v") ? s : `v${s}`;
}

function compareVersions(a: unknown, b: unknown): number {
  // Split off pre-release suffix (e.g. "1.2.3-rc.1" → ["1.2.3", "rc.1"])
  const splitPre = (v: unknown) => {
    const s = (typeof v === "string" ? v : "").replace(/^v/, "");
    const dash = s.indexOf("-");
    if (dash === -1) return { core: s, pre: null };
    return { core: s.slice(0, dash), pre: s.slice(dash + 1) };
  };
  const { core: ca, pre: prea } = splitPre(a);
  const { core: cb, pre: preb } = splitPre(b);
  const intOrZero = (n: string) => {
    const parsed = parseInt(n, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const pa = ca.split(".").map(intOrZero);
  const pb = cb.split(".").map(intOrZero);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
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
function comparePreRelease(prea: string, preb: string): number {
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

function getCurrentVersionTag(): string {
  // Read from the Electron package.json (accurate in dev and packaged modes).
  // workDir may be a native payload or source root. Its package.json
  // is not the Electron app, so do not use it for version detection.
  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );
    const version = fieldsOf(pkg)?.version;
    if (typeof version === "string" && version.trim()) {
      return normalizeVersionTag(version.trim());
    }
  } catch {
    // fall through
  }

  return normalizeVersionTag(app.getVersion());
}

// Only the packaged app installs updates; a development run updates from its
// own checkout like any other source deployment.
export function getUpdateMode(): UpdateMode {
  return app.isPackaged ? "native" : "source";
}

export function verifyUpdateChecksum(
  expected: string | null | undefined,
  actual: string | null | undefined,
): void {
  if (!expected || !actual || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Checksum mismatch — update was not installed");
  }
}

async function readGitHubRelease(): Promise<unknown> {
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

function releaseAssets(release: unknown): JsonRecord[] {
  const assets = fieldsOf(release)?.assets;
  const entries: unknown[] = Array.isArray(assets) ? assets : [];
  // Entries without fields never match an asset name below.
  return entries.flatMap<JsonRecord>((asset) => fieldsOf(asset) ?? []);
}

export function pickNativeAppZip(release: unknown): JsonRecord | null {
  return (
    releaseAssets(release).find((asset) =>
      /^Vision-.*-arm64-mac\.zip$/i.test(
        typeof asset.name === "string" ? asset.name : "",
      ),
    ) ?? null
  );
}

// Fallback for a release that carries no packaged app ZIP, and for development
// runs, which have no in-app installer: send the user to the release page so
// they can update by hand. Only https://github.com/ URLs from the API response
// are honoured — anything else falls back to the canonical releases page rather
// than handing an unexpected scheme to the OS.
function openReleasePage(htmlUrl: unknown): string {
  const fallback = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const url =
    typeof htmlUrl === "string" && /^https:\/\/github\.com\//i.test(htmlUrl)
      ? htmlUrl
      : fallback;
  try {
    void shell.openExternal(url);
  } catch (err) {
    console.warn("Failed to open release page:", errorMessage(err) || err);
  }
  return url;
}

function pickChecksumAsset(
  release: unknown,
  zipName: string,
): JsonRecord | null {
  const wanted = `${zipName}.sha256`.toLowerCase();
  return (
    releaseAssets(release).find(
      (a) =>
        (typeof a.name === "string" ? a.name : "").toLowerCase() === wanted,
    ) ?? null
  );
}

// fetch follows redirects itself (GitHub asset URLs 302 to a CDN).
async function fetchUrlBody(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}` },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function parseSha256Body(
  body: unknown,
  assetName: unknown,
): string | null {
  if (typeof body !== "string" || typeof assetName !== "string") return null;
  const match = /^([a-fA-F0-9]{64})  ([^\r\n]+)(?:\r?\n)?(?![\s\S])/.exec(body);
  const hash = match?.[1];
  return match?.[2] === assetName && hash ? hash.toLowerCase() : null;
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const download = await fetch(url, {
    headers: { "User-Agent": `${ctx.APP_NAME}-desktop/${app.getVersion()}` },
    signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
  });
  if (download.status !== 200 || !download.body) {
    throw new Error(`Download failed (${download.status})`);
  }
  await pipeline(
    Readable.fromWeb(download.body),
    fs.createWriteStream(filePath),
  );
}

function findVisionApp(root: string): string | null {
  return (
    [
      path.join(root, "Vision.app"),
      path.join(root, "mac-arm64", "Vision.app"),
      path.join(root, "mac", "Vision.app"),
    ].find((candidate) => fs.existsSync(candidate)) || null
  );
}

async function prepareNativeUpdateInstaller(): Promise<PreparedUpdate> {
  const release = await readGitHubRelease();
  const releaseFields = fieldsOf(release);
  const latestVersion = normalizeVersionTag(releaseFields?.tag_name);
  const currentVersion = getCurrentVersionTag();
  const asset = pickNativeAppZip(release);
  const releaseInfo: ReleaseInfo = {
    current_version: currentVersion,
    latest_version: latestVersion,
    html_url: releaseFields?.html_url,
    release_notes: releaseFields?.body || "",
    published_at: releaseFields?.published_at,
  };
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0)
    return { up_to_date: true, ...releaseInfo };
  const zipUrl = asset?.browser_download_url;
  if (!app.isPackaged || !asset || typeof zipUrl !== "string" || zipUrl === "")
    return { up_to_date: false, manual_download: true, ...releaseInfo };

  const assetName = String(asset.name);
  const tempRoot = path.join(
    app.getPath("temp"),
    `vision_native_update_${Date.now()}_${process.pid}`,
  );
  const zipPath = path.join(tempRoot, assetName);
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    await downloadToFile(zipUrl, zipPath);

    const checksumAsset = pickChecksumAsset(release, assetName);
    const checksumUrl = checksumAsset?.browser_download_url;
    if (typeof checksumUrl !== "string" || checksumUrl === "") {
      throw new Error("No checksum asset found for the native update");
    }
    const expected = parseSha256Body(
      await fetchUrlBody(checksumUrl),
      assetName,
    );
    if (!expected) {
      throw new Error("Native update checksum is invalid");
    }
    const actual = await computeFileSha256(zipPath);
    verifyUpdateChecksum(expected, actual);

    const zipEntries = await runCommand("zipinfo", ["-1", zipPath], tempRoot);
    for (const entry of zipEntries.split("\n")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = path.normalize(trimmed);
      if (normalized.startsWith("..") || path.isAbsolute(normalized))
        throw new Error(`Unsafe path in native update ZIP: ${trimmed}`);
    }
    await runCommand("ditto", ["-x", "-k", zipPath, extractDir], tempRoot);
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
    // The installer compiles next to this module and runs on its own.
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
    };
  } catch (error) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

export async function checkForShellUpdate(): Promise<ShellUpdateCheck> {
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
  const releaseFields = fieldsOf(release);
  const latestVersion = normalizeVersionTag(releaseFields?.tag_name);
  const currentVersion = getCurrentVersionTag();
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
    html_url: releaseFields?.html_url,
    release_notes: releaseFields?.body || "",
    published_at: releaseFields?.published_at,
    update_mode: mode,
  };
}

function currentPendingUpdate(): ReadyUpdate {
  if (!pendingShellUpdate) {
    throw new TypeError("The prepared update is no longer pending");
  }
  return pendingShellUpdate;
}

export async function installPreparedShellUpdate(): Promise<ShellUpdateInstallResult> {
  if (!pendingShellUpdate?.installerPath) {
    if (shellUpdateCheckInFlight) {
      return {
        success: false,
        error: "An update download is already in progress.",
      };
    }
    shellUpdateCheckInFlight = true;
    try {
      const prepared = await prepareNativeUpdateInstaller();
      if ("manual_download" in prepared) {
        const url = openReleasePage(prepared.html_url);
        return {
          success: false,
          manual_download: true,
          html_url: url,
          version: prepared.latest_version || "",
          error: t("update.manualDownload"),
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
      const message = errorMessage(err);
      return {
        success: false,
        error:
          typeof message === "string" && message !== ""
            ? message
            : String(err),
      };
    } finally {
      shellUpdateCheckInFlight = false;
    }
  }

  try {
    const pending = currentPendingUpdate();
    const installerPath = pending.installerPath;
    const latestVersion = pending.latest_version || "";
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
        recheck.latest_version &&
        compareVersions(recheck.latest_version, latestVersion) > 0
      ) {
        pendingShellUpdate = null;
        return {
          success: false,
          error: `A newer version (${recheck.latest_version}) is available. Please check for updates again.`,
        };
      }
    } catch {
      /* offline — proceed with the prepared bundle */
    }
    // Read the live pending update, as before, after the recheck awaits.
    await launchPreparedNativeInstaller({
      installerPath,
      installerArgs: currentPendingUpdate().installerArgs,
      stopRuntime: ctx.stopRuntime,
      startRuntime: ctx.startRuntime,
    });
    markQuitting();
    setImmediate(() => app.quit());
    return { success: true, version: latestVersion };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function promptForManualShellUpdate(): Promise<void> {
  try {
    const update = await checkForShellUpdate();
    if (update.up_to_date || !update.latest_version) return;

    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: [t("update.download"), t("update.later")],
      defaultId: 0,
      cancelId: 1,
      title: t("update.availableTitle", { app: ctx.APP_NAME }),
      message: t("update.versionAvailable", {
        version: update.latest_version,
      }),
      detail: t("update.detailDownload"),
    });

    if (response !== 0) return;

    notify(t("update.downloading"));
    const prepared = await prepareNativeUpdateInstaller();
    if ("manual_download" in prepared) {
      openReleasePage(prepared.html_url);
      notify(t("update.manualDownload"));
      return;
    }
    if (prepared.up_to_date || !prepared.installerPath) return;
    pendingShellUpdate = prepared;

    const { response: restartNow } = await dialog.showMessageBox({
      type: "info",
      buttons: [t("update.restartNow"), t("update.later")],
      defaultId: 0,
      cancelId: 1,
      title: t("update.readyTitle", { app: ctx.APP_NAME }),
      message: t("update.versionDownloaded", {
        version: prepared.latest_version,
      }),
      detail: t("update.detailRestart"),
    });

    if (restartNow === 0) {
      await installPreparedShellUpdate();
    }
  } catch (err) {
    console.warn(
      "Manual shell updater failed (non-fatal):",
      errorMessage(err) || err,
    );
  }
}

export function setupManualShellUpdater(): void {
  // A development run has nothing to install; it updates from its checkout.
  if (!app.isPackaged) return;
  setTimeout(
    () => void promptForManualShellUpdate(),
    MANUAL_UPDATE_CHECK_DELAY_MS,
  );
}

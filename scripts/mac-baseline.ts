#!/usr/bin/env bun
/**
 * Mac performance baseline for the installed Vision apps (Mac optimisation
 * plan, phase 0). Run it in your own Terminal on the Mac; see
 * docs/performance/mac-baseline.md.
 *
 * It launches each app with Chromium's --remote-debugging-port switch (a launch
 * argument only: normal launches, fuses, sandbox and CSP are unchanged), drives
 * scripted scrolls and page switches over the DevTools protocol, and records
 * one `sudo powermetrics` stream for the whole run. Each UI tier (and, with
 * --full-effects, each state of the "Full effects" switch) is set through the
 * app's own settings API, measured after a fresh launch, and the original
 * setting is restored at the end. --repeat measures every combination several
 * times so later phases can tell a win from run-to-run noise.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

import {
  CdpClient,
  attachToPage,
  browserSocketUrl,
  evaluate,
  readStream,
} from "./lib/mac-baseline/cdp.ts";
import {
  START_FRAME_RECORDER,
  STOP_FRAME_RECORDER,
  computeFrameStats,
  fpsBuckets,
  metricsDelta,
  type RawFrames,
} from "./lib/mac-baseline/frames.ts";
import { PowermetricsRecorder } from "./lib/mac-baseline/powermetrics.ts";
import {
  analyzeLeak,
  leakCsv,
  renderLeakSummary,
  type LeakPhase,
  type LeakResult,
} from "./lib/mac-baseline/leak.ts";
import {
  classifyProcesses,
  parseFootprintOutput,
  parsePsOutput,
  parseTopMem,
  summarizeRoles,
  type PsRow,
  type RoleRoots,
  type RoleSummary,
} from "./lib/mac-baseline/processes.ts";
import {
  renderSummary,
  type ActionMeasurement,
  type AppInfo,
  type AppResult,
  type BaselineResults,
  type LaunchTiming,
  type PageSwitch,
  type Tier,
  type TierResult,
  type WindowMeasurement,
} from "./lib/mac-baseline/report.ts";
import {
  MARK_PREFIX,
  TRACE_CATEGORIES,
  findSegments,
  summarizeTrace,
  type TraceEvent,
} from "./lib/mac-baseline/trace.ts";
import {
  RUNNING_ANIMATIONS,
  recordRequests,
  summarizeAnimations,
  summarizeRequests,
  type AnimationSample,
  type AnimationSeen,
} from "./lib/mac-baseline/launchProbe.ts";
import {
  parseSampleReport,
  renderHotSpots,
  renderNativeSection,
  parseNativePerfResults,
  runNamesNewestFirst,
  summarizeNativeRun,
  type MemorySample,
  type NativeAppResult,
  type PsSample,
} from "./lib/mac-baseline/native.ts";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

const TIERS: readonly Tier[] = ["reduced", "standard", "enhanced"];
const DEFAULT_APPS = [
  "/Applications/Vision Demo.app",
  "/Applications/Vision.app",
];
const DEFAULT_NATIVE_APPS = [
  "/Applications/Vision Native Demo.app",
  "/Applications/Vision Native.app",
];
const DEFAULT_PAGES = [
  "/",
  "/transactions",
  "/accounts",
  "/statistics",
  "/planned",
  "/portfolio",
];

const USAGE = `Usage: bun scripts/mac-baseline.ts [options]

  --app <path>          App bundle to measure; repeat for several
                        (default: ${DEFAULT_APPS.join(", ")} when present)
  --tiers <list>        Comma list of reduced,standard,enhanced (default: all)
  --full-effects <list> Comma list of off,on for the "Full effects" switch
                        (default: off)
  --repeat <n>          Measure every tier/switch combination n times, each
                        from a fresh launch, and report median and min–max
                        (default 1)
  --idle <s>            Idle window per tier (default 60)
  --sustained <s>       Sustained scroll/switch run per tier (default 300)
  --cooldown <s>        Wait with the app closed before each measured launch (default 60)
  --scroll-px <px>      Ledger scroll distance each way (default 15000)
  --pages <list>        Page-switch sequence (default ${DEFAULT_PAGES.join(",")})
  --out <dir>           Results root (default perf-results/ in the main checkout)
  --no-powermetrics     Skip sudo powermetrics (no GPU or power numbers)
  --no-trace            Skip the Chromium trace pass
  --launch-probe <s>    Before the settle, record running page animations (every
                        5 s), page requests, and per-process CPU/GPU for the first
                        <s> seconds after launch, without input; writes
                        launch-probe/<label>.json with the backend log tail.
                        A diagnostic: it delays the idle window, so leave it off
                        for before/after runs (default 0 = off)
  --quick               Smoke run: idle 10, sustained 30, cooldown 5, scroll 4000
  --native              Measure the installed native (Swift) apps (${DEFAULT_NATIVE_APPS.join(", ")}
                        when present) instead of the Electron apps, with the app's own
                        scripted run (-VisionPerfRun). Pass --app as well to measure
                        Electron apps in the same run. Idle and sustained default to the
                        app's 30 s and 60 s; --idle, --sustained and --quick override them.
                        --tiers, --full-effects, --repeat, --scroll-px, --pages and --no-trace
                        do not apply to native apps.
  --no-profile          Skip the native profiling pass (one extra run under \`sample\`)
  --native-app <path>   A native app bundle to measure; repeat for several (implies --native)
  --compare <path>      Electron results to compare the native apps with: a run directory
                        or a results root (default: the newest run in --out with Electron apps)
  --leak <min>          Leak check instead of the tier matrix: one launch of the
                        first app at its current tier, alternating active and
                        idle windows for <min> minutes (45 is enough for a
                        verdict); writes leak.md, leak.csv and leak.json
  --leak-window <s>     Length of each active and each idle window (default 300)
  --help                This text
`;

interface Options {
  apps: string[];
  nativeApps: string[];
  /** Seconds passed to the native app; null keeps the app's own default. */
  nativeIdleSeconds: number | null;
  nativeSustainedSeconds: number | null;
  compare: string | null;
  tiers: Tier[];
  fullEffects: boolean[];
  repeat: number;
  idleSeconds: number;
  sustainedSeconds: number;
  cooldownSeconds: number;
  scrollPx: number;
  pages: string[];
  outRoot: string;
  powermetrics: boolean;
  /** After the measured native runs, one more run sampled with `sample` for hot spots. */
  profile: boolean;
  trace: boolean;
  launchProbeSeconds: number;
  quick: boolean;
  leakMinutes: number | null;
  leakWindowSeconds: number;
}

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: "string", multiple: true },
      native: { type: "boolean" },
      "native-app": { type: "string", multiple: true },
      compare: { type: "string" },
      tiers: { type: "string" },
      "full-effects": { type: "string" },
      repeat: { type: "string" },
      idle: { type: "string" },
      sustained: { type: "string" },
      cooldown: { type: "string" },
      "scroll-px": { type: "string" },
      pages: { type: "string" },
      out: { type: "string" },
      "no-powermetrics": { type: "boolean" },
      "no-trace": { type: "boolean" },
      "no-profile": { type: "boolean" },
      "launch-probe": { type: "string" },
      quick: { type: "boolean" },
      leak: { type: "string" },
      "leak-window": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  const quick = values.quick === true;
  const number = (
    value: string | undefined,
    fallback: number,
    name: string,
  ) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`--${name} must be a number ≥ 0`);
    return parsed;
  };
  const tiers = (values.tiers ?? TIERS.join(","))
    .split(",")
    .map((tier) => tier.trim())
    .filter(Boolean);
  for (const tier of tiers) {
    if (!TIERS.includes(tier as Tier)) throw new Error(`Unknown tier: ${tier}`);
  }
  const fullEffects = (values["full-effects"] ?? "off")
    .split(",")
    .map((state) => state.trim())
    .filter(Boolean)
    .map((state) => {
      if (state !== "off" && state !== "on")
        throw new Error(`--full-effects takes off and/or on, not ${state}`);
      return state === "on";
    });
  if (fullEffects.length === 0)
    throw new Error("--full-effects needs off, on or off,on");
  const repeat = number(values.repeat, 1, "repeat");
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error("--repeat must be a whole number ≥ 1");
  const native = values.native === true || values["native-app"] !== undefined;
  // --native alone replaces the Electron default; an explicit --app keeps it.
  const apps =
    values.app ??
    (native ? [] : DEFAULT_APPS.filter((app) => fs.existsSync(app)));
  const nativeApps = native
    ? (
        values["native-app"] ??
        DEFAULT_NATIVE_APPS.filter((app) => fs.existsSync(app))
      ).map((app) => path.resolve(app))
    : [];
  return {
    apps: apps.map((app) => path.resolve(app)),
    nativeApps,
    nativeIdleSeconds:
      values.idle !== undefined
        ? number(values.idle, 0, "idle")
        : quick
          ? 10
          : null,
    nativeSustainedSeconds:
      values.sustained !== undefined
        ? number(values.sustained, 0, "sustained")
        : quick
          ? 30
          : null,
    compare: values.compare ? path.resolve(values.compare) : null,
    tiers: tiers as Tier[],
    fullEffects: [...new Set(fullEffects)],
    repeat,
    idleSeconds: number(values.idle, quick ? 10 : 60, "idle"),
    sustainedSeconds: number(values.sustained, quick ? 30 : 300, "sustained"),
    cooldownSeconds: number(values.cooldown, quick ? 5 : 60, "cooldown"),
    scrollPx: number(values["scroll-px"], quick ? 4000 : 15_000, "scroll-px"),
    pages: values.pages
      ? values.pages.split(",").map((page) => page.trim())
      : DEFAULT_PAGES,
    outRoot: path.resolve(
      values.out ?? path.join(mainWorktreeRoot(), "perf-results"),
    ),
    powermetrics: values["no-powermetrics"] !== true,
    trace: values["no-trace"] !== true,
    profile: values["no-profile"] !== true,
    launchProbeSeconds: number(values["launch-probe"], 0, "launch-probe"),
    quick,
    leakMinutes:
      values.leak === undefined ? null : number(values.leak, 45, "leak"),
    leakWindowSeconds: number(values["leak-window"], 300, "leak-window"),
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────

const abort = new AbortController();

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abort.signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      abort.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function checkAborted(): void {
  if (abort.signal.aborted) throw new Error("Aborted");
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function psSnapshot(): PsRow[] {
  return parsePsOutput(
    run("ps", ["-axww", "-o", "pid=,ppid=,rss=,time=,command="]) ?? "",
  );
}

function footprints(): Map<number, number> {
  return parseTopMem(
    run("top", ["-l", "1", "-s", "0", "-stats", "pid,mem"]) ?? "",
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── App bundle ───────────────────────────────────────────────────────────────

function plistValue(appPath: string, key: string): string {
  const value = run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  if (!value) throw new Error(`Cannot read ${key} from ${appPath}`);
  return value;
}

function duMb(target: string): number {
  const kb = Number((run("du", ["-sk", target]) ?? "").split(/\s+/)[0]);
  return Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : Number.NaN;
}

function appInfo(
  appPath: string,
): AppInfo & { executable: string; userData: string } {
  const name = plistValue(appPath, "CFBundleName");
  const breakdown: Record<string, number> = {};
  const contents = path.join(appPath, "Contents");
  for (const part of ["Frameworks", "MacOS"]) {
    const target = path.join(contents, part);
    if (fs.existsSync(target)) breakdown[part] = duMb(target);
  }
  const resources = path.join(contents, "Resources");
  if (fs.existsSync(resources)) {
    for (const entry of fs.readdirSync(resources)) {
      const size = duMb(path.join(resources, entry));
      if (size >= 1) breakdown[`Resources/${entry}`] = size;
    }
  }
  return {
    path: appPath,
    name,
    bundleId: plistValue(appPath, "CFBundleIdentifier"),
    version: plistValue(appPath, "CFBundleShortVersionString"),
    bundleMtime: fs.statSync(appPath).mtime.toISOString(),
    sizeMb: duMb(appPath),
    sizeBreakdownMb: breakdown,
    executable: path.join(
      contents,
      "MacOS",
      plistValue(appPath, "CFBundleExecutable"),
    ),
    userData: path.join(os.homedir(), "Library", "Application Support", name),
  };
}

/** Backend and PostgreSQL pids from the native runtime's pid files. */
function runtimeRoots(userData: string, mainPid: number): RoleRoots {
  const roots: RoleRoots = { mainPid };
  const nativeDir = path.join(userData, "native");
  let runtimes: string[] = [];
  try {
    runtimes = fs.readdirSync(nativeDir);
  } catch {
    return roots;
  }
  for (const runtime of runtimes) {
    for (const [file, key] of [
      ["backend.pid.json", "backendPid"],
      ["postgres.pid.json", "postgresPid"],
    ] as const) {
      try {
        const { pid } = JSON.parse(
          fs.readFileSync(path.join(nativeDir, runtime, file), "utf8"),
        ) as { pid?: unknown };
        if (typeof pid === "number" && processAlive(pid)) roots[key] = pid;
      } catch {
        /* no pid file for this runtime */
      }
    }
  }
  return roots;
}

// ── Launch, page access, quit ────────────────────────────────────────────────

interface RunningApp {
  child: ChildProcess;
  mainPid: number;
  cdp: CdpClient;
  sessionId: string;
  origin: string;
  launch: LaunchTiming;
  info: ReturnType<typeof appInfo>;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(VISION_|ELECTRON_|NODE_OPTIONS$)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function launchApp(
  info: ReturnType<typeof appInfo>,
  logPath: string,
): Promise<RunningApp> {
  checkAborted();
  const port = await freePort();
  const logFile = fs.createWriteStream(logPath, { flags: "a" });
  logFile.write(`\n=== launch ${new Date().toISOString()} port ${port}\n`);
  const started = performance.now();
  // detached: Ctrl-C in the terminal must not kill the app before the tier
  // setting is restored.
  const child = spawn(info.executable, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv(),
  });
  const phases: Record<string, number> = {};
  let spawnToReady: number | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No renderer_ready within 180 s; see ${logPath}`)),
      180_000,
    );
    let pending = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      logFile.write(chunk);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /\[startup\] (\{.*\})\s*$/.exec(line);
        if (!match) continue;
        try {
          const mark = JSON.parse(match[1] as string) as {
            phase?: string;
            ms?: number;
          };
          if (typeof mark.phase === "string" && typeof mark.ms === "number") {
            phases[mark.phase] = mark.ms;
            if (mark.phase === "renderer_ready" && spawnToReady === null) {
              spawnToReady = Math.round(performance.now() - started);
              clearTimeout(timer);
              resolve();
            }
          }
        } catch {
          /* not a boot mark */
        }
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => logFile.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`App exited during launch (code ${code}); see ${logPath}`),
      );
    });
  });
  let cdp: CdpClient | undefined;
  let sessionId: string;
  let url: string;
  try {
    await ready;
    cdp = await CdpClient.connect(await browserSocketUrl(port, 30_000));
    ({ sessionId, url } = await attachToPage(
      cdp,
      (candidate) =>
        /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//.test(candidate),
      30_000,
    ));
    await cdp.send("Performance.enable", {}, sessionId);
  } catch (error) {
    // A half-started app would hold the single-instance lock and block the
    // restore launch.
    cdp?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw error;
  }
  run("osascript", [
    "-e",
    `tell application id "${info.bundleId}" to activate`,
  ]);
  return {
    child,
    mainPid: child.pid ?? -1,
    cdp,
    sessionId,
    origin: new URL(url).origin,
    launch: { spawnToRendererReadyMs: spawnToReady, phases: { ...phases } },
    info,
  };
}

async function quitApp(app: RunningApp): Promise<void> {
  const postgresPid = runtimeRoots(app.info.userData, app.mainPid).postgresPid;
  app.cdp.close();
  run("osascript", [
    "-e",
    `tell application id "${app.info.bundleId}" to quit`,
  ]);
  const deadline = Date.now() + 60_000;
  while (processAlive(app.mainPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (processAlive(app.mainPid)) {
    log("App did not quit in 60 s; sending SIGTERM.");
    app.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  // PostgreSQL stops after the main process; wait so the next launch is clean.
  const pgDeadline = Date.now() + 30_000;
  while (
    postgresPid !== undefined &&
    processAlive(postgresPid) &&
    Date.now() < pgDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function page<T>(
  app: RunningApp,
  expression: string,
  timeoutMs?: number,
): Promise<T> {
  return evaluate<T>(app.cdp, app.sessionId, expression, timeoutMs);
}

interface PageState {
  classes: string[];
  focused: boolean;
  hidden: boolean;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  pathname: string;
}

const PAGE_STATE = `({
  classes: [...document.documentElement.classList].filter((name) => name.startsWith("fx-")),
  focused: document.hasFocus(),
  hidden: document.hidden,
  innerWidth, innerHeight, devicePixelRatio,
  screenWidth: screen.width, screenHeight: screen.height,
  pathname: location.pathname,
})`;

function effectiveTier(classes: string[]): Tier {
  if (classes.includes("fx-reduced")) return "reduced";
  if (classes.includes("fx-enhanced")) return "enhanced";
  return "standard";
}

async function checkFocus(
  app: RunningApp,
  warnings: string[],
  phase: string,
): Promise<void> {
  const state = await page<PageState>(app, PAGE_STATE);
  if (!state.focused || state.hidden) {
    warnings.push(
      `window not focused at the end of ${phase}: the aurora pauses when unfocused, so this phase is not comparable`,
    );
    run("osascript", [
      "-e",
      `tell application id "${app.info.bundleId}" to activate`,
    ]);
  }
}

// ── Settings API (same endpoints the renderer uses) ──────────────────────────

interface SettingRecord {
  value: unknown;
  expected: { exists: boolean; value?: unknown };
}

async function settingsRequest(
  origin: string,
  method: string,
  body?: unknown,
): Promise<SettingRecord | null> {
  const response = await fetch(`${origin}/api/settings/app_settings`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "DELETE" && response.status === 204) return null;
  const payload = (await response.json()) as {
    ok?: boolean;
    data?: SettingRecord;
    error?: unknown;
  };
  if (!response.ok || !payload.data) {
    throw new Error(
      `${method} app_settings failed (${response.status}): ${JSON.stringify(payload.error ?? payload)}`,
    );
  }
  return payload.data;
}

async function readSettings(origin: string): Promise<SettingRecord> {
  return (await settingsRequest(origin, "GET")) as SettingRecord;
}

async function writeTier(
  origin: string,
  tier: Tier,
  fullEffects: boolean,
): Promise<void> {
  const current = await readSettings(origin);
  const value = {
    ...(current.value as Record<string, unknown>),
    visualEffects: tier,
    fullEffects,
  };
  await settingsRequest(origin, "PUT", { value, expected: current.expected });
}

async function restoreSettings(
  origin: string,
  original: SettingRecord,
): Promise<void> {
  const current = await readSettings(origin);
  if (original.expected.exists) {
    await settingsRequest(origin, "PUT", {
      value: original.value,
      expected: current.expected,
    });
  } else if (current.expected.exists) {
    await settingsRequest(origin, "DELETE", { expected: current.expected });
  }
}

// ── Scripted actions ─────────────────────────────────────────────────────────

function navigateExpression(target: string): string {
  return `(async () => {
    const target = ${JSON.stringify(target)};
    const started = performance.now();
    let method = "link";
    const link = [...document.querySelectorAll("a[href]")].find(
      (a) => a.getAttribute("href") === target && a.offsetParent !== null,
    );
    if (location.pathname === target) method = "already-there";
    else if (link) link.click();
    else {
      method = "history";
      history.pushState(null, "", target);
      dispatchEvent(new PopStateEvent("popstate"));
    }
    // Settled = no DOM structure/text change for 400 ms (style-only animation ignored).
    return await new Promise((resolve) => {
      let last = performance.now();
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const check = () => {
        const now = performance.now();
        const timedOut = now - started > 15000;
        if (now - last >= 400 || timedOut) {
          observer.disconnect();
          resolve({ path: location.pathname, method, settleMs: Math.round(last - started), timedOut });
        } else setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  })()`;
}

async function navigate(app: RunningApp, target: string): Promise<PageSwitch> {
  return page<PageSwitch>(app, navigateExpression(target), 30_000);
}

const FIND_SCROLLER = `(() => {
  const candidates = [...document.querySelectorAll('[role="rowgroup"]')]
    .filter((el) => el.scrollHeight > el.clientHeight + 10)
    .sort((a, b) => b.clientHeight - a.clientHeight);
  const el = candidates[0];
  if (!el) return null;
  globalThis.__visionPerfScroller = el;
  el.scrollTop = 0;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 240) };
})()`;

const SCROLLER_STATE = `(() => {
  const el = globalThis.__visionPerfScroller;
  return el ? { scrollTop: Math.round(el.scrollTop), rows: el.querySelectorAll("[data-index]").length } : null;
})()`;

function programmaticScroll(distance: number, speed: number): string {
  return `new Promise((resolve) => {
    const el = globalThis.__visionPerfScroller;
    const distance = ${distance};
    const speed = ${speed};
    let moved = 0;
    let previous = performance.now();
    const step = (now) => {
      const delta = Math.min(Math.abs(distance) - moved, (speed * (now - previous)) / 1000);
      previous = now;
      moved += delta;
      el.scrollTop += Math.sign(distance) * delta;
      if (moved < Math.abs(distance)) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  })`;
}

/** Scroll the ledger down then back up; the gesture goes through the compositor like a trackpad. */
async function scrollLedger(
  app: RunningApp,
  distance: number,
  speed = 1500,
): Promise<{ method: string; reachedScrollTop: number; rowsRendered: number }> {
  const target = await page<{ x: number; y: number } | null>(
    app,
    FIND_SCROLLER,
  );
  if (!target)
    throw new Error("No scrollable ledger on /transactions (empty ledger?)");
  let method = "gesture";
  let reached = 0;
  let rows = 0;
  for (const direction of [-1, 1]) {
    const before = await page<{ scrollTop: number; rows: number }>(
      app,
      SCROLLER_STATE,
    );
    if (method === "gesture") {
      try {
        await app.cdp.send(
          "Input.synthesizeScrollGesture",
          {
            x: target.x,
            y: target.y,
            yDistance: direction * distance,
            speed,
            gestureSourceType: "mouse",
            preventFling: true,
          },
          app.sessionId,
          (distance / speed) * 1000 + 30_000,
        );
      } catch {
        method = "programmatic";
      }
    }
    const afterGesture = await page<{ scrollTop: number; rows: number }>(
      app,
      SCROLLER_STATE,
    );
    if (
      method === "gesture" &&
      direction === -1 &&
      afterGesture.scrollTop === before.scrollTop
    ) {
      method = "programmatic";
    }
    if (method === "programmatic") {
      await page(
        app,
        programmaticScroll(-direction * distance, speed),
        (distance / speed) * 1000 + 30_000,
      );
    }
    const after = await page<{ scrollTop: number; rows: number }>(
      app,
      SCROLLER_STATE,
    );
    if (direction === -1) {
      reached = after.scrollTop;
      rows = after.rows;
    }
  }
  return { method, reachedScrollTop: reached, rowsRendered: rows };
}

// ── Measurement windows ──────────────────────────────────────────────────────

interface Context {
  options: Options;
  powermetrics: PowermetricsRecorder | null;
  outDir: string;
}

async function pageMetrics(app: RunningApp): Promise<Record<string, number>> {
  const { metrics } = await app.cdp.send<{
    metrics: { name: string; value: number }[];
  }>("Performance.getMetrics", {}, app.sessionId);
  return Object.fromEntries(
    metrics.map((metric) => [metric.name, metric.value]),
  );
}

async function measureWindow<T>(
  ctx: Context,
  app: RunningApp,
  body: () => Promise<T>,
): Promise<{
  result: T;
  window: WindowMeasurement;
  start: number;
  end: number;
}> {
  const before = psSnapshot();
  const start = Date.now();
  const result = await body();
  const end = Date.now();
  const after = psSnapshot();
  const roles = classifyProcesses(
    after,
    runtimeRoots(app.info.userData, app.mainPid),
  );
  return {
    result,
    start,
    end,
    window: {
      wallMs: end - start,
      cpu: summarizeRoles(after, roles, {
        before,
        wallSeconds: (end - start) / 1000,
      }),
      power: ctx.powermetrics?.summarize(start, end) ?? null,
    },
  };
}

async function measureAction<T>(
  ctx: Context,
  app: RunningApp,
  body: () => Promise<T>,
): Promise<{
  result: T;
  action: ActionMeasurement;
  raw: RawFrames;
  start: number;
  end: number;
}> {
  const metricsBefore = await pageMetrics(app);
  await page(app, START_FRAME_RECORDER);
  const { result, window, start, end } = await measureWindow(ctx, app, body);
  const raw = await page<RawFrames>(app, STOP_FRAME_RECORDER);
  const metricsAfter = await pageMetrics(app);
  return {
    result,
    raw,
    start,
    end,
    action: {
      ...window,
      frames: computeFrameStats(raw),
      pageMetrics: metricsDelta(metricsBefore, metricsAfter),
    },
  };
}

/** Roles whose processes share memory (PostgreSQL's shared buffers). */
const SHARED_ONCE_ROLES = ["backend", "postgres"] as const;

/** footprint(1) over several pids: memory they share is counted once. */
function sharedOnceMb(pids: number[]): number | null {
  if (pids.length === 0) return null;
  const text = run("footprint", pids.map(String));
  if (text === null) return null;
  const { totalBytes } = parseFootprintOutput(text);
  return totalBytes === null
    ? null
    : Math.round((totalBytes / 1024 ** 2) * 10) / 10;
}

function memorySnapshot(app: RunningApp): RoleSummary {
  const rows = psSnapshot();
  const roles = classifyProcesses(
    rows,
    runtimeRoots(app.info.userData, app.mainPid),
  );
  const summary = summarizeRoles(rows, roles, { footprints: footprints() });
  for (const role of SHARED_ONCE_ROLES) {
    const stats = summary[role];
    if (!stats) continue;
    stats.sharedOnceMb = sharedOnceMb(
      [...roles].filter(([, r]) => r === role).map(([pid]) => pid),
    );
  }
  return summary;
}

async function pageSwitches(
  app: RunningApp,
  pages: string[],
  passes: number,
): Promise<PageSwitch[][]> {
  const out: PageSwitch[][] = [];
  for (let pass = 0; pass < passes; pass++) {
    const steps: PageSwitch[] = [];
    for (const target of pages) {
      checkAborted();
      steps.push(await navigate(app, target));
    }
    out.push(steps);
  }
  return out;
}

async function tracedPass(
  ctx: Context,
  app: RunningApp,
  label: string,
): Promise<TierResult["trace"]> {
  const mark = (name: string) =>
    page(app, `console.timeStamp(${JSON.stringify(`${MARK_PREFIX}${name}`)})`);
  await app.cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      traceBufferSizeInKb: 300 * 1024,
      includedCategories: TRACE_CATEGORIES,
    },
  });
  let text: string | undefined;
  try {
    await navigate(app, "/");
    await mark("idle:start");
    await sleep(10_000);
    await mark("idle:end");
    await navigate(app, "/transactions");
    await mark("scroll:start");
    await scrollLedger(app, Math.min(ctx.options.scrollPx, 6000));
    await mark("scroll:end");
    await mark("switch:start");
    await pageSwitches(app, ctx.options.pages, 1);
    await mark("switch:end");
  } finally {
    // Always end tracing so the browser drops its buffer, even after a failure.
    const complete = app.cdp.waitForEvent("Tracing.tracingComplete", 120_000);
    await app.cdp.send("Tracing.end");
    const stream = (await complete).params.stream;
    if (typeof stream === "string") text = await readStream(app.cdp, stream);
  }
  if (text === undefined) return null;
  const file = path.join(ctx.outDir, "traces", `${label}.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(text));
  const parsed = JSON.parse(text) as
    { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  const segments: Record<string, ReturnType<typeof summarizeTrace>> = {};
  for (const [name, window] of findSegments(events))
    segments[name] = summarizeTrace(events, window);
  return { file: path.relative(ctx.outDir, file), segments };
}

/** Last lines of the newest backend log of the app's native runtime. */
function backendLogTail(userData: string, lines: number): string[] {
  const nativeDir = path.join(userData, "native");
  let newest: { file: string; mtimeMs: number } | null = null;
  try {
    for (const runtime of fs.readdirSync(nativeDir)) {
      const file = path.join(nativeDir, runtime, "logs", "backend.log");
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
      } catch {
        /* no backend log for this runtime */
      }
    }
  } catch {
    return [];
  }
  if (!newest) return [];
  return fs
    .readFileSync(newest.file, "utf8")
    .trimEnd()
    .split("\n")
    .slice(-lines);
}

async function launchProbe(
  ctx: Context,
  app: RunningApp,
  label: string,
): Promise<void> {
  const seconds = ctx.options.launchProbeSeconds;
  log(`  launch probe ${seconds} s (no input)`);
  const startedAt = Date.now();
  const requests = recordRequests(app.cdp, app.sessionId, startedAt);
  await app.cdp.send("Network.enable", {}, app.sessionId);
  const samples: AnimationSample[] = [];
  const measured = await measureWindow(ctx, app, async () => {
    while (Date.now() - startedAt < seconds * 1000) {
      checkAborted();
      samples.push({
        atS: Math.round((Date.now() - startedAt) / 100) / 10,
        running: await page<AnimationSeen[]>(app, RUNNING_ANIMATIONS),
      });
      await sleep(
        Math.min(5000, Math.max(0, seconds * 1000 - (Date.now() - startedAt))),
      );
    }
  });
  const records = requests.stop();
  await app.cdp.send("Network.disable", {}, app.sessionId);
  const animations = summarizeAnimations(samples);
  const requestSummary = summarizeRequests(records);
  const file = path.join(ctx.outDir, "launch-probe", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        label,
        launch: app.launch,
        window: measured.window,
        animations,
        requests: requestSummary,
        samples,
        records,
        backendLogTail: backendLogTail(app.info.userData, 200),
      },
      null,
      2,
    ),
  );
  const cpu = measured.window.cpu;
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "?" : value.toFixed(1);
  log(
    `  probe: app CPU ${pct(cpu.appTotal?.cpuPercent)}% (backend ${pct(cpu.backend?.cpuPercent)}%, postgres ${pct(cpu.postgres?.cpuPercent)}%, gpu ${pct(cpu.gpu?.cpuPercent)}%), GPU active ${pct(measured.window.power?.gpuActivePercent)}%`,
  );
  for (const animation of animations.slice(0, 5)) {
    log(
      `    animation ${animation.name} on ${animation.target}: ${animation.samples}/${samples.length} samples (${animation.firstS}–${animation.lastS} s)`,
    );
  }
  for (const request of requestSummary.slice(0, 5)) {
    log(
      `    ${request.path}: ${request.count}× (failed ${request.failed}, open ${request.open}, max ${request.maxMs} ms)`,
    );
  }
  log(`    written to ${path.relative(ctx.outDir, file)}`);
}

async function measureTier(
  ctx: Context,
  app: RunningApp,
  tier: Tier,
  fullEffects: boolean,
  run: number,
  label: string,
): Promise<TierResult> {
  const warnings: string[] = [];
  const { options } = ctx;
  if (options.launchProbeSeconds > 0) {
    try {
      await launchProbe(ctx, app, label);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`launch probe failed: ${(error as Error).message}`);
    }
  }
  log(`  launched in ${app.launch.spawnToRendererReadyMs} ms; settling 10 s`);
  await sleep(10_000);
  const state = await page<PageState>(app, PAGE_STATE);
  const effective = effectiveTier(state.classes);
  if (effective !== tier) {
    warnings.push(
      `effective tier is ${effective}, not ${tier} (auto-adapt for a large display?)`,
    );
  }
  if (state.classes.includes("fx-full") !== fullEffects) {
    warnings.push(
      `Full effects is ${state.classes.includes("fx-full") ? "on" : "off"} in the window, not ${fullEffects ? "on" : "off"} (app build without the switch?)`,
    );
  }
  const afterLaunch = memorySnapshot(app);

  await navigate(app, "/");
  await sleep(3000);
  log(`  idle ${options.idleSeconds} s on /`);
  const idle = await measureWindow(ctx, app, () =>
    sleep(options.idleSeconds * 1000),
  );
  await checkFocus(app, warnings, "idle");
  const afterIdle = memorySnapshot(app);

  let scroll: TierResult["scroll"] = null;
  try {
    log("  ledger scroll");
    await navigate(app, "/transactions");
    await sleep(1500);
    const measured = await measureAction(ctx, app, () =>
      scrollLedger(app, options.scrollPx),
    );
    scroll = {
      ...measured.action,
      ...measured.result,
      requestedPx: options.scrollPx,
    };
  } catch (error) {
    if (abort.signal.aborted) throw error;
    warnings.push(`scroll skipped: ${(error as Error).message}`);
  }
  await checkFocus(app, warnings, "scroll");

  log("  page switches (2 passes)");
  await navigate(app, options.pages.at(-1) ?? "/");
  const switches = await measureAction(ctx, app, () =>
    pageSwitches(app, options.pages, 2),
  );
  await checkFocus(app, warnings, "page switches");

  let trace: TierResult["trace"] = null;
  if (options.trace) {
    try {
      log("  traced pass");
      trace = await tracedPass(ctx, app, label);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`trace skipped: ${(error as Error).message}`);
    }
  }

  let sustained: TierResult["sustained"] = null;
  let afterSustained: RoleSummary | null = null;
  if (options.sustainedSeconds > 0) {
    log(`  sustained ${options.sustainedSeconds} s`);
    let cycles = 0;
    const deadline = Date.now() + options.sustainedSeconds * 1000;
    const measured = await measureAction(ctx, app, async () => {
      while (Date.now() < deadline) {
        checkAborted();
        await navigate(app, "/transactions");
        try {
          await scrollLedger(app, Math.min(options.scrollPx, 6000));
        } catch {
          await sleep(2000);
        }
        for (const target of options.pages
          .filter((p) => p !== "/transactions")
          .slice(0, 3)) {
          if (Date.now() >= deadline) break;
          await navigate(app, target);
        }
        cycles += 1;
      }
    });
    const minute = 60_000;
    sustained = {
      ...measured.action,
      seconds: options.sustainedSeconds,
      cycles,
      fpsPer10s: fpsBuckets(measured.raw.stamps, 10_000),
      powerFirstMinute:
        ctx.powermetrics?.summarize(
          measured.start,
          Math.min(measured.end, measured.start + minute),
        ) ?? null,
      powerLastMinute:
        ctx.powermetrics?.summarize(
          Math.max(measured.start, measured.end - minute),
          measured.end,
        ) ?? null,
    };
    await checkFocus(app, warnings, "sustained run");
    afterSustained = memorySnapshot(app);
  }

  return {
    tier,
    fullEffects,
    run,
    effective: { tier: effective, classes: state.classes },
    page: {
      innerWidth: state.innerWidth,
      innerHeight: state.innerHeight,
      devicePixelRatio: state.devicePixelRatio,
      screenWidth: state.screenWidth,
      screenHeight: state.screenHeight,
    },
    launch: app.launch,
    memory: { afterLaunch, afterIdle, afterSustained },
    idle: { ...idle.window, seconds: options.idleSeconds, page: "/" },
    scroll,
    pageSwitch: { ...switches.action, passes: switches.result },
    trace,
    sustained,
    warnings,
  };
}

async function measureApp(ctx: Context, appPath: string): Promise<AppResult> {
  const info = appInfo(appPath);
  const result: AppResult = {
    app: {
      path: info.path,
      name: info.name,
      bundleId: info.bundleId,
      version: info.version,
      bundleMtime: info.bundleMtime,
      sizeMb: info.sizeMb,
      sizeBreakdownMb: info.sizeBreakdownMb,
    },
    originalTier: null,
    restored: false,
    tiers: [],
    error: null,
  };
  if (psSnapshot().some((row) => row.command.startsWith(info.executable))) {
    result.error = `${info.name} is already running; quit it and run again`;
    return result;
  }
  const slug = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const logPath = path.join(ctx.outDir, "logs", `${slug}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  let running: RunningApp | undefined;
  let original: SettingRecord | undefined;
  let dirty = false;
  try {
    log(`${info.name}: setup launch`);
    running = await launchApp(info, logPath);
    original = await readSettings(running.origin);
    const originalTier = (original.value as { visualEffects?: unknown })
      .visualEffects;
    result.originalTier = TIERS.includes(originalTier as Tier)
      ? (originalTier as Tier)
      : null;
    // Repeats are the outer loop so slow drift (heat, background work)
    // spreads over every combination instead of piling onto one.
    const { repeat } = ctx.options;
    for (let run = 1; run <= repeat; run += 1) {
      for (const tier of ctx.options.tiers) {
        for (const fullEffects of ctx.options.fullEffects) {
          const name = [
            tier,
            fullEffects ? "full" : null,
            repeat > 1 ? `run ${run}/${repeat}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          await writeTier(running.origin, tier, fullEffects);
          dirty = true;
          await quitApp(running);
          running = undefined;
          log(
            `${info.name} ${name}: cooldown ${ctx.options.cooldownSeconds} s`,
          );
          await sleep(ctx.options.cooldownSeconds * 1000);
          running = await launchApp(info, logPath);
          const label = [
            slug,
            tier,
            fullEffects ? "full" : null,
            repeat > 1 ? `r${run}` : null,
          ]
            .filter(Boolean)
            .join("-");
          result.tiers.push(
            await measureTier(ctx, running, tier, fullEffects, run, label),
          );
        }
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    if (dirty && original) {
      try {
        if (!running) running = await launchApp(info, logPath);
        await restoreSettings(running.origin, original);
        dirty = false;
        log(`${info.name}: tier setting restored`);
      } catch (error) {
        log(
          `${info.name}: could NOT restore the tier setting (${(error as Error).message}). Set it back in Settings.`,
        );
      }
    }
    if (running) await quitApp(running);
  }
  result.restored = !dirty;
  return result;
}

// ── Native (Swift) app ───────────────────────────────────────────────────────

const NATIVE_MEMORY_INTERVAL_MS = 15_000;
/** Allowed beyond the scripted windows: launch, settle, scroll, switches and quit. */
const NATIVE_RUN_SLACK_SECONDS = 600;

function roleFootprint(pids: number[]): MemorySample["backend"] {
  if (pids.length === 0) return null;
  const text = run("footprint", pids.map(String));
  if (text === null) return null;
  const { perProcess, totalBytes } = parseFootprintOutput(text);
  const mb = (bytes: number) => Math.round((bytes / 1024 ** 2) * 10) / 10;
  const summed = [...perProcess.values()].reduce((a, b) => a + b, 0);
  return {
    processes: pids.length,
    footprintMb: perProcess.size > 0 ? mb(summed) : null,
    sharedOnceMb: totalBytes === null ? null : mb(totalBytes),
  };
}

function bundleInfo(info: ReturnType<typeof appInfo>): AppInfo {
  return {
    path: info.path,
    name: info.name,
    bundleId: info.bundleId,
    version: info.version,
    bundleMtime: info.bundleMtime,
    sizeMb: info.sizeMb,
    sizeBreakdownMb: info.sizeBreakdownMb,
  };
}

function nativeFailure(
  info: ReturnType<typeof appInfo>,
  error: string,
): NativeAppResult {
  return {
    app: bundleInfo(info),
    variant: "unknown",
    launchToReadyMs: null,
    display: null,
    memory: { afterLaunch: {}, afterIdle: {}, afterSustained: null },
    windows: {},
    warnings: [],
    error,
  };
}

/**
 * Launches the native app with -VisionPerfRun and samples its processes (the
 * Swift app, its Bun backend and PostgreSQL, found through the runtime's pid
 * files) until the app has run its scenario and quit. The app times its own
 * phases; ps samples every second are matched to those windows afterwards.
 */
async function measureNativeApp(
  ctx: Context,
  appPath: string,
): Promise<NativeAppResult> {
  const { options } = ctx;
  const info = appInfo(appPath);
  if (psSnapshot().some((row) => row.command.startsWith(info.executable))) {
    return nativeFailure(
      info,
      `${info.name} is already running; quit it and run again`,
    );
  }
  const slug = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const perfDir = path.join(ctx.outDir, slug);
  fs.mkdirSync(perfDir, { recursive: true });
  const logPath = path.join(ctx.outDir, "logs", `${slug}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.createWriteStream(logPath, { flags: "a" });

  log(`${info.name}: cooldown ${options.cooldownSeconds} s`);
  await sleep(options.cooldownSeconds * 1000);

  const args = ["-VisionPerfRun", perfDir];
  if (options.nativeIdleSeconds !== null) {
    args.push("-VisionPerfIdleSeconds", String(options.nativeIdleSeconds));
  }
  if (options.nativeSustainedSeconds !== null) {
    args.push(
      "-VisionPerfSustainedSeconds",
      String(options.nativeSustainedSeconds),
    );
  }
  const scripted =
    (options.nativeIdleSeconds ?? 30) + (options.nativeSustainedSeconds ?? 60);
  log(`${info.name}: native run (about ${scripted + 60} s)`);
  logFile.write(`\n=== launch ${new Date().toISOString()} ${args.join(" ")}\n`);
  const child = spawn(info.executable, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv(),
  });
  child.stdout?.on("data", (chunk: Buffer) => logFile.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => logFile.write(chunk));
  let exitCode: number | null | undefined;
  child.once("exit", (code) => {
    exitCode = code;
  });
  const mainPid = child.pid ?? -1;

  const samples: PsSample[] = [];
  const memory: MemorySample[] = [];
  let lastMemoryAt = 0;
  let lastPostgresPid: number | undefined;
  let error: string | null = null;
  const deadline = Date.now() + (scripted + NATIVE_RUN_SLACK_SECONDS) * 1000;
  try {
    await sleep(1000);
    run("osascript", [
      "-e",
      `tell application id "${info.bundleId}" to activate`,
    ]);
    while (exitCode === undefined) {
      const now = Date.now();
      const rows = psSnapshot();
      const roots = runtimeRoots(info.userData, mainPid);
      lastPostgresPid = roots.postgresPid ?? lastPostgresPid;
      const roles = classifyProcesses(rows, roots);
      samples.push({
        t: now,
        rows: rows.filter((row) => roles.has(row.pid)),
        roles,
      });
      if (now - lastMemoryAt >= NATIVE_MEMORY_INTERVAL_MS) {
        lastMemoryAt = now;
        const pidsOf = (role: string) =>
          [...roles].filter(([, r]) => r === role).map(([pid]) => pid);
        memory.push({
          t: now,
          backend: roleFootprint(pidsOf("backend")),
          postgres: roleFootprint(pidsOf("postgres")),
        });
      }
      if (now > deadline) {
        error = `${info.name} did not finish within ${scripted + NATIVE_RUN_SLACK_SECONDS} s`;
        child.kill("SIGTERM");
        break;
      }
      await sleep(1000);
    }
  } catch (caught) {
    // Aborted (Ctrl-C): ask the app to quit, then stop the run.
    run("osascript", ["-e", `tell application id "${info.bundleId}" to quit`]);
    throw caught;
  } finally {
    logFile.end();
  }
  // PostgreSQL stops after the app; wait so the next launch is clean.
  const pgDeadline = Date.now() + 30_000;
  while (
    lastPostgresPid !== undefined &&
    processAlive(lastPostgresPid) &&
    Date.now() < pgDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const resultsFile = path.join(perfDir, "results.json");
  if (!fs.existsSync(resultsFile)) {
    return nativeFailure(
      info,
      error ??
        `${info.name} exited (code ${exitCode}) without writing results.json; see ${logPath}`,
    );
  }
  try {
    const results = parseNativePerfResults(
      fs.readFileSync(resultsFile, "utf8"),
    );
    const summary = summarizeNativeRun({
      app: bundleInfo(info),
      results,
      samples,
      memory,
      power: (start, end) => ctx.powermetrics?.summarize(start, end) ?? null,
    });
    if (error) summary.warnings.push(error);
    if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
      summary.warnings.push(`app exited with code ${exitCode}`);
    }
    return summary;
  } catch (caught) {
    return nativeFailure(info, (caught as Error).message);
  }
}

/** The newest earlier run with Electron apps, or the one named by --compare. */
function loadElectronReference(
  options: Options,
  outDir: string,
): BaselineResults | null {
  const readRun = (dir: string): BaselineResults | null => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, "results.json"), "utf8"),
      ) as BaselineResults;
      return parsed.apps?.some((app) => app.tiers.length > 0) ? parsed : null;
    } catch {
      return null;
    }
  };
  if (
    options.compare &&
    fs.existsSync(path.join(options.compare, "results.json"))
  ) {
    return readRun(options.compare);
  }
  // A run from a linked worktree (a nightly build checkout) falls back to the Electron runs
  // recorded in the repository's other checkouts.
  const roots = options.compare
    ? [options.compare]
    : [options.outRoot, ...otherWorktreeResultRoots()];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of runNamesNewestFirst(names, path.basename(outDir))) {
      const found = readRun(path.join(root, name));
      if (found) return found;
    }
  }
  return null;
}

/**
 * The main checkout, so runs started from a linked worktree land next to the others.
 * Falls back to this checkout outside git.
 */
function mainWorktreeRoot(): string {
  const repo = path.join(import.meta.dirname, "..");
  const listing = run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  const first = listing
    ?.split("\n")
    .find((line) => line.startsWith("worktree "));
  return first ? path.resolve(first.slice("worktree ".length)) : repo;
}

/** perf-results/ of the repository's other git worktrees. */
function otherWorktreeResultRoots(): string[] {
  const repo = path.join(import.meta.dirname, "..");
  const listing = run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (!listing) return [];
  const here = path.resolve(repo);
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)))
    .filter((dir) => dir !== here)
    .map((dir) => path.join(dir, "perf-results"));
}

/**
 * One more scripted run of a native app with `sample` attached while it idles and while it
 * scrolls and switches pages: the sampled run is not measured (sampling stops threads), it
 * only names the hot frames. The app marks each phase in phase.txt.
 */
async function profileNativeApp(
  ctx: Context,
  appPath: string,
): Promise<string> {
  const { options } = ctx;
  const info = appInfo(appPath);
  const slug = `${info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-profile`;
  const dir = path.join(ctx.outDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  log(`${info.name}: profiling pass (cooldown ${options.cooldownSeconds} s)`);
  await sleep(options.cooldownSeconds * 1000);
  const args = ["-VisionPerfRun", dir];
  if (options.nativeIdleSeconds !== null) {
    args.push("-VisionPerfIdleSeconds", String(options.nativeIdleSeconds));
  }
  if (options.nativeSustainedSeconds !== null) {
    args.push(
      "-VisionPerfSustainedSeconds",
      String(options.nativeSustainedSeconds),
    );
  }
  const child = spawn(info.executable, args, {
    detached: true,
    stdio: "ignore",
    env: cleanEnv(),
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const pid = child.pid ?? -1;
  // Each sample covers about one phase of the quick run, so the hot spots are per phase.
  const plan: Record<string, number> = { idle: 8, scroll: 3, pageSwitch: 6 };
  const samplers: Promise<void>[] = [];
  const files: { phase: string; file: string }[] = [];
  let postgresPid: number | undefined;
  const deadline = Date.now() + 400_000;
  await sleep(1000);
  run("osascript", [
    "-e",
    `tell application id "${info.bundleId}" to activate`,
  ]);
  while (!exited && Date.now() < deadline) {
    postgresPid = runtimeRoots(info.userData, pid).postgresPid ?? postgresPid;
    let phase = "";
    try {
      phase = fs.readFileSync(path.join(dir, "phase.txt"), "utf8").trim();
    } catch {
      // Not started yet, or finished.
    }
    const seconds = plan[phase];
    if (seconds !== undefined) {
      delete plan[phase];
      const file = path.join(dir, `${phase}.sample.txt`);
      files.push({ phase, file });
      const sampler = spawn(
        "sample",
        [String(pid), String(seconds), "-mayDie", "-file", file],
        { stdio: "ignore" },
      );
      samplers.push(
        new Promise((resolve) => {
          sampler.once("exit", () => resolve());
          sampler.once("error", () => resolve());
        }),
      );
    }
    await sleep(200);
  }
  if (!exited) child.kill("SIGTERM");
  await Promise.all(samplers);
  const pgDeadline = Date.now() + 30_000;
  while (
    postgresPid !== undefined &&
    processAlive(postgresPid) &&
    Date.now() < pgDeadline
  ) {
    await sleep(250);
  }
  const binary = path.basename(info.executable);
  const blocks: string[] = [];
  for (const { phase, file } of files) {
    try {
      const spots = parseSampleReport(fs.readFileSync(file, "utf8"), binary);
      blocks.push(
        renderHotSpots(
          `${info.name} hot spots: ${phase} (sampled, ${path.basename(file)})`,
          spots,
        ),
      );
    } catch (caught) {
      blocks.push(
        `#### ${info.name} hot spots: ${phase}\n\nNo sample: ${(caught as Error).message}\n`,
      );
    }
  }
  if (blocks.length === 0)
    blocks.push(
      `#### ${info.name} hot spots\n\nThe profiling pass saw no phase.\n`,
    );
  return blocks.join("\n");
}

// ── Leak check ───────────────────────────────────────────────────────────────

const LEAK_SAMPLE_SECONDS = 30;
const LEAK_WARMUP_SECONDS = 600;
const LEAK_COLUMNS = [
  "backend_mb",
  "postgres_mb",
  "backend_sum_mb",
  "postgres_sum_mb",
  "postgres_processes",
  "app_total_sum_mb",
  "main_mb",
  "renderer_mb",
  "gpu_mb",
];
/** Columns the verdict covers; renderer and GPU are recorded for phase E. */
const LEAK_VERDICT_COLUMNS = [
  "backend_mb",
  "postgres_mb",
  "backend_sum_mb",
  "postgres_sum_mb",
  "renderer_mb",
  "gpu_mb",
];

function leakValues(app: RunningApp): Record<string, number | null> {
  const memory = memorySnapshot(app);
  return {
    backend_mb: memory.backend?.sharedOnceMb ?? null,
    postgres_mb: memory.postgres?.sharedOnceMb ?? null,
    backend_sum_mb: memory.backend?.footprintMb ?? null,
    postgres_sum_mb: memory.postgres?.footprintMb ?? null,
    postgres_processes: memory.postgres?.processes ?? null,
    app_total_sum_mb: memory.appTotal?.footprintMb ?? null,
    main_mb: memory.main?.footprintMb ?? null,
    renderer_mb: memory.renderer?.footprintMb ?? null,
    gpu_mb: memory.gpu?.footprintMb ?? null,
  };
}

/** One active step: the sustained run's scroll and page-switch cycle. */
async function leakActiveStep(ctx: Context, app: RunningApp): Promise<void> {
  await navigate(app, "/transactions");
  try {
    await scrollLedger(app, Math.min(ctx.options.scrollPx, 6000));
  } catch {
    await sleep(2000);
  }
  for (const target of ctx.options.pages
    .filter((p) => p !== "/transactions")
    .slice(0, 3)) {
    await navigate(app, target);
  }
}

async function measureLeak(
  ctx: Context,
  appPath: string,
  minutes: number,
): Promise<LeakResult> {
  const info = appInfo(appPath);
  const windowSeconds = ctx.options.leakWindowSeconds;
  const result: LeakResult = {
    app: info.name,
    version: info.version,
    minutes,
    windowSeconds,
    warmupSeconds: LEAK_WARMUP_SECONDS,
    sampleSeconds: LEAK_SAMPLE_SECONDS,
    columns: LEAK_COLUMNS,
    samples: [],
    verdicts: [],
    error: null,
  };
  if (psSnapshot().some((row) => row.command.startsWith(info.executable))) {
    result.error = `${info.name} is already running; quit it and run again`;
    return result;
  }
  const slug = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const logPath = path.join(ctx.outDir, "logs", `${slug}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let running: RunningApp | undefined;
  try {
    log(`${info.name}: leak check, ${minutes} min`);
    running = await launchApp(info, logPath);
    await sleep(10_000);
    const app = running;
    const start = Date.now();
    const end = start + minutes * 60_000;
    let nextSample = start;
    const sample = (cycle: number, phase: LeakPhase) => {
      result.samples.push({
        t: Math.round((Date.now() - start) / 1000),
        cycle,
        phase,
        values: leakValues(app),
      });
      // A slow active step must not queue a burst of catch-up samples.
      nextSample = Math.max(
        nextSample + LEAK_SAMPLE_SECONDS * 1000,
        Date.now() + 1000,
      );
    };
    for (let cycle = 1; Date.now() < end; cycle += 1) {
      for (const phase of ["active", "idle"] as const) {
        const windowEnd = Math.min(end, Date.now() + windowSeconds * 1000);
        log(`  cycle ${cycle} ${phase}`);
        if (phase === "idle") await navigate(app, "/");
        while (Date.now() < windowEnd) {
          checkAborted();
          if (Date.now() >= nextSample) sample(cycle, phase);
          if (phase === "active") await leakActiveStep(ctx, app);
          else
            await sleep(
              Math.max(0, Math.min(nextSample, windowEnd) - Date.now()),
            );
        }
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    if (running) await quitApp(running);
  }
  result.verdicts = LEAK_VERDICT_COLUMNS.map((column) =>
    analyzeLeak(result.samples, column, LEAK_WARMUP_SECONDS),
  );
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function machineInfo(): Record<string, string | number | null> {
  const battery = run("pmset", ["-g", "batt"]) ?? "";
  return {
    model: run("sysctl", ["-n", "hw.model"]),
    chip: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    memoryGb: Math.round(
      Number(run("sysctl", ["-n", "hw.memsize"]) ?? 0) / 1024 ** 3,
    ),
    macos: run("sw_vers", ["-productVersion"]),
    powerSource: /'(.+?)'/.exec(battery)?.[1] ?? null,
    battery: /(\d+)%/.exec(battery)?.[1] ?? null,
    lowPowerMode:
      /lowpowermode\s+(\d)/.exec(run("pmset", ["-g"]) ?? "")?.[1] ?? null,
    loadAverage1m: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    topProcessesAtStart: (run("ps", ["-Ao", "pcpu=,comm=", "-r"]) ?? "")
      .split("\n")
      .slice(0, 6)
      .map((line) => line.trim())
      .join(" | "),
  };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    return 0;
  }
  if (process.platform !== "darwin") {
    console.error("mac-baseline runs on macOS only.");
    return 1;
  }
  if (options.apps.length === 0 && options.nativeApps.length === 0) {
    console.error(
      options.compare !== null || process.argv.includes("--native")
        ? "No Vision Native app found. Install it (apps/native, install-native.sh) or pass --native-app."
        : "No Vision app found. Install it (./install.sh, ./install-demo.sh) or pass --app.",
    );
    return 1;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(options.outRoot, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  log(`Results: ${outDir}`);
  log(
    "Keep the Vision window in front and leave the Mac alone until the run ends.",
  );

  process.on("SIGINT", () => {
    if (abort.signal.aborted) process.exit(130);
    log(
      "Stopping: restoring settings and quitting the app (Ctrl-C again to force).",
    );
    abort.abort();
  });

  // Keep the display and system awake for the run.
  const caffeinate = spawn(
    "caffeinate",
    ["-dimsu", "-w", String(process.pid)],
    { stdio: "ignore" },
  );
  caffeinate.unref();

  if (options.leakMinutes !== null) {
    const appPath = options.apps[0] as string;
    const leak = await measureLeak(
      { options, powermetrics: null, outDir },
      appPath,
      options.leakMinutes,
    );
    fs.writeFileSync(
      path.join(outDir, "leak.json"),
      `${JSON.stringify({ machine: machineInfo(), ...leak }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outDir, "leak.csv"),
      leakCsv(leak.samples, leak.columns),
    );
    fs.writeFileSync(path.join(outDir, "leak.md"), renderLeakSummary(leak));
    caffeinate.kill();
    log(`Done. Summary: ${path.join(outDir, "leak.md")}`);
    return leak.error ? 1 : 0;
  }

  const warnings: string[] = [];
  const machine = machineInfo();
  // Background work (Spotlight, Shortcuts, updates) skews whole-machine power.
  const busy = (run("ps", ["-Ao", "pcpu=,comm=", "-r"]) ?? "")
    .split("\n")
    .map((line) => /^\s*([\d.]+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => Number(match[1]) >= 25 && !/Vision/.test(match[2] ?? ""))
    .map((match) => `${path.basename(match[2] ?? "")} ${match[1]}%`);
  if (busy.length > 0) {
    warnings.push(
      `busy processes at start (whole-machine GPU/power numbers include them): ${busy.join(", ")}`,
    );
  }
  let recorder: PowermetricsRecorder | null = null;
  if (options.powermetrics) {
    log("sudo is needed once for powermetrics:");
    try {
      execFileSync("sudo", ["-v"], { stdio: "inherit" });
      recorder = new PowermetricsRecorder(
        path.join(outDir, "powermetrics.jsonl"),
      );
      recorder.start();
      await sleep(3000);
      if (!recorder.running || recorder.samples.length === 0) {
        warnings.push(
          `powermetrics produced no samples: ${recorder.status().stderr || "no output"}`,
        );
      }
    } catch (error) {
      warnings.push(`powermetrics unavailable: ${(error as Error).message}`);
      recorder = null;
    }
  }

  const ollamaPs = run("ollama", ["ps"]);
  const startRows = psSnapshot();
  const ollamaRoles = classifyProcesses(startRows, { mainPid: -1 });
  const ollamaMemory = summarizeRoles(startRows, ollamaRoles, {
    footprints: footprints(),
  });

  const results: BaselineResults = {
    schemaVersion: 3,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    options: {
      tiers: options.tiers,
      fullEffects: options.fullEffects.map((on) => (on ? "on" : "off")),
      repeat: options.repeat,
      idleSeconds: options.idleSeconds,
      sustainedSeconds: options.sustainedSeconds,
      cooldownSeconds: options.cooldownSeconds,
      scrollPx: options.scrollPx,
      pages: options.pages,
      powermetrics: options.powermetrics,
      trace: options.trace,
      quick: options.quick,
      native: options.nativeApps.length > 0,
    },
    machine,
    repoHead: run("git", [
      "-C",
      path.join(import.meta.dirname, ".."),
      "rev-parse",
      "--short",
      "HEAD",
    ]),
    powermetrics: {
      enabled: recorder !== null,
      samples: 0,
      parseErrors: 0,
      keysSeen: [],
      stderr: "",
    },
    ollama: {
      ps: ollamaPs,
      memory: ollamaMemory.ollama ? { ollama: ollamaMemory.ollama } : null,
    },
    apps: [],
    warnings,
  };

  const ctx: Context = { options, powermetrics: recorder, outDir };
  const nativeResults: NativeAppResult[] = [];
  const hotSpots: Record<string, string> = {};
  try {
    for (const appPath of options.apps) {
      if (abort.signal.aborted) break;
      results.apps.push(await measureApp(ctx, appPath));
    }
    for (const appPath of options.nativeApps) {
      if (abort.signal.aborted) break;
      nativeResults.push(await measureNativeApp(ctx, appPath));
    }
    if (options.profile) {
      for (const appPath of options.nativeApps) {
        if (abort.signal.aborted) break;
        hotSpots[appInfo(appPath).name] = await profileNativeApp(ctx, appPath);
      }
    }
  } finally {
    await recorder?.stop();
    if (recorder)
      results.powermetrics = { enabled: true, ...recorder.status() };
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(outDir, "results.json"),
      `${JSON.stringify({ ...results, native: nativeResults }, null, 2)}\n`,
    );
    const parts: string[] = [];
    if (results.apps.length > 0) {
      parts.push(renderSummary(results));
    } else {
      parts.push(
        `# Vision Mac performance baseline\n\nRun ${results.startedAt} → ${results.finishedAt}. ${machine.model ?? "Mac"}, ${machine.chip ?? "?"}, ${machine.memoryGb} GB, macOS ${machine.macos ?? "?"}. Power: ${machine.powerSource ?? "?"}. Low Power Mode: ${machine.lowPowerMode ?? "?"}. Repo HEAD ${results.repoHead ?? "?"}.\n`,
      );
    }
    if (options.nativeApps.length > 0) {
      parts.push(
        renderNativeSection(
          nativeResults,
          // This run's Electron apps when it measured any, else the newest earlier run.
          results.apps.some((app) => app.tiers.length > 0)
            ? results
            : loadElectronReference(options, outDir),
          results.apps.length > 0 ? [] : results.warnings,
          hotSpots,
        ),
      );
    }
    fs.writeFileSync(path.join(outDir, "summary.md"), parts.join("\n"));
    caffeinate.kill();
  }
  log(`Done. Summary: ${path.join(outDir, "summary.md")}`);
  return results.apps.some((app) => app.error || !app.restored) ||
    nativeResults.some((native) => native.error)
    ? 1
    : 0;
}

if (isEntrypoint(import.meta)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}

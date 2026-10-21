#!/usr/bin/env bun
/**
 * Mac performance baseline for the installed Vision apps (Mac optimisation
 * plan, phase 0). Run it in your own Terminal on the Mac; see
 * docs/performance/mac-baseline.md.
 *
 * It launches each app with Chromium's --remote-debugging-port switch (a launch
 * argument only: normal launches, fuses, sandbox and CSP are unchanged), drives
 * scripted scrolls and page switches over the DevTools protocol, and records
 * one `sudo powermetrics` stream for the whole run. Each UI tier is set through
 * the app's own settings API, measured after a fresh launch, and the original
 * setting is restored at the end.
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
  classifyProcesses,
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
import { isEntrypoint } from "./lib/isEntrypoint.ts";

const TIERS: readonly Tier[] = ["reduced", "standard", "enhanced"];
const DEFAULT_APPS = [
  "/Applications/Vision Demo.app",
  "/Applications/Vision.app",
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
  --idle <s>            Idle window per tier (default 60)
  --sustained <s>       Sustained scroll/switch run per tier (default 300)
  --cooldown <s>        Wait with the app closed before each measured launch (default 60)
  --scroll-px <px>      Ledger scroll distance each way (default 15000)
  --pages <list>        Page-switch sequence (default ${DEFAULT_PAGES.join(",")})
  --out <dir>           Results root (default perf-results/ in the checkout)
  --no-powermetrics     Skip sudo powermetrics (no GPU or power numbers)
  --no-trace            Skip the Chromium trace pass
  --quick               Smoke run: idle 10, sustained 30, cooldown 5, scroll 4000
  --help                This text
`;

interface Options {
  apps: string[];
  tiers: Tier[];
  idleSeconds: number;
  sustainedSeconds: number;
  cooldownSeconds: number;
  scrollPx: number;
  pages: string[];
  outRoot: string;
  powermetrics: boolean;
  trace: boolean;
  quick: boolean;
}

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: "string", multiple: true },
      tiers: { type: "string" },
      idle: { type: "string" },
      sustained: { type: "string" },
      cooldown: { type: "string" },
      "scroll-px": { type: "string" },
      pages: { type: "string" },
      out: { type: "string" },
      "no-powermetrics": { type: "boolean" },
      "no-trace": { type: "boolean" },
      quick: { type: "boolean" },
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
  const apps = values.app ?? DEFAULT_APPS.filter((app) => fs.existsSync(app));
  return {
    apps: apps.map((app) => path.resolve(app)),
    tiers: tiers as Tier[],
    idleSeconds: number(values.idle, quick ? 10 : 60, "idle"),
    sustainedSeconds: number(values.sustained, quick ? 30 : 300, "sustained"),
    cooldownSeconds: number(values.cooldown, quick ? 5 : 60, "cooldown"),
    scrollPx: number(values["scroll-px"], quick ? 4000 : 15_000, "scroll-px"),
    pages: values.pages
      ? values.pages.split(",").map((page) => page.trim())
      : DEFAULT_PAGES,
    outRoot: path.resolve(
      values.out ?? path.join(import.meta.dirname, "..", "perf-results"),
    ),
    powermetrics: values["no-powermetrics"] !== true,
    trace: values["no-trace"] !== true,
    quick,
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

async function writeTier(origin: string, tier: Tier): Promise<void> {
  const current = await readSettings(origin);
  const value = {
    ...(current.value as Record<string, unknown>),
    visualEffects: tier,
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

function memorySnapshot(app: RunningApp): RoleSummary {
  const rows = psSnapshot();
  const roles = classifyProcesses(
    rows,
    runtimeRoots(app.info.userData, app.mainPid),
  );
  return summarizeRoles(rows, roles, { footprints: footprints() });
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

async function measureTier(
  ctx: Context,
  app: RunningApp,
  tier: Tier,
  label: string,
): Promise<TierResult> {
  const warnings: string[] = [];
  const { options } = ctx;
  log(`  launched in ${app.launch.spawnToRendererReadyMs} ms; settling 10 s`);
  await sleep(10_000);
  const state = await page<PageState>(app, PAGE_STATE);
  const effective = effectiveTier(state.classes);
  if (effective !== tier) {
    warnings.push(
      `effective tier is ${effective}, not ${tier} (auto-adapt for a large display?)`,
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
    for (const tier of ctx.options.tiers) {
      await writeTier(running.origin, tier);
      dirty = true;
      await quitApp(running);
      running = undefined;
      log(`${info.name} ${tier}: cooldown ${ctx.options.cooldownSeconds} s`);
      await sleep(ctx.options.cooldownSeconds * 1000);
      running = await launchApp(info, logPath);
      result.tiers.push(
        await measureTier(ctx, running, tier, `${slug}-${tier}`),
      );
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
  if (options.apps.length === 0) {
    console.error(
      "No Vision app found. Install it (./install.sh, ./install-demo.sh) or pass --app.",
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
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    options: {
      tiers: options.tiers,
      idleSeconds: options.idleSeconds,
      sustainedSeconds: options.sustainedSeconds,
      cooldownSeconds: options.cooldownSeconds,
      scrollPx: options.scrollPx,
      pages: options.pages,
      powermetrics: options.powermetrics,
      trace: options.trace,
      quick: options.quick,
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
  try {
    for (const appPath of options.apps) {
      if (abort.signal.aborted) break;
      results.apps.push(await measureApp(ctx, appPath));
    }
  } finally {
    await recorder?.stop();
    if (recorder)
      results.powermetrics = { enabled: true, ...recorder.status() };
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(outDir, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(outDir, "summary.md"), renderSummary(results));
    caffeinate.kill();
  }
  log(`Done. Summary: ${path.join(outDir, "summary.md")}`);
  return results.apps.some((app) => app.error || !app.restored) ? 1 : 0;
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

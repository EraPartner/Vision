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
 *
 * --variant <name>=<file> adds an experiment axis next to the tier and Full
 * effects switch: after each launch the runner sets
 * document.documentElement.dataset.fxVariant and injects the .css (a <style>
 * element) or runs the .js over the DevTools protocol, so a CSS or script idea
 * can be measured against an unmodified "base" run in the same repeat loop.
 * Ready-made variants live in scripts/mac-baseline-variants/. Every idle
 * window also reports presented frames per second (from a short Chromium
 * trace, since requestAnimationFrame runs whether or not frames are composited)
 * and a census of backdrop-filter surfaces.
 *
 * --segment adds opt-in segments after the ledger scroll (and to the traced
 * pass): window-scroll scrolls the document on / and /statistics, chat-stream
 * streams a mocked AI answer through the chat page (a page-side fetch shim; no
 * Ollama, nothing stored). Each app's chrome://gpu readout (SystemInfo) is
 * recorded once per run, and --chromium-switch passes extra launch switches
 * next to --remote-debugging-port for A/B runs such as Graphite vs Ganesh.
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
  type ChatStreamMeasurement,
  type AppResult,
  type BaselineResults,
  type LaunchTiming,
  type PageSwitch,
  type Tier,
  type TierResult,
  type WindowMeasurement,
  type WindowScrollMeasurement,
} from "./lib/mac-baseline/report.ts";
import { summarizeGpuInfo, type GpuInfo } from "./lib/mac-baseline/gpuInfo.ts";
import {
  CHAT_MOCK_DONE,
  CHAT_MOCK_STATE,
  CHAT_RENDERED,
  CHAT_STREAM_PAGE,
  CHAT_STREAM_TOKENS,
  CHAT_STREAM_TOKENS_PER_SECOND,
  CLICK_CHAT_SEND,
  FIND_WINDOW_SCROLLER,
  FOCUS_CHAT_COMPOSER,
  RESTORE_CHAT_MOCK,
  WINDOW_SCROLL_MAX_PX,
  WINDOW_SCROLL_PAGES,
  chatStreamMockExpression,
  parseSegments,
  type ChatMockState,
  type ExtraSegment,
} from "./lib/mac-baseline/segments.ts";
import {
  MARK_PREFIX,
  TRACED_PASS_CATEGORIES,
  TRACE_CATEGORIES,
  findSegments,
  presentedFps,
  summarizeTrace,
  type TraceEvent,
} from "./lib/mac-baseline/trace.ts";
import {
  BASE_VARIANT,
  GLASS_CENSUS,
  cssInjectionExpression,
  jsInjectionExpression,
  loadVariants,
  type GlassCensus,
  type Variant,
  type VariantInjection,
} from "./lib/mac-baseline/variants.ts";
import {
  RUNNING_ANIMATIONS,
  recordRequests,
  summarizeAnimations,
  summarizeRequests,
  type AnimationSample,
  type AnimationSeen,
} from "./lib/mac-baseline/launchProbe.ts";
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

const VARIANTS_DIR = path.join(import.meta.dirname, "mac-baseline-variants");

const USAGE = `Usage: bun scripts/mac-baseline.ts [options]

  --app <path>          App bundle to measure; repeat for several
                        (default: ${DEFAULT_APPS.join(", ")} when present)
  --tiers <list>        Comma list of reduced,standard,enhanced (default: all)
  --full-effects <list> Comma list of off,on for the "Full effects" switch
                        (default: off)
  --repeat <n>          Measure every tier/switch combination n times, each
                        from a fresh launch, and report median and min–max
                        (default 1)
  --variant <name>=<file>
                        Also measure an experiment: after launch the runner sets
                        <html data-fx-variant="<name>"> and injects the file
                        (.css: appended as <style id="mac-baseline-variant">;
                        .js: evaluated), then waits 1 s. Repeatable. Name:
                        [a-z0-9-]+. A relative file is looked up in the working
                        directory, then in scripts/mac-baseline-variants/. An
                        implicit "base" variant (no injection) is always
                        measured; variants are one more axis inside the repeat
                        loop (tier, Full effects, variant), labelled like
                        standard/full-on/drift-20 in the log
  --variants-only-idle  Run only the idle phase (plus fps and glass census) for
                        variant runs; base runs keep every phase. Makes variant
                        sweeps cheap (about 2 min each)
  --idle-trace          Record the 10 s idle trace (presented fps) even with
                        --no-trace. Without --no-trace it is on anyway
  --idle <s>            Idle window per tier (default 60)
  --sustained <s>       Sustained scroll/switch run per tier (default 300)
  --cooldown <s>        Wait with the app closed before each measured launch (default 60)
  --scroll-px <px>      Ledger scroll distance each way (default 15000)
  --segment <list>      Opt-in segments, comma list or repeated (default: none,
                        so the default run is unchanged). They run after the
                        ledger scroll and in the traced pass, and are skipped
                        for variant runs with --variants-only-idle:
                          window-scroll  scroll the document (window scroller)
                                         on ${WINDOW_SCROLL_PAGES.join(" and ")}, ${WINDOW_SCROLL_MAX_PX} px each
                                         way at 1500 px/s (capped by
                                         --scroll-px); about 20 s
                          chat-stream    open ${CHAT_STREAM_PAGE}, send one message and
                                         stream a mocked answer of
                                         ${CHAT_STREAM_TOKENS} tokens at ${CHAT_STREAM_TOKENS_PER_SECOND}/s through the
                                         real chat page and aiChatStreamStore;
                                         a page-side fetch shim answers the
                                         /api/ai/ calls, so no Ollama is used
                                         and nothing is stored; about 20 s
  --chromium-switch=<switch>
                        Extra Chromium/Electron launch switch, appended after
                        --remote-debugging-port on every launch and recorded in
                        results.json. Repeatable. Use the = form for values that
                        start with a dash, e.g.
                        --chromium-switch=--disable-features=SkiaGraphite
  --pages <list>        Page-switch sequence (default ${DEFAULT_PAGES.join(",")})
  --out <dir>           Results root (default perf-results/ in the checkout)
  --no-powermetrics     Skip sudo powermetrics (no GPU or power numbers)
  --no-trace            Skip the Chromium trace pass and the idle fps trace
                        (--idle-trace keeps just the 10 s idle one)
  --launch-probe <s>    Before the settle, record running page animations (every
                        5 s), page requests, and per-process CPU/GPU for the first
                        <s> seconds after launch, without input; writes
                        launch-probe/<label>.json with the backend log tail.
                        A diagnostic: it delays the idle window, so leave it off
                        for before/after runs (default 0 = off)
  --background <s>      After the idle window, make Finder frontmost and measure
                        the same page for <s> seconds while Vision is in the
                        background (default 0 = off)
  --quick               Smoke run: idle 10, sustained 30, cooldown 5, scroll 4000
  --leak <min>          Leak check instead of the tier matrix: one launch of the
                        first app at its current tier, alternating active and
                        idle windows for <min> minutes (45 is enough for a
                        verdict); writes leak.md, leak.csv and leak.json
  --leak-window <s>     Length of each active and each idle window (default 300)
  --help                This text
`;

export interface Options {
  apps: string[];
  tiers: Tier[];
  fullEffects: boolean[];
  /** Always starts with the implicit base variant. */
  variants: Variant[];
  variantsOnlyIdle: boolean;
  /** Record the 10 s idle trace that yields presented fps. */
  idleTrace: boolean;
  repeat: number;
  idleSeconds: number;
  sustainedSeconds: number;
  cooldownSeconds: number;
  scrollPx: number;
  /** --segment: opt-in segments, in run order. */
  segments: ExtraSegment[];
  /** --chromium-switch: extra launch switches. */
  chromiumSwitches: string[];
  pages: string[];
  outRoot: string;
  powermetrics: boolean;
  trace: boolean;
  launchProbeSeconds: number;
  backgroundSeconds: number;
  quick: boolean;
  leakMinutes: number | null;
  leakWindowSeconds: number;
}

export function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: "string", multiple: true },
      tiers: { type: "string" },
      "full-effects": { type: "string" },
      variant: { type: "string", multiple: true },
      "variants-only-idle": { type: "boolean" },
      "idle-trace": { type: "boolean" },
      repeat: { type: "string" },
      idle: { type: "string" },
      sustained: { type: "string" },
      cooldown: { type: "string" },
      "scroll-px": { type: "string" },
      segment: { type: "string", multiple: true },
      "chromium-switch": { type: "string", multiple: true },
      pages: { type: "string" },
      out: { type: "string" },
      "no-powermetrics": { type: "boolean" },
      "no-trace": { type: "boolean" },
      "launch-probe": { type: "string" },
      background: { type: "string" },
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
  const apps = values.app ?? DEFAULT_APPS.filter((app) => fs.existsSync(app));
  const chromiumSwitches = (values["chromium-switch"] ?? []).map((value) =>
    value.trim(),
  );
  for (const value of chromiumSwitches) {
    if (!/^--[a-z0-9]/i.test(value))
      throw new Error(
        `--chromium-switch takes a switch like --disable-features=X, not "${value}" (write --chromium-switch=--name for dash values)`,
      );
    if (/^--remote-debugging-/.test(value))
      throw new Error("--chromium-switch cannot change the remote debugging switches");
  }
  return {
    apps: apps.map((app) => path.resolve(app)),
    tiers: tiers as Tier[],
    fullEffects: [...new Set(fullEffects)],
    variants: loadVariants(values.variant ?? [], VARIANTS_DIR),
    variantsOnlyIdle: values["variants-only-idle"] === true,
    idleTrace: values["no-trace"] !== true || values["idle-trace"] === true,
    repeat,
    idleSeconds: number(values.idle, quick ? 10 : 60, "idle"),
    sustainedSeconds: number(values.sustained, quick ? 30 : 300, "sustained"),
    cooldownSeconds: number(values.cooldown, quick ? 5 : 60, "cooldown"),
    scrollPx: number(values["scroll-px"], quick ? 4000 : 15_000, "scroll-px"),
    segments: parseSegments(values.segment ?? []),
    chromiumSwitches,
    pages: values.pages
      ? values.pages.split(",").map((page) => page.trim())
      : DEFAULT_PAGES,
    outRoot: path.resolve(
      values.out ?? path.join(import.meta.dirname, "..", "perf-results"),
    ),
    powermetrics: values["no-powermetrics"] !== true,
    trace: values["no-trace"] !== true,
    launchProbeSeconds: number(values["launch-probe"], 0, "launch-probe"),
    backgroundSeconds: number(values.background, 0, "background"),
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
  chromiumSwitches: readonly string[],
): Promise<RunningApp> {
  checkAborted();
  const port = await freePort();
  const logFile = fs.createWriteStream(logPath, { flags: "a" });
  const args = [`--remote-debugging-port=${port}`, ...chromiumSwitches];
  logFile.write(
    `\n=== launch ${new Date().toISOString()} port ${port} args ${args.join(" ")}\n`,
  );
  const started = performance.now();
  // detached: Ctrl-C in the terminal must not kill the app before the tier
  // setting is restored.
  const child = spawn(info.executable, args, {
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
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
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
    child.stdout.on("data", (chunk: Buffer) => logFile.write(chunk));
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
    // An explicit choice: since ADR-255 a missing or false value means
    // "auto", which is on for the standard tier.
    fullEffects: fullEffects ? "on" : "off",
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
  return el
    ? { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, rows: el.querySelectorAll("[data-index]").length }
    : null;
})()`;

interface ScrollerState {
  scrollTop: number;
  scrollHeight: number;
  rows: number;
}

interface ScrollOutcome {
  method: string;
  reachedScrollTop: number;
  rowsRendered: number;
  scrollHeight: number;
}

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
  const { method, reachedScrollTop, rowsRendered } = await scrollDownAndUp(
    app,
    FIND_SCROLLER,
    "No scrollable ledger on /transactions (empty ledger?)",
    distance,
    speed,
  );
  return { method, reachedScrollTop, rowsRendered };
}

/** Scroll the document (AppLayout's window scroller) down then back up. */
async function scrollWindow(
  app: RunningApp,
  distance: number,
  speed = 1500,
): Promise<ScrollOutcome> {
  return scrollDownAndUp(
    app,
    FIND_WINDOW_SCROLLER,
    "The page does not scroll (content shorter than the window?)",
    distance,
    speed,
  );
}

function windowScrollPx(options: Options): number {
  return Math.min(options.scrollPx, WINDOW_SCROLL_MAX_PX);
}

/** Scroll the element `find` picks down by `distance` and back up. */
async function scrollDownAndUp(
  app: RunningApp,
  find: string,
  missing: string,
  distance: number,
  speed: number,
): Promise<ScrollOutcome> {
  const target = await page<{ x: number; y: number } | null>(app, find);
  if (!target) throw new Error(missing);
  let method = "gesture";
  let reached = 0;
  let rows = 0;
  let height = 0;
  for (const direction of [-1, 1]) {
    const before = await page<ScrollerState>(app, SCROLLER_STATE);
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
    const afterGesture = await page<ScrollerState>(app, SCROLLER_STATE);
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
    const after = await page<ScrollerState>(app, SCROLLER_STATE);
    if (direction === -1) {
      reached = after.scrollTop;
      rows = after.rows;
      height = after.scrollHeight;
    }
  }
  return {
    method,
    reachedScrollTop: reached,
    rowsRendered: rows,
    scrollHeight: height,
  };
}

/**
 * Install the chat mock, open the chat page, type a message into the composer
 * and run `body` (the send and stream), restoring the real fetch even when it
 * fails. See chatStreamMockExpression in segments.ts.
 */
async function withChatComposer<T>(
  app: RunningApp,
  body: () => Promise<T>,
): Promise<T> {
  await page(app, chatStreamMockExpression());
  try {
    await navigate(app, CHAT_STREAM_PAGE);
    await sleep(1500);
    const ready = await page<boolean>(app, FOCUS_CHAT_COMPOSER, 30_000);
    if (!ready)
      throw new Error(
        `no enabled chat composer on ${CHAT_STREAM_PAGE} within 15 s (AI chat off in this build?)`,
      );
    await app.cdp.send(
      "Input.insertText",
      { text: "mac-baseline streaming segment" },
      app.sessionId,
    );
    await sleep(500);
    return await body();
  } finally {
    await page(app, RESTORE_CHAT_MOCK).catch(() => undefined);
  }
}

/** Send the typed message and wait for the mocked stream to finish. */
async function sendChat(
  app: RunningApp,
): Promise<Omit<ChatStreamMeasurement, keyof ActionMeasurement>> {
  let method = "enter";
  for (const type of ["rawKeyDown", "keyUp"]) {
    await app.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      },
      app.sessionId,
    );
  }
  const streaming = async () => {
    for (let poll = 0; poll < 15; poll += 1) {
      if ((await page<ChatMockState>(app, CHAT_MOCK_STATE)).streams > 0)
        return true;
      await sleep(200);
    }
    return false;
  };
  if (!(await streaming())) {
    method = "button";
    if (!(await page<boolean>(app, CLICK_CHAT_SEND)))
      throw new Error("the chat composer did not send (no send button)");
  }
  const streamSeconds = CHAT_STREAM_TOKENS / CHAT_STREAM_TOKENS_PER_SECOND;
  const { completed } = await page<{ completed: boolean }>(
    app,
    CHAT_MOCK_DONE,
    streamSeconds * 1000 + 30_000,
  );
  // Let the terminal event's cache merge and re-render land in the window.
  await sleep(1000);
  const state = await page<ChatMockState>(app, CHAT_MOCK_STATE);
  if (state.streams === 0)
    throw new Error("the chat page sent no stream request to the mock");
  return {
    tokens: CHAT_STREAM_TOKENS,
    tokensPerSecond: CHAT_STREAM_TOKENS_PER_SECOND,
    tokensSent: state.tokensSent,
    streamMs: state.streamMs,
    method,
    completed,
    rendered: await page<boolean>(app, CHAT_RENDERED),
    passedThrough: state.passedThrough,
  };
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

// Counts resource requests the page starts (fetches included) from the
// moment it is installed; read twice to get the requests inside a window.
const REQUEST_COUNTER = `(() => {
  if (window.__visionBaselineRequests === undefined) {
    window.__visionBaselineRequests = 0;
    new PerformanceObserver((list) => {
      window.__visionBaselineRequests += list.getEntries().length;
    }).observe({ type: "resource" });
  }
  return window.__visionBaselineRequests;
})()`;

function osascript(script: string): void {
  run("osascript", ["-e", script]);
}

/** A quiet window with renderer work and page requests alongside CPU/power. */
async function measureQuietWindow(
  ctx: Context,
  app: RunningApp,
  seconds: number,
  body: () => Promise<void> = () => sleep(seconds * 1000),
): Promise<
  WindowMeasurement & { pageMetrics: Record<string, number>; requests: number }
> {
  const requestsBefore = await page<number>(app, REQUEST_COUNTER);
  const metricsBefore = await pageMetrics(app);
  const { window } = await measureWindow(ctx, app, body);
  const metricsAfter = await pageMetrics(app);
  const requestsAfter = await page<number>(app, REQUEST_COUNTER);
  return {
    ...window,
    pageMetrics: metricsDelta(metricsBefore, metricsAfter),
    requests: requestsAfter - requestsBefore,
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
  warnings: string[],
): Promise<TierResult["trace"]> {
  const mark = (name: string) =>
    page(app, `console.timeStamp(${JSON.stringify(`${MARK_PREFIX}${name}`)})`);
  const { segments: extra } = ctx.options;
  await app.cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      traceBufferSizeInKb: 300 * 1024,
      includedCategories: TRACED_PASS_CATEGORIES,
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
    if (extra.includes("window-scroll")) {
      for (const target of WINDOW_SCROLL_PAGES) {
        try {
          await navigate(app, target);
          await sleep(1500);
          await mark(`window-scroll:${target}:start`);
          await scrollWindow(app, windowScrollPx(ctx.options));
          await mark(`window-scroll:${target}:end`);
        } catch (error) {
          if (abort.signal.aborted) throw error;
          warnings.push(
            `traced window scroll on ${target} skipped: ${(error as Error).message}`,
          );
        }
      }
    }
    if (extra.includes("chat-stream")) {
      try {
        await withChatComposer(app, async () => {
          await mark("chat-stream:start");
          await sendChat(app);
          await mark("chat-stream:end");
        });
      } catch (error) {
        if (abort.signal.aborted) throw error;
        warnings.push(`traced chat stream skipped: ${(error as Error).message}`);
      }
    }
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

/**
 * Presented frames per second over a short Chromium trace. Counting
 * requestAnimationFrame callbacks would be wrong: they run whether or not the
 * compositor presents a frame. Tracing perturbs CPU slightly, so this runs in
 * the tail of the idle window.
 */
async function idleFpsTrace(
  ctx: Context,
  app: RunningApp,
  label: string,
  seconds: number,
): Promise<TierResult["idleFps"]> {
  const mark = (name: string) =>
    page(app, `console.timeStamp(${JSON.stringify(`${MARK_PREFIX}${name}`)})`);
  await app.cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      traceBufferSizeInKb: 100 * 1024,
      includedCategories: TRACE_CATEGORIES,
    },
  });
  let text: string | undefined;
  try {
    await mark("idle-fps:start");
    await sleep(seconds * 1000);
    await mark("idle-fps:end");
  } finally {
    const complete = app.cdp.waitForEvent("Tracing.tracingComplete", 120_000);
    await app.cdp.send("Tracing.end");
    const stream = (await complete).params.stream;
    if (typeof stream === "string") text = await readStream(app.cdp, stream);
  }
  if (text === undefined) return null;
  const file = path.join(ctx.outDir, "traces", `${label}-idle.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(text));
  const parsed = JSON.parse(text) as
    { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  const window = findSegments(events).get("idle-fps");
  if (!window) return null;
  return presentedFps(summarizeTrace(events, window));
}

/** Tag <html> with the variant and inject its file; base injects nothing. */
async function injectVariant(
  app: RunningApp,
  variant: Variant,
  warnings: string[],
): Promise<void> {
  if (variant.kind === "none") return;
  const injection = await page<VariantInjection>(
    app,
    variant.kind === "css"
      ? cssInjectionExpression(variant)
      : jsInjectionExpression(variant),
  );
  if (variant.kind === "js") await page(app, variant.content, 30_000);
  if (!injection.applied) {
    warnings.push(`variant ${variant.name} was not applied (stylesheet rejected)`);
  } else if (injection.method === "adopted") {
    warnings.push(
      `variant ${variant.name}: the <style> element had no sheet (CSP?); used a constructed stylesheet`,
    );
  }
  await sleep(1000);
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
  return fs.readFileSync(newest.file, "utf8").trimEnd().split("\n").slice(-lines);
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
      await sleep(Math.min(5000, Math.max(0, seconds * 1000 - (Date.now() - startedAt))));
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
  variant: Variant,
): Promise<TierResult> {
  const warnings: string[] = [];
  const { options } = ctx;
  const idleOnly = options.variantsOnlyIdle && variant.name !== BASE_VARIANT;
  if (options.launchProbeSeconds > 0) {
    try {
      await launchProbe(ctx, app, label);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`launch probe failed: ${(error as Error).message}`);
    }
  }
  if (variant.name !== BASE_VARIANT) {
    log(`  injecting variant ${variant.name} (${path.basename(variant.file ?? "")})`);
    try {
      await injectVariant(app, variant, warnings);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`variant ${variant.name} failed: ${(error as Error).message}`);
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
  let idleFps: TierResult["idleFps"] = null;
  const idle = await measureQuietWindow(ctx, app, options.idleSeconds, async () => {
    // The trace sits in the tail of the window so the rest runs untraced.
    const traced = options.idleTrace ? Math.min(10, options.idleSeconds) : 0;
    await sleep((options.idleSeconds - traced) * 1000);
    if (traced > 0) {
      try {
        idleFps = await idleFpsTrace(ctx, app, label, traced);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        warnings.push(`idle fps trace skipped: ${(error as Error).message}`);
      }
    }
  });
  await checkFocus(app, warnings, "idle");
  let glass: GlassCensus | null = null;
  try {
    glass = await page<GlassCensus>(app, GLASS_CENSUS);
  } catch (error) {
    warnings.push(`glass census skipped: ${(error as Error).message}`);
  }
  const afterIdle = memorySnapshot(app);

  let background: TierResult["background"] = null;
  if (options.backgroundSeconds > 0 && !idleOnly) {
    log(`  background ${options.backgroundSeconds} s (Finder frontmost)`);
    osascript('tell application "Finder" to activate');
    await sleep(2000);
    const state = await page<PageState>(app, PAGE_STATE);
    if (state.focused)
      warnings.push("background: Vision still had focus after Finder activated");
    background = {
      ...(await measureQuietWindow(ctx, app, options.backgroundSeconds)),
      seconds: options.backgroundSeconds,
    };
    osascript(`tell application id "${app.info.bundleId}" to activate`);
    await sleep(2000);
  }

  let scroll: TierResult["scroll"] = null;
  if (!idleOnly) {
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
  }

  let windowScroll: TierResult["windowScroll"] = null;
  if (!idleOnly && options.segments.includes("window-scroll")) {
    windowScroll = [];
    const distance = windowScrollPx(options);
    for (const target of WINDOW_SCROLL_PAGES) {
      try {
        log(`  window scroll on ${target}`);
        await navigate(app, target);
        await sleep(1500);
        const measured = await measureAction(ctx, app, () =>
          scrollWindow(app, distance),
        );
        const entry: WindowScrollMeasurement = {
          ...measured.action,
          page: target,
          method: measured.result.method,
          requestedPx: distance,
          reachedScrollTop: measured.result.reachedScrollTop,
          scrollHeight: measured.result.scrollHeight,
        };
        windowScroll.push(entry);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        warnings.push(
          `window scroll on ${target} skipped: ${(error as Error).message}`,
        );
      }
    }
    await checkFocus(app, warnings, "window scroll");
  }

  let chatStream: TierResult["chatStream"] = null;
  if (!idleOnly && options.segments.includes("chat-stream")) {
    try {
      log(
        `  chat stream (${CHAT_STREAM_TOKENS} mocked tokens at ${CHAT_STREAM_TOKENS_PER_SECOND}/s)`,
      );
      const measured = await withChatComposer(app, () =>
        measureAction(ctx, app, () => sendChat(app)),
      );
      chatStream = { ...measured.action, ...measured.result };
      if (!chatStream.completed || !chatStream.rendered) {
        warnings.push(
          `chat stream: completed ${chatStream.completed}, last word rendered ${chatStream.rendered}`,
        );
      }
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`chat stream skipped: ${(error as Error).message}`);
    }
    await checkFocus(app, warnings, "chat stream");
  }

  let switches: Awaited<ReturnType<typeof measureAction<PageSwitch[][]>>> | null =
    null;
  if (!idleOnly) {
    log("  page switches (2 passes)");
    await navigate(app, options.pages.at(-1) ?? "/");
    switches = await measureAction(ctx, app, () =>
      pageSwitches(app, options.pages, 2),
    );
    await checkFocus(app, warnings, "page switches");
  }

  let trace: TierResult["trace"] = null;
  if (options.trace && !idleOnly) {
    try {
      log("  traced pass");
      trace = await tracedPass(ctx, app, label, warnings);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      warnings.push(`trace skipped: ${(error as Error).message}`);
    }
  }

  let sustained: TierResult["sustained"] = null;
  let afterSustained: RoleSummary | null = null;
  if (options.sustainedSeconds > 0 && !idleOnly) {
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
    variant: variant.name,
    idleFps,
    glass,
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
    idle: { ...idle, seconds: options.idleSeconds, page: "/" },
    background,
    scroll,
    windowScroll,
    chatStream,
    pageSwitch: switches
      ? { ...switches.action, passes: switches.result }
      : null,
    trace,
    sustained,
    warnings,
  };
}

/**
 * chrome://gpu equivalent, once per app and run: SystemInfo.getInfo on the
 * browser target. The full answer goes to gpu-info/<app>.json, the summary
 * into results.json.
 */
async function recordGpuInfo(
  ctx: Context,
  app: RunningApp,
  slug: string,
): Promise<GpuInfo | null> {
  try {
    const raw = await app.cdp.send("SystemInfo.getInfo", {}, undefined, 30_000);
    const file = path.join(ctx.outDir, "gpu-info", `${slug}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    const info = summarizeGpuInfo(raw);
    log(
      `  GPU: ${info.devices.map((device) => device.deviceString).join(", ") || "?"}; graphite ${info.graphite ?? "?"}; gpu_compositing ${info.featureStatus.gpu_compositing ?? "?"}`,
    );
    return info;
  } catch (error) {
    if (abort.signal.aborted) throw error;
    log(`  GPU info unavailable: ${(error as Error).message}`);
    return null;
  }
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
    gpuInfo: null,
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
    running = await launchApp(info, logPath, ctx.options.chromiumSwitches);
    original = await readSettings(running.origin);
    const originalTier = (original.value as { visualEffects?: unknown })
      .visualEffects;
    result.originalTier = TIERS.includes(originalTier as Tier)
      ? (originalTier as Tier)
      : null;
    result.gpuInfo = await recordGpuInfo(ctx, running, slug);
    // Repeats are the outer loop so slow drift (heat, background work)
    // spreads over every combination instead of piling onto one.
    const { repeat } = ctx.options;
    for (let run = 1; run <= repeat; run += 1) {
      for (const tier of ctx.options.tiers) {
        for (const fullEffects of ctx.options.fullEffects) {
          for (const variant of ctx.options.variants) {
            const name = [
              [
                tier,
                `full-${fullEffects ? "on" : "off"}`,
                variant.name,
              ].join("/"),
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
            running = await launchApp(info, logPath, ctx.options.chromiumSwitches);
            const label = [
              slug,
              tier,
              fullEffects ? "full" : null,
              variant.name === BASE_VARIANT ? null : variant.name,
              repeat > 1 ? `r${run}` : null,
            ]
              .filter(Boolean)
              .join("-");
            result.tiers.push(
              await measureTier(
                ctx,
                running,
                tier,
                fullEffects,
                run,
                label,
                variant,
              ),
            );
          }
        }
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    if (dirty && original) {
      try {
        running ??= await launchApp(info, logPath, ctx.options.chromiumSwitches);
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
    running = await launchApp(info, logPath, ctx.options.chromiumSwitches);
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

  if (options.leakMinutes !== null) {
    const appPath = options.apps[0] as string;
    const leak = await measureLeak(
      { options, powermetrics: null, outDir },
      appPath,
      options.leakMinutes,
    );
    fs.writeFileSync(
      path.join(outDir, "leak.json"),
      `${JSON.stringify(
        {
          machine: machineInfo(),
          chromiumSwitches: options.chromiumSwitches,
          ...leak,
        },
        null,
        2,
      )}\n`,
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
    schemaVersion: 5,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    options: {
      tiers: options.tiers,
      fullEffects: options.fullEffects.map((on) => (on ? "on" : "off")),
      variants: options.variants.map((variant) => ({
        name: variant.name,
        file: variant.file,
      })),
      variantsOnlyIdle: options.variantsOnlyIdle,
      idleTrace: options.idleTrace,
      repeat: options.repeat,
      idleSeconds: options.idleSeconds,
      sustainedSeconds: options.sustainedSeconds,
      cooldownSeconds: options.cooldownSeconds,
      scrollPx: options.scrollPx,
      segments: options.segments,
      chromiumSwitches: options.chromiumSwitches,
      pages: options.pages,
      powermetrics: options.powermetrics,
      trace: options.trace,
      backgroundSeconds: options.backgroundSeconds,
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
  return results.apps.some((app) => app.error !== null || !app.restored) ? 1 : 0;
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

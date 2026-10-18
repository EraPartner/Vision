#!/usr/bin/env bun
/**
 * Phase 0 performance baseline and golden screenshots for the Swift rewrite
 * (docs/adr/204-vision-native-swift-app-target.md). Run it on the Mac, in your
 * own terminal, against the synthetic Vision Demo app:
 *
 *   bun scripts/native-baseline.ts [--skip-screenshots] [--skip-launch]
 *                                  [--port <n>] [--cdp-port <n>] [--app "Vision Demo"]
 *
 * Needs only Bun, the Demo app and macOS built-ins (open, osascript, ps, curl,
 * du, sysctl, screencapture). It drives the renderer over the Chromium DevTools
 * Protocol through Electron's `--remote-debugging-port` switch; the Electron
 * shell neither strips nor rejects that switch (packaging/electron/main.ts sets
 * no command-line switches and the package flips no Electron fuses). When the
 * DevTools endpoint is unreachable (for example with --skip-launch against an
 * app started without the switch) it falls back to `screencapture -l` after
 * navigating with the app's `G <key>` shortcuts.
 *
 * Output: <repo>/.vision-cache/swift-baseline/<app slug>/ (gitignored; vision-demo
 * or vision-native). Phase 4 reruns the
 * same script against Vision Native with --app.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Small utilities ──────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

interface CommandResult {
  ok: boolean;
  code: number | undefined;
  stdout: string;
  stderr: string;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const baselineRoot = path.join(repoRoot, ".vision-cache", "swift-baseline");
/** Per-app output directory (set in main), so a Vision Native run never overwrites the Electron baseline. */
let outDir = baselineRoot;
const warnings: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`! ${message}`);
}

function log(message: string): void {
  console.log(message);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

function round(value: number | undefined, digits = 1): number | undefined {
  if (value === undefined) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number | undefined, unit = ""): string {
  return value === undefined ? "n/a" : `${value}${unit}`;
}

function run(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout, stderr });
          return;
        }
        const code =
          typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code?: unknown }).code as number)
            : undefined;
        resolve({
          ok: false,
          code,
          stdout: stdout ?? "",
          stderr: stderr || error.message,
        });
      },
    );
  });
}

function osascript(script: string, timeoutMs = 15_000): Promise<CommandResult> {
  return run("osascript", ["-e", script], timeoutMs);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Options ──────────────────────────────────────────────────────────────────

interface Options {
  skipScreenshots: boolean;
  skipLaunch: boolean;
  port: number | undefined;
  cdpPort: number;
  app: string;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    skipScreenshots: false,
    skipLaunch: false,
    port: undefined,
    cdpPort: 9222,
    app: "Vision Demo",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    const port = (value: string): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        throw new Error(`${arg}: invalid port ${value}`);
      return n;
    };
    switch (arg) {
      case "--skip-screenshots":
        options.skipScreenshots = true;
        break;
      case "--skip-launch":
        options.skipLaunch = true;
        break;
      case "--port":
        options.port = port(next());
        break;
      case "--cdp-port":
        options.cdpPort = port(next());
        break;
      case "--app": {
        const app = next();
        if (!ALLOWED_APPS.includes(app))
          throw new Error(
            `--app must be one of ${ALLOWED_APPS.map((a) => JSON.stringify(a)).join(", ")}; the real Vision app holds real financial data and is never a baseline target (AGENTS.md provider rules)`,
          );
        options.app = app;
        break;
      }
      case "--help":
      case "-h":
        log(
          'Usage: bun scripts/native-baseline.ts [--skip-screenshots] [--skip-launch] [--port <backend port>] [--cdp-port <n>] [--app "Vision Demo"|"Vision Native"]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

// ── Paths ────────────────────────────────────────────────────────────────────

interface AppPaths {
  bundle: string;
  supportDir: string;
  settingsFile: string;
}

/**
 * Demo settings live in Electron's userData directory. packaging/electron/main.ts
 * calls app.setName("Vision Demo") when the bundle carries resources/DEMO, so
 * app.getPath("userData") is ~/Library/Application Support/Vision Demo
 * (DEMO_USER_DATA_NAME in packaging/electron/runtime/native-demo.ts), and
 * settingsPath = path.join(userData, "settings.json") holds `appPort`
 * (resolveAppPort() in main.ts). The native PostgreSQL cluster sits below the
 * same directory (native/vision_demo, see the provider rules in AGENTS.md).
 */
/**
 * Apps the script may launch, reconfigure and screenshot. Both run on synthetic
 * data only; "Vision" (the real app and the real database) is rejected.
 */
const ALLOWED_APPS: readonly string[] = ["Vision Demo", "Vision Native"];

function appPaths(app: string): AppPaths {
  const supportDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    app,
  );
  return {
    bundle: path.join("/Applications", `${app}.app`),
    supportDir,
    settingsFile: path.join(supportDir, "settings.json"),
  };
}

function readAppPort(settingsFile: string): number | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const port = isRecord(data) ? Number(data.appPort) : Number.NaN;
    return Number.isInteger(port) && port >= 1024 && port <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Toolchain and bundle sizes ───────────────────────────────────────────────

async function writeToolchain(): Promise<string> {
  const commands: Array<[string, string[]]> = [
    ["sw_vers", []],
    ["uname", ["-m"]],
    ["sysctl", ["-n", "machdep.cpu.brand_string"]],
    ["sysctl", ["-n", "hw.memsize"]],
    ["xcode-select", ["-p"]],
    ["xcodebuild", ["-version"]],
    ["swift", ["--version"]],
    ["which", ["xcodegen"]],
    ["git", ["-C", repoRoot, "branch", "--show-current"]],
    ["git", ["-C", repoRoot, "rev-parse", "HEAD"]],
  ];
  const lines = [
    "# Toolchain",
    "",
    `Captured ${new Date().toISOString()} by scripts/native-baseline.ts.`,
    "",
  ];
  for (const [command, args] of commands) {
    const result = await run(command, args, 30_000);
    const output = (result.stdout || result.stderr).trim() || "(no output)";
    lines.push(
      `## \`${[command, ...args].join(" ")}\``,
      "",
      "```text",
      result.ok ? output : `exit ${fmt(result.code)}: ${output}`,
      "```",
      "",
    );
  }
  const file = path.join(outDir, "toolchain.md");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

interface BundleSize {
  path: string;
  exists: boolean;
  kilobytes: number | undefined;
  human: string | undefined;
}

async function measureSize(target: string): Promise<BundleSize> {
  if (!fs.existsSync(target))
    return {
      path: target,
      exists: false,
      kilobytes: undefined,
      human: undefined,
    };
  const sk = await run("du", ["-sk", target], 120_000);
  const sh = await run("du", ["-sh", target], 120_000);
  const kb = Number(sk.stdout.trim().split(/\s+/)[0]);
  return {
    path: target,
    exists: true,
    kilobytes: Number.isFinite(kb) ? kb : undefined,
    human: sh.stdout.trim().split(/\s+/)[0],
  };
}

async function measureBundles(selected: string): Promise<BundleSize[]> {
  const sizes: BundleSize[] = [];
  const bundles = ["/Applications/Vision.app", "/Applications/Vision Demo.app"];
  if (!bundles.includes(selected)) bundles.push(selected);
  for (const bundle of bundles) {
    const contents = path.join(bundle, "Contents");
    const runtime = path.join(contents, "Resources", "native-runtime");
    const targets = [
      bundle,
      path.join(contents, "Frameworks"),
      path.join(contents, "Resources"),
      runtime,
    ];
    if (fs.existsSync(runtime)) {
      for (const entry of fs.readdirSync(runtime).sort())
        targets.push(path.join(runtime, entry));
    }
    for (const target of targets) sizes.push(await measureSize(target));
  }
  return sizes;
}

// ── Processes and memory ─────────────────────────────────────────────────────

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

async function listProcesses(): Promise<ProcessRow[]> {
  const result = await run("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4] ?? "",
    });
  }
  return rows;
}

/**
 * Processes whose command path is inside the bundle or the support directory,
 * plus all their descendants (postgres renames its children's titles, e.g.
 * "postgres: checkpointer", so they only match through the parent chain).
 */
async function appProcesses(paths: AppPaths): Promise<ProcessRow[]> {
  const rows = await listProcesses();
  const roots = [`${paths.bundle}/`, `${paths.supportDir}/`];
  const selected = new Set<number>(
    rows
      .filter((row) => roots.some((root) => row.command.includes(root)))
      .map((row) => row.pid),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => selected.has(row.pid) && row.pid !== process.pid);
}

interface MemorySample {
  label: string;
  takenAt: string;
  totalRssKb: number;
  totalRssMb: number;
  processes: ProcessRow[];
}

async function sampleMemory(
  label: string,
  paths: AppPaths,
): Promise<MemorySample> {
  const processes = await appProcesses(paths);
  const totalRssKb = processes.reduce((sum, row) => sum + row.rssKb, 0);
  return {
    label,
    takenAt: new Date().toISOString(),
    totalRssKb,
    totalRssMb: round(totalRssKb / 1024) ?? 0,
    processes,
  };
}

// ── Launch control ───────────────────────────────────────────────────────────

async function quitApp(options: Options, paths: AppPaths): Promise<boolean> {
  const name = appleScriptString(options.app);
  await osascript(
    `if application ${name} is running then quit application ${name}`,
    60_000,
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await appProcesses(paths)).length === 0) return true;
    await sleep(500);
  }
  warn(`${options.app} processes still running 120 s after quit`);
  return false;
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function windowCount(app: string): Promise<number | undefined> {
  const result = await osascript(
    `tell application "System Events" to count windows of process ${appleScriptString(app)}`,
    5_000,
  );
  if (!result.ok) return undefined;
  const n = Number(result.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(cdpPort: number): Promise<CdpTarget[] | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(1_000),
    });
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return undefined;
    const targets: CdpTarget[] = [];
    for (const item of data) {
      if (!isRecord(item)) continue;
      const id = asString(item.id);
      const type = asString(item.type);
      const url = asString(item.url);
      const ws = asString(item.webSocketDebuggerUrl);
      if (id === undefined || type === undefined || url === undefined) continue;
      targets.push(
        ws === undefined
          ? { id, type, url }
          : { id, type, url, webSocketDebuggerUrl: ws },
      );
    }
    return targets;
  } catch {
    return undefined;
  }
}

function rendererOrigin(port: number): string {
  // main.ts: appUrl() = `http://localhost:${appPort}`; renderer-security.ts only
  // trusts that exact origin, and localStorage is keyed by it, so never use
  // 127.0.0.1 for the renderer.
  return `http://localhost:${port}`;
}

async function rendererTarget(
  cdpPort: number,
  port: number,
): Promise<CdpTarget | undefined> {
  const targets = await listTargets(cdpPort);
  return targets?.find(
    (target) =>
      target.type === "page" &&
      target.url.startsWith(rendererOrigin(port)) &&
      target.webSocketDebuggerUrl !== undefined,
  );
}

interface LaunchRun {
  run: number;
  quitClean: boolean;
  healthMs: number | undefined;
  windowMs: number | undefined;
  rendererTargetMs: number | undefined;
  port: number | undefined;
}

async function coldLaunch(
  index: number,
  options: Options,
  paths: AppPaths,
): Promise<LaunchRun> {
  const quitClean = await quitApp(options, paths);
  await sleep(2_000);
  const start = performance.now();
  const opened = await run("open", [
    "-a",
    options.app,
    "--args",
    `--remote-debugging-port=${options.cdpPort}`,
  ]);
  if (!opened.ok)
    throw new Error(`open -a ${options.app} failed: ${opened.stderr}`);
  const deadline = start + 180_000;
  let healthMs: number | undefined;
  let windowMs: number | undefined;
  let rendererTargetMs: number | undefined;
  let port = options.port;

  const healthLoop = (async () => {
    while (healthMs === undefined && performance.now() < deadline) {
      port ??= readAppPort(paths.settingsFile);
      if (port !== undefined && (await healthOk(port))) {
        healthMs = performance.now() - start;
        break;
      }
      await sleep(50);
    }
  })();
  const windowLoop = (async () => {
    while (windowMs === undefined && performance.now() < deadline) {
      const count = await windowCount(options.app);
      if (count !== undefined && count >= 1) {
        windowMs = performance.now() - start;
        break;
      }
      await sleep(50);
    }
  })();
  const rendererLoop = (async () => {
    while (rendererTargetMs === undefined && performance.now() < deadline) {
      if (port !== undefined && (await rendererTarget(options.cdpPort, port))) {
        rendererTargetMs = performance.now() - start;
        break;
      }
      await sleep(100);
    }
  })();
  await Promise.all([healthLoop, windowLoop, rendererLoop]);
  const result: LaunchRun = {
    run: index,
    quitClean,
    healthMs: round(healthMs, 0),
    windowMs: round(windowMs, 0),
    rendererTargetMs: round(rendererTargetMs, 0),
    port,
  };
  log(
    `  run ${index}: /health ${fmt(result.healthMs, " ms")}, window ${fmt(result.windowMs, " ms")}, renderer target ${fmt(result.rendererTargetMs, " ms")}`,
  );
  if (windowMs === undefined)
    warn(
      `run ${index}: System Events window count never reached 1 (grant Accessibility access to the terminal?)`,
    );
  return result;
}

// ── Chromium DevTools Protocol client ────────────────────────────────────────

interface CdpResponseMessage {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpEventMessage {
  method: string;
  params?: unknown;
}

type CdpEventHandler = (params: JsonRecord) => void;

interface CdpClient {
  send(
    method: string,
    params?: JsonRecord,
    timeoutMs?: number,
  ): Promise<JsonRecord>;
  on(method: string, handler: CdpEventHandler): () => void;
  close(): void;
}

function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (value: JsonRecord) => void; reject: (err: Error) => void }
    >();
    const handlers = new Map<string, Set<CdpEventHandler>>();

    socket.addEventListener("message", (event: MessageEvent) => {
      const raw: unknown = event.data;
      if (typeof raw !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      if (typeof parsed.id === "number") {
        const message = parsed as unknown as CdpResponseMessage;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error)
          waiter.reject(new Error(`CDP ${message.error.message}`));
        else waiter.resolve(isRecord(message.result) ? message.result : {});
        return;
      }
      if (typeof parsed.method === "string") {
        const message = parsed as unknown as CdpEventMessage;
        const params = isRecord(message.params) ? message.params : {};
        for (const handler of handlers.get(message.method) ?? [])
          handler(params);
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values())
        waiter.reject(new Error("CDP socket closed"));
      pending.clear();
    });
    socket.addEventListener("error", () =>
      reject(new Error(`CDP connect failed: ${wsUrl}`)),
    );
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}, timeoutMs = 60_000) {
          const id = nextId++;
          return new Promise<JsonRecord>((resolveSend, rejectSend) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectSend(new Error(`CDP ${method} timed out`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolveSend(value);
              },
              reject: (err) => {
                clearTimeout(timer);
                rejectSend(err);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, handler) {
          const set = handlers.get(method) ?? new Set<CdpEventHandler>();
          set.add(handler);
          handlers.set(method, set);
          return () => set.delete(handler);
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

interface Page {
  client: CdpClient;
  port: number;
  inflight: Set<string>;
  lastNetworkActivity: number;
}

async function evaluate(
  page: Page,
  expression: string,
  timeoutMs = 60_000,
): Promise<unknown> {
  const response = await page.client.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  const details = response.exceptionDetails;
  if (isRecord(details)) {
    const exception = isRecord(details.exception) ? details.exception : {};
    throw new Error(
      `evaluate failed: ${asString(exception.description) ?? asString(details.text) ?? "unknown error"}`,
    );
  }
  const result = isRecord(response.result) ? response.result : {};
  return result.value;
}

async function openPage(
  options: Options,
  port: number,
): Promise<Page | undefined> {
  const deadline = Date.now() + 60_000;
  let target: CdpTarget | undefined;
  while (!target && Date.now() < deadline) {
    target = await rendererTarget(options.cdpPort, port);
    if (!target) await sleep(500);
  }
  if (!target?.webSocketDebuggerUrl) return undefined;
  const client = await connectCdp(target.webSocketDebuggerUrl);
  const page: Page = {
    client,
    port,
    inflight: new Set(),
    lastNetworkActivity: Date.now(),
  };
  const touch = (): void => {
    page.lastNetworkActivity = Date.now();
  };
  client.on("Network.requestWillBeSent", (params) => {
    touch();
    const id = asString(params.requestId);
    const type = asString(params.type);
    // EventSource streams never finish; they would block network idle forever.
    if (id !== undefined && type !== "EventSource" && type !== "WebSocket")
      page.inflight.add(id);
  });
  for (const method of ["Network.loadingFinished", "Network.loadingFailed"]) {
    client.on(method, (params) => {
      touch();
      const id = asString(params.requestId);
      if (id !== undefined) page.inflight.delete(id);
    });
  }
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Runtime.enable");
  return page;
}

async function waitForNetworkIdle(
  page: Page,
  idleMs = 600,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      page.inflight.size === 0 &&
      Date.now() - page.lastNetworkActivity >= idleMs
    )
      return true;
    await sleep(100);
  }
  page.inflight.clear();
  return false;
}

async function navigate(page: Page, route: string): Promise<boolean> {
  const url = `${rendererOrigin(page.port)}${route}`;
  page.inflight.clear();
  const result = await page.client.send("Page.navigate", { url });
  const failure = asString(result.errorText);
  if (failure) throw new Error(`navigate ${route}: ${failure}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(
        page,
        `document.readyState === "complete" && (document.getElementById("root")?.childElementCount ?? 0) > 0`,
        5_000,
      );
      if (ready === true) break;
    } catch {
      // The execution context is replaced while the document navigates.
    }
    await sleep(150);
  }
  const idle = await waitForNetworkIdle(page);
  await evaluate(
    page,
    "document.fonts ? document.fonts.ready.then(() => true) : true",
  );
  await sleep(500);
  return idle;
}

const SCROLL_HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scrollables = () => [document.scrollingElement, ...document.querySelectorAll("*")]
    .filter((el) => el && el.scrollHeight > el.clientHeight + 4 &&
      (el === document.scrollingElement || /(auto|scroll)/.test(getComputedStyle(el).overflowY)));
  const largest = () => scrollables().sort((a, b) =>
    b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
`;

/** Step through the main scroll container so lazy (IntersectionObserver) charts mount. */
async function scrollThrough(page: Page): Promise<void> {
  await evaluate(
    page,
    `(async () => {
      ${SCROLL_HELPERS}
      const el = largest();
      if (!el) return false;
      for (let y = 0; y < el.scrollHeight; y += Math.max(200, el.clientHeight * 0.8)) {
        el.scrollTop = y;
        await sleep(200);
      }
      el.scrollTop = el.scrollHeight;
      await sleep(400);
      el.scrollTop = 0;
      await sleep(400);
      return true;
    })()`,
  );
}

const TABLE_SCROLLER = `[role="table"] [role="rowgroup"].overflow-auto`;

/**
 * The transactions body scroller: VirtualDataTable's parentRef div
 * (role="rowgroup", class "overflow-auto") inside the role="table" CardContent.
 */
const FIND_TABLE_SCROLLER = `
  ${SCROLL_HELPERS}
  const candidate = document.querySelector(${JSON.stringify(TABLE_SCROLLER)});
  const el = candidate && candidate.scrollHeight > candidate.clientHeight + 4 ? candidate : largest();
  const via = el === candidate ? ${JSON.stringify(TABLE_SCROLLER)} : "largest scrollable element";
`;

async function scrollTransactionsToBottom(page: Page): Promise<JsonRecord> {
  const value = await evaluate(
    page,
    `(async () => {
      ${FIND_TABLE_SCROLLER}
      if (!el) return { error: "no scroll container" };
      let lastHeight = -1, stable = 0;
      const start = performance.now();
      while (stable < 4 && performance.now() - start < 90000) {
        el.scrollTop = el.scrollHeight;
        await sleep(500);
        if (el.scrollHeight === lastHeight) stable++; else { stable = 0; lastHeight = el.scrollHeight; }
      }
      return { via, scrollHeight: el.scrollHeight, ms: Math.round(performance.now() - start) };
    })()`,
    120_000,
  );
  return isRecord(value) ? value : {};
}

interface ScrollFps {
  container: string | undefined;
  frames: number | undefined;
  durationMs: number | undefined;
  fps: number | undefined;
  longestFrameMs: number | undefined;
  wraps: number | undefined;
  error: string | undefined;
}

async function measureScrollFps(page: Page): Promise<ScrollFps> {
  const value = await evaluate(
    page,
    `(async () => {
      ${FIND_TABLE_SCROLLER}
      if (!el) return { error: "no scroll container" };
      el.scrollTop = 0;
      await sleep(500);
      const duration = 5000, pxPerSecond = 1500;
      let frames = 0, longest = 0, wraps = 0;
      const start = performance.now();
      let last = start;
      await new Promise((resolve) => {
        const step = (now) => {
          const dt = now - last;
          if (frames > 0) longest = Math.max(longest, dt);
          last = now;
          frames++;
          el.scrollTop += pxPerSecond * dt / 1000;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) { el.scrollTop = 0; wraps++; }
          if (now - start < duration) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      const durationMs = last - start;
      return { container: via, frames, durationMs, fps: frames / (durationMs / 1000), longestFrameMs: longest, wraps };
    })()`,
    30_000,
  );
  const record = isRecord(value) ? value : {};
  return {
    container: asString(record.container),
    frames: asNumber(record.frames),
    durationMs: round(asNumber(record.durationMs), 0),
    fps: round(asNumber(record.fps)),
    longestFrameMs: round(asNumber(record.longestFrameMs)),
    wraps: asNumber(record.wraps),
    error: asString(record.error),
  };
}

async function pageTransactionCount(page: Page): Promise<string | undefined> {
  const value = await evaluate(
    page,
    `(() => {
      const m = /([\\d][\\d.,\\u00a0\\u202f ]*)\\s+(transactions|transacties)/i.exec(document.body.innerText);
      return m ? m[1].trim() : undefined;
    })()`,
  );
  return asString(value);
}

// ── Backend API (settings, counts, ids) ─────────────────────────────────────

async function api(
  port: number,
  endpoint: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${endpoint} → ${response.status}`);
  return isRecord(body) && body.ok === true ? body.data : body;
}

interface SettingRecord {
  value: JsonRecord;
  expected: JsonRecord;
}

async function getSetting(port: number, key: string): Promise<SettingRecord> {
  const data = await api(port, `/api/settings/${key}`);
  if (!isRecord(data) || !isRecord(data.expected))
    throw new Error(`unexpected /api/settings/${key} response`);
  return {
    value: isRecord(data.value) ? data.value : {},
    expected: data.expected,
  };
}

/** Same compare-and-set contract the renderer's saveSetting() uses. */
async function patchSetting(
  port: number,
  key: string,
  patch: JsonRecord,
): Promise<void> {
  const current = await getSetting(port, key);
  await api(port, `/api/settings/${key}`, {
    method: "PUT",
    body: { value: { ...current.value, ...patch }, expected: current.expected },
  });
}

interface Appearance {
  theme: "light" | "dark";
  language: "en" | "nl";
  admin: boolean;
}

interface SavedSettings {
  theme: SettingRecord;
  app: SettingRecord;
}

/**
 * Theme, language and admin mode are backend settings, not localStorage:
 * ThemeHydration persists `theme_settings.mode`, AppSettingsHydration persists
 * `app_settings.language` and `app_settings.adminMode` (RequireAdmin gates
 * /admin/* on it). The localStorage keys vision_theme and vision.language are
 * only boot caches that the server value overwrites on hydration. So switch
 * through PUT /api/settings/:key and reload the renderer.
 */
async function applyAppearance(
  port: number,
  appearance: Appearance,
): Promise<void> {
  await patchSetting(port, "theme_settings", { mode: appearance.theme });
  await patchSetting(port, "app_settings", {
    language: appearance.language,
    adminMode: appearance.admin,
  });
}

async function restoreSettings(
  port: number,
  saved: SavedSettings,
): Promise<void> {
  const restoreOne = async (
    key: string,
    original: SettingRecord,
    fields: string[],
  ): Promise<void> => {
    const current = await getSetting(port, key);
    if (original.expected.exists === false) {
      if (current.expected.exists === true)
        await api(port, `/api/settings/${key}`, {
          method: "DELETE",
          body: { expected: current.expected },
        });
      return;
    }
    const patch: JsonRecord = {};
    for (const field of fields) patch[field] = original.value[field];
    await api(port, `/api/settings/${key}`, {
      method: "PUT",
      body: {
        value: { ...current.value, ...patch },
        expected: current.expected,
      },
    });
  };
  await restoreOne("theme_settings", saved.theme, ["mode"]);
  await restoreOne("app_settings", saved.app, ["language", "adminMode"]);
}

function firstId(value: unknown): string | undefined {
  const list = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.items, value.batches, value.data, value.accounts].find(
          Array.isArray,
        )
      : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (
      isRecord(item) &&
      (typeof item.id === "number" || typeof item.id === "string")
    )
      return String(item.id);
  }
  return undefined;
}

async function apiTransactionCount(port: number): Promise<number | undefined> {
  try {
    const data = await api(port, "/api/transactions?limit=1&offset=0");
    return isRecord(data) ? asNumber(data.total) : undefined;
  } catch (err) {
    warn(`transaction count API failed: ${errorText(err)}`);
    return undefined;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

interface RouteSpec {
  pattern: string;
  route: string | undefined;
  admin: boolean;
  source: string;
  skipReason: string | undefined;
}

function documentedRoutes(): Array<{ pattern: string; source: string }> {
  const doc = fs.readFileSync(
    path.join(repoRoot, "docs", "reference", "frontend-routes.md"),
    "utf8",
  );
  const routes: Array<{ pattern: string; source: string }> = [];
  for (const line of doc.split("\n")) {
    const match = /^\|\s*`(\/[^`]*)`\s*\|/.exec(line);
    if (match?.[1] && !routes.some((r) => r.pattern === match[1]))
      routes.push({ pattern: match[1], source: "frontend-routes.md" });
  }
  // Pages in the route manifest that the reference does not list yet.
  const manifest = fs.readFileSync(
    path.join(repoRoot, "apps", "frontend", "src", "lib", "routePreload.ts"),
    "utf8",
  );
  for (const match of manifest.matchAll(/path:\s*"(\/[^"]*)"/g)) {
    const pattern = match[1];
    if (pattern && !routes.some((r) => r.pattern === pattern))
      routes.push({
        pattern,
        source: "routePreload.ts (not in frontend-routes.md)",
      });
  }
  return routes;
}

async function resolveRoutes(port: number): Promise<RouteSpec[]> {
  const lookups: Record<string, () => Promise<string | undefined>> = {
    "/accounts/:id": async () => firstId(await api(port, "/api/accounts")),
    "/import/:batchId/review": async () =>
      firstId(await api(port, "/api/import/batches?limit=20&offset=0")),
    "/portfolio/import/:batchId/review": async () =>
      firstId(
        await api(port, "/api/portfolio/import/batches?limit=20&offset=0"),
      ),
    "/admin/db/:table": async () => "transactions",
  };
  const specs: RouteSpec[] = [];
  for (const { pattern, source } of documentedRoutes()) {
    const admin = pattern === "/admin" || pattern.startsWith("/admin/");
    if (!pattern.includes(":")) {
      specs.push({
        pattern,
        route: pattern,
        admin,
        source,
        skipReason: undefined,
      });
      continue;
    }
    const lookup = lookups[pattern];
    let id: string | undefined;
    let reason = "no id lookup for this parameter";
    if (lookup) {
      try {
        id = await lookup();
        reason = "the Demo database has no record for this parameter";
      } catch (err) {
        reason = `id lookup failed: ${errorText(err)}`;
      }
    }
    specs.push({
      pattern,
      route:
        id === undefined
          ? undefined
          : pattern.replace(/:[A-Za-z]+/, encodeURIComponent(id)),
      admin,
      source,
      skipReason: id === undefined ? reason : undefined,
    });
  }
  return specs;
}

function slug(route: string): string {
  if (route === "/") return "home";
  const [pathname = "", query = ""] = route.split("?");
  const base = pathname.replace(/^\//, "").replace(/[/:]+/g, "-") || "home";
  const suffix = query.replace(/[=&]+/g, "-");
  return suffix ? `${base}--${suffix}` : base;
}

// ── Screenshots ──────────────────────────────────────────────────────────────

interface ShotEntry {
  file: string;
  route: string;
  theme: string;
  language: string;
  admin: boolean;
  method: string;
  note: string;
}

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };

async function setViewport(page: Page, theme: string): Promise<void> {
  await page.client.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
  await page.client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await page.client.send("Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
}

async function capture(page: Page, file: string): Promise<void> {
  const shot = await page.client.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true, fromSurface: true },
    120_000,
  );
  const data = asString(shot.data);
  if (!data) throw new Error("Page.captureScreenshot returned no data");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

async function captureRoute(
  page: Page,
  route: string,
  file: string,
  before?: () => Promise<void>,
): Promise<string> {
  const idle = await navigate(page, route);
  await scrollThrough(page);
  const idleAfter = await waitForNetworkIdle(page);
  await sleep(400);
  if (before) await before();
  await capture(page, file);
  return idle && idleAfter ? "" : "network idle not reached within 20 s";
}

async function dispatchKey(page: Page, init: JsonRecord): Promise<void> {
  await evaluate(
    page,
    `(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
  await sleep(900);
}

async function cdpScreenshots(
  page: Page,
  routes: RouteSpec[],
  shotsDir: string,
): Promise<ShotEntry[]> {
  const entries: ShotEntry[] = [];
  const method = `CDP Page.captureScreenshot (captureBeyondViewport, ${VIEWPORT.width}x${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x)`;
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["en", "nl"] as const) {
      await setViewport(page, theme);
      const dir = `${theme}-${language}`;
      for (const admin of [false, true]) {
        await applyAppearance(page.port, { theme, language, admin });
        for (const spec of routes) {
          if (spec.admin !== admin || spec.route === undefined) continue;
          const rel = path.join(dir, `${slug(spec.route)}.png`);
          try {
            const note = await captureRoute(
              page,
              spec.route,
              path.join(shotsDir, rel),
            );
            entries.push({
              file: rel,
              route: spec.route,
              theme,
              language,
              admin,
              method,
              note,
            });
            log(`  ${rel}`);
          } catch (err) {
            warn(`screenshot ${rel}: ${errorText(err)}`);
          }
        }
        if (admin || theme !== "light" || language !== "en") continue;
        // Light-en extras: Settings sections, command palette, shortcuts overlay.
        for (const section of [
          "general",
          "appearance",
          "statistics",
          "behavior",
          "ai",
          "backup",
          "about",
        ]) {
          const route = `/?settings=${section}`;
          const rel = path.join(dir, `settings-${section}.png`);
          try {
            const note = await captureRoute(
              page,
              route,
              path.join(shotsDir, rel),
            );
            entries.push({
              file: rel,
              route,
              theme,
              language,
              admin,
              method,
              note,
            });
            log(`  ${rel}`);
          } catch (err) {
            warn(`screenshot ${rel}: ${errorText(err)}`);
          }
        }
        const overlays: Array<[string, string, JsonRecord]> = [
          [
            "command-palette",
            "⌘K on /",
            { key: "k", code: "KeyK", metaKey: true },
          ],
          [
            "shortcuts-overlay",
            "? on /",
            { key: "?", code: "Slash", shiftKey: true },
          ],
        ];
        for (const [name, route, init] of overlays) {
          const rel = path.join(dir, `${name}.png`);
          try {
            const note = await captureRoute(
              page,
              "/",
              path.join(shotsDir, rel),
              () => dispatchKey(page, init),
            );
            entries.push({
              file: rel,
              route,
              theme,
              language,
              admin,
              method,
              note,
            });
            log(`  ${rel}`);
          } catch (err) {
            warn(`screenshot ${rel}: ${errorText(err)}`);
          }
        }
      }
    }
  }
  await page.client.send("Emulation.clearDeviceMetricsOverride");
  await page.client.send("Emulation.setEmulatedMedia", { features: [] });
  return entries;
}

/** CGWindowID of the app's first normal-layer window, via JXA and CoreGraphics. */
async function windowId(app: string): Promise<number | undefined> {
  const script = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)));
const w = list.find((w) => w.kCGWindowOwnerName === ${JSON.stringify(app)} && w.kCGWindowLayer === 0);
w ? String(w.kCGWindowNumber) : "";`;
  const result = await run(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    15_000,
  );
  const n = Number(result.stdout.trim());
  return result.ok && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `G <key>` page shortcuts from apps/frontend/src/lib/navigation.ts (shortcutKey). */
const G_SHORTCUTS: Array<[string, string]> = [
  ["/", "h"],
  ["/transactions", "t"],
  ["/categories", "c"],
  ["/recipients", "y"],
  ["/statistics", "i"],
  ["/import", "e"],
  ["/portfolio", "p"],
  ["/portfolio/net-worth", "n"],
  ["/research/markets", "m"],
  ["/ai-chat", "a"],
];

async function fallbackScreenshots(
  options: Options,
  port: number,
  shotsDir: string,
): Promise<ShotEntry[]> {
  warn(
    "DevTools endpoint unreachable: falling back to screencapture -l for the G-shortcut pages only (window size as-is, no full-page capture, no admin routes)",
  );
  const entries: ShotEntry[] = [];
  const app = appleScriptString(options.app);
  const method =
    "screencapture -l <window id> after G-shortcut navigation (osascript System Events)";
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["en", "nl"] as const) {
      await applyAppearance(port, { theme, language, admin: false });
      await osascript(`tell application ${app} to activate`);
      await osascript(
        `tell application "System Events" to tell process ${app} to keystroke "r" using command down`,
      );
      await sleep(5_000);
      for (const [route, key] of G_SHORTCUTS) {
        await osascript(`tell application ${app} to activate`);
        await osascript(
          `tell application "System Events" to tell process ${app}
             keystroke "g"
             delay 0.2
             keystroke "${key}"
           end tell`,
        );
        await sleep(4_000);
        const id = await windowId(options.app);
        const rel = path.join(`${theme}-${language}`, `${slug(route)}.png`);
        if (id === undefined) {
          warn(
            `screenshot ${rel}: no on-screen window found (Screen Recording permission?)`,
          );
          continue;
        }
        fs.mkdirSync(path.join(shotsDir, `${theme}-${language}`), {
          recursive: true,
        });
        const shot = await run("screencapture", [
          "-l",
          String(id),
          "-o",
          "-x",
          path.join(shotsDir, rel),
        ]);
        if (!shot.ok) {
          warn(`screenshot ${rel}: ${shot.stderr.trim()}`);
          continue;
        }
        entries.push({
          file: rel,
          route,
          theme,
          language,
          admin: false,
          method,
          note: "viewport only",
        });
        log(`  ${rel}`);
      }
    }
  }
  return entries;
}

function writeScreenshotIndex(
  shotsDir: string,
  entries: ShotEntry[],
  skipped: RouteSpec[],
): string {
  const lines = [
    "# Golden screenshots",
    "",
    `Captured ${new Date().toISOString()} by scripts/native-baseline.ts from the synthetic Vision Demo data.`,
    "Non-admin routes are captured with admin mode off; admin routes with admin mode on.",
    "",
    "| File | Route | Theme | Language | Admin mode | Method | Note |",
    "| ---- | ----- | ----- | -------- | ---------- | ------ | ---- |",
    ...entries.map(
      (e) =>
        `| \`${e.file}\` | \`${e.route}\` | ${e.theme} | ${e.language} | ${e.admin ? "on" : "off"} | ${e.method} | ${e.note} |`,
    ),
    "",
  ];
  if (skipped.length > 0) {
    lines.push(
      "## Skipped routes",
      "",
      "| Route | Reason |",
      "| ----- | ------ |",
    );
    for (const spec of skipped)
      lines.push(`| \`${spec.pattern}\` | ${spec.skipReason ?? ""} |`);
    lines.push("");
  }
  const file = path.join(shotsDir, "index.md");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform !== "darwin")
    throw new Error(
      "native-baseline runs on macOS only (open, osascript, screencapture)",
    );
  const paths = appPaths(options.app);
  if (!fs.existsSync(paths.bundle))
    throw new Error(`${paths.bundle} not found`);
  outDir = path.join(
    baselineRoot,
    options.app.toLowerCase().replace(/\s+/g, "-"),
  );
  // Stale screenshots from an interrupted run must not mix with this run's.
  fs.rmSync(path.join(outDir, "screenshots"), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();

  log("Toolchain …");
  const toolchainFile = await writeToolchain();
  log("Bundle sizes …");
  const bundles = await measureBundles(paths.bundle);

  const launches: LaunchRun[] = [];
  if (!options.skipLaunch) {
    log("Cold launch × 3 …");
    for (let i = 1; i <= 3; i++)
      launches.push(await coldLaunch(i, options, paths));
  }
  const port =
    options.port ?? launches.at(-1)?.port ?? readAppPort(paths.settingsFile);
  if (port === undefined)
    throw new Error(
      `No appPort in ${paths.settingsFile}; launch the app once or pass --port`,
    );
  if (!(await healthOk(port)))
    throw new Error(`Backend /health on port ${port} is not 200`);

  const page = await openPage(options, port).catch((err: unknown) => {
    warn(`CDP connect failed: ${errorText(err)}`);
    return undefined;
  });
  if (!page)
    warn(
      `No renderer target on DevTools port ${options.cdpPort}; relaunch without --skip-launch so the app starts with --remote-debugging-port`,
    );

  const saved: SavedSettings = {
    theme: await getSetting(port, "theme_settings"),
    app: await getSetting(port, "app_settings"),
  };
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    try {
      await restoreSettings(port, saved);
      log("Restored theme, language and admin mode.");
    } catch (err) {
      warn(
        `Could not restore settings (${errorText(err)}). Original theme_settings=${JSON.stringify(saved.theme.value)} app_settings.language=${String(saved.app.value.language)} adminMode=${String(saved.app.value.adminMode)}`,
      );
    }
    if (page) {
      await page.client
        .send("Emulation.clearDeviceMetricsOverride")
        .catch(() => undefined);
      await navigate(page, "/").catch(() => undefined);
    }
  };
  const onSignal = (): void => {
    void restore().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const memory: MemorySample[] = [];
  let scroll: ScrollFps | undefined;
  let transactionsBottom: JsonRecord | undefined;
  let pageCount: string | undefined;
  let shots: ShotEntry[] = [];
  let skippedRoutes: RouteSpec[] = [];
  let screenshotMethod = "skipped";
  const apiCount = await apiTransactionCount(port);

  try {
    // Measurements use the user's own appearance, with admin mode off.
    await applyAppearance(port, {
      theme: saved.theme.value.mode === "dark" ? "dark" : "light",
      language: saved.app.value.language === "nl" ? "nl" : "en",
      admin: false,
    });
    await osascript(
      `tell application ${appleScriptString(options.app)} to activate`,
    );
    if (page) {
      await page.client.send("Page.bringToFront");
      await navigate(page, "/");
    } else {
      await osascript(
        `tell application "System Events" to tell process ${appleScriptString(options.app)}
           keystroke "g"
           delay 0.2
           keystroke "h"
         end tell`,
      );
    }
    log("Memory: 60 s idle on Home …");
    await sleep(60_000);
    memory.push(await sampleMemory("home-idle-60s", paths));

    if (page) {
      log("Transactions: scroll frame rate …");
      await navigate(page, "/transactions");
      pageCount = await pageTransactionCount(page);
      scroll = await measureScrollFps(page);
      log("Transactions: scroll to bottom …");
      transactionsBottom = await scrollTransactionsToBottom(page);
      await waitForNetworkIdle(page);
      memory.push(await sampleMemory("transactions-scrolled-to-bottom", paths));
    } else {
      warn(
        "Scroll frame rate and transactions memory need the DevTools endpoint; skipped",
      );
    }

    if (!options.skipScreenshots) {
      log("Golden screenshots …");
      const shotsDir = path.join(outDir, "screenshots");
      const routes = await resolveRoutes(port);
      skippedRoutes = routes.filter((spec) => spec.route === undefined);
      if (page) {
        screenshotMethod = "cdp";
        shots = await cdpScreenshots(page, routes, shotsDir);
      } else {
        screenshotMethod = "screencapture";
        shots = await fallbackScreenshots(options, port, shotsDir);
      }
      writeScreenshotIndex(shotsDir, shots, skippedRoutes);
    }
  } finally {
    await restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    page?.client.close();
  }

  // A run after an unclean quit (processes retained, e.g. keepServicesOnQuit)
  // measures a warm backend, not a cold start, so it never enters the medians.
  const cleanLaunches = launches.filter((r) => r.quitClean);
  for (const r of launches)
    if (!r.quitClean)
      warn(
        `run ${r.run}: unclean quit before launch; excluded from the medians`,
      );
  const launchSummary = {
    runs: launches,
    medianHealthMs: median(
      cleanLaunches.flatMap((r) =>
        r.healthMs === undefined ? [] : [r.healthMs],
      ),
    ),
    medianWindowMs: median(
      cleanLaunches.flatMap((r) =>
        r.windowMs === undefined ? [] : [r.windowMs],
      ),
    ),
    medianRendererTargetMs: median(
      cleanLaunches.flatMap((r) =>
        r.rendererTargetMs === undefined ? [] : [r.rendererTargetMs],
      ),
    ),
  };
  const baseline = {
    generatedAt: new Date().toISOString(),
    startedAt,
    app: options.app,
    bundlePath: paths.bundle,
    appPort: port,
    cdpPort: options.cdpPort,
    options,
    toolchainFile: path.relative(outDir, toolchainFile),
    bundles,
    coldLaunch: launchSummary,
    memory,
    scroll,
    transactions: {
      apiTotal: apiCount,
      pageLabel: pageCount,
      scrollToBottom: transactionsBottom,
    },
    screenshots: {
      method: screenshotMethod,
      count: shots.length,
      index: shots.length > 0 ? "screenshots/index.md" : undefined,
      skippedRoutes: skippedRoutes.map((s) => ({
        route: s.pattern,
        reason: s.skipReason,
      })),
    },
    methods: METHODS,
    warnings,
  };
  fs.writeFileSync(
    path.join(outDir, "baseline.json"),
    `${JSON.stringify(baseline, undefined, 2)}\n`,
  );
  fs.writeFileSync(path.join(outDir, "baseline.md"), renderMarkdown(baseline));

  log("");
  log(`Baseline for ${options.app} → ${outDir}`);
  log(
    `  cold launch median: /health ${fmt(launchSummary.medianHealthMs, " ms")}, window ${fmt(launchSummary.medianWindowMs, " ms")}`,
  );
  for (const sample of memory)
    log(
      `  memory ${sample.label}: ${sample.totalRssMb} MB RSS in ${sample.processes.length} processes`,
    );
  if (scroll)
    log(
      `  scroll: ${fmt(scroll.fps, " fps")}, longest frame ${fmt(scroll.longestFrameMs, " ms")}`,
    );
  log(
    `  transactions: API total ${fmt(apiCount)}, page label ${pageCount ?? "n/a"}`,
  );
  log(`  screenshots: ${shots.length} (${screenshotMethod})`);
  if (warnings.length > 0)
    log(`  ${warnings.length} warning(s); see baseline.md`);
}

const METHODS = {
  toolchain:
    "sw_vers, uname -m, sysctl machdep.cpu.brand_string/hw.memsize, xcode-select -p, xcodebuild -version, swift --version, which xcodegen, git branch/HEAD → toolchain.md",
  bundleSize:
    "du -sk (KiB, authoritative) and du -sh (display) on the bundle, Contents/Frameworks, Contents/Resources and each Resources/native-runtime entry",
  coldLaunch:
    "quit via osascript (only if running) and wait until no process path is inside the bundle or Application Support dir, 2 s pause, then `open -a <app> --args --remote-debugging-port=<cdp>`; times from just before `open` to the first GET http://127.0.0.1:<appPort>/health = 200 (polled every 50 ms, appPort from Application Support/<app>/settings.json), to System Events window count ≥ 1, and to a CDP page target on http://localhost:<appPort>. Process cold start; the disk cache is warm.",
  memory:
    "sum of RSS from `ps -axo pid,ppid,rss,command` for processes whose command contains the bundle or Application Support path, plus all their descendants (postgres workers), after 60 s idle on Home and after scrolling /transactions to the bottom until its height is stable",
  scroll:
    "CDP Runtime.evaluate on /transactions: rAF loop for 5 s that advances the VirtualDataTable body scroller ([role=table] [role=rowgroup].overflow-auto) by 1500 px/s, wrapping at the bottom; fps = callbacks / elapsed seconds, longest frame = largest rAF interval",
  transactionCount:
    "GET /api/transactions?limit=1&offset=0 → data.total, plus the '{n} transactions' label read from the page",
  screenshots:
    "CDP Page.navigate to http://localhost:<appPort><route>, Emulation 1440x900 @2x, wait for network idle, step-scroll the main scroller to the bottom and back so lazy charts mount, wait for idle again, Page.captureScreenshot captureBeyondViewport. Theme/language/admin switched via PUT /api/settings/theme_settings and app_settings, restored at the end.",
};

/** Escapes backslashes, pipes and backticks so a value is safe inside a Markdown table cell. */
function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}

function renderMarkdown(baseline: {
  generatedAt: string;
  app: string;
  appPort: number;
  bundles: BundleSize[];
  coldLaunch: {
    runs: LaunchRun[];
    medianHealthMs: number | undefined;
    medianWindowMs: number | undefined;
    medianRendererTargetMs: number | undefined;
  };
  memory: MemorySample[];
  scroll: ScrollFps | undefined;
  transactions: {
    apiTotal: number | undefined;
    pageLabel: string | undefined;
    scrollToBottom: JsonRecord | undefined;
  };
  screenshots: { method: string; count: number };
  warnings: string[];
}): string {
  const lines: string[] = [
    `# ${baseline.app} performance baseline`,
    "",
    `Generated ${baseline.generatedAt} by \`bun scripts/native-baseline.ts\` (ADR-204 phase 0). Backend port ${baseline.appPort}. Toolchain: [toolchain.md](toolchain.md).`,
    "",
    "## Bundle size",
    "",
    `Method: ${METHODS.bundleSize}.`,
    "",
    "| Path | KiB | Size |",
    "| ---- | --: | ---- |",
    ...baseline.bundles.map((b) =>
      b.exists
        ? `| \`${b.path}\` | ${fmt(b.kilobytes)} | ${b.human ?? ""} |`
        : `| \`${b.path}\` | missing | |`,
    ),
    "",
    "## Cold launch",
    "",
    `Method: ${METHODS.coldLaunch}`,
    "",
    "| Run | /health 200 (ms) | Window ≥ 1 (ms) | Renderer target (ms) | Clean quit |",
    "| --: | ---------------: | --------------: | -------------------: | ---------- |",
    ...baseline.coldLaunch.runs.map(
      (r) =>
        `| ${r.run} | ${fmt(r.healthMs)} | ${fmt(r.windowMs)} | ${fmt(r.rendererTargetMs)} | ${r.quitClean ? "yes" : "no (excluded)"} |`,
    ),
    `| median (clean runs) | ${fmt(baseline.coldLaunch.medianHealthMs)} | ${fmt(baseline.coldLaunch.medianWindowMs)} | ${fmt(baseline.coldLaunch.medianRendererTargetMs)} | |`,
    "",
    "## Memory",
    "",
    `Method: ${METHODS.memory}.`,
    "",
  ];
  for (const sample of baseline.memory) {
    lines.push(
      `### ${sample.label}: ${sample.totalRssMb} MB RSS (${sample.processes.length} processes, ${sample.takenAt})`,
      "",
      "| PID | PPID | RSS (KiB) | Command |",
      "| --: | ---: | --------: | ------- |",
      ...sample.processes.map(
        (p) =>
          `| ${p.pid} | ${p.ppid} | ${p.rssKb} | \`${escapeTableCell(p.command).slice(0, 160)}\` |`,
      ),
      "",
    );
  }
  const s = baseline.scroll;
  lines.push(
    "## Transactions scroll",
    "",
    `Method: ${METHODS.scroll}.`,
    "",
    s
      ? `- ${fmt(s.fps, " fps")} over ${fmt(s.durationMs, " ms")} (${fmt(s.frames)} frames), longest frame ${fmt(s.longestFrameMs, " ms")}, wraps ${fmt(s.wraps)}, container ${s.container ?? s.error ?? "n/a"}`
      : "- not measured (no DevTools endpoint)",
    `- Transaction count (${METHODS.transactionCount}): API ${fmt(baseline.transactions.apiTotal)}, page label ${baseline.transactions.pageLabel ?? "n/a"}`,
    `- Scroll to bottom: ${baseline.transactions.scrollToBottom ? JSON.stringify(baseline.transactions.scrollToBottom) : "n/a"}`,
    "",
    "## Golden screenshots",
    "",
    `Method: ${METHODS.screenshots}`,
    "",
    `${baseline.screenshots.count} files (${baseline.screenshots.method}); see [screenshots/index.md](screenshots/index.md).`,
    "",
  );
  if (baseline.warnings.length > 0)
    lines.push(
      "## Warnings",
      "",
      ...baseline.warnings.map((w) => `- ${w}`),
      "",
    );
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`native-baseline failed: ${errorText(err)}`);
  process.exit(1);
});

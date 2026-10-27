/**
 * Result shapes and the human summary for the Mac performance baseline.
 */
import type { FrameStats } from "./frames.ts";
import type { GpuInfo } from "./gpuInfo.ts";
import type { PowerSummary } from "./powermetrics.ts";
import type { RoleSummary, ProcessRole } from "./processes.ts";
import { WINDOW_SCROLL_PAGES } from "./segments.ts";
import type { PresentedFps, TraceSegmentSummary } from "./trace.ts";
import type { GlassCensus } from "./variants.ts";

export type Tier = "reduced" | "standard" | "enhanced";

export interface AppInfo {
  path: string;
  name: string;
  bundleId: string;
  version: string;
  bundleMtime: string;
  sizeMb: number;
  sizeBreakdownMb: Record<string, number>;
}

export interface LaunchTiming {
  /** Spawn → main process logs renderer_ready (wall clock, this script). */
  spawnToRendererReadyMs: number | null;
  /** Main-process boot phases from its `[startup]` log lines. */
  phases: Record<string, number>;
}

export interface WindowMeasurement {
  wallMs: number;
  cpu: RoleSummary;
  power: PowerSummary | null;
}

export interface ActionMeasurement extends WindowMeasurement {
  frames: FrameStats;
  pageMetrics: Record<string, number>;
}

/** --segment window-scroll: one page's document scrolled down and back up. */
export interface WindowScrollMeasurement extends ActionMeasurement {
  page: string;
  method: string;
  requestedPx: number;
  reachedScrollTop: number;
  scrollHeight: number;
}

/** --segment chat-stream: one mocked AI chat answer streamed into /ai-chat. */
export interface ChatStreamMeasurement extends ActionMeasurement {
  tokens: number;
  tokensPerSecond: number;
  tokensSent: number;
  /** First token → terminal event in the page, ms. */
  streamMs: number | null;
  /** "enter" (key press in the composer) or "button" (send button click). */
  method: string;
  completed: boolean;
  /** The transcript showed the last streamed word afterwards. */
  rendered: boolean;
  /** AI requests the mock let through to the real backend. */
  passedThrough: string[];
}

export interface PageSwitch {
  path: string;
  method: string;
  settleMs: number;
  timedOut: boolean;
}

export interface TierResult {
  tier: Tier;
  /** The "Full effects" switch (AppSettings.fullEffects) for this launch. */
  fullEffects: boolean;
  /** 1-based repeat number (--repeat). */
  run: number;
  /** --variant name; absent or "base" means nothing was injected. */
  variant?: string;
  /** Presented frames/s of the idle window's 10 s trace; null without one. */
  idleFps?: PresentedFps | null;
  /** Backdrop-filter surface census after the idle window. */
  glass?: GlassCensus | null;
  /** Effective tier from <html> classes, plus atmosphere and fx-full flags. */
  effective: { tier: Tier; classes: string[] };
  page: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    screenWidth: number;
    screenHeight: number;
  };
  launch: LaunchTiming;
  memory: {
    afterLaunch: RoleSummary;
    afterIdle: RoleSummary;
    afterSustained: RoleSummary | null;
  };
  idle: WindowMeasurement & {
    seconds: number;
    page: string;
    /** Renderer work during the window (Performance.getMetrics delta). */
    pageMetrics?: Record<string, number>;
    /** Resource requests the page started during the window. */
    requests?: number;
  };
  /** --background: the same idle page while another app is frontmost. */
  background?:
    | (WindowMeasurement & {
        seconds: number;
        pageMetrics: Record<string, number>;
        requests: number;
      })
    | null;
  scroll:
    | (ActionMeasurement & {
        method: string;
        requestedPx: number;
        reachedScrollTop: number;
        rowsRendered: number;
      })
    | null;
  /** --segment window-scroll; absent or null when not requested. */
  windowScroll?: WindowScrollMeasurement[] | null;
  /** --segment chat-stream; absent or null when not requested. */
  chatStream?: ChatStreamMeasurement | null;
  pageSwitch:(ActionMeasurement & { passes: PageSwitch[][] }) | null;
  trace: { file: string; segments: Record<string, TraceSegmentSummary> } | null;
  sustained:
    | (ActionMeasurement & {
        seconds: number;
        cycles: number;
        fpsPer10s: number[];
        powerFirstMinute: PowerSummary | null;
        powerLastMinute: PowerSummary | null;
      })
    | null;
  warnings: string[];
}

export interface AppResult {
  app: AppInfo;
  originalTier: Tier | null;
  restored: boolean;
  /** chrome://gpu readout from the setup launch; null when unavailable. */
  gpuInfo?: GpuInfo | null;
  tiers: TierResult[];
  error: string | null;
}

export interface BaselineResults {
  /**
   * 2 adds TierResult.fullEffects and TierResult.run; 3 adds
   * RoleStats.sharedOnceMb; 4 adds TierResult.variant, idleFps and glass; 5
   * adds TierResult.windowScroll and chatStream, trace segment compositor
   * summaries, AppResult.gpuInfo and options.segments/chromiumSwitches.
   */
  schemaVersion: 3 | 4 | 5;
  startedAt: string;
  finishedAt: string;
  options: Record<string, unknown>;
  machine: Record<string, string | number | null>;
  repoHead: string | null;
  powermetrics: {
    enabled: boolean;
    samples: number;
    parseErrors: number;
    keysSeen: string[];
    stderr: string;
  };
  ollama: { ps: string | null; memory: RoleSummary | null };
  apps: AppResult[];
  warnings: string[];
}

const dash = "–";
const fmt = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? dash
    : value.toFixed(digits);
const cpu = (
  summary: RoleSummary | undefined,
  role: ProcessRole | "appTotal",
) => fmt(summary?.[role]?.cpuPercent, 1);
const mem = (
  summary: RoleSummary | undefined | null,
  role: ProcessRole | "appTotal",
) => fmt(summary?.[role]?.footprintMb, 0);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export const BASE = "base";

/** "standard", "standard full", "standard full drift-20 #2". */
export function variantLabel(tier: TierResult): string {
  return [
    tier.tier,
    tier.fullEffects ? "full" : null,
    tier.variant && tier.variant !== BASE ? tier.variant : null,
    tier.run > 1 ? `#${tier.run}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function rowsFor(
  results: BaselineResults,
  build: (app: AppResult, tier: TierResult) => string[] | null,
): string[][] {
  const rows: string[][] = [];
  for (const app of results.apps) {
    for (const tier of app.tiers) {
      const row = build(app, tier);
      if (row) rows.push([app.app.name, variantLabel(tier), ...row]);
    }
  }
  return rows;
}

/** Headline metrics compared across repeats and between switch off and on. */
export const SPREAD_METRICS: readonly {
  key: string;
  label: string;
  digits: number;
  read: (tier: TierResult) => number | null | undefined;
}[] = [
  {
    key: "idleAppCpu",
    label: "Idle app CPU %",
    digits: 1,
    read: (t) => t.idle.cpu.appTotal?.cpuPercent,
  },
  {
    key: "idleGpuActive",
    label: "Idle GPU active %",
    digits: 1,
    read: (t) => t.idle.power?.gpuActivePercent,
  },
  {
    key: "idleGpuMw",
    label: "Idle GPU mW",
    digits: 0,
    read: (t) => t.idle.power?.gpuPowerMw,
  },
  {
    key: "idleRendererCpu",
    label: "Idle renderer CPU %",
    digits: 1,
    read: (t) => t.idle.cpu.renderer?.cpuPercent,
  },
  {
    key: "idleScriptMs",
    label: "Idle renderer script ms",
    digits: 0,
    read: (t) => t.idle.pageMetrics?.ScriptDurationMs,
  },
  {
    key: "idleTaskMs",
    label: "Idle renderer task ms",
    digits: 0,
    read: (t) => t.idle.pageMetrics?.TaskDurationMs,
  },
  {
    key: "idleRequests",
    label: "Idle page requests",
    digits: 0,
    read: (t) => t.idle.requests,
  },
  {
    key: "backgroundAppCpu",
    label: "Background app CPU %",
    digits: 1,
    read: (t) => t.background?.cpu.appTotal?.cpuPercent,
  },
  {
    key: "backgroundRendererCpu",
    label: "Background renderer CPU %",
    digits: 1,
    read: (t) => t.background?.cpu.renderer?.cpuPercent,
  },
  {
    key: "backgroundScriptMs",
    label: "Background renderer script ms",
    digits: 0,
    read: (t) => t.background?.pageMetrics.ScriptDurationMs,
  },
  {
    key: "idleFps",
    label: "Idle fps (presented)",
    digits: 1,
    read: (t) => t.idleFps?.fps,
  },
  {
    key: "glassArea",
    label: "Glass area %",
    digits: 1,
    read: (t) => t.glass?.areaPercent,
  },
  {
    key: "glassSurfaces",
    label: "Glass surfaces",
    digits: 0,
    read: (t) => t.glass?.surfaces,
  },
  {
    key: "scrollFps",
    label: "Scroll FPS",
    digits: 1,
    read: (t) => t.scroll?.frames.fps,
  },
  {
    key: "scrollGpuMw",
    label: "Scroll GPU mW",
    digits: 0,
    read: (t) => t.scroll?.power?.gpuPowerMw,
  },
  {
    key: "traceScrollDrawFrameMs",
    label: "Traced ledger scroll viz DrawFrame ms",
    digits: 0,
    read: (t) => t.trace?.segments.scroll?.compositor.drawFrameMs,
  },
  {
    key: "traceScrollRenderPasses",
    label: "Traced ledger scroll render passes per frame",
    digits: 1,
    read: (t) => t.trace?.segments.scroll?.compositor.renderPassesPerFrame,
  },
  ...WINDOW_SCROLL_PAGES.flatMap((page) => {
    const of = (t: TierResult) =>
      t.windowScroll?.find((entry) => entry.page === page);
    return [
      {
        key: `windowScrollFps:${page}`,
        label: `Window scroll ${page} FPS`,
        digits: 1,
        read: (t: TierResult) => of(t)?.frames.fps,
      },
      {
        key: `windowScrollGpuMw:${page}`,
        label: `Window scroll ${page} GPU mW`,
        digits: 0,
        read: (t: TierResult) => of(t)?.power?.gpuPowerMw,
      },
      {
        key: `windowScrollRendererCpu:${page}`,
        label: `Window scroll ${page} renderer CPU %`,
        digits: 1,
        read: (t: TierResult) => of(t)?.cpu.renderer?.cpuPercent,
      },
    ];
  }),
  {
    key: "chatStreamFps",
    label: "Chat stream FPS",
    digits: 1,
    read: (t) => t.chatStream?.frames.fps,
  },
  {
    key: "chatStreamGpuMw",
    label: "Chat stream GPU mW",
    digits: 0,
    read: (t) => t.chatStream?.power?.gpuPowerMw,
  },
  {
    key: "chatStreamRendererCpu",
    label: "Chat stream renderer CPU %",
    digits: 1,
    read: (t) => t.chatStream?.cpu.renderer?.cpuPercent,
  },
  {
    key: "chatStreamTaskMs",
    label: "Chat stream renderer task ms",
    digits: 0,
    read: (t) => t.chatStream?.pageMetrics.TaskDurationMs,
  },
  {
    key: "switchGpuMw",
    label: "Page-switch GPU mW",
    digits: 0,
    read: (t) => t.pageSwitch?.power?.gpuPowerMw,
  },
  {
    key: "sustainedGpuMw",
    label: "Sustained GPU mW",
    digits: 0,
    read: (t) => t.sustained?.power?.gpuPowerMw,
  },
  {
    key: "sustainedPackageMw",
    label: "Sustained package mW",
    digits: 0,
    read: (t) => t.sustained?.power?.combinedPowerMw,
  },
  {
    key: "rendererAfterSustainedMb",
    label: "Renderer memory after sustained MB",
    digits: 0,
    read: (t) => t.memory.afterSustained?.renderer?.footprintMb,
  },
  {
    key: "gpuAfterSustainedMb",
    label: "GPU process memory after sustained MB",
    digits: 0,
    read: (t) => t.memory.afterSustained?.gpu?.footprintMb,
  },
  {
    key: "heapAfterSustainedMb",
    label: "JS heap used after sustained MB",
    digits: 1,
    read: (t) => t.sustained?.pageMetrics.JSHeapUsedSizeMb,
  },
  {
    key: "nodesAfterSustained",
    label: "DOM nodes after sustained",
    digits: 0,
    read: (t) => t.sustained?.pageMetrics.Nodes,
  },
  {
    key: "launchMs",
    label: "Launch ms",
    digits: 0,
    read: (t) => t.launch.spawnToRendererReadyMs,
  },
  {
    key: "memoryAfterLaunchMb",
    label: "App memory after launch MB",
    digits: 0,
    read: (t) => t.memory.afterLaunch.appTotal?.footprintMb,
  },
  {
    key: "backendAfterLaunchMb",
    label: "Backend memory after launch MB (shared once)",
    digits: 1,
    read: (t) => t.memory.afterLaunch.backend?.sharedOnceMb,
  },
  {
    key: "postgresAfterLaunchMb",
    label: "PostgreSQL memory after launch MB (shared once)",
    digits: 1,
    read: (t) => t.memory.afterLaunch.postgres?.sharedOnceMb,
  },
];

export interface Spread {
  n: number;
  median: number;
  min: number;
  max: number;
}

export function spreadOf(values: (number | null | undefined)[]): Spread | null {
  const finite = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  return {
    n: finite.length,
    median: median(finite) as number,
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

/**
 * Off vs on is "beyond noise" only when the two ranges over the repeats do
 * not overlap. With one run per side there is no range, so it is never
 * claimed.
 */
export function beyondNoise(off: Spread | null, on: Spread | null): boolean {
  if (!off || !on || off.n < 2 || on.n < 2) return false;
  return off.max < on.min || on.max < off.min;
}

function formatSpread(spread: Spread | null, digits: number): string {
  if (!spread) return dash;
  if (spread.n === 1) return fmt(spread.median, digits);
  return `${fmt(spread.median, digits)} (${fmt(spread.min, digits)}–${fmt(spread.max, digits)})`;
}

interface VariantGroup {
  app: string;
  tier: Tier;
  off: TierResult[];
  on: TierResult[];
}

function groupVariants(results: BaselineResults): VariantGroup[] {
  const groups = new Map<string, VariantGroup>();
  for (const app of results.apps) {
    for (const tier of app.tiers) {
      if (tier.variant && tier.variant !== BASE) continue;
      const key = `${app.app.name}|${tier.tier}`;
      let group = groups.get(key);
      if (!group) {
        group = { app: app.app.name, tier: tier.tier, off: [], on: [] };
        groups.set(key, group);
      }
      (tier.fullEffects ? group.on : group.off).push(tier);
    }
  }
  return [...groups.values()];
}

/** Rows of: app, tier, metric, off, on, delta of medians, beyond noise. */
export function comparisonRows(results: BaselineResults): string[][] {
  const rows: string[][] = [];
  for (const group of groupVariants(results)) {
    for (const metric of SPREAD_METRICS) {
      const off = spreadOf(group.off.map(metric.read));
      const on = spreadOf(group.on.map(metric.read));
      if (!off && !on) continue;
      const delta =
        off && on && off.median !== 0
          ? `${on.median - off.median >= 0 ? "+" : ""}${fmt(((on.median - off.median) / Math.abs(off.median)) * 100, 0)}%`
          : dash;
      rows.push([
        group.app,
        group.tier,
        metric.label,
        formatSpread(off, metric.digits),
        formatSpread(on, metric.digits),
        delta,
        off && on ? (beyondNoise(off, on) ? "yes" : "no") : dash,
      ]);
    }
  }
  return rows;
}

/**
 * Rows of: app, tier, Full effects, variant, metric, base, variant, delta of
 * medians, beyond noise. Each variant is compared with the base runs of the
 * same app, tier and switch state.
 */
export function variantComparisonRows(results: BaselineResults): string[][] {
  const rows: string[][] = [];
  for (const app of results.apps) {
    const groups = new Map<string, TierResult[]>();
    for (const tier of app.tiers) {
      const key = `${tier.tier}|${tier.fullEffects}|${tier.variant ?? BASE}`;
      groups.set(key, [...(groups.get(key) ?? []), tier]);
    }
    for (const [key, runs] of groups) {
      const [tierName, full, variant] = key.split("|") as [
        string,
        string,
        string,
      ];
      if (variant === BASE) continue;
      const base = groups.get(`${tierName}|${full}|${BASE}`) ?? [];
      for (const metric of SPREAD_METRICS) {
        const baseSpread = spreadOf(base.map(metric.read));
        const variantSpread = spreadOf(runs.map(metric.read));
        if (!baseSpread && !variantSpread) continue;
        const delta =
          baseSpread && variantSpread && baseSpread.median !== 0
            ? `${variantSpread.median - baseSpread.median >= 0 ? "+" : ""}${fmt(((variantSpread.median - baseSpread.median) / Math.abs(baseSpread.median)) * 100, 0)}%`
            : dash;
        rows.push([
          app.app.name,
          tierName,
          full === "true" ? "on" : "off",
          variant,
          metric.label,
          formatSpread(baseSpread, metric.digits),
          formatSpread(variantSpread, metric.digits),
          delta,
          baseSpread && variantSpread
            ? beyondNoise(baseSpread, variantSpread)
              ? "yes"
              : "no"
            : dash,
        ]);
      }
    }
  }
  return rows;
}

export function renderSummary(results: BaselineResults): string {
  const out: string[] = [];
  const m = results.machine;
  out.push(`# Vision Mac performance baseline`);
  out.push("");
  out.push(
    `Run ${results.startedAt} → ${results.finishedAt}. ${m.model ?? "Mac"}, ${m.chip ?? "?"}, ${fmt(Number(m.memoryGb), 0)} GB, macOS ${m.macos ?? "?"}. Power: ${m.powerSource ?? "?"}. Low Power Mode: ${m.lowPowerMode ?? "?"}. Repo HEAD ${results.repoHead ?? "?"}.`,
  );
  out.push("");
  out.push(
    `Options: ${Object.entries(results.options)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ")}.`,
  );
  out.push("");

  const comparison = comparisonRows(results);
  if (comparison.length > 0) {
    out.push("## Headline: Full effects off vs on (median, min–max over repeats)");
    out.push(
      'A difference counts as beyond noise only when the off and on ranges do not overlap (needs --repeat 2 or more). Delta is on vs off, relative to the off median.',
    );
    out.push("");
    out.push(
      table(
        ["App", "Tier", "Metric", "Off", "On", "Delta", "Beyond noise"],
        comparison,
      ),
    );
    out.push("");
  }

  const variantComparison = variantComparisonRows(results);
  if (variantComparison.length > 0) {
    out.push("## Variants vs base (median, min–max over repeats)");
    out.push(
      "Each variant against the base runs with the same tier and Full effects state. Beyond noise needs non-overlapping ranges (--repeat 2 or more). Variant runs with --variants-only-idle only have idle metrics.",
    );
    out.push("");
    out.push(
      table(
        [
          "App",
          "Tier",
          "Full effects",
          "Variant",
          "Metric",
          "Base",
          "Variant value",
          "Delta",
          "Beyond noise",
        ],
        variantComparison,
      ),
    );
    out.push("");
  }

  out.push("## App bundles");
  out.push(
    table(
      ["App", "Version", "Bundle mtime", "Size MB", "Largest parts (MB)"],
      results.apps.map(({ app }) => [
        app.name,
        app.version,
        app.bundleMtime,
        fmt(app.sizeMb, 0),
        Object.entries(app.sizeBreakdownMb)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([part, size]) => `${part} ${fmt(size, 0)}`)
          .join(", "),
      ]),
    ),
  );
  out.push("");

  const gpuRows = results.apps
    .filter((app) => app.gpuInfo)
    .map(({ app, gpuInfo }) => {
      const info = gpuInfo as GpuInfo;
      const pairs = (entries: Record<string, unknown>) =>
        Object.entries(entries)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(", ") || dash;
      return [
        app.name,
        info.devices
          .map((device) => device.deviceString || device.vendorString)
          .filter(Boolean)
          .join(", ") || dash,
        info.graphite ?? dash,
        pairs(info.skia),
        pairs(info.overlay),
        pairs(info.featureStatus),
      ];
    });
  if (gpuRows.length > 0) {
    out.push("## GPU (chrome://gpu, SystemInfo.getInfo at the setup launch)");
    out.push(
      "The full readout, command line included, is in results.json (apps[].gpuInfo) and gpu-info/.",
    );
    out.push("");
    out.push(
      table(
        ["App", "GPU", "Graphite", "Skia", "Overlay", "Feature status"],
        gpuRows,
      ),
    );
    out.push("");
  }

  out.push("## Launch");
  out.push(
    table(
      [
        "App",
        "Tier",
        "Spawn → renderer ready ms",
        "Main: renderer_ready ms",
        "Main: launch_total ms",
        "native_runtime_start ms",
      ],
      rowsFor(results, (_app, tier) => [
        fmt(tier.launch.spawnToRendererReadyMs),
        fmt(tier.launch.phases.renderer_ready),
        fmt(tier.launch.phases.launch_total),
        fmt(tier.launch.phases.native_runtime_start),
      ]),
    ),
  );
  out.push("");

  out.push("## Idle");
  out.push(
    "CPU in % of one core. GPU and power from powermetrics (whole machine). Idle fps is presented frames/s from a 10 s Chromium trace at the end of the idle window (needs the trace pass or --idle-trace); glass columns count elements with a backdrop-filter, clipped to the viewport (nested surfaces add up).",
  );
  out.push("");
  out.push(
    table(
      [
        "App",
        "Tier",
        "Effective",
        "App CPU",
        "Renderer",
        "GPU proc",
        "Main",
        "Backend",
        "Postgres",
        "WindowServer",
        "GPU active %",
        "GPU mW",
        "Package mW",
        "Idle fps",
        "Glass area %",
        "Glass surfaces",
      ],
      rowsFor(results, (_app, tier) => [
        tier.effective.tier,
        cpu(tier.idle.cpu, "appTotal"),
        cpu(tier.idle.cpu, "renderer"),
        cpu(tier.idle.cpu, "gpu"),
        cpu(tier.idle.cpu, "main"),
        cpu(tier.idle.cpu, "backend"),
        cpu(tier.idle.cpu, "postgres"),
        cpu(tier.idle.cpu, "windowserver"),
        fmt(tier.idle.power?.gpuActivePercent, 1),
        fmt(tier.idle.power?.gpuPowerMw),
        fmt(tier.idle.power?.combinedPowerMw),
        fmt(tier.idleFps?.fps, 1),
        fmt(tier.glass?.areaPercent, 1),
        fmt(tier.glass?.surfaces),
      ]),
    ),
  );
  out.push("");

  const actionRow = (action: ActionMeasurement) => [
    fmt(action.frames.fps, 1),
    fmt(action.frames.droppedPercent, 1),
    fmt(action.frames.p95Ms, 1),
    String(action.frames.longFrames),
    cpu(action.cpu, "appTotal"),
    cpu(action.cpu, "renderer"),
    cpu(action.cpu, "gpu"),
    fmt(action.power?.gpuActivePercent, 1),
    fmt(action.power?.gpuPowerMw),
    fmt(action.power?.combinedPowerMw),
  ];
  const actionHeader = [
    "FPS",
    "Dropped %",
    "p95 frame ms",
    "Frames >50 ms",
    "App CPU",
    "Renderer",
    "GPU proc",
    "GPU active %",
    "GPU mW",
    "Package mW",
  ];

  out.push("## Ledger scroll");
  out.push(
    table(
      ["App", "Tier", "Method", ...actionHeader],
      rowsFor(results, (_app, tier) =>
        tier.scroll ? [tier.scroll.method, ...actionRow(tier.scroll)] : null,
      ),
    ),
  );
  out.push("");

  const windowRows: string[][] = [];
  for (const app of results.apps) {
    for (const tier of app.tiers) {
      for (const entry of tier.windowScroll ?? []) {
        windowRows.push([
          app.app.name,
          variantLabel(tier),
          entry.page,
          entry.method,
          `${fmt(entry.reachedScrollTop)} / ${fmt(entry.scrollHeight)}`,
          ...actionRow(entry),
        ]);
      }
    }
  }
  if (windowRows.length > 0) {
    out.push("## Window scroll (--segment window-scroll)");
    out.push(
      "The document itself scrolls (AppLayout's window scroller) under the sticky topbar. Reached is the scrollTop at the bottom of the down pass; a page shorter than the requested distance stops early while the gesture runs on.",
    );
    out.push("");
    out.push(
      table(
        ["App", "Tier", "Page", "Method", "Reached / height px", ...actionHeader],
        windowRows,
      ),
    );
    out.push("");
  }

  const chatRows = rowsFor(results, (_app, tier) => {
    const chat = tier.chatStream;
    if (!chat) return null;
    return [
      `${chat.tokensSent}/${chat.tokens} at ${chat.tokensPerSecond}/s`,
      fmt(chat.streamMs === null ? null : chat.streamMs / 1000, 1),
      chat.method,
      chat.completed && chat.rendered ? "yes" : "no",
      ...actionRow(chat),
      fmt(chat.pageMetrics.ScriptDurationMs),
      fmt(chat.pageMetrics.TaskDurationMs),
    ];
  });
  if (chatRows.length > 0) {
    out.push("## Chat streaming (--segment chat-stream)");
    out.push(
      "A mocked answer (page-side fetch shim, no Ollama, nothing stored) streamed through the chat page's real send path and aiChatStreamStore. Rendered: the stream completed and the transcript showed its last word.",
    );
    out.push("");
    out.push(
      table(
        [
          "App",
          "Tier",
          "Tokens",
          "Stream s",
          "Method",
          "Rendered",
          ...actionHeader,
          "Script ms",
          "Task ms",
        ],
        chatRows,
      ),
    );
    out.push("");
  }

  out.push("## Page switches");
  out.push(
    table(
      ["App", "Tier", "Median settle ms (pass 1 / 2)", ...actionHeader],
      rowsFor(results, (_app, tier) => {
        if (!tier.pageSwitch) return null;
        const medians = tier.pageSwitch.passes
          .map((pass) => fmt(median(pass.map((step) => step.settleMs))))
          .join(" / ");
        return [medians, ...actionRow(tier.pageSwitch)];
      }),
    ),
  );
  out.push("");

  out.push("## Sustained run (throttling check)");
  out.push("First minute → last minute.");
  out.push("");
  out.push(
    table(
      [
        "App",
        "Tier",
        "Seconds",
        "GPU MHz",
        "GPU active %",
        "GPU mW",
        "Package mW",
        "FPS (first → last 10 s)",
        "Thermal pressure",
        "App CPU",
      ],
      rowsFor(results, (_app, tier) => {
        const s = tier.sustained;
        if (!s) return null;
        const pair = (
          a: number | null | undefined,
          b: number | null | undefined,
          digits = 0,
        ) => `${fmt(a, digits)} → ${fmt(b, digits)}`;
        return [
          String(s.seconds),
          pair(s.powerFirstMinute?.gpuFreqMhz, s.powerLastMinute?.gpuFreqMhz),
          pair(
            s.powerFirstMinute?.gpuActivePercent,
            s.powerLastMinute?.gpuActivePercent,
            1,
          ),
          pair(s.powerFirstMinute?.gpuPowerMw, s.powerLastMinute?.gpuPowerMw),
          pair(
            s.powerFirstMinute?.combinedPowerMw,
            s.powerLastMinute?.combinedPowerMw,
          ),
          pair(s.fpsPer10s[0], s.fpsPer10s.at(-1), 1),
          Object.entries(s.power?.thermalPressure ?? {})
            .map(([state, count]) => `${state} ${count}`)
            .join(", ") || dash,
          cpu(s.cpu, "appTotal"),
        ];
      }),
    ),
  );
  out.push("");

  out.push("## Memory footprint (MB)");
  out.push("After launch / after the sustained run.");
  out.push("");
  const roles: (ProcessRole | "appTotal")[] = [
    "appTotal",
    "main",
    "renderer",
    "gpu",
    "network",
    "utility",
    "backend",
    "postgres",
  ];
  out.push(
    table(
      [
        "App",
        "Tier",
        ...roles.map((role) => (role === "appTotal" ? "App total" : role)),
      ],
      rowsFor(results, (_app, tier) =>
        roles.map(
          (role) =>
            `${mem(tier.memory.afterLaunch, role)} / ${mem(tier.memory.afterSustained, role)}`,
        ),
      ),
    ),
  );
  out.push("");
  out.push("## Backend and PostgreSQL memory (MB)");
  out.push(
    "After launch / after the sustained run. Summed adds up each process's footprint, so memory the PostgreSQL processes share is counted once per process; shared once is footprint(1) over the role's processes together.",
  );
  out.push("");
  const backendCell = (
    summary: RoleSummary | undefined | null,
    role: "backend" | "postgres",
    field: "processes" | "footprintMb" | "sharedOnceMb",
  ) => fmt(summary?.[role]?.[field], field === "processes" ? 0 : 1);
  out.push(
    table(
      [
        "App",
        "Tier",
        "backend summed",
        "backend shared once",
        "postgres processes",
        "postgres summed",
        "postgres shared once",
      ],
      rowsFor(results, (_app, tier) =>
        (
          [
            ["backend", "footprintMb"],
            ["backend", "sharedOnceMb"],
            ["postgres", "processes"],
            ["postgres", "footprintMb"],
            ["postgres", "sharedOnceMb"],
          ] as const
        ).map(
          ([role, field]) =>
            `${backendCell(tier.memory.afterLaunch, role, field)} / ${backendCell(tier.memory.afterSustained, role, field)}`,
        ),
      ),
    ),
  );
  out.push("");
  if (results.ollama.memory?.ollama) {
    out.push(
      `Ollama at start: ${results.ollama.memory.ollama.processes} processes, ${fmt(results.ollama.memory.ollama.footprintMb)} MB footprint.`,
    );
    out.push("");
  }

  const traced = rowsFor(results, (_app, tier) => {
    if (!tier.trace) return null;
    const lines = Object.entries(tier.trace.segments).map(
      ([segment, summary]) => {
        const states = Object.entries(summary.frameStates)
          .map(
            ([process, counts]) =>
              `${process.split(" ")[0]}: ${Object.entries(counts)
                .map(
                  ([state, count]) =>
                    `${state.replace(/^STATE_/, "")} ${count}`,
                )
                .join(" ")}`,
          )
          .join("; ");
        const renderer = Object.entries(summary.threadBusyMs)
          .filter(([key]) => key.endsWith("/CrRendererMain"))
          .reduce((sum, [, value]) => sum + value, 0);
        const gpu = Object.entries(summary.threadBusyMs)
          .filter(([key]) => /\/(CrGpuMain|VizCompositorThread)$/.test(key))
          .reduce((sum, [, value]) => sum + value, 0);
        const cc = summary.compositor;
        return `${segment} (${fmt(summary.durationMs)} ms): renderer main ${fmt(renderer)} ms, GPU/viz ${fmt(gpu)} ms; viz DrawFrame ${cc.drawFrames}× ${fmt(cc.drawFrameMs)} ms, render passes/frame ${fmt(cc.renderPassesPerFrame, 1)}, raster ${cc.rasterTasks}× ${fmt(cc.rasterTaskMs)} ms, GPU raster ${fmt(cc.gpuRasterMs)} ms; frames ${states || dash}`;
      },
    );
    return [lines.join("<br>")];
  });
  if (traced.length > 0) {
    out.push("## Chromium trace (separate traced pass)");
    out.push(table(["App", "Tier", "Segments"], traced));
    out.push("");
  }

  const warnings = [
    ...results.warnings,
    ...results.apps.flatMap((app) => [
      ...(app.error ? [`${app.app.name}: ${app.error}`] : []),
      ...(app.restored || app.originalTier === null
        ? []
        : [
            `${app.app.name}: tier setting NOT restored (was ${app.originalTier}).`,
          ]),
      ...app.tiers.flatMap((tier) =>
        tier.warnings.map(
          (warning) => `${app.app.name} ${variantLabel(tier)}: ${warning}`,
        ),
      ),
    ]),
  ];
  out.push("## Warnings");
  out.push(
    warnings.length > 0
      ? warnings.map((warning) => `- ${warning}`).join("\n")
      : "None.",
  );
  out.push("");
  return out.join("\n");
}

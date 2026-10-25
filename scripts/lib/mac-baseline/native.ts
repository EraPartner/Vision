/**
 * The native (Swift) app in the Mac performance baseline: the shape of the
 * app's own results.json (apps/native/Sources/VisionNativeCore/Perf/
 * PerfRunModel.swift), window summaries that join it with the harness's
 * process samples and powermetrics stream, and the side-by-side section for
 * summary.md. Pure functions only; scripts/mac-baseline.ts does the I/O.
 */
import { computeFrameStats, fpsBuckets, type FrameStats } from "./frames.ts";
import type { PowerSummary } from "./powermetrics.ts";
import {
  summarizeRoles,
  type ProcessRole,
  type PsRow,
  type RoleStats,
  type RoleSummary,
} from "./processes.ts";
import {
  median,
  variantLabel,
  type AppInfo,
  type BaselineResults,
  type TierResult,
} from "./report.ts";

export type NativePhaseName = "idle" | "scroll" | "pageSwitch" | "sustained";

export const NATIVE_PHASES: readonly NativePhaseName[] = [
  "idle",
  "scroll",
  "pageSwitch",
  "sustained",
];

export interface NativePhase {
  name: NativePhaseName;
  startEpochMs: number;
  endEpochMs: number;
  wallMs: number;
  cpuSeconds: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
  footprintStartMb: number;
  footprintEndMb: number;
  framesTracked: boolean;
  /** Display-link timestamps in ms: the shape of the Electron harness's RawFrames.stamps. */
  frameStampsMs: number[];
  frames: {
    frames: number;
    refreshMs: number;
    hitches: number;
    maxIntervalMs: number;
  } | null;
  steps: { path: string; settleMs: number; timedOut: boolean }[];
  scroll: { found: boolean; distancePx: number; durationMs: number } | null;
  cycles: number | null;
  windowVisibleAtEnd: boolean;
  appActiveAtEnd: boolean;
}

export interface NativePerfResults {
  schemaVersion: 1;
  app: {
    name: string;
    bundleIdentifier: string;
    variant: string;
    version: string;
    pid: number;
  };
  machine: {
    maximumFramesPerSecond: number;
    backingScale: number;
    windowPixelsWide: number;
    windowPixelsHigh: number;
    lowPowerMode: boolean;
    thermalState: number;
  } | null;
  options: { idleSeconds: number; sustainedSeconds: number };
  processStartEpochMs: number;
  readyEpochMs: number | null;
  launchToReadyMs: number | null;
  afterLaunch: { cpuSeconds: number; footprintMb: number } | null;
  phases: NativePhase[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the parts the summary reads; anything else is carried as is. */
export function parseNativePerfResults(text: string): NativePerfResults {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`results.json is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error("results.json is not a native perf run (schemaVersion 1)");
  }
  if (!isRecord(raw.app) || !Array.isArray(raw.phases)) {
    throw new Error("results.json has no app or phases");
  }
  for (const phase of raw.phases) {
    if (
      !isRecord(phase) ||
      !NATIVE_PHASES.includes(phase.name as NativePhaseName) ||
      typeof phase.startEpochMs !== "number" ||
      typeof phase.endEpochMs !== "number" ||
      !Array.isArray(phase.frameStampsMs)
    ) {
      throw new Error("results.json has a malformed phase");
    }
  }
  const results = raw as unknown as NativePerfResults;
  return {
    ...results,
    machine: results.machine ?? null,
    readyEpochMs: results.readyEpochMs ?? null,
    launchToReadyMs: results.launchToReadyMs ?? null,
    afterLaunch: results.afterLaunch ?? null,
    error: results.error ?? null,
    phases: results.phases.map((phase) => ({
      ...phase,
      frames: phase.frames ?? null,
      scroll: phase.scroll ?? null,
      cycles: phase.cycles ?? null,
      steps: phase.steps ?? [],
    })),
  };
}

// ── Process samples ──────────────────────────────────────────────────────────

/** ps rows of the app's roles at one moment (wall clock, ms). */
export interface PsSample {
  t: number;
  rows: PsRow[];
  roles: Map<number, ProcessRole>;
}

/** The backend and PostgreSQL footprint at one moment. */
export interface MemorySample {
  t: number;
  backend: Pick<RoleStats, "processes" | "footprintMb" | "sharedOnceMb"> | null;
  postgres: Pick<
    RoleStats,
    "processes" | "footprintMb" | "sharedOnceMb"
  > | null;
}

/** The sample closest to `t`; ties go to the earlier one. */
export function nearestSample<T extends { t: number }>(
  samples: readonly T[],
  t: number,
): T | null {
  let best: T | null = null;
  for (const sample of samples) {
    if (best === null || Math.abs(sample.t - t) < Math.abs(best.t - t)) {
      best = sample;
    }
  }
  return best;
}

/**
 * CPU per role over [startMs, endMs] from the two process samples nearest to
 * the window edges. The rate divides by the samples' own spacing, so a sample
 * that lands a little off the edge does not skew it. Null when no two distinct
 * samples bracket the window.
 */
export function windowCpu(
  samples: readonly PsSample[],
  startMs: number,
  endMs: number,
): RoleSummary | null {
  const before = nearestSample(samples, startMs);
  const after = nearestSample(samples, endMs);
  if (!before || !after || after.t <= before.t) return null;
  return summarizeRoles(after.rows, after.roles, {
    before: before.rows,
    wallSeconds: (after.t - before.t) / 1000,
  });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Footprint per role at `t`: the app's own phys_footprint for the main
 * process (the app reports it), the harness's footprint(1) samples for the
 * backend and PostgreSQL. App total sums the roles' summed footprints, the
 * convention of the Electron tables.
 */
export function memoryAt(
  mainFootprintMb: number | null,
  samples: readonly MemorySample[],
  t: number,
): RoleSummary {
  const summary: RoleSummary = {};
  const sample = nearestSample(samples, t);
  let total = 0;
  let any = false;
  if (mainFootprintMb !== null) {
    summary.main = {
      processes: 1,
      rssMb: round1(mainFootprintMb),
      footprintMb: round1(mainFootprintMb),
      cpuPercent: null,
    };
    total += mainFootprintMb;
    any = true;
  }
  for (const role of ["backend", "postgres"] as const) {
    const stats = sample?.[role];
    if (!stats) continue;
    summary[role] = {
      processes: stats.processes,
      rssMb: stats.footprintMb ?? 0,
      footprintMb: stats.footprintMb,
      sharedOnceMb: stats.sharedOnceMb ?? null,
      cpuPercent: null,
    };
    total += stats.footprintMb ?? 0;
    any = true;
  }
  if (any) {
    summary.appTotal = {
      processes: 1,
      rssMb: round1(total),
      footprintMb: round1(total),
      cpuPercent: null,
    };
  }
  return summary;
}

// ── Summaries ────────────────────────────────────────────────────────────────

export interface NativeWindow {
  name: NativePhaseName;
  wallMs: number;
  /** Same fields as the Electron frame stats; null for the idle window (no display link). */
  frames: FrameStats | null;
  /** Frames later than 1.5x the refresh interval, counted by the app. */
  hitches: number | null;
  /** The app's own getrusage CPU over the window, in % of one core. */
  inAppCpuPercent: number | null;
  footprintEndMb: number;
  /** ps CPU per role over the window. */
  cpu: RoleSummary | null;
  power: PowerSummary | null;
  fpsPer10s: number[];
  settleMedianMs: number | null;
  settleMaxMs: number | null;
  cycles: number | null;
  timedOutSteps: number;
  scroll: { found: boolean; distancePx: number; durationMs: number } | null;
  windowVisibleAtEnd: boolean;
  appActiveAtEnd: boolean;
}

export interface NativeAppResult {
  app: AppInfo;
  variant: string;
  launchToReadyMs: number | null;
  display: NativePerfResults["machine"];
  memory: {
    afterLaunch: RoleSummary;
    afterIdle: RoleSummary;
    afterSustained: RoleSummary | null;
  };
  windows: Partial<Record<NativePhaseName, NativeWindow>>;
  warnings: string[];
  error: string | null;
}

export function summarizePhase(
  phase: NativePhase,
  inputs: {
    samples: readonly PsSample[];
    power: (startMs: number, endMs: number) => PowerSummary | null;
  },
): NativeWindow {
  const frames =
    phase.framesTracked && phase.frameStampsMs.length > 1
      ? computeFrameStats({ stamps: phase.frameStampsMs, loaf: [] })
      : null;
  const settles = phase.steps.map((step) => step.settleMs);
  return {
    name: phase.name,
    wallMs: phase.wallMs,
    frames,
    hitches: phase.frames?.hitches ?? null,
    inAppCpuPercent:
      phase.wallMs > 0
        ? round1((phase.cpuSeconds / (phase.wallMs / 1000)) * 100)
        : null,
    footprintEndMb: phase.footprintEndMb,
    cpu: windowCpu(inputs.samples, phase.startEpochMs, phase.endEpochMs),
    power: inputs.power(phase.startEpochMs, phase.endEpochMs),
    fpsPer10s:
      phase.name === "sustained" ? fpsBuckets(phase.frameStampsMs, 10_000) : [],
    settleMedianMs: median(settles),
    settleMaxMs: settles.length > 0 ? Math.max(...settles) : null,
    cycles: phase.cycles,
    timedOutSteps: phase.steps.filter((step) => step.timedOut).length,
    scroll: phase.scroll,
    windowVisibleAtEnd: phase.windowVisibleAtEnd,
    appActiveAtEnd: phase.appActiveAtEnd,
  };
}

export function summarizeNativeRun(input: {
  app: AppInfo;
  results: NativePerfResults;
  samples: readonly PsSample[];
  memory: readonly MemorySample[];
  power: (startMs: number, endMs: number) => PowerSummary | null;
}): NativeAppResult {
  const { results } = input;
  const windows: NativeAppResult["windows"] = {};
  for (const phase of results.phases) {
    windows[phase.name] = summarizePhase(phase, input);
  }
  const phase = (name: NativePhaseName) =>
    results.phases.find((candidate) => candidate.name === name);
  const idle = phase("idle");
  const sustained = phase("sustained");
  const warnings: string[] = [];
  for (const window of Object.values(windows)) {
    if (!window.windowVisibleAtEnd || !window.appActiveAtEnd) {
      warnings.push(
        `${window.name}: the window was hidden or the app inactive at the end of the window`,
      );
    }
    if (window.timedOutSteps > 0) {
      warnings.push(
        `${window.name}: ${window.timedOutSteps} page switch(es) timed out`,
      );
    }
    if (window.scroll && !window.scroll.found) {
      warnings.push(`${window.name}: no scrollable ledger was found`);
    }
  }
  if (results.error) warnings.push(`app: ${results.error}`);
  const readyAt = results.readyEpochMs;
  return {
    app: input.app,
    variant: results.app.variant,
    launchToReadyMs: results.launchToReadyMs,
    display: results.machine,
    memory: {
      afterLaunch: memoryAt(
        results.afterLaunch?.footprintMb ?? null,
        input.memory,
        readyAt === null ? (idle?.startEpochMs ?? 0) : readyAt + 10_000,
      ),
      afterIdle: memoryAt(
        idle?.footprintEndMb ?? null,
        input.memory,
        idle?.endEpochMs ?? 0,
      ),
      afterSustained: sustained
        ? memoryAt(sustained.footprintEndMb, input.memory, sustained.endEpochMs)
        : null,
    },
    windows,
    warnings,
    error: results.error,
  };
}

// ── Electron reference ───────────────────────────────────────────────────────

/** Run directory names (ISO stamps sort as text), newest first, without `exclude`. */
export function runNamesNewestFirst(
  names: readonly string[],
  exclude: string,
): string[] {
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name) && name !== exclude)
    .sort()
    .reverse();
}

const TIER_PREFERENCE = ["standard", "enhanced", "reduced"];

/**
 * The Electron variant to compare a native app with: the app with the same
 * edition ("Vision Native Demo" → "Vision Demo"), preferring Full effects on,
 * then the standard tier.
 */
export function pickElectronReference(
  results: BaselineResults,
  nativeName: string,
): { appName: string; tier: TierResult; runStartedAt: string } | null {
  const target = nativeName.replace(/\bNative\b\s*/, "").trim();
  const app =
    results.apps.find(
      (candidate) =>
        candidate.app.name === target && candidate.tiers.length > 0,
    ) ?? results.apps.find((candidate) => candidate.tiers.length > 0);
  if (!app) return null;
  const ranked = [...app.tiers].sort((a, b) => {
    const full = Number(b.fullEffects) - Number(a.fullEffects);
    if (full !== 0) return full;
    return (
      TIER_PREFERENCE.indexOf(a.tier) - TIER_PREFERENCE.indexOf(b.tier) ||
      a.run - b.run
    );
  });
  const tier = ranked[0];
  return tier
    ? { appName: app.app.name, tier, runStartedAt: results.startedAt }
    : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const dash = "–";
const fmt = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? dash
    : value.toFixed(digits);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

const UI_ROLES: readonly ProcessRole[] = [
  "main",
  "renderer",
  "gpu",
  "network",
  "utility",
  "other",
];

/** CPU % of the app's UI processes: Electron main, renderer and GPU together, or the Swift app. */
function uiCpu(cpu: RoleSummary | null | undefined): number | null {
  if (!cpu) return null;
  let total = 0;
  let any = false;
  for (const role of UI_ROLES) {
    const value = cpu[role]?.cpuPercent;
    if (typeof value === "number") {
      total += value;
      any = true;
    }
  }
  return any ? round1(total) : null;
}

/** CPU % of the backend and PostgreSQL together; null when neither was seen. */
function serviceCpu(cpu: RoleSummary | null | undefined): number | null {
  const backend = cpu?.backend?.cpuPercent;
  const postgres = cpu?.postgres?.cpuPercent;
  if (typeof backend !== "number" && typeof postgres !== "number") return null;
  return round1((backend ?? 0) + (postgres ?? 0));
}

interface ComparisonRow {
  label: string;
  digits: number;
  electron: number | null | undefined;
  native: number | null | undefined;
}

export function comparisonMetrics(
  native: NativeAppResult,
  electron: TierResult | null,
): ComparisonRow[] {
  const w = native.windows;
  const row = (
    label: string,
    digits: number,
    electronValue: number | null | undefined,
    nativeValue: number | null | undefined,
  ): ComparisonRow => ({
    label,
    digits,
    electron: electronValue,
    native: nativeValue,
  });
  return [
    row(
      "Launch to ready ms",
      0,
      electron?.launch.spawnToRendererReadyMs,
      native.launchToReadyMs,
    ),
    row(
      "Idle app CPU % (all processes)",
      1,
      electron?.idle.cpu.appTotal?.cpuPercent,
      w.idle?.cpu?.appTotal?.cpuPercent,
    ),
    row(
      "Idle UI process CPU %",
      1,
      uiCpu(electron?.idle.cpu),
      uiCpu(w.idle?.cpu),
    ),
    row(
      "Idle backend + PostgreSQL CPU %",
      1,
      serviceCpu(electron?.idle.cpu),
      serviceCpu(w.idle?.cpu),
    ),
    row(
      "Idle GPU active %",
      1,
      electron?.idle.power?.gpuActivePercent,
      w.idle?.power?.gpuActivePercent,
    ),
    row(
      "Idle GPU mW",
      0,
      electron?.idle.power?.gpuPowerMw,
      w.idle?.power?.gpuPowerMw,
    ),
    row(
      "Idle package mW",
      0,
      electron?.idle.power?.combinedPowerMw,
      w.idle?.power?.combinedPowerMw,
    ),
    row("Scroll FPS", 1, electron?.scroll?.frames.fps, w.scroll?.frames?.fps),
    row(
      "Scroll dropped %",
      1,
      electron?.scroll?.frames.droppedPercent,
      w.scroll?.frames?.droppedPercent,
    ),
    row(
      "Scroll p95 frame ms",
      1,
      electron?.scroll?.frames.p95Ms,
      w.scroll?.frames?.p95Ms,
    ),
    row(
      "Scroll frames >50 ms",
      0,
      electron?.scroll?.frames.longFrames,
      w.scroll?.frames?.longFrames,
    ),
    row(
      "Scroll app CPU %",
      1,
      electron?.scroll?.cpu.appTotal?.cpuPercent,
      w.scroll?.cpu?.appTotal?.cpuPercent,
    ),
    row(
      "Scroll GPU mW",
      0,
      electron?.scroll?.power?.gpuPowerMw,
      w.scroll?.power?.gpuPowerMw,
    ),
    row(
      "Page-switch FPS",
      1,
      electron?.pageSwitch?.frames.fps,
      w.pageSwitch?.frames?.fps,
    ),
    row(
      "Page-switch median settle ms",
      0,
      median(
        electron?.pageSwitch?.passes.flatMap((pass) =>
          pass.map((step) => step.settleMs),
        ) ?? [],
      ),
      w.pageSwitch?.settleMedianMs,
    ),
    row(
      "Sustained FPS",
      1,
      electron?.sustained?.frames.fps,
      w.sustained?.frames?.fps,
    ),
    row(
      "Sustained app CPU %",
      1,
      electron?.sustained?.cpu.appTotal?.cpuPercent,
      w.sustained?.cpu?.appTotal?.cpuPercent,
    ),
    row(
      "Sustained GPU mW",
      0,
      electron?.sustained?.power?.gpuPowerMw,
      w.sustained?.power?.gpuPowerMw,
    ),
    row(
      "Sustained package mW",
      0,
      electron?.sustained?.power?.combinedPowerMw,
      w.sustained?.power?.combinedPowerMw,
    ),
    row(
      "Memory after launch MB (app total)",
      0,
      electron?.memory.afterLaunch.appTotal?.footprintMb,
      native.memory.afterLaunch.appTotal?.footprintMb,
    ),
    row(
      "Memory after idle MB (app total)",
      0,
      electron?.memory.afterIdle.appTotal?.footprintMb,
      native.memory.afterIdle.appTotal?.footprintMb,
    ),
    row(
      "Memory after sustained MB (app total)",
      0,
      electron?.memory.afterSustained?.appTotal?.footprintMb,
      native.memory.afterSustained?.appTotal?.footprintMb,
    ),
  ];
}

/** Native minus Electron, relative to Electron; negative is better for every row but FPS. */
export function deltaPercent(
  electron: number | null | undefined,
  native: number | null | undefined,
): string {
  if (
    typeof electron !== "number" ||
    typeof native !== "number" ||
    !Number.isFinite(electron) ||
    !Number.isFinite(native) ||
    electron === 0
  ) {
    return dash;
  }
  const delta = ((native - electron) / Math.abs(electron)) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
}

export function renderNativeSection(
  natives: readonly NativeAppResult[],
  electronResults: BaselineResults | null,
  extraWarnings: readonly string[] = [],
): string {
  const out: string[] = [];
  out.push("## Native app (Swift)");
  out.push(
    "Measured by the app's own scripted run (`VisionPerfRun`, same phases as above): idle on Home, a ledger scroll, two page-switch passes and a sustained scroll/switch loop. Frames are display-link ticks on the main window; Electron frames are `requestAnimationFrame` callbacks. CPU is ps-sampled (1 s) over each window; GPU and power are the same whole-machine powermetrics stream.",
  );
  out.push("");
  if (natives.length === 0) {
    out.push("No native app was measured.");
    out.push("");
  }
  for (const native of natives) {
    const reference = electronResults
      ? pickElectronReference(electronResults, native.app.name)
      : null;
    out.push(`### ${native.app.name} ${native.app.version}`);
    out.push("");
    const display = native.display;
    if (display) {
      out.push(
        `Display up to ${display.maximumFramesPerSecond} Hz at ${display.backingScale}x, window ${Math.round(display.windowPixelsWide)}×${Math.round(display.windowPixelsHigh)} px (${fmt((display.windowPixelsWide * display.windowPixelsHigh) / 1e6, 1)} M). Low Power Mode: ${display.lowPowerMode ? "on" : "off"}.`,
      );
      out.push("");
    }
    if (reference) {
      out.push(
        `Compared with ${reference.appName} (${variantLabel(reference.tier)}) from the Electron run of ${reference.runStartedAt}. Delta is native vs Electron.`,
      );
    } else {
      out.push("No earlier Electron run was found to compare with.");
    }
    out.push("");
    out.push(
      table(
        ["Metric", "Electron", "Native", "Delta"],
        comparisonMetrics(native, reference?.tier ?? null).map((metric) => [
          metric.label,
          fmt(metric.electron, metric.digits),
          fmt(metric.native, metric.digits),
          deltaPercent(metric.electron, metric.native),
        ]),
      ),
    );
    out.push("");
    out.push("#### Native windows");
    out.push(
      table(
        [
          "Window",
          "Seconds",
          "FPS",
          "Dropped %",
          "p95 frame ms",
          "Hitches (>1.5x refresh)",
          "App CPU (ps)",
          "Main CPU (ps)",
          "In-app CPU",
          "GPU active %",
          "GPU mW",
          "Package mW",
        ],
        NATIVE_PHASES.flatMap((name) => {
          const w = native.windows[name];
          if (!w) return [];
          return [
            [
              name,
              fmt(w.wallMs / 1000, 0),
              fmt(w.frames?.fps, 1),
              fmt(w.frames?.droppedPercent, 1),
              fmt(w.frames?.p95Ms, 1),
              fmt(w.hitches),
              fmt(w.cpu?.appTotal?.cpuPercent, 1),
              fmt(w.cpu?.main?.cpuPercent, 1),
              fmt(w.inAppCpuPercent, 1),
              fmt(w.power?.gpuActivePercent, 1),
              fmt(w.power?.gpuPowerMw),
              fmt(w.power?.combinedPowerMw),
            ],
          ];
        }),
      ),
    );
    out.push("");
    const sustained = native.windows.sustained;
    if (sustained && sustained.fpsPer10s.length > 0) {
      out.push(
        `Sustained: ${fmt(sustained.cycles)} cycles, FPS first → last 10 s ${fmt(sustained.fpsPer10s[0], 1)} → ${fmt(sustained.fpsPer10s.at(-1), 1)}.`,
      );
      out.push("");
    }
    out.push("#### Native memory footprint (MB)");
    out.push("After launch / after idle / after the sustained run.");
    out.push("");
    const memoryCell = (role: ProcessRole | "appTotal") =>
      [
        native.memory.afterLaunch,
        native.memory.afterIdle,
        native.memory.afterSustained,
      ]
        .map((summary) => fmt(summary?.[role]?.footprintMb, 0))
        .join(" / ");
    out.push(
      table(
        ["App total", "Swift app", "Backend", "PostgreSQL"],
        [
          [
            memoryCell("appTotal"),
            memoryCell("main"),
            memoryCell("backend"),
            memoryCell("postgres"),
          ],
        ],
      ),
    );
    out.push("");
    const warnings = [...native.warnings, ...extraWarnings];
    if (warnings.length > 0) {
      out.push(warnings.map((warning) => `- ${warning}`).join("\n"));
      out.push("");
    }
  }
  return out.join("\n");
}

/**
 * Result shapes and the human summary for the Mac performance baseline.
 */
import type { FrameStats } from "./frames.ts";
import type { PowerSummary } from "./powermetrics.ts";
import type { RoleSummary, ProcessRole } from "./processes.ts";
import type { TraceSegmentSummary } from "./trace.ts";

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

export interface PageSwitch {
  path: string;
  method: string;
  settleMs: number;
  timedOut: boolean;
}

export interface TierResult {
  tier: Tier;
  /** Effective tier from <html> classes, plus atmosphere flags. */
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
  idle: WindowMeasurement & { seconds: number; page: string };
  scroll:
    | (ActionMeasurement & {
        method: string;
        requestedPx: number;
        reachedScrollTop: number;
        rowsRendered: number;
      })
    | null;
  pageSwitch: (ActionMeasurement & { passes: PageSwitch[][] }) | null;
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
  tiers: TierResult[];
  error: string | null;
}

export interface BaselineResults {
  schemaVersion: 1;
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function rowsFor(
  results: BaselineResults,
  build: (app: AppResult, tier: TierResult) => string[] | null,
): string[][] {
  const rows: string[][] = [];
  for (const app of results.apps) {
    for (const tier of app.tiers) {
      const row = build(app, tier);
      if (row) rows.push([app.app.name, tier.tier, ...row]);
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
    "CPU in % of one core. GPU and power from powermetrics (whole machine).",
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
        return `${segment} (${fmt(summary.durationMs)} ms): renderer main ${fmt(renderer)} ms, GPU/viz ${fmt(gpu)} ms; frames ${states || dash}`;
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
          (warning) => `${app.app.name} ${tier.tier}: ${warning}`,
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

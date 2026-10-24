/**
 * Leak check for the Mac performance baseline (--leak). The app alternates
 * active and idle windows; memory is sampled throughout and judged on the idle
 * samples only, so activity spikes do not look like growth.
 */

export type LeakPhase = "active" | "idle";

export interface LeakSample {
  /** Seconds since the leak run started. */
  t: number;
  cycle: number;
  phase: LeakPhase;
  /** Column → value; columns carry their unit (`backend_mb`, `postgres_processes`). */
  values: Record<string, number | null>;
}

export interface LeakVerdict {
  role: string;
  /** Median of each idle window after the warm-up, in order. */
  idleMediansMb: number[];
  /** Least-squares slope over idle samples after the warm-up. */
  slopeMbPerMin: number | null;
  verdict: "rising" | "flat" | "too short";
}

/** Growth faster than this across the idle windows counts as a leak. */
export const LEAK_SLOPE_MB_PER_MIN = 1;
/** Idle windows after the warm-up needed for a verdict. */
export const LEAK_MIN_WINDOWS = 3;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export function slopePerMinute(points: [number, number][]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den === 0 ? null : (num / den) * 60;
}

/**
 * "rising" needs both a slope above LEAK_SLOPE_MB_PER_MIN and idle-window
 * medians that went up across each of the last LEAK_MIN_WINDOWS windows, so
 * one noisy window cannot produce it.
 */
export function analyzeLeak(
  samples: readonly LeakSample[],
  role: string,
  warmupSeconds: number,
): LeakVerdict {
  const idle = samples.filter(
    (sample) =>
      sample.phase === "idle" &&
      sample.t >= warmupSeconds &&
      typeof sample.values[role] === "number",
  );
  const byCycle = new Map<number, number[]>();
  for (const sample of idle) {
    const list = byCycle.get(sample.cycle) ?? [];
    list.push(sample.values[role] as number);
    byCycle.set(sample.cycle, list);
  }
  const idleMediansMb = [...byCycle.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, values]) => Math.round(median(values) * 10) / 10);
  const slope = slopePerMinute(
    idle.map((sample) => [sample.t, sample.values[role] as number]),
  );
  const slopeMbPerMin = slope === null ? null : Math.round(slope * 100) / 100;
  if (idleMediansMb.length < LEAK_MIN_WINDOWS || slopeMbPerMin === null) {
    return { role, idleMediansMb, slopeMbPerMin, verdict: "too short" };
  }
  const last = idleMediansMb.slice(-LEAK_MIN_WINDOWS);
  const climbing = last.every(
    (value, index) => index === 0 || value > (last[index - 1] as number),
  );
  return {
    role,
    idleMediansMb,
    slopeMbPerMin,
    verdict:
      climbing && slopeMbPerMin > LEAK_SLOPE_MB_PER_MIN ? "rising" : "flat",
  };
}

export function leakCsv(
  samples: readonly LeakSample[],
  columns: readonly string[],
): string {
  const header = ["t_s", "cycle", "phase", ...columns];
  const rows = samples.map((sample) => [
    String(sample.t),
    String(sample.cycle),
    sample.phase,
    ...columns.map((column) => {
      const value = sample.values[column];
      return typeof value === "number" ? value.toFixed(1) : "";
    }),
  ]);
  return `${[header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

export interface LeakResult {
  app: string;
  version: string;
  minutes: number;
  windowSeconds: number;
  warmupSeconds: number;
  sampleSeconds: number;
  columns: string[];
  samples: LeakSample[];
  verdicts: LeakVerdict[];
  error: string | null;
}

export function renderLeakSummary(result: LeakResult): string {
  const out = [
    `# Vision leak check: ${result.app} ${result.version}`,
    "",
    `${result.minutes} min of alternating ${result.windowSeconds} s active (scroll and page switches) and ${result.windowSeconds} s idle, sampled every ${result.sampleSeconds} s. Judged on idle samples after a ${result.warmupSeconds / 60} min warm-up.`,
    `"rising" = idle-window medians went up across each of the last ${LEAK_MIN_WINDOWS} windows AND the slope is above ${LEAK_SLOPE_MB_PER_MIN} MB/min. backend_mb and postgres_mb count shared memory once (footprint(1)); the *_sum_mb columns add up each process.`,
    "",
  ];
  if (result.error) out.push(`**Stopped early:** ${result.error}`, "");
  out.push(
    "| Column | Idle medians (MB) | Slope (MB/min) | Verdict |",
    "| --- | --- | --- | --- |",
  );
  for (const verdict of result.verdicts) {
    out.push(
      `| ${verdict.role} | ${verdict.idleMediansMb.join(" → ") || "–"} | ${verdict.slopeMbPerMin ?? "–"} | ${verdict.verdict} |`,
    );
  }
  out.push(
    "",
    "Raw samples: leak.csv. Phase E (renderer, GPU) columns are recorded only.",
    "",
  );
  return out.join("\n");
}

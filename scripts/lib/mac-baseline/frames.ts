/**
 * In-page frame recording for the Mac performance baseline. A rAF loop keeps
 * the page producing frames, so it runs only during scripted actions, never
 * during the idle window.
 */

/** Starts the recorder in the page. Long animation frames come from LoAF. */
export const START_FRAME_RECORDER = `(() => {
  const state = { stamps: [], loaf: [], running: true, observer: null };
  const tick = (stamp) => {
    if (!state.running) return;
    state.stamps.push(stamp);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.loaf.push({ duration: entry.duration, blocking: entry.blockingDuration ?? 0 });
      }
    });
    state.observer.observe({ type: "long-animation-frame", buffered: false });
  } catch {}
  globalThis.__visionPerfFrames = state;
  return true;
})()`;

/** Stops the recorder and returns its raw data. */
export const STOP_FRAME_RECORDER = `(() => {
  const state = globalThis.__visionPerfFrames;
  if (!state) return { stamps: [], loaf: [] };
  state.running = false;
  state.observer?.disconnect();
  delete globalThis.__visionPerfFrames;
  return { stamps: state.stamps, loaf: state.loaf };
})()`;

export interface RawFrames {
  stamps: number[];
  loaf: { duration: number; blocking: number }[];
}

export interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number | null;
  /** Estimated display refresh interval (10th percentile frame interval). */
  refreshMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** Vsyncs missed: Σ max(0, round(interval / refresh) − 1). */
  droppedFrames: number | null;
  droppedPercent: number | null;
  /** Frames longer than 50 ms. */
  longFrames: number;
  longAnimationFrames: number;
  longAnimationFrameMs: number;
  blockingMs: number;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function computeFrameStats(raw: RawFrames): FrameStats {
  const intervals: number[] = [];
  for (let index = 1; index < raw.stamps.length; index++) {
    const previous = raw.stamps[index - 1] as number;
    const current = raw.stamps[index] as number;
    intervals.push(current - previous);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const durationMs =
    raw.stamps.length > 1
      ? (raw.stamps.at(-1) as number) - (raw.stamps[0] as number)
      : 0;
  const refresh = percentile(sorted, 10);
  let dropped: number | null = null;
  if (refresh !== null && refresh > 0) {
    dropped = 0;
    for (const interval of intervals) {
      dropped += Math.max(0, Math.round(interval / refresh) - 1);
    }
  }
  const expected =
    refresh !== null && refresh > 0 ? Math.round(durationMs / refresh) : null;
  const loafMs = raw.loaf.reduce((sum, entry) => sum + entry.duration, 0);
  const blockingMs = raw.loaf.reduce((sum, entry) => sum + entry.blocking, 0);
  const pick = (value: number | null) =>
    value === null ? null : round1(value);
  return {
    frames: raw.stamps.length,
    durationMs: Math.round(durationMs),
    fps:
      durationMs > 0
        ? round1(((raw.stamps.length - 1) * 1000) / durationMs)
        : null,
    refreshMs: pick(refresh),
    p50Ms: pick(percentile(sorted, 50)),
    p95Ms: pick(percentile(sorted, 95)),
    p99Ms: pick(percentile(sorted, 99)),
    maxMs: pick(sorted.at(-1) ?? null),
    droppedFrames: dropped,
    droppedPercent:
      dropped !== null && expected !== null && expected > 0
        ? round1((dropped / expected) * 100)
        : null,
    longFrames: intervals.filter((interval) => interval > 50).length,
    longAnimationFrames: raw.loaf.length,
    longAnimationFrameMs: Math.round(loafMs),
    blockingMs: Math.round(blockingMs),
  };
}

/** Frames per second in full fixed buckets from the first stamp (sustained runs). */
export function fpsBuckets(
  stamps: readonly number[],
  bucketMs: number,
): number[] {
  if (stamps.length === 0) return [];
  const first = stamps[0] as number;
  const full = Math.floor(((stamps.at(-1) as number) - first) / bucketMs);
  const counts = new Array<number>(full).fill(0);
  for (const stamp of stamps) {
    const bucket = Math.floor((stamp - first) / bucketMs);
    if (bucket < full) counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts.map((count) => round1((count * 1000) / bucketMs));
}

/** Performance.getMetrics delta over an action (durations in seconds → ms). */
export function metricsDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(after)) {
    const start = before[name];
    if (start === undefined) continue;
    if (/Count$/.test(name)) out[name] = value - start;
    else if (/Duration$/.test(name))
      out[`${name}Ms`] = Math.round((value - start) * 1000);
  }
  for (const name of ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes"]) {
    const value = after[name];
    if (value === undefined) continue;
    out[name.endsWith("Size") ? `${name}Mb` : name] = name.endsWith("Size")
      ? round1(value / 1024 ** 2)
      : value;
  }
  return out;
}

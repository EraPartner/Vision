/**
 * Chromium trace summaries for the Mac performance baseline. Segments are cut
 * at console.timeStamp() markers the runner drops into the page.
 */

export interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
}

/** Categories recorded for the idle fps trace. */
export const TRACE_CATEGORIES = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "benchmark",
  "viz",
  "gpu",
];

/**
 * Categories of the separate traced pass: the idle ones plus `cc` for raster
 * tasks and compositor frame production. The per-quad viz categories
 * (disabled-by-default-viz.quads) are left out: they log every quad of every
 * frame and would perturb the frames being measured.
 */
export const TRACED_PASS_CATEGORIES = [...TRACE_CATEGORIES, "cc"];

export const MARK_PREFIX = "vision-perf:";

/** Segment markers: `vision-perf:<segment>:start|end`, in trace time (µs). */
export function findSegments(
  events: readonly TraceEvent[],
): Map<string, { start: number; end: number }> {
  const marks = new Map<string, { start?: number; end?: number }>();
  for (const event of events) {
    if (event.name !== "TimeStamp" || event.ts === undefined) continue;
    const data = event.args?.data as { message?: unknown } | undefined;
    const message = typeof data?.message === "string" ? data.message : "";
    const match = new RegExp(`^${MARK_PREFIX}(.+):(start|end)$`).exec(message);
    if (!match) continue;
    const entry = marks.get(match[1] as string) ?? {};
    if (match[2] === "start") entry.start = event.ts;
    else entry.end = event.ts;
    marks.set(match[1] as string, entry);
  }
  const segments = new Map<string, { start: number; end: number }>();
  for (const [name, entry] of marks) {
    if (entry.start !== undefined && entry.end !== undefined) {
      segments.set(name, { start: entry.start, end: entry.end });
    }
  }
  return segments;
}

export interface TraceSegmentSummary {
  durationMs: number;
  /** Busy ms per "process/thread" from top-level task events. */
  threadBusyMs: Record<string, number>;
  /**
   * PipelineReporter frame states per process (STATE_PRESENTED_ALL,
   * STATE_DROPPED, ...), plus how many frames carried a compositor or
   * main-thread animation.
   */
  frameStates: Record<string, Record<string, number>>;
  /** Largest renderer timeline events by total duration. */
  rendererTopEvents: { name: string; count: number; totalMs: number }[];
  /** Compositor attribution: viz frames, render passes and raster work. */
  compositor: CompositorSummary;
}

/**
 * Event names follow Chromium's viz DirectRenderer and cc tile-raster trace
 * points (not yet checked against an Electron 44 trace); topEvents keeps the
 * largest cc and viz events either way, so a renamed event still shows up.
 */
export interface CompositorSummary {
  /** DirectRenderer::DrawFrame on VizCompositorThread (one per drawn frame). */
  drawFrames: number;
  drawFrameMs: number;
  /** DirectRenderer::DrawRenderPass events (all threads). */
  renderPasses: number;
  renderPassesPerFrame: number | null;
  /** cc RasterTask events (renderer raster workers). */
  rasterTasks: number;
  rasterTaskMs: number;
  /** GPU-process raster (RasterDecoderImpl::DoRasterCHROMIUM). */
  gpuRasterMs: number;
  /** Largest cc and viz events by total duration, any thread. */
  topEvents: { name: string; count: number; totalMs: number }[];
}

const TOP_LEVEL_TASKS = new Set([
  "ThreadControllerImpl::RunTask",
  "ThreadPool_RunTask",
]);
/** Timeline task wrappers that would only repeat the busy time. */
const WRAPPER_EVENTS = new Set([
  "RunTask",
  "ThreadControllerImpl::RunTask",
  "ThreadPool_RunTask",
]);
const THREADS_OF_INTEREST =
  /^(CrBrowserMain|CrRendererMain|Compositor|CrGpuMain|VizCompositorThread)$/;

export interface PresentedFps {
  fps: number;
  presentedFrames: number;
  seconds: number;
}

/**
 * Presented frames per second of one traced window, from the PipelineReporter
 * counts: STATE_PRESENTED_ALL plus STATE_PRESENTED_PARTIAL. Several processes
 * can report the same frame, so the busiest single process is used instead of
 * the sum.
 */
export function presentedFps(summary: TraceSegmentSummary): PresentedFps {
  let presentedFrames = 0;
  for (const states of Object.values(summary.frameStates)) {
    const presented =
      (states.STATE_PRESENTED_ALL ?? 0) + (states.STATE_PRESENTED_PARTIAL ?? 0);
    presentedFrames = Math.max(presentedFrames, presented);
  }
  const seconds = summary.durationMs / 1000;
  return {
    fps: seconds > 0 ? Math.round((presentedFrames / seconds) * 10) / 10 : 0,
    presentedFrames,
    seconds,
  };
}

export function summarizeTrace(
  events: readonly TraceEvent[],
  window?: { start: number; end: number },
): TraceSegmentSummary {
  const processNames = new Map<number, string>();
  const threadNames = new Map<string, string>();
  for (const event of events) {
    if (event.ph !== "M") continue;
    const name = (event.args as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") continue;
    if (event.name === "process_name" && event.pid !== undefined) {
      processNames.set(event.pid, name);
    } else if (event.name === "thread_name") {
      threadNames.set(`${event.pid}:${event.tid}`, name);
    }
  }
  const processLabel = (pid: number | undefined) =>
    `${processNames.get(pid ?? -1) ?? "process"} ${pid ?? "?"}`;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  const inside = (event: TraceEvent) => {
    if (event.ts === undefined) return false;
    if (!window) return true;
    return event.ts >= window.start && event.ts <= window.end;
  };

  const threadBusy = new Map<string, number>();
  const frameStates: Record<string, Record<string, number>> = {};
  const rendererEvents = new Map<string, { count: number; total: number }>();
  const compositorEvents = new Map<string, { count: number; total: number }>();
  const compositor = {
    drawFrames: 0,
    drawFrameUs: 0,
    renderPasses: 0,
    rasterTasks: 0,
    rasterTaskUs: 0,
    gpuRasterUs: 0,
  };

  for (const event of events) {
    if (event.ph === "M" || !inside(event)) continue;
    const ts = event.ts as number;
    minTs = Math.min(minTs, ts);
    maxTs = Math.max(maxTs, ts + (event.dur ?? 0));
    const threadName = threadNames.get(`${event.pid}:${event.tid}`) ?? "";

    if (
      event.ph === "X" &&
      event.dur !== undefined &&
      event.name !== undefined &&
      TOP_LEVEL_TASKS.has(event.name) &&
      THREADS_OF_INTEREST.test(threadName)
    ) {
      const key = `${processLabel(event.pid)}/${threadName}`;
      threadBusy.set(key, (threadBusy.get(key) ?? 0) + event.dur);
    }

    if (
      event.name === "PipelineReporter" &&
      (event.ph === "b" || event.ph === "X")
    ) {
      const reporter = (event.args?.frame_reporter ??
        event.args?.chrome_frame_reporter) as
        | {
            state?: unknown;
            has_compositor_animation?: unknown;
            has_main_animation?: unknown;
          }
        | undefined;
      const state =
        typeof reporter?.state === "string" ? reporter.state : "unknown";
      const process = processLabel(event.pid);
      const states = frameStates[process] ?? {};
      states[state] = (states[state] ?? 0) + 1;
      if (reporter?.has_compositor_animation === true) {
        states.with_compositor_animation =
          (states.with_compositor_animation ?? 0) + 1;
      }
      if (reporter?.has_main_animation === true) {
        states.with_main_animation = (states.with_main_animation ?? 0) + 1;
      }
      frameStates[process] = states;
    }

    if (
      event.ph === "X" &&
      event.dur !== undefined &&
      event.name !== undefined &&
      !WRAPPER_EVENTS.has(event.name) &&
      threadName === "CrRendererMain" &&
      (event.cat ?? "").includes("devtools.timeline")
    ) {
      const entry = rendererEvents.get(event.name) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += event.dur;
      rendererEvents.set(event.name, entry);
    }

    if (event.ph === "X" && event.dur !== undefined && event.name !== undefined) {
      if (
        event.name === "DirectRenderer::DrawFrame" &&
        threadName === "VizCompositorThread"
      ) {
        compositor.drawFrames += 1;
        compositor.drawFrameUs += event.dur;
      } else if (event.name === "DirectRenderer::DrawRenderPass") {
        compositor.renderPasses += 1;
      } else if (event.name === "RasterTask") {
        compositor.rasterTasks += 1;
        compositor.rasterTaskUs += event.dur;
      } else if (event.name === "RasterDecoderImpl::DoRasterCHROMIUM") {
        compositor.gpuRasterUs += event.dur;
      }
      const categories = (event.cat ?? "").split(",");
      if (
        !WRAPPER_EVENTS.has(event.name) &&
        (categories.includes("cc") || categories.includes("viz"))
      ) {
        const entry = compositorEvents.get(event.name) ?? {
          count: 0,
          total: 0,
        };
        entry.count += 1;
        entry.total += event.dur;
        compositorEvents.set(event.name, entry);
      }
    }
  }

  const ms = (us: number) => Math.round(us / 100) / 10;
  const topEvents = (map: Map<string, { count: number; total: number }>) =>
    [...map]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 12)
      .map(([name, entry]) => ({
        name,
        count: entry.count,
        totalMs: ms(entry.total),
      }));
  return {
    durationMs: window
      ? ms(window.end - window.start)
      : Number.isFinite(minTs)
        ? ms(maxTs - minTs)
        : 0,
    threadBusyMs: Object.fromEntries(
      [...threadBusy]
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => [key, ms(value)]),
    ),
    frameStates,
    rendererTopEvents: topEvents(rendererEvents),
    compositor: {
      drawFrames: compositor.drawFrames,
      drawFrameMs: ms(compositor.drawFrameUs),
      renderPasses: compositor.renderPasses,
      renderPassesPerFrame:
        compositor.drawFrames > 0
          ? Math.round((compositor.renderPasses / compositor.drawFrames) * 10) /
            10
          : null,
      rasterTasks: compositor.rasterTasks,
      rasterTaskMs: ms(compositor.rasterTaskUs),
      gpuRasterMs: ms(compositor.gpuRasterUs),
      topEvents: topEvents(compositorEvents),
    },
  };
}

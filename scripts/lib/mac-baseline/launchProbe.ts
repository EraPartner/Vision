/**
 * Launch probe for the Mac performance baseline (--launch-probe): what the page
 * animates and requests during the first seconds after launch. Built to find
 * the post-launch GPU burn on the real app (phase A of the optimisation plan).
 */

import type { CdpClient, CdpEvent } from "./cdp.ts";

/** One running animation as seen by document.getAnimations(). */
export interface AnimationSeen {
  name: string;
  target: string;
}

export interface AnimationSample {
  /** Seconds since the probe started. */
  atS: number;
  running: AnimationSeen[];
}

export interface RequestRecord {
  path: string;
  method: string;
  startMs: number;
  endMs: number | null;
  status: number | null;
  failed: boolean;
}

export interface RequestSummary {
  path: string;
  count: number;
  failed: number;
  /** Requests still without a response when the probe ended. */
  open: number;
  maxMs: number;
}

/**
 * Page expression: running animations with a short description of their
 * target (tag, id, the first two classes, and nearest data-testid).
 */
export const RUNNING_ANIMATIONS = `(() => {
  const describe = (el) => {
    if (!(el instanceof Element)) return "?";
    const classes = [...el.classList].slice(0, 2).join(".");
    const testId = el.closest("[data-testid]")?.getAttribute("data-testid");
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
      (classes ? "." + classes : "") + (testId ? " in " + testId : "");
  };
  return document.getAnimations()
    .filter((a) => a.playState === "running")
    .map((a) => ({
      name: a.animationName ?? a.transitionProperty ?? a.id ?? "animation",
      target: describe(a.effect?.target),
    }));
})()`;

/** Strip origin and query so repeated polls group under one path. */
export function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Record page network requests on one target session until stopped. */
export function recordRequests(
  cdp: CdpClient,
  sessionId: string,
  startedAt: number,
): { stop: () => RequestRecord[] } {
  const byId = new Map<string, RequestRecord>();
  const now = () => Date.now() - startedAt;
  const off = cdp.onEvent((event: CdpEvent) => {
    if (event.sessionId !== sessionId) return;
    const id = event.params.requestId;
    if (typeof id !== "string") return;
    if (event.method === "Network.requestWillBeSent") {
      const request = event.params.request as
        { url?: unknown; method?: unknown } | undefined;
      const url = typeof request?.url === "string" ? request.url : "";
      if (!url.startsWith("http")) return;
      byId.set(id, {
        path: requestPath(url),
        method: typeof request?.method === "string" ? request.method : "GET",
        startMs: now(),
        endMs: null,
        status: null,
        failed: false,
      });
    } else if (event.method === "Network.responseReceived") {
      const record = byId.get(id);
      const response = event.params.response as
        { status?: unknown } | undefined;
      if (record && typeof response?.status === "number")
        record.status = response.status;
    } else if (
      event.method === "Network.loadingFinished" ||
      event.method === "Network.loadingFailed"
    ) {
      const record = byId.get(id);
      if (!record) return;
      record.endMs = now();
      record.failed = event.method === "Network.loadingFailed";
    }
  });
  return {
    stop: () => {
      off();
      return [...byId.values()];
    },
  };
}

export function summarizeRequests(
  records: readonly RequestRecord[],
): RequestSummary[] {
  const groups = new Map<string, RequestSummary>();
  for (const record of records) {
    const key = `${record.method} ${record.path}`;
    const group = groups.get(key) ?? {
      path: key,
      count: 0,
      failed: 0,
      open: 0,
      maxMs: 0,
    };
    group.count += 1;
    if (record.failed) group.failed += 1;
    if (record.endMs === null) group.open += 1;
    else group.maxMs = Math.max(group.maxMs, record.endMs - record.startMs);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.maxMs - a.maxMs,
  );
}

/** How many samples each animation (name + target) was running in. */
export function summarizeAnimations(
  samples: readonly AnimationSample[],
): {
  name: string;
  target: string;
  samples: number;
  firstS: number;
  lastS: number;
}[] {
  const seen = new Map<
    string,
    {
      name: string;
      target: string;
      samples: number;
      firstS: number;
      lastS: number;
    }
  >();
  for (const sample of samples) {
    for (const animation of new Set(
      sample.running.map((a) => `${a.name}\u0000${a.target}`),
    )) {
      const [name = "", target = ""] = animation.split("\u0000");
      const entry = seen.get(animation) ?? {
        name,
        target,
        samples: 0,
        firstS: sample.atS,
        lastS: sample.atS,
      };
      entry.samples += 1;
      entry.lastS = sample.atS;
      seen.set(animation, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.samples - a.samples);
}

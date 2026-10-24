import assert from "node:assert/strict";
import test from "node:test";

import {
  requestPath,
  summarizeAnimations,
  summarizeRequests,
} from "../lib/mac-baseline/launchProbe.ts";

test("groups repeated polls by method and path, counting open and failed", () => {
  assert.equal(
    requestPath("http://127.0.0.1:3001/api/info/insights-count?x=1"),
    "/api/info/insights-count",
  );
  const poll = (startMs: number, endMs: number | null, failed = false) => ({
    path: "/api/info/insights-count",
    method: "GET",
    startMs,
    endMs,
    status: endMs === null ? null : 200,
    failed,
  });
  const summary = summarizeRequests([
    poll(0, 40),
    poll(2000, 2900),
    poll(4000, null),
    poll(6000, 6010, true),
    { ...poll(0, 15), path: "/api/settings" },
  ]);
  assert.deepEqual(summary[0], {
    path: "GET /api/info/insights-count",
    count: 4,
    failed: 1,
    open: 1,
    maxMs: 900,
  });
  assert.equal(summary[1]?.path, "GET /api/settings");
});

test("counts in how many samples each animation ran", () => {
  const shimmer = { name: "shimmer", target: "div.animate-shimmer" };
  const result = summarizeAnimations([
    { atS: 0, running: [shimmer, shimmer] },
    { atS: 5, running: [shimmer, { name: "fade", target: "div" }] },
    { atS: 10, running: [] },
  ]);
  assert.deepEqual(result[0], {
    ...shimmer,
    samples: 2,
    firstS: 0,
    lastS: 5,
  });
  assert.equal(result[1]?.samples, 1);
});

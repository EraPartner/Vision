// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { apiEventBus, type ApiRequestEvent } from "@/lib/devtools/apiEventBus";
import {
  resetQueryMetrics,
  initQueryMetrics,
  useQueryMetrics,
} from "@/lib/devtools/queryMetrics";

function ev(over: Partial<ApiRequestEvent> = {}): ApiRequestEvent {
  return {
    id: "1",
    method: "GET",
    endpoint: "/x",
    startedAt: 0,
    attempt: 1,
    phase: "success",
    durationMs: 100,
    ...over,
  };
}

describe("queryMetrics computation", () => {
  afterEach(() => {
    act(() => resetQueryMetrics());
  });

  test("aggregates totals, error rate and per-endpoint stats", () => {
    const { result } = renderHook(() => useQueryMetrics());

    act(() => {
      apiEventBus.emit(ev({ id: "1", endpoint: "/a", phase: "success", durationMs: 100 }));
      apiEventBus.emit(ev({ id: "2", endpoint: "/a", phase: "success", durationMs: 200 }));
      apiEventBus.emit(ev({ id: "3", endpoint: "/a", phase: "error", durationMs: 300 }));
      apiEventBus.emit(ev({ id: "4", endpoint: "/b", phase: "success", durationMs: 1500 }));
    });

    expect(result.current.totalRequests).toBe(4);
    expect(result.current.errorRate).toBeCloseTo(0.25);
    // start phase is ignored by metrics.
    act(() => apiEventBus.emit(ev({ id: "5", phase: "start" })));
    expect(result.current.totalRequests).toBe(4);

    // /b request was >= 1000ms and successful → slow.
    expect(result.current.slowRequests.map((e) => e.id)).toEqual(["4"]);

    const a = result.current.topEndpoints.find((e) => e.endpoint === "GET /a");
    expect(a?.count).toBe(3);
    expect(a?.errorCount).toBe(1);
  });

  test("resetQueryMetrics clears the snapshot", () => {
    const { result } = renderHook(() => useQueryMetrics());
    act(() => apiEventBus.emit(ev({ id: "1", phase: "success" })));
    expect(result.current.totalRequests).toBe(1);
    act(() => resetQueryMetrics());
    expect(result.current.totalRequests).toBe(0);
    expect(result.current.errorRate).toBe(0);
  });

  test("initQueryMetrics subscribes to caches and returns a working unsubscribe", () => {
    const qc = new QueryClient();
    const unsub = initQueryMetrics(qc);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
    qc.clear();
  });
});

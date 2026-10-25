// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { apiEventBus, type ApiRequestEvent } from "@/lib/devtools/apiEventBus";
import { useApiRequestLog, clearApiRequestLog } from "@/lib/devtools/apiRequestLog";

function ev(over: Partial<ApiRequestEvent> = {}): ApiRequestEvent {
  return {
    id: "1",
    method: "GET",
    endpoint: "/x",
    startedAt: 0,
    attempt: 1,
    phase: "start",
    ...over,
  };
}

describe("apiRequestLog", () => {
  afterEach(() => {
    act(() => clearApiRequestLog());
  });

  test("completed requests land in the log, newest first", () => {
    const { result } = renderHook(() => useApiRequestLog());
    expect(result.current.log).toHaveLength(0);

    act(() => {
      apiEventBus.emit(ev({ id: "a", phase: "start" }));
      apiEventBus.emit(ev({ id: "a", phase: "success", durationMs: 50 }));
      apiEventBus.emit(ev({ id: "b", phase: "error" }));
    });

    expect(result.current.inFlight).toHaveLength(0);
    expect(result.current.log.map((e) => e.id)).toEqual(["b", "a"]);
  });

  test("the last request of a burst leaves nothing in flight", () => {
    const { result } = renderHook(() => useApiRequestLog());
    act(() => {
      apiEventBus.emit(ev({ id: "x", phase: "start" }));
    });
    expect(result.current.inFlight.map((e) => e.id)).toEqual(["x"]);

    act(() => {
      apiEventBus.emit(ev({ id: "x", phase: "success", durationMs: 5 }));
    });
    expect(result.current.inFlight).toHaveLength(0);
  });

  test("clearApiRequestLog empties the log and in-flight set", () => {
    const { result } = renderHook(() => useApiRequestLog());
    act(() => {
      apiEventBus.emit(ev({ id: "p", phase: "success" }));
      apiEventBus.emit(ev({ id: "q", phase: "success" }));
    });
    expect(result.current.log.length).toBeGreaterThan(0);

    act(() => clearApiRequestLog());
    expect(result.current.log).toHaveLength(0);
    expect(result.current.inFlight).toHaveLength(0);
  });
});

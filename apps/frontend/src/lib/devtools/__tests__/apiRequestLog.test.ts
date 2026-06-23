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

// The store publishes a fresh cachedSnapshot via a second bus subscriber that
// runs after the notifying one, so the React-visible snapshot settles on the
// *next* notify. clearApiRequestLog() refreshes the snapshot AND notifies, so
// we use it as a deterministic flush/observation point.

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
      // Trailing emit flushes the snapshot into the React-visible state.
      apiEventBus.emit(ev({ id: "c", phase: "success" }));
    });

    expect(result.current.inFlight).toHaveLength(0);
    // c is the trailing flush event; b and a precede it (newest first).
    expect(result.current.log.map((e) => e.id)).toEqual(["c", "b", "a"]);
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

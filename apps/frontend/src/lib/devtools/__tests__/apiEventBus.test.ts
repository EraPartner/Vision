import { describe, expect, test, vi } from "vitest";
import { apiEventBus, type ApiRequestEvent } from "@/lib/devtools/apiEventBus";

function ev(over: Partial<ApiRequestEvent> = {}): ApiRequestEvent {
  return {
    id: "1",
    method: "GET",
    endpoint: "/x",
    startedAt: 0,
    attempt: 1,
    phase: "success",
    ...over,
  };
}

describe("apiEventBus", () => {
  test("delivers events to subscribers and unsubscribe stops delivery", () => {
    const fn = vi.fn();
    const unsub = apiEventBus.subscribe(fn);
    apiEventBus.emit(ev());
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    apiEventBus.emit(ev());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a throwing subscriber does not break the bus", () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const u1 = apiEventBus.subscribe(bad);
    const u2 = apiEventBus.subscribe(good);
    expect(() => apiEventBus.emit(ev())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });
});

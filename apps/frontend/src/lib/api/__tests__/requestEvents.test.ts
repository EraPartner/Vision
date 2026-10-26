import { afterEach, describe, expect, test, vi } from "vitest";
import { apiRequest } from "@/lib/api/client";
import { apiEventBus, type ApiRequestEvent } from "@/lib/devtools/apiEventBus";

function openStarts(events: ApiRequestEvent[]) {
  const open = new Set<string>();
  for (const event of events) {
    const key = `${event.id}#${event.attempt}`;
    if (event.phase === "start") open.add(key);
    else open.delete(key);
  }
  return open;
}

describe("apiRequest devtools events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a request cancelled while it waits to retry leaves nothing in flight", async () => {
    const events: ApiRequestEvent[] = [];
    const unsubscribe = apiEventBus.subscribe((event) => events.push(event));
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      // Cancel during the back-off before the retry.
      queueMicrotask(() => controller.abort());
      return Promise.resolve(new Response("busy", { status: 503 }));
    });
    try {
      await expect(
        apiRequest("/api/test", { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
    }
    expect(events.filter((e) => e.phase === "start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ phase: "error", status: 503 });
    expect(openStarts(events).size).toBe(0);
  });
});

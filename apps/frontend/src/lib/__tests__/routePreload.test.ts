// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { routeLoaders, preloadRoute } from "@/lib/routePreload";

describe("routeLoaders map", () => {
  it("exposes loader functions keyed by route path", () => {
    expect(typeof routeLoaders["/"]).toBe("function");
    expect(typeof routeLoaders["/transactions"]).toBe("function");
    expect(typeof routeLoaders["/portfolio/net-worth"]).toBe("function");
    // Every entry is a callable lazy importer.
    for (const loader of Object.values(routeLoaders)) {
      expect(typeof loader).toBe("function");
    }
  });
});

describe("preloadRoute", () => {
  it("is a no-op for an unknown route", () => {
    // No loader exists, so nothing is invoked and no error is thrown.
    expect(() => preloadRoute("/does-not-exist")).not.toThrow();
  });

  it("warms a known chunk only once (dedup on repeated calls)", async () => {
    const importSpy = vi.fn(() => Promise.resolve({}));
    // Replace one loader with a spy to observe the warm-once behaviour without
    // pulling a real page chunk into the test bundle.
    const original = routeLoaders["/owes"];
    (routeLoaders as Record<string, () => Promise<unknown>>)["/owes"] = importSpy;
    try {
      preloadRoute("/owes");
      preloadRoute("/owes");
      await Promise.resolve();
      expect(importSpy).toHaveBeenCalledTimes(1);
    } finally {
      (routeLoaders as Record<string, () => Promise<unknown>>)["/owes"] = original;
    }
  });
});

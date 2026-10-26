import { describe, expect, it, vi } from "vitest";
import {
  type InfoCache,
  invalidatePortfolioCaches,
  invalidateStatisticsCaches,
  portfolioSummaryCache,
  resolveCacheWithInflight,
  statisticsResponseCache,
} from "../src/services/info/cache.ts";

function deferred() {
  let resolve!: (value: number) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe.each([
  ["portfolio", portfolioSummaryCache, invalidatePortfolioCaches],
  ["statistics", statisticsResponseCache, invalidateStatisticsCaches],
] as const)("%s cache invalidation", (_name, cache: InfoCache, invalidate) => {
  it("does not resurrect an invalidated response", async () => {
    invalidate();
    const old = deferred();
    const pending = resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: () => old.promise,
    });
    invalidate();
    old.resolve(100);
    expect(await pending).toBe(100);
    const fresh = vi.fn(() => Promise.resolve(200));
    expect(await resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: fresh,
    })).toBe(200);
    expect(fresh).toHaveBeenCalledOnce();
  });

  it.each([false, true])("old completion cannot replace/delete a newer result (reject=%s)", async (reject) => {
    invalidate();
    const old = deferred();
    const pending = resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: () => old.promise,
    });
    const observed = pending.catch(() => undefined);
    invalidate();
    await resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: () => Promise.resolve(200),
    });
    if (reject) old.reject(new Error("expired request failed"));
    else old.resolve(100);
    await observed;
    const unexpected = vi.fn(() => Promise.resolve(300));
    expect(await resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: unexpected,
    })).toBe(200);
    expect(unexpected).not.toHaveBeenCalled();
});

  it("joins current work and retries a failed current load", async () => {
    invalidate();
    const work = deferred();
    const loader = vi.fn(() => work.promise);
    const options = { ttlMs: 60_000, loader };
    const first = resolveCacheWithInflight(cache, "EUR", options);
    const second = resolveCacheWithInflight(cache, "EUR", options);
    const observed = Promise.allSettled([first, second]);
    work.reject(new Error("temporary failure"));
    expect((await observed).every((result) => result.status === "rejected")).toBe(true);
    expect(loader).toHaveBeenCalledOnce();
    expect(await resolveCacheWithInflight(cache, "EUR", {
      ttlMs: 60_000, loader: () => Promise.resolve(200),
    })).toBe(200);
});
});

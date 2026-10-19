import { describe, it, expect, vi } from "vitest";
import { dotenvPaths, applyDotenvContent } from "../src/config/dotenvLayers.ts";
import { prepareViewsAfterBackfill } from "../src/startup/prepareViews.ts";

describe("environment layers", () => {
  it("uses repository root and preserves explicit process values, including empty values", () => {
    expect(
      dotenvPaths(
        "file:///synthetic/Vision/apps/node-backend/src/config/loadDotenv.ts",
      ),
    ).toEqual([
      "/synthetic/Vision/apps/node-backend/.env.local",
      "/synthetic/Vision/.env",
    ]);
    const target: Record<string, string | undefined> = {
      EXISTING: "process",
      EMPTY: "",
    };
    applyDotenvContent("EXISTING=local\nEMPTY=local\nLAYER=local", target);
    applyDotenvContent("LAYER=root\nBASE=synthetic", target);
    expect(target).toEqual({
      EXISTING: "process",
      EMPTY: "",
      LAYER: "local",
      BASE: "synthetic",
    });
  });
});

for (const skipped of [true, false]) {
  it(`reports readable views before the refresh only when backfill was skipped=${skipped}`, async () => {
    const events: string[] = [];
    let finishRefresh!: () => void;
    const preparation = prepareViewsAfterBackfill({
      prepare: async () => {},
      backfill: async () => ({ skipped }),
      refresh: () =>
        new Promise<void>((resolve) => {
          events.push("refresh-started");
          finishRefresh = resolve;
        }),
      backfillFailed: vi.fn(),
      readable: () => events.push("readable"),
    });
    await vi.waitFor(() => expect(events).toContain("refresh-started"));
    expect(events).toEqual(
      skipped ? ["readable", "refresh-started"] : ["refresh-started"],
    );
    finishRefresh();
    await preparation;
  });
}

it("never reports readable views when preparation failed", async () => {
  const readable = vi.fn();
  await expect(
    prepareViewsAfterBackfill({
      prepare: async () => {
        throw new Error("prepare failed");
      },
      backfill: async () => ({ skipped: true }),
      refresh: vi.fn(async () => {}),
      backfillFailed: vi.fn(),
      readable,
    }),
  ).rejects.toThrow("prepare failed");
  expect(readable).not.toHaveBeenCalled();
});

for (const failedPreparation of [false, true]) {
  it(`refreshes once after late backfill with preparation failure=${failedPreparation}`, async () => {
    let finish!: () => void;
    const backfill = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refresh = vi.fn(async () => {});
    const preparation = prepareViewsAfterBackfill({
      prepare: async () => {
        if (failedPreparation) throw new Error("prepare failed");
      },
      backfill: async () => {
        await backfill;
        return { skipped: false };
      },
      refresh,
      backfillFailed: vi.fn(),
    });
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    finish();
    if (failedPreparation)
      await expect(preparation).rejects.toThrow("prepare failed");
    else await preparation;
    expect(refresh).toHaveBeenCalledTimes(1);
  });
}

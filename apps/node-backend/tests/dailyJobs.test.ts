import { describe, expect, it, vi } from "vitest";
import { createDailyJob } from "../src/startup/dailyJobs.ts";
const DAY = 86400000;
function fixture(completedAt: unknown) {
  let clock = 10 * DAY;
  const store = {
    get: vi.fn(async () => completedAt),
    set: vi.fn(async (_key: string, value: number) => {
      completedAt = value;
    }),
  };
  return {
    store,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
describe("single-instance durable daily jobs", () => {
  it("coalesces multiple missed periods, persists completion and honors it after restart", async () => {
    const f = fixture(DAY);
    const run = vi.fn(async () => true);
    await createDailyJob("example", run, f)();
    await createDailyJob("example", run, f)();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.store.set).toHaveBeenCalledWith("daily_job_example", 10 * DAY);
    f.advance(DAY);
    await createDailyJob("example", run, f)();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not overlap startup with timer ticks", async () => {
    const f = fixture(undefined);
    let release: ((value: boolean) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const tick = createDailyJob("example", run, f);
    const first = tick();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await tick();
    release!(true);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([false, "error"])(
    "retries incomplete work without recording completion (%s)",
    async (result) => {
      const f = fixture(undefined);
      const run = vi.fn(async () => {
        if (result === "error") throw new Error("failed");
        return false;
      });
      const tick = createDailyJob("example", run, f);
      await tick();
      await tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(f.store.set).not.toHaveBeenCalled();
      f.advance(3600000);
      await tick();
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
  it("does not run if the checkpoint read fails", async () => {
    const f = fixture(undefined);
    f.store.get.mockRejectedValue(new Error("database unavailable"));
    const run = vi.fn();
    await createDailyJob("example", run, f)();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([undefined, "bad", Infinity, -1, 20 * DAY])(
    "treats missing or invalid checkpoints as due (%s)",
    async (value) => {
      const f = fixture(value);
      const run = vi.fn(async () => true);
      await createDailyJob("example", run, f)();
      expect(run).toHaveBeenCalledOnce();
    },
  );
});

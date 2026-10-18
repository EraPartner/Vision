import { expect, it } from "vitest";
import { withReportSlot } from "../src/services/reports/reportConcurrency.ts";

it("bounds the whole operation, rejects excess demand, and removes cancelled queued work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const work = async () => {
    started++;
    await gate;
  };
  const first = withReportSlot(work);
  const second = withReportSlot(work);
  const cancelled = new AbortController();
  const waiting = withReportSlot(work, cancelled.signal);
  const rejected = expect(waiting).rejects.toThrow();
  const others = Array.from({ length: 7 }, () => withReportSlot(work));
  await Promise.resolve();
  expect(started).toBe(2);
  await expect(withReportSlot(work)).rejects.toMatchObject({ status: 503 });
  cancelled.abort();
  await rejected;
  const replacement = withReportSlot(work);
  release();
  await Promise.all([first, second, ...others, replacement]);
  expect(started).toBe(10);
  await expect(
    withReportSlot(async () => {
      throw new Error("render failed");
    }),
  ).rejects.toThrow("render failed");
  await expect(withReportSlot(async () => "recovered")).resolves.toBe(
    "recovered",
  );
});

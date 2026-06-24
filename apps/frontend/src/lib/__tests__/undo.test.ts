import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerUndo, consumeUndo } from "@/lib/undo";

describe("undo registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    // Drain any pending entry so tests don't leak the single slot.
    consumeUndo();
    vi.useRealTimers();
  });

  test("consumeUndo returns false when nothing is pending", () => {
    expect(consumeUndo()).toBe(false);
  });

  test("runs the registered undo and clears it", () => {
    const run = vi.fn();
    registerUndo(run);
    expect(consumeUndo()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    // Single-slot: second consume finds nothing.
    expect(consumeUndo()).toBe(false);
  });

  test("expired entry is not run", () => {
    const run = vi.fn();
    registerUndo(run, 1_000);
    vi.advanceTimersByTime(1_001);
    expect(consumeUndo()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("entry within TTL is still valid", () => {
    const run = vi.fn();
    registerUndo(run, 5_000);
    vi.advanceTimersByTime(4_000);
    expect(consumeUndo()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

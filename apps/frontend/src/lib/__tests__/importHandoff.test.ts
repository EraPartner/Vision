/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPendingImportFile,
  consumePendingImportFile,
} from "@/lib/importHandoff";

function makeFile(name = "a.csv") {
  return new File(["x"], name, { type: "text/csv" });
}

afterEach(() => {
  vi.useRealTimers();
  // Drain any leftover handoff so tests stay independent.
  consumePendingImportFile();
});

describe("importHandoff", () => {
  it("returns null when nothing is pending", () => {
    expect(consumePendingImportFile()).toBeNull();
  });

  it("hands off a registered file exactly once", () => {
    const file = makeFile();
    registerPendingImportFile(file);
    expect(consumePendingImportFile()).toBe(file);
    // Second read is empty — single-slot semantics.
    expect(consumePendingImportFile()).toBeNull();
  });

  it("expires the file after the TTL (expired branch)", () => {
    vi.useFakeTimers();
    registerPendingImportFile(makeFile(), 1000);
    vi.advanceTimersByTime(1001);
    expect(consumePendingImportFile()).toBeNull();
  });

  it("still hands off within the TTL window (live branch)", () => {
    vi.useFakeTimers();
    const file = makeFile();
    registerPendingImportFile(file, 1000);
    vi.advanceTimersByTime(500);
    expect(consumePendingImportFile()).toBe(file);
  });
});

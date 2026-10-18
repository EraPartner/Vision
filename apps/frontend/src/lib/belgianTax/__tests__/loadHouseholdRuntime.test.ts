import { describe, expect, test, vi } from "vitest";
import { loadHouseholdRuntime } from "../loadHouseholdRuntime";
import * as runtime from "../householdRuntime";

describe("loadHouseholdRuntime", () => {
    test("retries a rejected import once", async () => {
        const importRuntime = vi
            .fn<() => Promise<typeof runtime>>()
            .mockRejectedValueOnce(new Error("chunk failed"))
            .mockResolvedValueOnce(runtime);
        await expect(loadHouseholdRuntime(importRuntime)).resolves.toBe(runtime);
        expect(importRuntime).toHaveBeenCalledTimes(2);
    });

    test("rejects when the retry fails too", async () => {
        const importRuntime = vi
            .fn<() => Promise<typeof runtime>>()
            .mockRejectedValue(new Error("chunk failed"));
        await expect(loadHouseholdRuntime(importRuntime)).rejects.toThrow(
            "chunk failed",
        );
        expect(importRuntime).toHaveBeenCalledTimes(2);
    });

    test("imports the runtime by default", async () => {
        await expect(loadHouseholdRuntime()).resolves.toHaveProperty(
            "loadHouseholdSettings",
        );
    });
});

import { describe, expect, it } from "vitest";
import { QUERY_STALE_TIME_MS } from "./queryPolicies";

describe("QUERY_STALE_TIME_MS", () => {
    it("pins the named cache cadence without changing existing values", () => {
        expect(QUERY_STALE_TIME_MS).toEqual({
            DEFAULT: 30_000,
            FREQUENT: 30_000,
            STANDARD: 60_000,
        });
    });
});

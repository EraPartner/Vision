import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { mockConnection } from "./helpers/repoMocks.ts";
import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/database/connection.ts", () => mockConnection());

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { RowContractError } from "../src/database/rowContracts.ts";
import { autoResolveFxRateToEur } from "../src/services/portfolio/fxResolve.ts";

/** `query` as these tests drive it: SQL text in, a bare `{ rows }` result out. */
const query = vi.mocked(rawQuery) as unknown as Mock<
  (sql: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;

describe("autoResolveFxRateToEur", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the stored on-or-before rate", async () => {
    query.mockResolvedValueOnce({ rows: [{ rate_to_eur: "0.9100000000" }] });

    await expect(autoResolveFxRateToEur("usd", "2026-01-15")).resolves.toBe(
      0.91,
    );
  });

  it("degrades to undefined when the lookup itself fails", async () => {
    query.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      autoResolveFxRateToEur("USD", "2026-01-15"),
    ).resolves.toBeUndefined();
  });

  it("surfaces a stored rate that breaks its contract instead of dropping it", async () => {
    // NUMERIC arrives as a string; a number here means the read is wrong.
    query.mockResolvedValueOnce({ rows: [{ rate_to_eur: 0.91 }] });

    await expect(
      autoResolveFxRateToEur("USD", "2026-01-15"),
    ).rejects.toBeInstanceOf(RowContractError);
  });
});

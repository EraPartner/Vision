import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
const spies = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    query: spies.query,
    withTransaction: vi.fn(async (fn) => fn({ query: spies.query })),
  }),
);
import { rollbackBatch } from "../src/repositories/importBatchRepository.ts";

beforeEach(() => spies.query.mockReset());
describe("bank import rollback eligibility", () => {
  it.each(["staging", "validating", "matching", "committing", "aborted"])(
    "rejects current %s status even if a route previously allowed rollback",
    async (status) => {
      spies.query.mockResolvedValue({ rows: [{ status }], rowCount: 1 });
      await expect(rollbackBatch(42)).rejects.toMatchObject({ status: 400 });
      expect(spies.query).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a batch removed after a route read", async () => {
    spies.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(rollbackBatch(42)).rejects.toMatchObject({ status: 404 });
    expect(spies.query).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { readVerifiedAuditPage } from "../src/services/auditReadService.js";

const HASH = "a".repeat(64);

function transaction() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  const transact = vi.fn((callback) => callback(client));
  return { client, transact };
}

describe("verified audit page", () => {
  it("verifies and reads under one repeatable-read transaction", async () => {
    const { client, transact } = transaction();
    const verify = vi.fn().mockResolvedValue({
      status: "partially_verified",
      sequence: 4,
      hash: HASH,
      anchoredThrough: 2,
    });
    const readSegment = vi
      .fn()
      .mockResolvedValue(
        [2, 3, 4].map((sequence) => ({ sequence, hash: HASH })),
      );
    const trustedCheckpoint = { sequence: 2, hash: HASH };
    const result = await readVerifiedAuditPage({
      trustedCheckpoint,
      afterSequence: 1,
      limit: 2,
      transact,
      verify,
      readSegment,
    });
    expect(client.query).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(verify).toHaveBeenCalledWith({ trustedCheckpoint });
    expect(readSegment).toHaveBeenCalledWith({ afterSequence: 1, limit: 3 });
    expect(result).toMatchObject({
      hasMore: true,
      entries: [
        { sequence: 2, anchorStatus: "anchored" },
        { sequence: 3, anchorStatus: "pending_anchor" },
      ],
    });
  });

  it("never returns entries when verification is unavailable or failed", async () => {
    for (const status of ["unavailable", "failed"]) {
      const { transact } = transaction();
      const readSegment = vi.fn();
      const result = await readVerifiedAuditPage({
        transact,
        verify: vi.fn().mockResolvedValue({ status, reason: "test" }),
        readSegment,
      });
      expect(result).toEqual({
        verification: { status, reason: "test" },
        entries: [],
        hasMore: false,
      });
      expect(readSegment).not.toHaveBeenCalled();
    }
  });
});

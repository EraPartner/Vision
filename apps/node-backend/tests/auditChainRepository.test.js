import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const { client } = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock("../src/database/connection.js", () => mockTxConnection(client));

import { query, withTransaction } from "../src/database/connection.js";
import {
  appendAuditEvent,
  readAuditSegment,
  recordAuditCheckpoint,
} from "../src/repositories/auditChainRepository.js";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  verifyAuditChain,
} from "../src/lib/auditChainCore.js";

const payload = {
  action: "create",
  actor: "local-user",
  entityId: "42",
  entityType: "transaction",
  occurredAt: "2026-09-20T00:00:00.000Z",
};

describe("auditChainRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks, checks, and appends the first event in one transaction", async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "0", last_hash: AUDIT_CHAIN_GENESIS_HASH }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ created_at: "now" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const entry = await appendAuditEvent(payload);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1][0]).toContain("ORDER BY sequence DESC");
    expect(client.query.mock.calls[2][1][0]).toBe(1);
    expect(client.query.mock.calls[2][1][4]).toBe(
      JSON.stringify(Object.fromEntries(Object.entries(payload).sort())),
    );
    expect(client.query.mock.calls[3][1]).toEqual([
      1,
      entry.hash,
      0,
      AUDIT_CHAIN_GENESIS_HASH,
    ]);
    expect(
      verifyAuditChain([entry], {
        firstSequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        expectedLastSequence: 1,
        expectedHeadHash: entry.hash,
      }),
    ).toMatchObject({ ok: true });
  });

  it("uses a caller-owned manual transaction client without opening another transaction", async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "0", last_hash: AUDIT_CHAIN_GENESIS_HASH }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ created_at: "now" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendAuditEvent(payload, client);

    expect(withTransaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  it("refuses a head that disagrees with the latest entry before writing", async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "2", last_hash: "a".repeat(64) }],
      })
      .mockResolvedValueOnce({
        rows: [{ sequence: "1", entry_hash: "b".repeat(64) }],
      });

    await expect(appendAuditEvent(payload)).rejects.toThrow(
      "does not match stored history",
    );
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("hashes and stores the same snapshot when the caller mutates during the lock", async () => {
    let releaseHead;
    client.query
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseHead = () =>
              resolve({
                rows: [
                  {
                    last_sequence: "0",
                    last_hash: AUDIT_CHAIN_GENESIS_HASH,
                  },
                ],
              });
          }),
      )
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ created_at: "now" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const mutable = { ...payload };
    const pending = appendAuditEvent(mutable);
    await vi.waitFor(() => expect(releaseHead).toBeTypeOf("function"));
    mutable.action = "delete";
    releaseHead();

    const entry = await pending;
    expect(entry.payload.action).toBe("create");
    expect(JSON.parse(client.query.mock.calls[2][1][4]).action).toBe("create");
    expect(
      verifyAuditChain([entry], {
        firstSequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unsafe payload numbers before reading database state", async () => {
    await expect(appendAuditEvent({ ...payload, amount: 1.2 })).rejects.toThrow(
      "safe integers",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("records only a checkpoint matching the locked head", async () => {
    const hash = "a".repeat(64);
    const receipt = {
      sequence: 3,
      headHash: hash,
      anchorKind: "external-file",
      receiptId: "receipt-3",
      receiptHash: "b".repeat(64),
    };
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "3", last_hash: hash }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "7" }] });

    await expect(recordAuditCheckpoint(receipt)).resolves.toMatchObject({
      id: "7",
    });
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1][1]).toEqual([
      3,
      hash,
      "external-file",
      "receipt-3",
      "b".repeat(64),
    ]);
  });

  it("records a verified older head after later audited writes", async () => {
    const olderHash = "a".repeat(64);
    const receipt = {
      sequence: 3,
      headHash: olderHash,
      anchorKind: "external-file",
      receiptId: "receipt-3",
      receiptHash: "b".repeat(64),
    };
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "4", last_hash: "c".repeat(64) }],
      })
      .mockResolvedValueOnce({ rows: [{ entry_hash: olderHash }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "7" }] });

    await expect(recordAuditCheckpoint(receipt)).resolves.toMatchObject({
      id: "7",
    });
    expect(client.query.mock.calls[1][1]).toEqual([3]);
  });

  it("accepts an exact repeated checkpoint and rejects a conflicting receipt identity", async () => {
    const hash = "a".repeat(64);
    const receipt = {
      sequence: 3,
      headHash: hash,
      anchorKind: "external-file",
      receiptId: "receipt-3",
      receiptHash: "b".repeat(64),
    };
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "3", last_hash: hash }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            sequence: "3",
            head_hash: hash,
            receipt_hash: receipt.receiptHash,
          },
        ],
      });
    await expect(recordAuditCheckpoint(receipt)).resolves.toMatchObject({
      id: "7",
    });
    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({
        rows: [{ last_sequence: "3", last_hash: hash }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "7",
            sequence: "3",
            head_hash: hash,
            receipt_hash: "c".repeat(64),
          },
        ],
      });
    await expect(recordAuditCheckpoint(receipt)).rejects.toThrow(
      "Audit checkpoint receipt identity conflicts",
    );
  });

  it("returns bounded segments in the verifier's field shape", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          sequence: "9",
          version: 1,
          previous_hash: "a".repeat(64),
          entry_hash: "b".repeat(64),
          payload,
          created_at: "now",
        },
      ],
    });
    await expect(
      readAuditSegment({ afterSequence: 8, limit: 1 }),
    ).resolves.toEqual([
      {
        sequence: 9,
        version: 1,
        previousHash: "a".repeat(64),
        hash: "b".repeat(64),
        payload,
        createdAt: "now",
      },
    ]);
    expect(query.mock.calls[0][1]).toEqual([8, 1]);
  });
});

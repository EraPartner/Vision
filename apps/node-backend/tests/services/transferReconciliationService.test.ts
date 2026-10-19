import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockTxConnection } from "../helpers/repoMocks.ts";
import {
  asTransactionId,
} from "@vision/types/brands";
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock("../../src/database/connection.ts", () =>
  mockTxConnection(mockClient, {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  }),
);

import { query } from "../../src/database/connection.ts";
import {
  unmarkTransfer,
  markTransfer,
  reconcileTransfers,
  getTransferSuggestions,
} from "../../src/services/transferReconciliationService.ts";

/** Issued SQL without identifier quotes, lower-cased, with its params. */
const issued = () =>
  mockClient.query.mock.calls.map(([sql, params]) => ({
    sql: String(sql).replaceAll('"', "").toLowerCase(),
    params: (params ?? []) as unknown[],
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("unmarkTransfer — sticky per-pair dismissal (ADR-083, migration 0070)", () => {
  it("records the rejected PAIR and resets both legs to open (NULL)", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] }) // discover target 10 → peer 20
      .mockResolvedValueOnce({ rows: [{ id: 10, transfer_peer_id: 20 }, { id: 20, transfer_peer_id: 10 }] }); // lock the complete pair, which still points back
    await unmarkTransfer(asTransactionId(10));

    const sqls = issued();
    // Both the target and its peer are locked FOR UPDATE before any mutation
    // (mirrors markTransfer) so a concurrent re-pair can't strand a third row.
    const locks = sqls.filter((s) => s.sql.includes("for update"));
    expect(locks).toHaveLength(1);
    expect(locks[0]!.sql).toMatch(/order by id.*for update/s);
    // The pairing is persisted in transfer_dismissals (ordered, idempotent)…
    const dismissal = sqls.find((s) =>
      s.sql.includes("insert into transfer_dismissals"),
    );
    expect(dismissal).toBeTruthy();
    expect(dismissal!.sql).toContain("least");
    expect(dismissal!.sql).toContain("greatest");
    expect(dismissal!.sql).toContain("on conflict do nothing");
    // …and the ROWS go back to open so each can still pair with OTHER candidates.
    const updates = sqls.filter((s) => s.sql.includes("update transactions"));
    expect(updates).toHaveLength(2); // the row + its peer
    for (const update of updates) {
      expect(update.sql).toMatch(/transfer_source = (null|\$\d)/);
      expect(update.params).not.toContain("dismissed");
    }
  });

  it("does not reset a peer concurrently re-paired to a third row (reciprocity under lock)", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] }) // discover target 10 → peer 20
      .mockResolvedValueOnce({ rows: [{ id: 10, transfer_peer_id: 20 }, { id: 20, transfer_peer_id: 99 }] }); // lock known pair: peer 20 now points at 99
    await unmarkTransfer(asTransactionId(10));

    const sqls = issued();
    // Both rows were locked in one sorted FOR UPDATE query.
    expect(sqls.filter((s) => s.sql.includes("for update"))).toHaveLength(1);
    // The stale pair 10↔20 is no longer reciprocal → no dismissal recorded…
    expect(sqls.find((s) => s.sql.includes("transfer_dismissals"))).toBeUndefined();
    // …and ONLY the target is reset; the re-paired peer (20→99) is left intact,
    // so row 99 is never stranded as a phantom one-way transfer.
    const updates = sqls.filter((s) => s.sql.includes("update transactions"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).toContain(10);
    expect(updates[0]!.params).not.toContain(20);
  });

  it("a peerless (single-leg) row is just reset — no pair to dismiss", async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ transfer_peer_id: null }],
    }).mockResolvedValueOnce({ rows: [{ id: 10, transfer_peer_id: null }] });
    await unmarkTransfer(asTransactionId(10));
    const sqls = issued();
    expect(sqls.find((s) => s.sql.includes("transfer_dismissals"))).toBeUndefined();
    const updates = sqls.filter((s) => s.sql.includes("update transactions"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toMatch(/transfer_source = (null|\$\d)/);
  });
});

it("rejects changed discovery rather than locking a new peer out of order", async () => {
  mockClient.query.mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] })
    .mockResolvedValueOnce({ rows: [{ id: 10, transfer_peer_id: 30 }, { id: 20, transfer_peer_id: null }] });
  await expect(unmarkTransfer(asTransactionId(10))).rejects.toMatchObject({ status: 409 });
  expect(issued().some((s) => s.sql.includes("update transactions"))).toBe(false);
});

describe("releaseInvalidAutoPairs — reciprocity guard", () => {
  it("the release query requires the peer to point back (p.transfer_peer_id = t.id)", async () => {
    await reconcileTransfers();
    const releaseSql = mockClient.query.mock.calls.map(([sql]) => sql)
      .find(
        (s) =>
          s.includes("t.transfer_source IN ('auto', 'manual')") &&
          s.includes("NOT EXISTS"),
      );
    expect(releaseSql).toBeTruthy();
    expect(releaseSql).toContain("p.transfer_peer_id = t.id");
  });
});

describe("suggestion page input", () => {
  it("continues candidates for the same outflow across pages without dropping the lookahead", async () => {
    const detail = (id: number) => ({
      id,
      date: new Date("2026-01-01"),
      amount: "10.0000",
      currency: "EUR",
      bank_account: "Synthetic",
      memo: null,
      recipient_id: null,
    });
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [
          { outId: 1, inId: 2 },
          { outId: 1, inId: 3 },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [detail(1), detail(2)], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ outId: 1, inId: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [detail(1), detail(3)], rowCount: 2 });
    const first = await getTransferSuggestions({ limit: 1 });
    expect(first).toMatchObject({
      hasMore: true,
      nextCursor: "1:2",
      items: [{ outflow: { id: 1 }, candidates: [{ id: 2 }] }],
    });
    const last = await getTransferSuggestions({
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(last).toMatchObject({
      hasMore: false,
      nextCursor: null,
      items: [{ outflow: { id: 1 }, candidates: [{ id: 3 }] }],
    });
    // The window (3 days) binds once per use; besides it, the second page
    // continues after (1, 2) and asks for limit + 1 = 2 rows.
    const pageParams = vi.mocked(query).mock.calls[2]?.[1] ?? [];
    expect(pageParams).toContain(3);
    expect(pageParams.filter((value) => value !== 3)).toEqual([1, 2, 2]);
  });

  it.each([
    "",
    "0:1",
    "1:0",
    "1:2:3",
    "1.5:2",
    "-1:2",
    "2147483648:2",
    "NaN:1",
  ])("rejects invalid cursor %s before querying", async (cursor) => {
    await expect(getTransferSuggestions({ cursor })).rejects.toMatchObject({
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([0, -1, 201, 1.5, NaN])("rejects invalid limit %s", async (limit) => {
    await expect(getTransferSuggestions({ limit })).rejects.toMatchObject({
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

it("rejects new inbound peers discovered after sorted graph locking", async () => {
  const rows = [{ id: 10, amount: "-10", account_id: 1, is_active: true, transfer_peer_id: null }, { id: 20, amount: "10", account_id: 2, is_active: true, transfer_peer_id: null }];
  mockClient.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [...rows, { id: 30, amount: "10", account_id: 3, is_active: true, transfer_peer_id: 10 }] });
  await expect(markTransfer(asTransactionId(10), asTransactionId(20))).rejects.toMatchObject({ status: 409 });
  expect(issued().some((s) => s.sql.includes("update transactions"))).toBe(false);
});

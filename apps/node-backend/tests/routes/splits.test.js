/**
 * Split route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). Mount is /api/splits (main.js:332, no
 * per-mount `before` middleware). validateIdParam
 * (routes/splits.js:168,178,193,247,263,271,285,299) now runs for real on
 * every id-bearing route — every test here already used a valid numeric id,
 * so nothing was fake-passing under the old bypass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, okEnvelope, errEnvelope } from "../helpers/routeApp.js";

vi.mock("../../src/services/splitService.js", () => ({
  default: {
    getOwedSummary: vi.fn(),
    getOwedByRecipient: vi.fn(),
    countOwedByRecipient: vi.fn(),
    getSplitsByTransaction: vi.fn(),
    countSplitsByTransaction: vi.fn(),
    countPayments: vi.fn(),
    getOwedExportRowsByRecipient: vi.fn(),
    getTransactionSplitTotals: vi.fn(),
    createSplitAtomic: vi.fn(),
    createSplitsBatch: vi.fn(),
    createSplitsBatchAtomic: vi.fn(),
    addPayment: vi.fn(),
    getPayments: vi.fn(),
    settleSplit: vi.fn(),
    settleAllByRecipient: vi.fn(),
    deleteSplit: vi.fn(),
    getSplitById: vi.fn(),
    getAlreadyPaid: vi.fn(),
  },
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

import splitService from "../../src/services/splitService.js";
import {
  ValidationError,
  NotFoundError,
} from "../../src/middleware/errorHandler.js";

const { default: splitsRouter } = await import("../../src/routes/splits.js");

const BASE = "/api/splits";
const api = routeAgent(splitsRouter, { mountPath: BASE });

describe("Splits Routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /owed", () => {
    it("returns owed summary items", async () => {
      splitService.getOwedSummary.mockResolvedValue([
        { recipient_id: 2, amount: 12.5 },
      ]);

      const res = await api.get(`${BASE}/owed`).expect(200);

      expect(res.body).toEqual(
        okEnvelope({ items: [{ recipient_id: 2, amount: 12.5 }], total: 1 }),
      );
    });

    // The summary is derived in JS, so the route slices the computed array —
    // `total` must still be the full group count, not the page length.
    it("slices the computed summary when limit/offset are supplied", async () => {
      splitService.getOwedSummary.mockResolvedValue([
        { recipient_id: 1 },
        { recipient_id: 2 },
        { recipient_id: 3 },
      ]);

      const res = await api
        .get(`${BASE}/owed`)
        .query({ limit: "1", offset: "1" })
        .expect(200);

      expect(res.body).toEqual(
        okEnvelope({
          items: [{ recipient_id: 2 }],
          total: 3,
          limit: 1,
          offset: 1,
        }),
      );
    });

    it("propagates error when owed summary fails", async () => {
      splitService.getOwedSummary.mockRejectedValue(new Error("boom"));

      const res = await api.get(`${BASE}/owed`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("GET /owed/:id", () => {
    it("returns owed items by recipient", async () => {
      splitService.getOwedByRecipient.mockResolvedValue([
        { id: 1, split_id: 4 },
      ]);

      const res = await api.get(`${BASE}/owed/7`).expect(200);

      expect(splitService.getOwedByRecipient).toHaveBeenCalledWith(7, {});
      expect(res.body).toEqual(
        okEnvelope({ items: [{ id: 1, split_id: 4 }], total: 1 }),
      );
    });

    it("pages owed detail when limit/offset are supplied", async () => {
      splitService.getOwedByRecipient.mockResolvedValue([
        { id: 2, split_id: 5 },
      ]);
      splitService.countOwedByRecipient.mockResolvedValue(31);

      const res = await api
        .get(`${BASE}/owed/7`)
        .query({ limit: "1", offset: "10" })
        .expect(200);

      expect(splitService.getOwedByRecipient).toHaveBeenCalledWith(7, {
        limit: 1,
        offset: 10,
      });
      expect(res.body).toEqual(
        okEnvelope({
          items: [{ id: 2, split_id: 5 }],
          total: 31,
          limit: 1,
          offset: 10,
        }),
      );
    });

    it("propagates error when owed by recipient fails", async () => {
      splitService.getOwedByRecipient.mockRejectedValue(new Error("boom"));

      const res = await api.get(`${BASE}/owed/7`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("POST /", () => {
    it("throws ValidationError when split exceeds transaction total", async () => {
      splitService.createSplitAtomic.mockRejectedValue(
        new ValidationError("Split would exceed transaction total"),
      );

      const res = await api
        .post(`${BASE}/`)
        .send({ transaction_id: 1, recipient_id: 2, amount: 15 })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("creates split when amount fits remaining total", async () => {
      splitService.createSplitAtomic.mockResolvedValue({
        id: 7,
        transaction_id: 1,
        recipient_id: 2,
        amount: 20,
      });
      await api
        .post(`${BASE}/`)
        .send({ transaction_id: 1, recipient_id: 2, amount: 20 })
        .expect(201);

      expect(splitService.createSplitAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 20 }),
      );
    });

    // Pins for the zod swap (ZOD-08): raw values are forwarded to the repo
    // unchanged; malformed ids/amounts stay 400s.
    it("throws ValidationError for non-integer transaction_id / recipient_id", async () => {
      for (const body of [
        { transaction_id: "abc", recipient_id: 2, amount: 5 },
        { transaction_id: 1, recipient_id: "abc", amount: 5 },
      ]) {
        const res = await api.post(`${BASE}/`).send(body).expect(400);
        expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      }
      expect(splitService.createSplitAtomic).not.toHaveBeenCalled();
    });

    it("throws ValidationError for a non-finite amount", async () => {
      const res = await api
        .post(`${BASE}/`)
        .send({ transaction_id: 1, recipient_id: 2, amount: "abc" })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitAtomic).not.toHaveBeenCalled();
    });

    it("forwards a numeric-string amount and actor to the service", async () => {
      splitService.createSplitAtomic.mockResolvedValue({
        id: 7,
        transaction_id: 1,
        recipient_id: 2,
        amount: 20,
      });
      await api
        .post(`${BASE}/`)
        .set("x-actor", "manual-entry")
        .send({ transaction_id: 1, recipient_id: 2, amount: "20" })
        .expect(201);

      expect(splitService.createSplitAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ amount: "20", actor: "manual-entry" }),
      );
    });

    it("throws ValidationError when a falsy recipient_id hits the required check", async () => {
      const res = await api
        .post(`${BASE}/`)
        .send({ transaction_id: 1, recipient_id: 0, amount: 5 })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });
  });

  describe("POST /batch", () => {
    it("throws NotFoundError when transaction does not exist", async () => {
      splitService.createSplitsBatchAtomic.mockRejectedValue(
        new NotFoundError("Transaction not found"),
      );

      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 10 }],
        })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("throws ValidationError when cumulative amount exceeds transaction total", async () => {
      splitService.createSplitsBatchAtomic.mockRejectedValue(
        new ValidationError("Split would exceed transaction total"),
      );

      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20 },
            { recipient_id: 3, amount: 15 },
          ],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("throws ValidationError for non-positive split amounts in batch", async () => {
      splitService.createSplitsBatchAtomic.mockRejectedValue(
        new ValidationError("Split amount must be a positive number"),
      );

      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [{ recipient_id: 2, amount: 0 }],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("rejects a non-empty batch whose rows are all invalid with 400, not a 201 empty envelope", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          // Both rows fail row validation (missing recipient_id / amount).
          splits: [{ amount: 10 }, { recipient_id: 3 }],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });

    it("creates batch with normalized splits", async () => {
      splitService.createSplitsBatchAtomic.mockResolvedValue([{ id: 1 }]);
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20, note: "x" },
            { recipient_id: 4, amount: 5, note: "y" },
          ],
        })
        .expect(201);

      expect(splitService.createSplitsBatchAtomic).toHaveBeenCalledWith({
        transaction_id: 1,
        splits: [
          { recipient_id: 2, amount: 20, note: "x" },
          { recipient_id: 4, amount: 5, note: "y" },
        ],
        actor: null,
      });
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 1 }], total: 1 }));
    });

    // All-or-nothing (bulk-operation semantics): a batch mixing valid and
    // malformed rows used to commit the valid subset silently. It must now be
    // rejected wholesale, with the 400 naming each offending index.
    it("rejects the whole batch when one row of several is malformed, writing nothing", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20, note: "x" },
            { recipient_id: null, amount: 20, note: "dropped before this fix" },
            { recipient_id: 3, amount: 5 },
          ],
        })
        .expect(400);

      expect(res.body.error.message).toMatch(/splits\[1\]/);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });

    it("names every offending index when several rows are malformed", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: 2, amount: 20 },
            { recipient_id: "abc", amount: 5 },
            { recipient_id: 3, amount: "not-a-number" },
          ],
        })
        .expect(400);

      expect(res.body.error.message).toMatch(
        /splits\[1\].*recipient_id.*splits\[2\].*amount/s,
      );
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });

    // Pins for the zod swap (ZOD-08): normalization keeps finite (even
    // non-positive) amounts. The id half of this pin ('12abc' → 12) was
    // dropped when validateId became a strict digit-string parse — it recorded
    // what parseInt happened to do, not a contract worth keeping, and a batch
    // row silently splitting to recipient 12 because the client sent "12abc"
    // is a wrong-record write. Trailing garbage now rejects the whole batch,
    // consistent with the all-or-nothing rule the row schema already applies.
    it("throws ValidationError for a non-integer batch transaction_id", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: "abc",
          splits: [{ recipient_id: 2, amount: 10 }],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });

    it("normalizes rows with strict id coercion and Number amount coercion", async () => {
      splitService.createSplitsBatchAtomic.mockResolvedValue([{ id: 1 }]);
      await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: "12", amount: "5", note: "n" },
            { recipient_id: 3, amount: 0 }, // finite non-positive amounts survive normalization
          ],
        })
        .expect(201);

      expect(splitService.createSplitsBatchAtomic).toHaveBeenCalledWith({
        transaction_id: 1,
        splits: [
          { recipient_id: 12, amount: 5, note: "n" },
          { recipient_id: 3, amount: 0, note: undefined },
        ],
        actor: null,
      });
    });

    it("rejects the whole batch when a row id carries trailing garbage", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [
            { recipient_id: "12abc", amount: "5" },
            { recipient_id: 3, amount: 10 },
          ],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });

    it("rejects the batch on null and non-object rows instead of dropping them", async () => {
      const res = await api
        .post(`${BASE}/batch`)
        .send({
          transaction_id: 1,
          splits: [null, "junk", { recipient_id: 2, amount: 10 }],
        })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.createSplitsBatchAtomic).not.toHaveBeenCalled();
    });
  });

  describe("GET /owed/:id/export/csv", () => {
    it("returns csv with remaining split amount rows", async () => {
      splitService.getOwedExportRowsByRecipient.mockResolvedValue([
        {
          date: "2026-03-20",
          bank_account: "Main",
          recipient_name: "Coffee Shop",
          memo: "Lunch",
          amount: 5,
          currency: "EUR",
          balance: 100,
          category_name: "FOOD:LUNCH",
          comment: "shared",
        },
      ]);

      const res = await api.get(`${BASE}/owed/7/export/csv`).expect(200);

      expect(splitService.getOwedExportRowsByRecipient).toHaveBeenCalledWith(7);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text).toContain(
        "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment",
      );
      expect(res.text).toContain(
        "2026-03-20,Main,Coffee Shop,Lunch,5,EUR,100,FOOD:LUNCH,shared",
      );
    });

    it("throws NotFoundError when recipient has no unsettled owed transactions", async () => {
      splitService.getOwedExportRowsByRecipient.mockResolvedValue([]);

      const res = await api.get(`${BASE}/owed/7/export/csv`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });
  });

  describe("GET /transaction/:id", () => {
    it("returns splits for transaction", async () => {
      splitService.getSplitsByTransaction.mockResolvedValue([
        { id: 8, transaction_id: 2 },
      ]);

      const res = await api.get(`${BASE}/transaction/2`).expect(200);

      // No limit/offset on the request → the repository is left unbounded and
      // the response carries no limit/offset (the body IS the whole list).
      expect(splitService.getSplitsByTransaction).toHaveBeenCalledWith(2, {});
      expect(res.body).toEqual(
        okEnvelope({ items: [{ id: 8, transaction_id: 2 }], total: 1 }),
      );
    });

    it("slices and reports the full total when limit/offset are supplied", async () => {
      splitService.getSplitsByTransaction.mockResolvedValue([
        { id: 9, transaction_id: 2 },
      ]);
      splitService.countSplitsByTransaction.mockResolvedValue(7);

      const res = await api
        .get(`${BASE}/transaction/2`)
        .query({ limit: "1", offset: "3" })
        .expect(200);

      expect(splitService.getSplitsByTransaction).toHaveBeenCalledWith(2, {
        limit: 1,
        offset: 3,
      });
      expect(res.body).toEqual(
        okEnvelope({
          items: [{ id: 9, transaction_id: 2 }],
          total: 7,
          limit: 1,
          offset: 3,
        }),
      );
    });

    it("propagates error when transaction splits lookup fails", async () => {
      splitService.getSplitsByTransaction.mockRejectedValue(new Error("boom"));

      const res = await api.get(`${BASE}/transaction/2`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("POST /:id/pay", () => {
    it("throws NotFoundError when split does not exist", async () => {
      splitService.addPayment.mockRejectedValue(
        new NotFoundError("Split not found"),
      );

      const res = await api
        .post(`${BASE}/5/pay`)
        .send({ amount: 5 })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
      expect(splitService.addPayment).toHaveBeenCalled();
    });

    it("throws ValidationError for non-positive payment amount", async () => {
      splitService.getSplitById.mockResolvedValue({ id: 5, amount: 100 });
      splitService.getAlreadyPaid.mockResolvedValue(0);

      const res = await api
        .post(`${BASE}/5/pay`)
        .send({ amount: 0 })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(splitService.addPayment).not.toHaveBeenCalled();
    });

    it("records payment and returns 201", async () => {
      splitService.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitService.getAlreadyPaid.mockResolvedValue(0);
      splitService.addPayment.mockResolvedValue({
        id: 5,
        split_id: 7,
        amount: 12,
      });

      const res = await api
        .post(`${BASE}/7/pay`)
        .send({ amount: 12, note: "partial", paid_at: "2026-03-20" })
        .expect(201);

      expect(splitService.addPayment).toHaveBeenCalledWith({
        split_id: 7,
        amount: 12,
        note: "partial",
        paid_at: "2026-03-20",
        actor: null,
      });
      expect(res.body).toEqual(okEnvelope({ id: 5, split_id: 7, amount: 12 }));
    });

    it("propagates the caller-supplied actor header to the audit row", async () => {
      splitService.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitService.getAlreadyPaid.mockResolvedValue(0);
      splitService.addPayment.mockResolvedValue({
        id: 5,
        split_id: 7,
        amount: 12,
      });

      await api
        .post(`${BASE}/7/pay`)
        .set("x-actor", "import-review")
        .send({ amount: 12 })
        .expect(201);

      expect(splitService.addPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "import-review",
        }),
      );
    });

    // Pins for the zod swap (ZOD-08): positive-finite check, raw forwarding.
    it("throws ValidationError for non-numeric or negative payment amounts", async () => {
      for (const amount of ["abc", -5, undefined]) {
        const res = await api
          .post(`${BASE}/5/pay`)
          .send({ amount })
          .expect(400);
        expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      }
      expect(splitService.addPayment).not.toHaveBeenCalled();
    });

    it("forwards a numeric-string payment amount raw to the repo", async () => {
      splitService.addPayment.mockResolvedValue({
        id: 5,
        split_id: 7,
        amount: 12,
      });

      await api.post(`${BASE}/7/pay`).send({ amount: "12" }).expect(201);

      expect(splitService.addPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: "12" }),
      );
    });

    it("propagates error when recording payment fails", async () => {
      splitService.getSplitById.mockResolvedValue({ id: 7, amount: 100 });
      splitService.getAlreadyPaid.mockResolvedValue(0);
      splitService.addPayment.mockRejectedValue(new Error("boom"));

      const res = await api
        .post(`${BASE}/7/pay`)
        .send({ amount: 12 })
        .expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("GET /:id/payments", () => {
    it("returns split payments", async () => {
      splitService.getPayments.mockResolvedValue([
        { id: 3, split_id: 7, amount: 6 },
      ]);

      const res = await api.get(`${BASE}/7/payments`).expect(200);

      expect(splitService.getPayments).toHaveBeenCalledWith(7, {});
      expect(res.body).toEqual(
        okEnvelope({ items: [{ id: 3, split_id: 7, amount: 6 }], total: 1 }),
      );
    });

    it("pages payments when limit/offset are supplied", async () => {
      splitService.getPayments.mockResolvedValue([
        { id: 4, split_id: 7, amount: 2 },
      ]);
      splitService.countPayments.mockResolvedValue(12);

      const res = await api
        .get(`${BASE}/7/payments`)
        .query({ limit: "1", offset: "1" })
        .expect(200);

      expect(splitService.getPayments).toHaveBeenCalledWith(7, {
        limit: 1,
        offset: 1,
      });
      expect(res.body).toEqual(
        okEnvelope({
          items: [{ id: 4, split_id: 7, amount: 2 }],
          total: 12,
          limit: 1,
          offset: 1,
        }),
      );
    });

    it("propagates error when payments lookup fails", async () => {
      splitService.getPayments.mockRejectedValue(new Error("boom"));

      const res = await api.get(`${BASE}/7/payments`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("POST /:id/settle", () => {
    it("throws NotFoundError when split is not found", async () => {
      splitService.settleSplit.mockResolvedValue(null);

      const res = await api.post(`${BASE}/9/settle`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("returns settled split when found", async () => {
      splitService.settleSplit.mockResolvedValue({ id: 9, settled: true });
      const res = await api.post(`${BASE}/9/settle`).expect(200);

      expect(splitService.settleSplit).toHaveBeenCalledWith(9, null);
      expect(res.body).toEqual(okEnvelope({ id: 9, settled: true }));
    });

    it("propagates error when settle fails", async () => {
      splitService.settleSplit.mockRejectedValue(new Error("boom"));

      const res = await api.post(`${BASE}/9/settle`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("POST /owed/:id/settle-all", () => {
    it("returns settle-all result", async () => {
      splitService.settleAllByRecipient.mockResolvedValue({
        settled_count: 2,
      });
      const res = await api.post(`${BASE}/owed/12/settle-all`).expect(200);

      expect(splitService.settleAllByRecipient).toHaveBeenCalledWith(12, null);
      expect(res.body).toEqual(okEnvelope({ settled_count: 2 }));
    });

    it("propagates error when settle-all fails", async () => {
      splitService.settleAllByRecipient.mockRejectedValue(new Error("boom"));

      const res = await api.post(`${BASE}/owed/12/settle-all`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });

  describe("DELETE /:id", () => {
    it("throws NotFoundError when split does not exist", async () => {
      splitService.deleteSplit.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/1`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
      expect(splitService.deleteSplit).toHaveBeenCalledWith(1, null);
    });

    it("throws NotFoundError when split cannot be deleted", async () => {
      splitService.deleteSplit.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/1`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("returns 204 with no body when split is deleted", async () => {
      splitService.deleteSplit.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/1`).expect(204);
      expect(splitService.deleteSplit).toHaveBeenCalledWith(1, null);
      expect(res.body).toEqual({});
    });

    it("propagates error when deleting split fails", async () => {
      splitService.deleteSplit.mockRejectedValue(new Error("boom"));

      const res = await api.delete(`${BASE}/1`).expect(500);
      expect(res.body).toEqual(
        errEnvelope({ code: "INTERNAL_SERVER_ERROR", message: "boom" }),
      );
    });
  });
});

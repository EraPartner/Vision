/**
 * Recipient route tests.
 * Mirrors: apps/backend/tests/test_recipients.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, errEnvelope } from "../helpers/routeApp.js";

// The route imports its repository through services/recipientService.js, which
// re-exports the default from this module — mocking the repository here
// intercepts that same binding.
vi.mock("../../src/repositories/recipientRepository.js", () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    createOrGet: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    mergeRecipients: vi.fn(),
    getAliases: vi.fn(),
    unmergeRecipient: vi.fn(),
  },
}));

vi.mock("../../src/services/recipientMergeService.js", () => ({
  mergeRecipients: vi.fn(),
}));

vi.mock("../../src/services/recipientPatternService.js", () => ({
  listPatternsForRecipient: vi.fn(),
  createPattern: vi.fn(),
  updatePattern: vi.fn(),
  deletePattern: vi.fn(),
  previewPatternMatches: vi.fn(),
  suggestPatternFromNames: vi.fn(() => null),
}));

vi.mock("../../src/services/recipientClusterService.js", () => ({
  findRecipientClusters: vi.fn(),
}));

vi.mock("../../src/services/materializedViewService.js", () => ({
  scheduleRefresh: vi.fn(),
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

import recipientRepository from "../../src/repositories/recipientRepository.js";
import { mergeRecipients as mergeRecipientsAtomic } from "../../src/services/recipientMergeService.js";
import {
  updatePattern,
  deletePattern,
} from "../../src/services/recipientPatternService.js";

const { default: recipientsRouter } =
  await import("../../src/routes/recipients.js");

const api = routeAgent(recipientsRouter, { mountPath: "/api/recipients" });
const BASE = "/api/recipients";

describe("Recipient Routes", () => {
  beforeEach(() => vi.resetAllMocks());

  describe("GET /", () => {
    it("should return empty list", async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);

      const res = await api.get(BASE).expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it("should return recipients with data", async () => {
      recipientRepository.getAll.mockResolvedValue([
        { id: 1, name: "JOHN DOE", is_active: true },
        { id: 2, name: "JANE SMITH", is_active: true },
      ]);
      recipientRepository.getCount.mockResolvedValue(2);

      const res = await api.get(BASE).expect(200);

      expect(res.body.data.total).toBe(2);
    });

    // Same id-parser set as the planned-transactions and transactions list
    // filters. `default_category_id` was `x ? parseInt(x) : null`, so
    // ?default_category_id=12abc listed the recipients defaulting to category
    // 12 — a filter nobody asked for — and ?default_category_id=abc produced a
    // NaN that passed the repository's `!= null` guard and reached Postgres as
    // a 22P02 500.
    it("rejects a malformed default_category_id instead of truncating it", async () => {
      for (const raw of [
        "12abc",
        "1e3",
        "12.5",
        "0",
        "-4",
        "abc",
        "NaN",
        "0x10",
        "2147483648",
        " 5",
      ]) {
        const res = await api
          .get(`${BASE}?default_category_id=${encodeURIComponent(raw)}`)
          .expect(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
      expect(recipientRepository.getAll).not.toHaveBeenCalled();
    });

    it('keeps absent and empty default_category_id meaning "no filter"', async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);
      for (const query of ["", "?default_category_id="]) {
        await api.get(`${BASE}${query}`).expect(200);
      }
      for (const call of recipientRepository.getAll.mock.calls) {
        expect(call[0]).toMatchObject({ defaultCategoryId: null });
      }
    });

    it("passes a well-formed default_category_id through unchanged", async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);
      await api.get(`${BASE}?default_category_id=7`).expect(200);
      expect(recipientRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ defaultCategoryId: 7 }),
      );
    });
  });

  describe("POST /", () => {
    it("should create recipient with 201", async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: "JOHN DOE", is_active: true },
        created: true,
      });

      const res = await api.post(BASE).send({ name: "John Doe" }).expect(201);
      expect(res.body.data.created).toBe(true);
    });

    it("should return 200 for duplicate", async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: "JOHN DOE", is_active: true },
        created: false,
      });

      const res = await api.post(BASE).send({ name: "John Doe" }).expect(200);
      expect(res.body.data.created).toBe(false);
    });

    it("should return a 400 VALIDATION_ERROR envelope for missing name", async () => {
      const res = await api.post(BASE).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });
  });

  describe("GET /:id", () => {
    it("should return recipient by id", async () => {
      recipientRepository.getById.mockResolvedValue({
        id: 1,
        name: "JOHN DOE",
      });

      const res = await api.get(`${BASE}/1`).expect(200);
      expect(res.body.data.id).toBe(1);
    });

    it("should return a 404 NOT_FOUND envelope for non-existent", async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/99999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("rejects a non-integer :id via the real validateIdParam guard", async () => {
      // Previously `vi.mock('.../middleware/validation.js')` replaced
      // validateIdParam with a pass-through, so this guard was never tested.
      const res = await api.get(`${BASE}/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(recipientRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:id", () => {
    it("should update recipient", async () => {
      recipientRepository.update.mockResolvedValue({ id: 1, name: "UPDATED" });

      const res = await api
        .patch(`${BASE}/1`)
        .send({ notes: "new" })
        .expect(200);
      expect(res.body.data.name).toBe("UPDATED");
    });

    it("should return a 404 NOT_FOUND envelope for non-existent", async () => {
      recipientRepository.update.mockResolvedValue(null);

      const res = await api
        .patch(`${BASE}/99999`)
        .send({ notes: "x" })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });
  });

  describe("DELETE /:id", () => {
    it("should delete recipient and return 204 with no body", async () => {
      recipientRepository.hardDelete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/1`).expect(204);
      expect(res.text).toBe("");
    });

    it("should return a 404 NOT_FOUND envelope for non-existent", async () => {
      recipientRepository.hardDelete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/99999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });
  });

  describe("POST /:id/merge", () => {
    it("should return a 400 VALIDATION_ERROR envelope when alias_ids is missing", async () => {
      const res = await api.post(`${BASE}/1/merge`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("should return a 400 VALIDATION_ERROR envelope when primary recipient is itself an alias", async () => {
      recipientRepository.getById.mockResolvedValue({
        id: 1,
        primary_recipient_id: 2,
      });

      const res = await api
        .post(`${BASE}/1/merge`)
        .send({ alias_ids: [3] })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("should merge aliases and return primary plus aliases", async () => {
      recipientRepository.getById
        .mockResolvedValueOnce({
          id: 1,
          name: "PRIMARY",
          primary_recipient_id: null,
        })
        .mockResolvedValueOnce({
          id: 1,
          name: "PRIMARY",
          primary_recipient_id: null,
        });
      mergeRecipientsAtomic.mockResolvedValue({
        mergedAliasIds: [3, 4],
        reassigned: { transactions: 7, splits: 0, planned: 0, bankAccounts: 1 },
      });
      recipientRepository.getAliases.mockResolvedValue([
        { id: 3, name: "ALIAS A" },
        { id: 4, name: "ALIAS B" },
      ]);

      const res = await api
        .post(`${BASE}/1/merge`)
        .send({ alias_ids: ["3", "4"] })
        .expect(200);

      expect(mergeRecipientsAtomic).toHaveBeenCalledWith(1, [3, 4]);
      expect(res.body.data).toEqual({
        primary: {
          id: 1,
          name: "PRIMARY",
          primary_recipient_id: null,
          links: [],
        },
        merged_ids: [3, 4],
        reassigned: { transactions: 7, splits: 0, planned: 0, bankAccounts: 1 },
        aliases: [
          { id: 3, name: "ALIAS A" },
          { id: 4, name: "ALIAS B" },
        ],
        patternSuggestion: null,
      });
    });

    it("rejects the whole merge when any alias id is malformed, without calling the service", async () => {
      recipientRepository.getById.mockResolvedValue({
        id: 1,
        name: "PRIMARY",
        primary_recipient_id: null,
      });

      for (const bad of ["12abc", "1e3", "0x10", 1.5, 0, -1, true]) {
        const res = await api
          .post(`${BASE}/1/merge`)
          .send({ alias_ids: [3, bad] })
          .expect(400);
        expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      }

      expect(mergeRecipientsAtomic).not.toHaveBeenCalled();
    });

    it("should return a 404 NOT_FOUND envelope when primary recipient does not exist", async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const res = await api
        .post(`${BASE}/123/merge`)
        .send({ alias_ids: [5] })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });
  });

  describe("POST /:id/unmerge", () => {
    it("should return a 404 NOT_FOUND envelope when recipient cannot be unmerged", async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(false);

      const res = await api.post(`${BASE}/44/unmerge`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("should return updated recipient when unmerge succeeds", async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(true);
      recipientRepository.getById.mockResolvedValue({
        id: 44,
        name: "UNMERGED",
        primary_recipient_id: null,
      });

      const res = await api.post(`${BASE}/44/unmerge`).expect(200);

      expect(recipientRepository.unmergeRecipient).toHaveBeenCalledWith(44);
      expect(recipientRepository.getById).toHaveBeenCalledWith(44);
      expect(res.body.data).toEqual({
        id: 44,
        name: "UNMERGED",
        primary_recipient_id: null,
        links: [],
      });
    });
  });

  describe("GET /:id/aliases", () => {
    it("should return aliases with pagination meta", async () => {
      recipientRepository.getAliases.mockResolvedValue([
        { id: 10, name: "Alias One", primary_recipient_id: 1 },
        { id: 11, name: "Alias Two", primary_recipient_id: 1 },
      ]);

      const res = await api.get(`${BASE}/1/aliases`).expect(200);

      expect(recipientRepository.getAliases).toHaveBeenCalledWith(1);
      expect(res.body.data).toEqual({
        items: [
          { id: 10, name: "Alias One", primary_recipient_id: 1, links: [] },
          { id: 11, name: "Alias Two", primary_recipient_id: 1, links: [] },
        ],
        total: 2,
      });
    });
  });

  describe("pattern sub-route id guards", () => {
    it("PATCH /:id/patterns/:patternId rejects a negative patternId", async () => {
      const res = await api.patch(`${BASE}/1/patterns/-3`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(updatePattern).not.toHaveBeenCalled();
    });

    it("DELETE /:id/patterns/:patternId rejects a zero patternId", async () => {
      const res = await api.delete(`${BASE}/1/patterns/0`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(deletePattern).not.toHaveBeenCalled();
    });

    it("DELETE /:id/patterns/:patternId returns 204 with no body", async () => {
      const res = await api.delete(`${BASE}/1/patterns/77`).expect(204);

      expect(deletePattern).toHaveBeenCalledWith(77);
      expect(res.text).toBe("");
    });
  });
});

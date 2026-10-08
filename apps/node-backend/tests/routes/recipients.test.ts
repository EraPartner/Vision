/**
 * Recipient route tests.
 * Mirrors: apps/backend/tests/test_recipients.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

// The route imports its repository through services/recipientService.js, which
// re-exports the default from this module — mocking the repository here
// intercepts that same binding.
vi.mock("../../src/repositories/recipientRepository.ts", () => ({
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

vi.mock("../../src/services/recipientMergeService.ts", () => ({
  mergeRecipients: vi.fn(),
}));

vi.mock("../../src/services/recipientPatternService.ts", () => ({
  listPatternsForRecipient: vi.fn(),
  createPattern: vi.fn(),
  updatePattern: vi.fn(),
  deletePattern: vi.fn(),
  previewPatternMatches: vi.fn(),
  suggestPatternFromNames: vi.fn(() => null),
}));

vi.mock("../../src/services/recipientClusterService.ts", () => ({
  findRecipientClusters: vi.fn(),
}));

vi.mock("../../src/services/materializedViewService.ts", () => ({
  scheduleRefresh: vi.fn(),
}));

vi.mock("../../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

import rawRecipientRepository from "../../src/repositories/recipientRepository.ts";
import type {
  EnrichedRecipientRow,
  RecipientRow,
} from "../../src/repositories/recipientRepository.ts";
import { mergeRecipients as rawMergeRecipientsAtomic } from "../../src/services/recipientMergeService.ts";
import {
  createPattern,
  updatePattern,
  deletePattern,
  previewPatternMatches,
} from "../../src/services/recipientPatternService.ts";
import { findRecipientClusters } from "../../src/services/recipientClusterService.ts";

const recipientRepository = vi.mocked(rawRecipientRepository);
const mergeRecipientsAtomic = vi.mocked(rawMergeRecipientsAtomic);

type AliasRow = RecipientRow & { default_category_name: string | null };

/** Recipient fixture carrying only the columns a test sets. */
const recipient = (fields: Partial<EnrichedRecipientRow>) =>
  fields as EnrichedRecipientRow;
/** Alias-row fixture (getAliases) carrying only the columns a test sets. */
const alias = (fields: Partial<AliasRow>) => fields as AliasRow;

const { default: recipientsRouter } =
  await import("../../src/routes/recipients.ts");

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
        recipient({ id: 1, name: "JOHN DOE", is_active: true }),
        recipient({ id: 2, name: "JANE SMITH", is_active: true }),
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
        expect(call[0]).toMatchObject({ defaultCategoryId: undefined });
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
        recipient: recipient({ id: 1, name: "JOHN DOE", is_active: true }),
        created: true,
      });

      const res = await api.post(BASE).send({ name: "John Doe" }).expect(201);
      expect(res.body.data.created).toBe(true);
    });

    it("should return 200 for duplicate", async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: recipient({ id: 1, name: "JOHN DOE", is_active: true }),
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
      recipientRepository.getById.mockResolvedValue(
        recipient({
          id: 1,
          name: "JOHN DOE",
        }),
      );

      const res = await api.get(`${BASE}/1`).expect(200);
      expect(res.body.data.id).toBe(1);
    });

    it("should return a 404 NOT_FOUND envelope for non-existent", async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/99999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("rejects a non-integer :id via the real validateIdParam guard", async () => {
      // Previously `vi.mock('.../middleware/validation.ts')` replaced
      // validateIdParam with a pass-through, so this guard was never tested.
      const res = await api.get(`${BASE}/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(recipientRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:id", () => {
    it("should update recipient", async () => {
      recipientRepository.update.mockResolvedValue(
        recipient({ id: 1, name: "UPDATED" }),
      );

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
      recipientRepository.getById.mockResolvedValue(
        recipient({
          id: 1,
          primary_recipient_id: 2,
        }),
      );

      const res = await api
        .post(`${BASE}/1/merge`)
        .send({ alias_ids: [3] })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("should merge aliases and return primary plus aliases", async () => {
      recipientRepository.getById
        .mockResolvedValueOnce(
          recipient({
            id: 1,
            name: "PRIMARY",
            primary_recipient_id: null,
          }),
        )
        .mockResolvedValueOnce(
          recipient({
            id: 1,
            name: "PRIMARY",
            primary_recipient_id: null,
          }),
        );
      mergeRecipientsAtomic.mockResolvedValue({
        mergedAliasIds: [3, 4],
        reassigned: { transactions: 7, splits: 0, planned: 0, bankAccounts: 1 },
      });
      recipientRepository.getAliases.mockResolvedValue([
        alias({ id: 3, name: "ALIAS A" }),
        alias({ id: 4, name: "ALIAS B" }),
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
      recipientRepository.getById.mockResolvedValue(
        recipient({
          id: 1,
          name: "PRIMARY",
          primary_recipient_id: null,
        }),
      );

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
      recipientRepository.getById.mockResolvedValue(
        recipient({
          id: 44,
          name: "UNMERGED",
          primary_recipient_id: null,
        }),
      );

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
        alias({ id: 10, name: "Alias One", primary_recipient_id: 1 }),
        alias({ id: 11, name: "Alias Two", primary_recipient_id: 1 }),
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

  // ADR-193: every query/body field is parsed by the route's zod schema, so a
  // wrong JSON type is a 400 before any service or repository runs. Before,
  // `name: 123` reached `name.toUpperCase()` (500), a non-string `pattern`
  // reached `pattern.trim()` (500), and the other wrong types were forwarded
  // to Postgres.
  describe("request schemas (zod)", () => {
    it.each([
      ["?min_count=2&min_count=3", "/clusters"],
      ["?name=a&name=b", ""],
      ["?search=a&search=b", ""],
      ["?sort_by=a&sort_by=b", ""],
    ])(
      "rejects a repeated or bracketed single-value query (%s)",
      async (query, path) => {
        const res = await api.get(`${BASE}${path}${query}`).expect(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        expect(findRecipientClusters).not.toHaveBeenCalled();
        expect(recipientRepository.getAll).not.toHaveBeenCalled();
      },
    );

    it("keeps an unrecognised sort_dir as the default order", async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);
      await api.get(`${BASE}?sort_dir=sideways&limit=abc`).expect(200);
      expect(recipientRepository.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ sortDir: undefined, limit: 50, offset: 0 }),
      );
    });

    it.each([
      [{ name: 123 }, "name: must be a string"],
      [{ name: "" }, "name: Missing required field"],
      [{ name: "A", default_category_id: "1e3" }, "default_category_id"],
      [{ name: "A", notes: 42 }, "notes"],
    ])("POST / rejects %j", async (body, message) => {
      const res = await api.post(BASE).send(body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toContain(message);
      expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
      expect(recipientRepository.update).not.toHaveBeenCalled();
    });

    it("POST / still coerces a digit-string default_category_id", async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: recipient({ id: 4, name: "A" }),
        created: true,
      });
      recipientRepository.update.mockResolvedValue(recipient({ id: 4 }));
      await api
        .post(BASE)
        .send({ name: "A", default_category_id: "7" })
        .expect(201);
      expect(recipientRepository.update).toHaveBeenCalledWith(4, {
        default_category_id: 7,
        notes: undefined,
      });
    });

    it.each([
      { name: 5 },
      { default_category_id: "abc" },
      { default_category_id: 0 },
      { notes: ["x"] },
      { is_active: "yes" },
    ])("PATCH /:id rejects %j", async (body) => {
      const res = await api.patch(`${BASE}/1`).send(body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(recipientRepository.update).not.toHaveBeenCalled();
    });

    it("PATCH /:id forwards only the known fields, keeping null clears", async () => {
      recipientRepository.update.mockResolvedValue(recipient({ id: 1 }));
      await api
        .patch(`${BASE}/1`)
        .send({
          default_category_id: null,
          notes: "n",
          primary_recipient_id: 9,
        })
        .expect(200);
      expect(recipientRepository.update).toHaveBeenCalledWith(1, {
        default_category_id: null,
        notes: "n",
      });
    });

    it.each([{ alias_ids: "3" }, { alias_ids: [] }])(
      "POST /:id/merge rejects %j",
      async (body) => {
        const res = await api.post(`${BASE}/1/merge`).send(body).expect(400);
        expect(res.body.error.message).toContain(
          "Missing required field: alias_ids",
        );
        expect(mergeRecipientsAtomic).not.toHaveBeenCalled();
      },
    );

    it.each([
      { pattern: 123 },
      { pattern: "" },
      { pattern: "ACME", pattern_kind: "fuzzy" },
      { pattern: "ACME", case_sensitive: "yes" },
      { pattern: "ACME", priority: "high" },
      { pattern: "ACME", priority: 1.5 },
      { pattern: "ACME", priority: 2147483648 },
      { pattern: "ACME", notes: 7 },
    ])("POST /:id/patterns rejects %j", async (body) => {
      const res = await api.post(`${BASE}/1/patterns`).send(body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(createPattern).not.toHaveBeenCalled();
    });

    it("POST /:id/patterns forwards a well-typed body", async () => {
      vi.mocked(createPattern).mockResolvedValue({ id: 3 });
      await api
        .post(`${BASE}/1/patterns`)
        .send({ pattern: "ACME", pattern_kind: "glob", priority: 5 })
        .expect(201);
      expect(createPattern).toHaveBeenCalledWith({
        recipientId: 1,
        pattern: "ACME",
        pattern_kind: "glob",
        case_sensitive: undefined,
        priority: 5,
        notes: undefined,
      });
    });

    it("POST /:id/patterns treats null options as their defaults", async () => {
      vi.mocked(createPattern).mockResolvedValue({ id: 4 });
      await api
        .post(`${BASE}/1/patterns`)
        .send({
          pattern: "ACME",
          pattern_kind: null,
          case_sensitive: null,
          priority: null,
          notes: null,
        })
        .expect(201);
      expect(createPattern).toHaveBeenCalledWith({
        recipientId: 1,
        pattern: "ACME",
        pattern_kind: undefined,
        case_sensitive: undefined,
        priority: undefined,
        notes: null,
      });
    });

    it("POST /:id/patterns/preview treats null options as their defaults", async () => {
      await api
        .post(`${BASE}/1/patterns/preview`)
        .send({ pattern: "ACME", pattern_kind: null, case_sensitive: null })
        .expect(200);
      expect(previewPatternMatches).toHaveBeenCalled();
    });

    it.each([{}, { pattern: ["A"] }, { pattern: "A", case_sensitive: 1 }])(
      "POST /:id/patterns/preview rejects %j",
      async (body) => {
        await api.post(`${BASE}/1/patterns/preview`).send(body).expect(400);
        expect(previewPatternMatches).not.toHaveBeenCalled();
      },
    );

    it("POST /:id/patterns/preview rejects a malformed :id", async () => {
      await api
        .post(`${BASE}/abc/patterns/preview`)
        .send({ pattern: "A" })
        .expect(400);
      expect(previewPatternMatches).not.toHaveBeenCalled();
    });

    it.each([
      { pattern: null },
      { priority: "1" },
      { is_active: "false" },
      { pattern_kind: "REGEX" },
    ])("PATCH /:id/patterns/:patternId rejects %j", async (body) => {
      await api.patch(`${BASE}/1/patterns/2`).send(body).expect(400);
      expect(updatePattern).not.toHaveBeenCalled();
    });

    it("PATCH /:id/patterns/:patternId still clears a note with null", async () => {
      vi.mocked(updatePattern).mockResolvedValue(undefined);
      await api.patch(`${BASE}/1/patterns/2`).send({ notes: null }).expect(200);
      expect(updatePattern).toHaveBeenCalledWith(2, { notes: null });
    });
  });
});

/**
 * Saved Charts route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). Body validation in savedCharts.js is inline in
 * the handlers (zod), while `:id` is guarded by the shared `validateIdParam`
 * middleware, so this migration is mechanical: `routeHandlers[...]` calls
 * become supertest requests and `.rejects.toBeInstanceOf(...)` assertions
 * become status-code + envelope assertions against the real error handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, okEnvelope, errEnvelope } from "../helpers/routeApp.js";

vi.mock("../../src/repositories/savedChartsRepository.js", () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

import savedChartsRepository from "../../src/repositories/savedChartsRepository.js";

const { default: savedChartsRouter } =
  await import("../../src/routes/savedCharts.js");

const api = routeAgent(savedChartsRouter, { mountPath: "/api/saved-charts" });
const BASE = "/api/saved-charts";

describe("Saved Charts Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /", () => {
    it("returns all saved charts", async () => {
      savedChartsRepository.getAll.mockResolvedValue([{ id: 1 }]);

      const res = await api.get(BASE).expect(200);

      // No limit/offset on the request → unbounded query, canonical collection
      // shape { items, total } with total = row count and no COUNT round-trip.
      expect(savedChartsRepository.getAll).toHaveBeenCalledWith({});
      expect(savedChartsRepository.getCount).not.toHaveBeenCalled();
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 1 }], total: 1 }));
    });

    it("pages and reports the full total when limit/offset are supplied", async () => {
      savedChartsRepository.getAll.mockResolvedValue([{ id: 2 }]);
      savedChartsRepository.getCount.mockResolvedValue(5);

      const res = await api
        .get(BASE)
        .query({ limit: "1", offset: "1" })
        .expect(200);

      expect(savedChartsRepository.getAll).toHaveBeenCalledWith({
        limit: 1,
        offset: 1,
      });
      expect(res.body).toEqual(
        okEnvelope({ items: [{ id: 2 }], total: 5, limit: 1, offset: 1 }),
      );
    });

    it("propagates error when repository fails", async () => {
      savedChartsRepository.getAll.mockRejectedValue(new Error("db down"));

      const res = await api.get(BASE).expect(500);
      expect(res.body.error.message).toBe("db down");
    });
  });

  describe("POST /", () => {
    it("returns 400 when a selected filter was deleted concurrently", async () => {
      savedChartsRepository.create.mockRejectedValue(
        Object.assign(new Error("foreign key violation"), { code: "23503" }),
      );

      const res = await api
        .post(BASE)
        .send({ name: "Stale filter", categoryIds: [999] })
        .expect(400);

      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("throws ValidationError when name is missing", async () => {
      const res = await api
        .post(BASE)
        .send({ chartType: "line", categoryIds: [1] })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    });

    it("throws ValidationError when chartType is invalid", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", chartType: "pie", categoryIds: [1] })
        .expect(400);
    });

    it("throws ValidationError when categoryIds has invalid entries", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", chartType: "line", categoryIds: [1, "nope"] })
        .expect(400);
    });

    it("creates chart with trimmed name and default chart type", async () => {
      savedChartsRepository.create.mockResolvedValue({
        id: 4,
        name: "Main",
        chart_type: "line",
        category_ids: [1, 2],
      });

      const res = await api
        .post(BASE)
        .send({ name: "  Main  ", categoryIds: ["1", 2] })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith({
        name: "Main",
        chartType: "line",
        categoryIds: [1, 2],
        recipientIds: undefined,
        allCategories: false,
        allRecipients: false,
        allTags: false,
        chartVariant: "default",
        timeBucket: "monthly",
        dateRangeStart: undefined,
        dateRangeEnd: undefined,
      });
      expect(res.body).toEqual(
        okEnvelope({
          id: 4,
          name: "Main",
          chart_type: "line",
          category_ids: [1, 2],
        }),
      );
    });

    it("normalizes tagIds when provided", async () => {
      savedChartsRepository.create.mockResolvedValue({
        id: 5,
        name: "Tagged",
        tag_ids: [5, 6],
      });

      await api
        .post(BASE)
        .send({ name: "Tagged", categoryIds: [], tagIds: ["5", 6] })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tagIds: [5, 6] }),
      );
    });

    it("throws ValidationError when tagIds has invalid entries", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", categoryIds: [], tagIds: [1, "nope"] })
        .expect(400);
    });

    it("passes all-source flags through to the repository", async () => {
      savedChartsRepository.create.mockResolvedValue({
        id: 6,
        name: "AllTags",
      });

      await api
        .post(BASE)
        .send({ name: "AllTags", categoryIds: [], allTags: true })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allTags: true,
          allCategories: false,
          allRecipients: false,
        }),
      );
    });

    it("throws ValidationError when an all-source flag is not a boolean", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", categoryIds: [], allTags: "yes" })
        .expect(400);
    });

    it("accepts the ranked variant on a bar chart", async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 7, name: "Ranked" });

      await api
        .post(BASE)
        .send({
          name: "Ranked",
          categoryIds: [1],
          chartType: "bar",
          chartVariant: "ranked",
        })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ chartType: "bar", chartVariant: "ranked" }),
      );
    });

    it("rejects the ranked variant on a line chart", async () => {
      await api
        .post(BASE)
        .send({
          name: "Bad",
          categoryIds: [1],
          chartType: "line",
          chartVariant: "ranked",
        })
        .expect(400);
    });

    it("rejects a whitespace-only name", async () => {
      await api
        .post(BASE)
        .send({ name: "   ", categoryIds: [1] })
        .expect(400);
      expect(savedChartsRepository.create).not.toHaveBeenCalled();
    });

    it("rejects a non-string name", async () => {
      await api
        .post(BASE)
        .send({ name: 123, categoryIds: [1] })
        .expect(400);
    });

    it("rejects a missing categoryIds field", async () => {
      await api.post(BASE).send({ name: "Main" }).expect(400);
      expect(savedChartsRepository.create).not.toHaveBeenCalled();
    });

    it("wraps a scalar categoryIds into a one-element int array", async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 10 });

      await api
        .post(BASE)
        .send({ name: "Scalar", categoryIds: "5" })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: [5] }),
      );
    });

    it("normalizes recipientIds and rejects invalid entries", async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 11 });

      await api
        .post(BASE)
        .send({ name: "R", categoryIds: [], recipientIds: ["2", 3] })
        .expect(201);
      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ recipientIds: [2, 3] }),
      );

      await api
        .post(BASE)
        .send({ name: "R", categoryIds: [], recipientIds: [0] })
        .expect(400);
    });

    it("rejects an unknown chartVariant", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", categoryIds: [1], chartVariant: "wavy" })
        .expect(400);
    });

    it("rejects an unknown timeBucket", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", categoryIds: [1], timeBucket: "weekly" })
        .expect(400);
    });

    it("rejects a null chartType (only undefined may fall back to the default)", async () => {
      await api
        .post(BASE)
        .send({ name: "Main", categoryIds: [1], chartType: null })
        .expect(400);
    });

    it("passes a yearly timeBucket through", async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 12 });

      await api
        .post(BASE)
        .send({ name: "Yearly", categoryIds: [1], timeBucket: "yearly" })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeBucket: "yearly" }),
      );
    });

    // Full INVALID_COMBINATIONS coverage: the variant defaults interact with the
    // cross-field rule, so pin every illegal (chartType, chartVariant) pair.
    it.each([
      ["line", "stacked"],
      ["line", "grouped"],
      ["line", "ranked"],
      ["area", "grouped"],
      ["area", "ranked"],
    ])(
      "rejects the illegal combination %s:%s",
      async (chartType, chartVariant) => {
        await api
          .post(BASE)
          .send({ name: "Combo", categoryIds: [1], chartType, chartVariant })
          .expect(400);
        expect(savedChartsRepository.create).not.toHaveBeenCalled();
      },
    );

    it("rejects a variant that is illegal against the DEFAULT line chartType", async () => {
      // No chartType in the body: the default 'line' must still participate in
      // the combination rule, so a bare stacked variant is rejected.
      await api
        .post(BASE)
        .send({ name: "Combo", categoryIds: [1], chartVariant: "stacked" })
        .expect(400);
    });

    it.each([
      ["bar", "stacked"],
      ["bar", "grouped"],
      ["area", "stacked"],
    ])(
      "accepts the legal combination %s:%s",
      async (chartType, chartVariant) => {
        savedChartsRepository.create.mockResolvedValue({ id: 13 });

        await api
          .post(BASE)
          .send({ name: "Combo", categoryIds: [1], chartType, chartVariant })
          .expect(201);

        expect(savedChartsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ chartType, chartVariant }),
        );
      },
    );

    it("rejects an unparsable dateRangeStart", async () => {
      await api
        .post(BASE)
        .send({ name: "Dated", categoryIds: [1], dateRangeStart: "not-a-date" })
        .expect(400);
    });

    it("passes a valid dateRangeStart through unchanged and maps empty string to null", async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 14 });

      await api
        .post(BASE)
        .send({
          name: "Dated",
          categoryIds: [1],
          dateRangeStart: "2025-01-01",
          dateRangeEnd: "",
        })
        .expect(201);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dateRangeStart: "2025-01-01",
          dateRangeEnd: null,
        }),
      );
    });
  });

  describe("PATCH /:id", () => {
    it("throws ValidationError when id is not a number", async () => {
      await api.patch(`${BASE}/abc`).send({}).expect(400);
    });

    it("throws ValidationError when name is blank after trimming", async () => {
      await api.patch(`${BASE}/1`).send({ name: "   " }).expect(400);
    });

    it("throws ValidationError when categoryIds is invalid", async () => {
      await api
        .patch(`${BASE}/1`)
        .send({ categoryIds: [1, "bad-id"] })
        .expect(400);
    });

    it("throws NotFoundError when chart does not exist", async () => {
      savedChartsRepository.update.mockResolvedValue(null);

      const res = await api
        .patch(`${BASE}/9`)
        .send({ name: "Updated" })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("updates chart and normalizes categoryIds when provided", async () => {
      savedChartsRepository.update.mockResolvedValue({
        id: 9,
        name: "Updated",
      });

      const res = await api
        .patch(`${BASE}/9`)
        .send({ categoryIds: ["3", 4], chartType: "bar" })
        .expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(9, {
        name: undefined,
        chartType: "bar",
        categoryIds: [3, 4],
      });
      expect(res.body).toEqual(okEnvelope({ id: 9, name: "Updated" }));
    });

    it("normalizes tagIds when provided", async () => {
      savedChartsRepository.update.mockResolvedValue({
        id: 9,
        name: "Updated",
      });

      await api
        .patch(`${BASE}/9`)
        .send({ tagIds: ["7", 8] })
        .expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ tagIds: [7, 8] }),
      );
    });

    it("throws ValidationError when tagIds is invalid", async () => {
      await api
        .patch(`${BASE}/1`)
        .send({ tagIds: [1, "bad-id"] })
        .expect(400);
    });

    it("updates all-source flags when provided", async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ allRecipients: true }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ allRecipients: true }),
      );
    });

    it("throws ValidationError when an all-source flag is not a boolean", async () => {
      await api.patch(`${BASE}/1`).send({ allCategories: 1 }).expect(400);
    });

    it("trims the name before updating", async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ name: "  Renamed  " }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ name: "Renamed" }),
      );
    });

    it("rejects a non-string name", async () => {
      await api.patch(`${BASE}/1`).send({ name: 42 }).expect(400);
    });

    it("rejects an unknown chartVariant", async () => {
      await api.patch(`${BASE}/1`).send({ chartVariant: "wavy" }).expect(400);
    });

    it("rejects an unknown timeBucket", async () => {
      await api.patch(`${BASE}/1`).send({ timeBucket: "daily" }).expect(400);
    });

    it("rejects an illegal chartType/chartVariant pair when both are provided", async () => {
      await api
        .patch(`${BASE}/1`)
        .send({ chartType: "line", chartVariant: "stacked" })
        .expect(400);
      expect(savedChartsRepository.update).not.toHaveBeenCalled();
    });

    it("allows chartType alone without cross-checking the stored variant", async () => {
      // The combination rule only fires when BOTH fields are in the PATCH body —
      // a lone chartType change never consults the persisted variant.
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ chartType: "line" }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ chartType: "line" }),
      );
    });

    it("allows chartVariant alone without cross-checking the stored type", async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ chartVariant: "ranked" }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ chartVariant: "ranked" }),
      );
    });

    it("rejects an unparsable dateRangeEnd", async () => {
      await api
        .patch(`${BASE}/1`)
        .send({ dateRangeEnd: "yesterdayish" })
        .expect(400);
    });

    it("maps an empty-string date to null (clear) on update", async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ dateRangeEnd: "" }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ dateRangeEnd: null }),
      );
    });

    it("rejects a zero chart id", async () => {
      await api.patch(`${BASE}/0`).send({ name: "x" }).expect(400);
    });

    it("passes null through to CLEAR a date range (was silently coerced to undefined)", async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      await api.patch(`${BASE}/9`).send({ dateRangeStart: null }).expect(200);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ dateRangeStart: null }),
      );
    });
  });

  describe("DELETE /:id", () => {
    it("throws ValidationError for invalid chart id", async () => {
      await api.delete(`${BASE}/bad`).expect(400);
    });

    it("throws ValidationError for a negative chart id (was accepted as -5)", async () => {
      await api.delete(`${BASE}/-5`).expect(400);
      expect(savedChartsRepository.delete).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when delete misses", async () => {
      savedChartsRepository.delete.mockResolvedValue(false);

      await api.delete(`${BASE}/8`).expect(404);
    });

    it("returns 204 when delete succeeds", async () => {
      savedChartsRepository.delete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/8`).expect(204);

      expect(res.text).toBe("");
    });
  });
});

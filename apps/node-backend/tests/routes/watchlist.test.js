/**
 * Watchlist route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent, errEnvelope } from "../helpers/routeApp.js";

// The route imports its repository through services/watchlistService.js, which
// re-exports this named binding — mocking the repository here intercepts it.
vi.mock("../../src/repositories/watchlistRepository.js", () => ({
  watchlistRepository: {
    getAllWithCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

import { watchlistRepository } from "../../src/repositories/watchlistRepository.js";

const { default: watchlistRouter } =
  await import("../../src/routes/watchlist.js");

const api = routeAgent(watchlistRouter, { mountPath: "/api/watchlist" });
const BASE = "/api/watchlist";

describe("Watchlist Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /", () => {
    it("clamps pagination and forwards asset class filter", async () => {
      watchlistRepository.getAllWithCount.mockResolvedValue({
        rows: [{ id: 1 }],
        total: 1,
      });

      const res = await api
        .get(`${BASE}?limit=10000&offset=-15&asset_class=stocks`)
        .expect(200);

      expect(watchlistRepository.getAllWithCount).toHaveBeenCalledWith({
        limit: 5000,
        offset: 0,
        assetClass: "stocks",
      });
      expect(res.body.data).toEqual({
        items: [{ id: 1 }],
        total: 1,
        limit: 5000,
        offset: 0,
      });
    });

    it("answers a 500 when repository throws", async () => {
      watchlistRepository.getAllWithCount.mockRejectedValue(
        new Error("db exploded"),
      );

      const res = await api.get(BASE).expect(500);
      expect(res.body.error.message).toBe("db exploded");
    });
  });

  describe("GET /:id", () => {
    it("returns a 404 NOT_FOUND envelope for missing watchlist item", async () => {
      watchlistRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/7`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("rejects a non-integer :id via the real validateIdParam guard", async () => {
      // Previously this suite ran through the mock-router harness, which
      // silently dropped validateIdParam from the chain, so the guard was
      // never actually tested.
      const res = await api.get(`${BASE}/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(watchlistRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe("POST /", () => {
    it("returns a 400 VALIDATION_ERROR envelope when required fields are missing", async () => {
      const res = await api.post(BASE).send({ name: "ETF" }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("creates watchlist item", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 9, name: "ETF Idea" });

      const body = {
        name: "ETF Idea",
        symbol: "VUSA.AS",
        asset_class: "etf",
        target_price: 100,
        currency: "EUR",
        notes: "watch this",
        price_provider_id: "yahoo",
      };

      const res = await api.post(BASE).send(body).expect(201);

      expect(watchlistRepository.create).toHaveBeenCalledWith({
        name: "ETF Idea",
        symbol: "VUSA.AS",
        asset_class: "etf",
        target_price: 100,
        currency: "EUR",
        notes: "watch this",
        price_provider_id: "yahoo",
        added_price: undefined,
      });
      expect(res.body.data).toEqual({ id: 9, name: "ETF Idea" });
    });
  });

  describe("POST / field validation", () => {
    const validBody = {
      name: "NVIDIA",
      symbol: "NVDA",
      asset_class: "stock",
      target_price: 100,
      currency: "USD",
    };

    it("rejects non-numeric target_price with a 400 VALIDATION_ERROR envelope (not a DB 500)", async () => {
      const res = await api
        .post(BASE)
        .send({ ...validBody, target_price: "abc" })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("rejects negative target_price", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, target_price: -5 })
        .expect(400);
    });

    it("rejects a zero target_price (meaningless for the at-or-below alert)", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, target_price: 0 })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("rejects target_price beyond the NUMERIC(18,6) cap (was a DB overflow 500)", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, target_price: 1e15 })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("rejects Infinity target_price", async () => {
      // Infinity is not valid JSON — JSON.stringify(Infinity) === 'null', so
      // send the raw body with a JSON-invalid literal to keep the original
      // intent (a non-finite value reaching the route) instead of silently
      // becoming `target_price: null`.
      await api
        .post(BASE)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ ...validBody, target_price: "Infinity" }))
        .expect(400);
    });

    it("rejects added_price beyond the NUMERIC(18,6) cap", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, added_price: 1e15 })
        .expect(400);
    });

    it("rejects an over-length name (VARCHAR(200)) before the DB 22001", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, name: "x".repeat(201) })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("rejects an over-length symbol (VARCHAR(20))", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, symbol: "A".repeat(21) })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("rejects unknown asset_class", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, asset_class: "beanie-babies" })
        .expect(400);
    });

    it("rejects malformed currency", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, currency: "EURO" })
        .expect(400);
    });

    it("rejects an explicit null currency before the NOT NULL column", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, currency: null })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("normalises a lower-case currency to uppercase before the repository", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      await api
        .post(BASE)
        .send({ ...validBody, currency: "usd" })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "USD" }),
      );
    });

    it("rejects a whitespace-only name (truthy, so the POST presence check let it through)", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, name: "   " })
        .expect(400);
      expect(watchlistRepository.create).not.toHaveBeenCalled();
    });

    it("coerces numeric-string target_price before reaching the repository", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      await api
        .post(BASE)
        .send({ ...validBody, target_price: "123.45" })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ target_price: 123.45 }),
      );
    });

    it("accepts boundary-length name (200) and symbol (20)", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const name = "n".repeat(200);
      const symbol = "S".repeat(20);
      await api
        .post(BASE)
        .send({ ...validBody, name, symbol })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name, symbol }),
      );
    });

    it("accepts target_price at the exact NUMERIC(18,6) cap and rejects one past it", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      const MAX_PRICE = 999_999_999_999;

      await api
        .post(BASE)
        .send({ ...validBody, target_price: MAX_PRICE })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ target_price: MAX_PRICE }),
      );

      await api
        .post(BASE)
        .send({ ...validBody, target_price: MAX_PRICE + 1 })
        .expect(400);
    });

    it("rejects an over-length price_provider_id (VARCHAR(200))", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, price_provider_id: "p".repeat(201) })
        .expect(400);
    });

    it("trims and uppercases a padded lower-case currency", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      await api
        .post(BASE)
        .send({ ...validBody, currency: " usd " })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "USD" }),
      );
    });

    it("rejects an empty-string currency (explicit key must carry a real code)", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, currency: "" })
        .expect(400);
    });

    it("accepts the metals asset_class", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });
      await api
        .post(BASE)
        .send({ ...validBody, asset_class: "metals" })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ asset_class: "metals" }),
      );
    });

    it("accepts a zero added_price (only target_price has the >0 rule) and coerces strings", async () => {
      watchlistRepository.create.mockResolvedValue({ id: 1 });

      await api
        .post(BASE)
        .send({ ...validBody, added_price: 0 })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ added_price: 0 }),
      );

      await api
        .post(BASE)
        .send({ ...validBody, added_price: "12.5" })
        .expect(201);
      expect(watchlistRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ added_price: 12.5 }),
      );
    });

    it("rejects a non-numeric added_price", async () => {
      await api
        .post(BASE)
        .send({ ...validBody, added_price: "soon" })
        .expect(400);
    });
  });

  describe("PATCH /:id field validation", () => {
    it("rejects non-numeric target_price before hitting the repository", async () => {
      const res = await api
        .patch(`${BASE}/1`)
        .send({ target_price: "abc" })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it("rejects unknown asset_class on partial update", async () => {
      await api.patch(`${BASE}/1`).send({ asset_class: "nft" }).expect(400);
    });

    it("allows partial updates that omit typed fields", async () => {
      watchlistRepository.update.mockResolvedValue({
        id: 1,
        notes: "watch earnings",
      });
      await api
        .patch(`${BASE}/1`)
        .send({ notes: "watch earnings" })
        .expect(200);
      expect(watchlistRepository.update).toHaveBeenCalledWith(1, {
        notes: "watch earnings",
      });
    });

    it("rejects an empty name on PATCH (400, not a persisted blank label)", async () => {
      await api.patch(`${BASE}/1`).send({ name: "" }).expect(400);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only name on PATCH", async () => {
      await api.patch(`${BASE}/1`).send({ name: "   " }).expect(400);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it("rejects a null name on PATCH", async () => {
      await api.patch(`${BASE}/1`).send({ name: null }).expect(400);
    });

    it("coerces a numeric-string target_price on PATCH", async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      await api.patch(`${BASE}/1`).send({ target_price: "50.5" }).expect(200);
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ target_price: 50.5 }),
      );
    });

    it("rejects a zero target_price on PATCH", async () => {
      await api.patch(`${BASE}/1`).send({ target_price: 0 }).expect(400);
    });

    it("uppercases currency on PATCH", async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      await api.patch(`${BASE}/1`).send({ currency: "gbp" }).expect(200);
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ currency: "GBP" }),
      );
    });

    it("rejects a null currency on PATCH before the NOT NULL column", async () => {
      await api.patch(`${BASE}/1`).send({ currency: null }).expect(400);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });

    it("rejects an over-length symbol on PATCH", async () => {
      await api
        .patch(`${BASE}/1`)
        .send({ symbol: "A".repeat(21) })
        .expect(400);
    });

    it("passes unvalidated fields through to the repository untouched", async () => {
      // The repository allow-list (not the route) is what drops unknown keys —
      // the route must forward them so notes/other allow-listed columns update.
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      await api
        .patch(`${BASE}/1`)
        .send({ notes: "hold", unknown_field: "kept" })
        .expect(200);
      expect(watchlistRepository.update).toHaveBeenCalledWith(1, {
        notes: "hold",
        unknown_field: "kept",
      });
    });

    it("allows an explicit null added_price on PATCH (only non-null values are frozen)", async () => {
      watchlistRepository.update.mockResolvedValue({ id: 1 });
      await api.patch(`${BASE}/1`).send({ added_price: null }).expect(200);
      expect(watchlistRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ added_price: null }),
      );
    });

    it("rejects added_price on PATCH instead of silently accepting-then-dropping it", async () => {
      // added_price is an add-time snapshot: the repository update allow-list omits
      // it, so before the fix a valid value validated fine yet never persisted (a
      // no-op). It must now surface a 400 rather than the silent no-op.
      await api.patch(`${BASE}/1`).send({ added_price: 123.45 }).expect(400);
      expect(watchlistRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:id", () => {
    it("returns a 404 NOT_FOUND envelope when updating a missing item", async () => {
      watchlistRepository.update.mockResolvedValue(null);

      const res = await api
        .patch(`${BASE}/99`)
        .send({ notes: "updated" })
        .expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });
  });

  describe("DELETE /:id", () => {
    it("returns a 404 NOT_FOUND envelope when delete returns false", async () => {
      watchlistRepository.delete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/33`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
    });

    it("returns 204 with no body on successful delete", async () => {
      watchlistRepository.delete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/33`).expect(204);
      expect(res.text).toBe("");
    });
  });
});

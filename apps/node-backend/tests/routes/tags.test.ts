/**
 * Tag route tests.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeAgent, errEnvelope } from "../helpers/routeApp.ts";

vi.mock("../../src/repositories/tagRepository.ts", () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getBySlug: vi.fn(),
    findOrCreateBySlug: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    countTransactionReferences: vi.fn(),
  },
}));

import tagRepository from "../../src/repositories/tagRepository.ts";
import type { TagRow } from "../../src/repositories/tagRepository.ts";

const repo = vi.mocked(tagRepository);
const tag = (row: Partial<TagRow>) => row as TagRow;

const { default: tagsRouter } = await import("../../src/routes/tags.ts");

const api = routeAgent(tagsRouter, { mountPath: "/api/tags" });
const BASE = "/api/tags";

describe("GET /api/tags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns active tags by default", async () => {
    repo.getAll.mockResolvedValue([
      tag({ id: 1, slug: "rome-2020", is_active: true }),
    ]);
    repo.getCount.mockResolvedValue(1);
    const res = await api.get(BASE).expect(200);
    expect(tagRepository.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ active: true }),
    );
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].slug).toBe("rome-2020");
  });

  it("passes active=false when ?active=false", async () => {
    repo.getAll.mockResolvedValue([]);
    repo.getCount.mockResolvedValue(0);
    await api.get(`${BASE}?active=false`).expect(200);
    expect(tagRepository.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  it("passes the repository no-filter sentinel when ?active=all", async () => {
    repo.getAll.mockResolvedValue([]);
    repo.getCount.mockResolvedValue(0);
    await api.get(`${BASE}?active=all`).expect(200);
    expect(tagRepository.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ active: null }),
    );
  });
});

describe("GET /api/tags — pagination is opt-in", () => {
  beforeEach(() => vi.clearAllMocks());

  // Tag pickers/filters render every tag and send no limit/offset; the route
  // must keep answering the complete list (and must not echo limit/offset).
  // 60 rows pins the old silent truncation at the parsePagination default of 50.
  it("returns the full list (more than 50 rows) and no limit/offset when neither param is sent", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      tag({
        id: i + 1,
        slug: `tag-${i + 1}`,
        is_active: true,
      }),
    );
    repo.getAll.mockResolvedValue(rows);
    const res = await api.get(BASE).expect(200);

    expect(tagRepository.getAll).toHaveBeenCalledWith({
      active: true,
      limit: null,
      offset: 0,
    });
    expect(tagRepository.getCount).not.toHaveBeenCalled();
    expect(res.body.data.items).toHaveLength(60);
    expect(res.body.data.total).toBe(60);
    expect(res.body.data.limit).toBeUndefined();
    expect(res.body.data.offset).toBeUndefined();
  });

  it("treats an empty limit param as absent", async () => {
    repo.getAll.mockResolvedValue([tag({ id: 1, slug: "a", is_active: true })]);
    const res = await api.get(`${BASE}?limit=`).expect(200);

    expect(tagRepository.getAll).toHaveBeenCalledWith({
      active: true,
      limit: null,
      offset: 0,
    });
    expect(res.body.data.limit).toBeUndefined();
  });

  it("pages and reports the full total when limit/offset are supplied", async () => {
    repo.getAll.mockResolvedValue([tag({ id: 3, slug: "c", is_active: true })]);
    repo.getCount.mockResolvedValue(12);
    const res = await api.get(`${BASE}?limit=1&offset=2`).expect(200);

    expect(tagRepository.getAll).toHaveBeenCalledWith({
      active: true,
      limit: 1,
      offset: 2,
    });
    expect(res.body.data).toEqual({
      items: [{ id: 3, slug: "c", is_active: true }],
      total: 12,
      limit: 1,
      offset: 2,
      links: [],
    });
  });

  it("clamps limit to the per-resource cap", async () => {
    repo.getAll.mockResolvedValue([]);
    repo.getCount.mockResolvedValue(0);
    await api.get(`${BASE}?limit=99999`).expect(200);

    expect(tagRepository.getAll).toHaveBeenCalledWith({
      active: true,
      limit: 1000,
      offset: 0,
    });
  });
});

describe("POST /api/tags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates new tag, slugifies input, returns 201", async () => {
    repo.getBySlug.mockResolvedValue(null);
    repo.findOrCreateBySlug.mockResolvedValue({
      tag: tag({ id: 1, slug: "rome-2020", color: null, is_active: true }),
      reactivated: false,
    });
    const res = await api.post(BASE).send({ slug: "Rome 2020" }).expect(201);
    expect(tagRepository.findOrCreateBySlug).toHaveBeenCalledWith(
      "rome-2020",
      null,
    );
    expect(res.body.data.slug).toBe("rome-2020");
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.reactivated).toBe(false);
  });

  it("reactivates inactive tag, returns 201 with junction count", async () => {
    repo.getBySlug.mockResolvedValue(
      tag({
        id: 5,
        slug: "old",
        is_active: false,
      }),
    );
    repo.countTransactionReferences.mockResolvedValue(3);
    repo.findOrCreateBySlug.mockResolvedValue({
      tag: tag({ id: 5, slug: "old", is_active: true }),
      reactivated: true,
    });
    const res = await api.post(BASE).send({ slug: "old" }).expect(201);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.reactivated).toBe(true);
    expect(res.body.data.reactivated_junction_count).toBe(3);
  });

  it("returns 200 when slug matches an active tag (conflict update path)", async () => {
    repo.getBySlug.mockResolvedValue(
      tag({
        id: 6,
        slug: "active",
        is_active: true,
      }),
    );
    repo.findOrCreateBySlug.mockResolvedValue({
      tag: tag({ id: 6, slug: "active", is_active: true }),
      reactivated: true,
    });
    const res = await api.post(BASE).send({ slug: "active" }).expect(200);
    expect(res.body.data.created).toBe(false);
  });

  it("returns a 400 VALIDATION_ERROR envelope when slug is missing", async () => {
    const res = await api.post(BASE).send({}).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("returns a 400 VALIDATION_ERROR envelope when slug normalizes to empty string", async () => {
    const res = await api.post(BASE).send({ slug: "!!!" }).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("returns a 400 VALIDATION_ERROR envelope when color is not a string", async () => {
    repo.getBySlug.mockResolvedValue(null);
    const res = await api
      .post(BASE)
      .send({ slug: "valid", color: 123 })
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("accepts null color", async () => {
    repo.getBySlug.mockResolvedValue(null);
    repo.findOrCreateBySlug.mockResolvedValue({
      tag: tag({ id: 1, slug: "x", color: null, is_active: true }),
      reactivated: false,
    });
    await api.post(BASE).send({ slug: "x", color: null }).expect(201);
    expect(tagRepository.findOrCreateBySlug).toHaveBeenCalledWith("x", null);
  });
});

describe("PATCH /api/tags/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates color and returns the tag", async () => {
    repo.update.mockResolvedValue(
      tag({
        id: 1,
        slug: "rome",
        color: "#f00",
        is_active: true,
      }),
    );
    const res = await api
      .patch(`${BASE}/1`)
      .send({ color: "#f00" })
      .expect(200);
    expect(res.body.data.color).toBe("#f00");
  });

  it("returns a 404 NOT_FOUND envelope when tag not found", async () => {
    repo.update.mockResolvedValue(null);
    const res = await api
      .patch(`${BASE}/999`)
      .send({ color: "#f00" })
      .expect(404);
    expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
  });

  it("returns a 400 VALIDATION_ERROR envelope when color is not a string", async () => {
    const res = await api.patch(`${BASE}/1`).send({ color: 42 }).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("returns a 400 VALIDATION_ERROR envelope when is_active is not a boolean", async () => {
    const res = await api
      .patch(`${BASE}/1`)
      .send({ is_active: "yes" })
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("rejects a non-integer :id via the real validateIdParam guard", async () => {
    // Previously `vi.mock('.../middleware/validation.ts')` replaced
    // validateIdParam with a pass-through, so this guard was never tested.
    const res = await api
      .patch(`${BASE}/abc`)
      .send({ color: "#f00" })
      .expect(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    expect(tagRepository.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tags/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  // Soft delete, so 200 + the deactivated entity rather than 204 (see
  // docs/reference/code-patterns.md, "DELETE responses").
  it("soft-deletes and returns 200 with the deactivated tag", async () => {
    repo.softDelete.mockResolvedValue(
      tag({
        id: 1,
        slug: "rome",
        is_active: false,
      }),
    );
    const res = await api.delete(`${BASE}/1`).expect(200);
    expect(res.body.data).toMatchObject({
      id: 1,
      slug: "rome",
      is_active: false,
      links: [],
    });
  });

  it("returns a 404 NOT_FOUND envelope when tag not found", async () => {
    repo.softDelete.mockResolvedValue(null);
    const res = await api.delete(`${BASE}/999`).expect(404);
    expect(res.body).toEqual(errEnvelope({ code: "NOT_FOUND" }));
  });
});

describe("tag request schemas (zod)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([{ slug: 123 }, { slug: ["a"] }])(
    "POST rejects a non-string slug %j before the service slugifies it",
    async (body) => {
      const res = await api.post(BASE).send(body).expect(400);
      expect(res.body.error.message).toContain("slug");
      expect(repo.findOrCreateBySlug).not.toHaveBeenCalled();
    },
  );

  it("PATCH without a body stays a no-op update", async () => {
    repo.update.mockResolvedValue(tag({ id: 1 }));
    await api.patch(`${BASE}/1`).expect(200);
    expect(repo.update).toHaveBeenCalledWith(1, {
      color: undefined,
      is_active: undefined,
    });
  });

  it("DELETE rejects a malformed :id before deactivating", async () => {
    await api.delete(`${BASE}/12abc`).expect(400);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });
});

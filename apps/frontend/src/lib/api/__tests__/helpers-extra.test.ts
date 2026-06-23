// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  buildQuery,
  buildExclusionQuery,
  requestBlob,
  createWithStatus,
} from "@/lib/api/helpers";
import { bulkExportTransactions } from "@/lib/api/transactions";
import { exportOwedByRecipientCsv } from "@/lib/api/splits";

const API_BASE = "http://localhost:3002";

afterEach(() => server.resetHandlers());

describe("buildQuery", () => {
  it("returns an empty string when params is undefined", () => {
    expect(buildQuery(undefined)).toBe("");
  });

  it("drops undefined, null and empty-string values but keeps falsy 0/false", () => {
    const q = buildQuery({ a: 1, b: undefined, c: null, d: "", e: 0, f: false });
    const params = new URLSearchParams(q);
    expect(params.get("a")).toBe("1");
    expect(params.has("b")).toBe(false);
    expect(params.has("c")).toBe(false);
    expect(params.has("d")).toBe(false);
    expect(params.get("e")).toBe("0");
    expect(params.get("f")).toBe("false");
  });
});

describe("buildExclusionQuery", () => {
  it("returns empty for no params", () => {
    expect(buildExclusionQuery()).toBe("");
    expect(buildExclusionQuery({})).toBe("");
  });

  it("appends repeated ids and a currency", () => {
    const q = new URLSearchParams(
      buildExclusionQuery({
        excluded_category_ids: [1, 2],
        excluded_recipient_ids: [3],
        currency: "EUR",
      }),
    );
    expect(q.getAll("excluded_category_ids")).toEqual(["1", "2"]);
    expect(q.getAll("excluded_recipient_ids")).toEqual(["3"]);
    expect(q.get("currency")).toBe("EUR");
  });

  it("skips empty id arrays", () => {
    expect(buildExclusionQuery({ excluded_category_ids: [], excluded_recipient_ids: [] })).toBe("");
  });
});

describe("requestBlob", () => {
  it("returns the Blob on success and uses API_BASE_URL for relative paths", async () => {
    server.use(
      http.get(`${API_BASE}/api/blob-test`, () =>
        HttpResponse.text("hello", { headers: { "Content-Type": "text/csv" } }),
      ),
    );
    const blob = await requestBlob("/api/blob-test");
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("hello");
  });

  it("does not prepend the base when an absolute URL is passed", async () => {
    let hit = false;
    server.use(
      http.get(`${API_BASE}/api/abs-blob`, () => {
        hit = true;
        return HttpResponse.text("x");
      }),
    );
    await requestBlob(`${API_BASE}/api/abs-blob`);
    expect(hit).toBe(true);
  });

  it("throws an Export error on a non-ok response", async () => {
    server.use(
      http.get(`${API_BASE}/api/blob-fail`, () =>
        HttpResponse.json({ ok: false, error: { message: "nope" } }, { status: 500 }),
      ),
    );
    await expect(requestBlob("/api/blob-fail")).rejects.toBeTruthy();
  });
});

describe("createWithStatus", () => {
  it("reports wasCreated=true on 201 and unwraps the envelope data", async () => {
    server.use(
      http.post(`${API_BASE}/api/cw-test`, () =>
        HttpResponse.json({ ok: true, data: { id: 1 } }, { status: 201 }),
      ),
    );
    const res = await createWithStatus<{ x: number }, { id: number }>("/api/cw-test", { x: 1 });
    expect(res.wasCreated).toBe(true);
    expect(res.data.id).toBe(1);
  });

  it("reports wasCreated=false on 200", async () => {
    server.use(
      http.post(`${API_BASE}/api/cw-test`, () =>
        HttpResponse.json({ ok: true, data: { id: 2 } }, { status: 200 }),
      ),
    );
    const res = await createWithStatus<{ x: number }, { id: number }>("/api/cw-test", { x: 1 });
    expect(res.wasCreated).toBe(false);
  });

  it("throws on a non-ok response", async () => {
    server.use(
      http.post(`${API_BASE}/api/cw-test`, () =>
        HttpResponse.json({ ok: false, error: { message: "bad" } }, { status: 400 }),
      ),
    );
    await expect(createWithStatus("/api/cw-test", {})).rejects.toBeTruthy();
  });
});

describe("blob export endpoints", () => {
  it("bulkExportTransactions posts the request and returns a Blob", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/transactions/bulk-export`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.text("csv,data", { headers: { "Content-Type": "text/csv" } });
      }),
    );
    const blob = await bulkExportTransactions({ ids: [1, 2], format: "csv" } as never);
    expect(body).toMatchObject({ ids: [1, 2] });
    expect(await blob.text()).toBe("csv,data");
  });

  it("exportOwedByRecipientCsv returns a Blob for the recipient", async () => {
    server.use(
      http.get(`${API_BASE}/api/splits/owed/4/export/csv`, () =>
        HttpResponse.text("owed,csv", { headers: { "Content-Type": "text/csv" } }),
      ),
    );
    const blob = await exportOwedByRecipientCsv(4);
    expect(await blob.text()).toBe("owed,csv");
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { listAttachments, deleteAttachment, getAttachmentDownloadUrl } from "@/lib/api/attachments";

afterEach(() => server.resetHandlers());

describe("attachments API client", () => {
  it("listAttachments fetches by transaction id", async () => {
    server.use(
      http.get(`${API_BASE}/api/attachments/transaction/8`, () =>
        ok({ items: [{ id: 1, transaction_id: 8, filename: "r.pdf" }] }),
      ),
    );
    const res = await listAttachments(8);
    expect(res.items[0].filename).toBe("r.pdf");
  });

  it("deleteAttachment DELETEs by id and resolves on 204", async () => {
    let hit = 0;
    server.use(
      http.delete(`${API_BASE}/api/attachments/2`, () => {
        hit += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    // Hard delete → 204 No Content, so there is no body to unwrap.
    await expect(deleteAttachment(2)).resolves.toBeUndefined();
    expect(hit).toBe(1);
  });

  it("getAttachmentDownloadUrl builds the absolute download URL", () => {
    expect(getAttachmentDownloadUrl(42)).toBe(`${API_BASE}/api/attachments/42/download`);
  });
});

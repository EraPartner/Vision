import { describe, expect, it, vi } from "vitest";

import { getRequestContext } from "../src/lib/requestContext.js";
import { requestId } from "../src/middleware/requestId.js";

function createResponse() {
  return { setHeader: vi.fn() };
}

describe("requestId middleware context", () => {
  it("seeds safe incoming ids into the response and async context", async () => {
    const req = { get: vi.fn(() => "incoming-request-123") };
    const res = createResponse();
    let seenAfterAwait;

    await requestId(req, res, async () => {
      await Promise.resolve();
      seenAfterAwait = getRequestContext()?.requestId;
    });

    expect(req.id).toBe("incoming-request-123");
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Request-Id",
      "incoming-request-123",
    );
    expect(seenAfterAwait).toBe("incoming-request-123");
    expect(getRequestContext()).toBeUndefined();
  });

  it("replaces unsafe incoming ids before seeding context", () => {
    const req = { get: vi.fn(() => "bad id\nforged") };
    const res = createResponse();
    let seen;

    requestId(req, res, () => {
      seen = getRequestContext()?.requestId;
    });

    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(req.id);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", req.id);
  });
});

import { describe, expect, it, vi } from "vitest";

import { getRequestContext } from "../src/lib/requestContext.ts";
import { requestId } from "../src/middleware/requestId.ts";
import type { ExpressRequest, ExpressResponse } from "../src/types/express.ts";
import { partial } from "./helpers/partial.ts";

function createResponse() {
  return partial<ExpressResponse>({ setHeader: vi.fn() });
}

describe("requestId middleware context", () => {
  it("seeds safe incoming ids into the response and async context", async () => {
    const req = partial<ExpressRequest>({
      get: vi.fn(() => "incoming-request-123"),
    });
    const res = createResponse();
    let seenAfterAwait: string | undefined;

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
    const req = partial<ExpressRequest>({ get: vi.fn(() => "bad id\nforged") });
    const res = createResponse();
    let seen: string | undefined;

    requestId(req, res, () => {
      seen = getRequestContext()?.requestId;
    });

    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(req.id);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", req.id);
  });
});

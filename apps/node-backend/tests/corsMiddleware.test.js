import { describe, expect, it, vi } from "vitest";
import { createCorsMiddleware } from "../src/middleware/cors.js";

function createResponse() {
  const headers = new Map();
  const response = {
    setHeader: vi.fn((name, value) => headers.set(name.toLowerCase(), value)),
    getHeader: (name) => headers.get(name.toLowerCase()),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  response.writeHead.mockReturnValue(response);
  return response;
}

describe("createCorsMiddleware", () => {
  it("reflects an explicitly allowed origin with the fixed CORS contract", () => {
    const middleware = createCorsMiddleware(() => ["https://app.example"]);
    const response = createResponse();
    const next = vi.fn();

    middleware(
      { method: "GET", headers: { origin: "https://app.example" } },
      response,
      next,
    );

    expect(response.getHeader("vary")).toBe("Origin");
    expect(response.getHeader("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(response.getHeader("access-control-allow-credentials")).toBe("true");
    expect(response.getHeader("access-control-allow-methods")).toBe(
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    expect(response.getHeader("access-control-allow-headers")).toBe(
      "Content-Type,Authorization,X-Request-Id",
    );
    expect(response.getHeader("access-control-expose-headers")).toBe(
      "X-Request-Id,X-Exported-Count",
    );
    expect(next).toHaveBeenCalledOnce();
    expect(response.end).not.toHaveBeenCalled();
  });

  it.each([
    ["a disallowed origin", { origin: "https://evil.example" }],
    ["a missing origin", {}],
  ])("sets no allow headers for %s", (_label, headers) => {
    const middleware = createCorsMiddleware(() => ["https://app.example"]);
    const response = createResponse();
    const next = vi.fn();

    middleware({ method: "GET", headers }, response, next);

    expect(response.getHeader("access-control-allow-origin")).toBeUndefined();
    expect(
      response.getHeader("access-control-allow-credentials"),
    ).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("terminates every OPTIONS request with the existing 204 contract", () => {
    const middleware = createCorsMiddleware(() => []);
    const response = createResponse();
    const next = vi.fn();

    middleware(
      { method: "OPTIONS", headers: { origin: "https://evil.example" } },
      response,
      next,
    );

    expect(response.getHeader("access-control-max-age")).toBe("600");
    expect(response.writeHead).toHaveBeenCalledWith(204);
    expect(response.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});

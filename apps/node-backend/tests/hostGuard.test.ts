import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHostGuard } from "../src/middleware/hostGuard.ts";
import { createCsrfGuard } from "../src/middleware/csrfGuard.ts";
import { createCorsMiddleware } from "../src/middleware/cors.ts";
import { ForbiddenError } from "../src/middleware/errorHandler.ts";
import type {
  ExpressHandler,
  ExpressRequest,
  ExpressResponse,
} from "../src/types/express.ts";
import { loose, partial } from "./helpers/partial.ts";

const guard = createHostGuard();
function run(
  host: string | string[] | undefined,
  options: Partial<ExpressRequest> = {},
  middleware: ExpressHandler = guard,
) {
  const next = vi.fn();
  middleware(
    // loose: a duplicated Host can reach rawHeaders as a nested array here.
    loose<ExpressRequest>({
      headers: { host },
      rawHeaders: host ? ["Host", host] : [],
      ...options,
    }),
    partial<ExpressResponse>({}),
    next,
  );
  return next;
}

describe("destination Host boundary", () => {
  it.each([
    "localhost",
    "LOCALHOST:3002",
    "localhost.:5174",
    "127.0.0.1:3002",
    "127.42.0.5:65535",
    "[::1]:8080",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]:1234",
    "[::ffff:7f00:1]",
    "127.1",
    "2130706433",
    "0x7f000001",
  ])("allows local authority %s", (host) => {
    expect(run(host)).toHaveBeenCalledWith();
  });
  it.each([
    undefined,
    "",
    "rebind.example:3002",
    "localhost.evil.test",
    "127.0.0.1.evil.test",
    "128.0.0.1",
    "0.0.0.0",
    "[::]",
    "[::ffff:192.168.1.2]",
    "::1",
    "127.999.0.1",
    "localhost:0",
    "localhost:65536",
    "localhost:abc",
    "localhost:",
    "localhost:3002/path",
    "user@localhost",
    "localhost?x",
    "localhost#x",
    "localhost\\evil",
    " localhost",
    "localhost\t",
    "localhost,evil.test",
    "http://localhost",
    "..localhost",
    "-localhost",
    "local_host",
  ])("rejects unsafe authority %s", (host) => {
    expect(run(host).mock.calls[0]![0]).toBeInstanceOf(ForbiddenError);
  });
  it("rejects duplicate wire headers despite Node retaining only the first Host", () => {
    expect(
      run("localhost", {
        rawHeaders: ["Host", "localhost", "hOsT", "evil.test"],
      }).mock.calls[0]![0],
    ).toBeInstanceOf(ForbiddenError);
    expect(
      run("localhost", { rawHeaders: [] }).mock.calls[0]![0],
    ).toBeInstanceOf(ForbiddenError);
    expect(run(["localhost", "evil.test"]).mock.calls[0]![0]).toBeInstanceOf(
      ForbiddenError,
    );
  });
  it.each(["0.0.0.0", "::"])(
    "does not disable validation for bind %s",
    (bindHost) => {
      expect(
        run("evil.test", {}, createHostGuard({ bindHost })).mock.calls[0]![0],
      ).toBeInstanceOf(ForbiddenError);
    },
  );
  it("allows exact configured deployment hosts while ignoring forwarded hosts", () => {
    const deployed = createHostGuard({
      bindHost: "192.168.1.5",
      allowedHosts: ["Vision.Example.com", "::1"],
    });
    expect(run("vision.example.com:443", {}, deployed)).toHaveBeenCalledWith();
    expect(run("192.168.1.5", {}, deployed)).toHaveBeenCalledWith();
    expect(
      run("child.vision.example.com", {}, deployed).mock.calls[0]![0],
    ).toBeInstanceOf(ForbiddenError);
    expect(
      run(
        "evil.test",
        { headers: { host: "evil.test", "x-forwarded-host": "localhost" } },
        deployed,
      ).mock.calls[0]![0],
    ).toBeInstanceOf(ForbiddenError);
  });
  it.each([
    "*",
    "*.example.com",
    "https://vision.example.com",
    "vision.example.com:443",
    "0.0.0.0",
    "::",
  ])("fails closed for invalid allowlist %s", (host) => {
    expect(() => createHostGuard({ allowedHosts: [host] })).toThrow(
      "SERVER_ALLOWED_HOSTS",
    );
  });
  it.each(["GET", "POST", "OPTIONS"])(
    "blocks same-origin rebinding %s before any subsequent effects",
    (method) => {
      const effects: string[] = [];
      const request = {
        method,
        headers: {
          host: "rebind.example:3002",
          origin: "http://rebind.example:3002",
          "sec-fetch-site": "same-origin",
          authorization: "Bearer test-token",
          "x-forwarded-host": "localhost",
        },
        rawHeaders: ["Host", "rebind.example:3002"],
      };
      // loose: `end` returns push()'s count rather than the response.
      const response = loose<
        Parameters<ReturnType<typeof createCorsMiddleware>>[1]
      >({
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        end: () => effects.push("cors"),
      });
      const req = partial<ExpressRequest>(request);
      let error: unknown;
      guard(req, response, (err) => {
        error = err;
        if (err) return;
        createCorsMiddleware(() => [request.headers.origin])(
          req,
          response,
          () => {
            effects.push("body");
            createCsrfGuard(() => [request.headers.origin])(req, response, () =>
              effects.push("route"),
            );
          },
        );
      });
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(effects).toEqual([]);
    },
  );
  it("mounts the guard before CORS, body parsing, health and routes", () => {
    const source = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const mount = source.indexOf("createHostGuard({");
    expect(mount).toBeGreaterThan(source.indexOf("app.use(requestId)"));
    for (const token of [
      "app.use(createCorsMiddleware",
      "express.json(",
      'app.use("/api",',
    ])
      expect(source.indexOf(token), token).toBeGreaterThan(mount);
    expect(source.indexOf('"/health"')).toBeGreaterThan(mount);
  });
});

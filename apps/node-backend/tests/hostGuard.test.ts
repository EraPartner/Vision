import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createHostGuard,
  isLoopbackHost,
} from "../src/middleware/hostGuard.ts";
import { createCsrfGuard } from "../src/middleware/csrfGuard.ts";
import { ForbiddenError } from "../src/middleware/errorHandler.ts";
import type {
  ExpressHandler,
  ExpressRequest,
  ExpressResponse,
} from "../src/types/express.ts";
import { loose, partial } from "./helpers/partial.ts";
import { must } from "./helpers/must.ts";

const guard = createHostGuard();
function run(
  host: string | string[] | undefined,
  options: Partial<ExpressRequest> = {},
  middleware: ExpressHandler = guard,
) {
  const next = vi.fn();
  middleware(
    // loose: a repeated Host can arrive as an array here.
    loose<ExpressRequest>({
      headers: { host },
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
    "[::1]:8080",
    "[0:0:0:0:0:0:0:1]",
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
    "127.42.0.5:3002",
    "[::ffff:127.0.0.1]:1234",
    "192.168.1.5:3002",
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
    expect(must(run(host).mock.calls[0], "run(host).mock.calls[0]")[0]).toBeInstanceOf(ForbiddenError);
  });
  it("rejects a repeated Host header value", () => {
    expect(must(run(["localhost", "evil.test"]).mock.calls[0], "run([\"localhost\", \"evil.test\"]).mock.calls[0]")[0]).toBeInstanceOf(
      ForbiddenError,
    );
  });
  it.each([
    ["0.0.0.0", "0.0.0.0"],
    ["::", "[::]"],
    ["192.168.1.5", "192.168.1.5"],
    ["vision.example.com", "vision.example.com"],
  ])("never widens the allowlist for non-loopback bind %s", (bindHost, host) => {
    const bound = createHostGuard({ bindHost });
    expect(must(run("evil.test", {}, bound).mock.calls[0], "run(\"evil.test\", {}, bound).mock.calls[0]")[0]).toBeInstanceOf(
      ForbiddenError,
    );
    expect(must(run(host, {}, bound).mock.calls[0], "run(host, {}, bound).mock.calls[0]")[0]).toBeInstanceOf(
      ForbiddenError,
    );
  });
  it("adds a differently spelled loopback bind address", () => {
    const bound = createHostGuard({ bindHost: "127.0.0.2" });
    expect(run("127.0.0.2:3002", {}, bound)).toHaveBeenCalledWith();
  });
  it("requires the configured port when one is given", () => {
    const bound = createHostGuard({ port: 3002 });
    for (const host of ["localhost:3002", "127.0.0.1:3002", "[::1]:3002"])
      expect(run(host, {}, bound), host).toHaveBeenCalledWith();
    for (const host of ["localhost", "localhost:3003", "127.0.0.1:80"])
      expect(must(run(host, {}, bound).mock.calls[0], "run(host, {}, bound).mock.calls[0]")[0], host).toBeInstanceOf(
        ForbiddenError,
      );
  });
  it("ignores forwarded host headers", () => {
    expect(
      must(run("evil.test", {
        headers: { host: "evil.test", "x-forwarded-host": "localhost" },
      }).mock.calls[0], "run(\"evil.test\", { headers: { host: \"evil.test\", \"x-forwarde")[0],
    ).toBeInstanceOf(ForbiddenError);
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
          "x-forwarded-host": "localhost",
        },
      };
      const response = partial<ExpressResponse>({ setHeader: vi.fn() });
      const req = partial<ExpressRequest>(request);
      let error: unknown;
      guard(req, response, (err) => {
        error = err;
        if (err) return;
        effects.push("body");
        createCsrfGuard(() => [request.headers.origin])(req, response, () =>
          effects.push("route"),
        );
      });
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(effects).toEqual([]);
    },
  );
  it("mounts the guard before body parsing, health and routes", () => {
    const source = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const mount = source.indexOf("createHostGuard({");
    expect(mount).toBeGreaterThan(source.indexOf("app.use(requestId)"));
    for (const token of ["express.json(", 'app.use("/api",'])
      expect(source.indexOf(token), token).toBeGreaterThan(mount);
    expect(source.indexOf('"/health"')).toBeGreaterThan(mount);
  });
});

describe("isLoopbackHost", () => {
  it("accepts localhost and the 127/8 block", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.10.20.30",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ])
      expect(isLoopbackHost(host), host).toBe(true);
  });
  it("rejects wildcard, LAN, public and empty binds", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "vision.example.com",
      "",
      undefined,
    ])
      expect(isLoopbackHost(host), String(host)).toBe(false);
  });
});

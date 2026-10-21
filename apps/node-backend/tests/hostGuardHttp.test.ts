import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createHostGuard } from "../src/middleware/hostGuard.ts";

const servers: http.Server[] = [];
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}
function request(
  port: number,
  headers: string,
  {
    method = "GET",
    path = "/health",
    body = "",
  }: { method?: string; path?: string; body?: string } = {},
) {
  return new Promise<{ status: number; response: string }>(
    (resolve, reject) => {
      let response = "";
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `${method} ${path} HTTP/1.1\r\n${headers ? `${headers}\r\n` : ""}${body ? "Content-Type: application/json\r\n" : ""}Connection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      });
      socket.setTimeout(5000, () =>
        socket.destroy(new Error("HTTP smoke timed out")),
      );
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () =>
        resolve({ status: Number(response.split(" ")[1]), response }),
      );
    },
  );
}
function backend(port?: number) {
  const app = express();
  const effects: string[] = [];
  app.use(createHostGuard({ port }));
  app.use(express.json());
  app.use((req, res) => {
    effects.push(req.path);
    res
      .status(200)
      .send(req.path === "/" ? "<html>Vision fixture</html>" : "ok");
  });
  app.use(((error, _req, res, _next) =>
    res
      .status(error.statusCode || error.status || 500)
      .send(error.message)) satisfies ErrorRequestHandler);
  return { app, effects };
}
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error?: NodeJS.ErrnoException) =>
              error && error.code !== "ERR_SERVER_NOT_RUNNING"
                ? reject(error)
                : resolve(),
            ),
          ),
      ),
  );
});

describe("Host boundary over real HTTP sockets", () => {
  it("allows local health, SPA and API authorities", async () => {
    const { app, effects } = backend();
    const port = await listen(app);
    for (const path of ["/health", "/", "/api/settings"])
      for (const host of [
        `localhost:${port}`,
        `127.0.0.1:${port}`,
        `[::1]:${port}`,
      ])
        expect((await request(port, `Host: ${host}`, { path })).status).toBe(
          200,
        );
    expect(effects).toHaveLength(9);
  });
  it("rejects hostile and missing Host before parsing and routes", async () => {
    const { app, effects } = backend();
    const port = await listen(app);
    const malformed = {
      method: "POST",
      path: "/api/settings",
      body: "{broken",
    };
    const control = await request(port, "Host: localhost", malformed);
    expect(control.status).toBe(400);
    expect(control.response).toContain("JSON");
    for (const headers of [
      "Host: hostile.example",
      "",
    ])
      for (const options of [
        { method: "OPTIONS" },
        { method: "POST", path: "/api/settings", body: "{broken" },
        { path: "/" },
      ]) {
        const result = await request(port, headers, options);
        // Node may reject missing Host at its own HTTP parser boundary.
        if (headers) {
          expect(result.status).toBe(403);
          expect(result.response).toContain("Invalid request host");
        } else expect([400, 403]).toContain(result.status);
        expect(result.response).not.toContain("Access-Control-Max-Age");
        expect(result.response).not.toContain("JSON");
      }
    expect(effects).toEqual([]);
  });
  it("rejects a loopback Host that names another port", async () => {
    let app: http.RequestListener = () => {};
    const port = await listen((req, res) => app(req, res));
    const fixture = backend(port);
    app = fixture.app;
    expect((await request(port, `Host: 127.0.0.1:${port}`)).status).toBe(200);
    for (const host of ["localhost", `localhost:${port + 1}`]) {
      const result = await request(port, `Host: ${host}`);
      expect(result.status, host).toBe(403);
      expect(result.response).toContain("Invalid request host");
    }
    expect(fixture.effects).toEqual(["/health"]);
  });
});

import express from "express";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import supertest from "supertest";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";
import { createRouteApp } from "./helpers/routeApp.ts";
import {
  createNativeHelperArtifactRouter,
  NATIVE_HELPER_ASSET_PREFIX,
  NATIVE_HELPER_DOCUMENT_PATH,
} from "../src/middleware/nativeHelperArtifacts.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

const SPA = "<html><body>synthetic-normal-SPA-marker</body></html>";
const HELPER =
  '<html><body><script type="module" src="/native-helper-assets/bootstrap-AaBb1234.js"></script></body></html>';
const temporary: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(includeHelper = false) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vision-helper-artifacts-"),
  );
  temporary.push(root);
  const dist = path.join(root, "dist");
  await fs.mkdir(path.join(dist, "assets"), { recursive: true });
  await fs.writeFile(path.join(dist, "index.html"), SPA);
  await fs.writeFile(
    path.join(dist, "assets", "normal.js"),
    "console.log('synthetic normal asset');",
  );
  await fs.writeFile(
    path.join(root, "outside-secret.txt"),
    "synthetic-outside-root-marker",
  );
  if (includeHelper) {
    await fs.mkdir(path.join(dist, "native-helper-assets"), {
      recursive: true,
    });
    await fs.writeFile(path.join(dist, "native-helper.html"), HELPER);
    await fs.writeFile(
      path.join(dist, "native-helper-assets", "bootstrap-AaBb1234.js"),
      "export const helper = true;",
    );
    await fs.writeFile(
      path.join(dist, "native-helper-assets", "fiscal-CcDd5678.js"),
      "export const syntheticLazyFiscal = true;",
    );
    await fs.writeFile(
      path.join(dist, "native-helper-assets", "helper-EeFf1234.css"),
      "body { display: none; }",
    );
    await fs.writeFile(
      path.join(dist, "native-helper-assets", ".private"),
      "synthetic-hidden-marker",
    );
    await fs.mkdir(path.join(dist, "native-helper-assets", "nested"));
    await fs.writeFile(
      path.join(dist, "native-helper-assets", "nested", "index.html"),
      "synthetic-directory-index-marker",
    );
  }
  // Reproduce only main.ts's production serving order on a real Express edge.
  // Never import main.ts: its startup graph owns real services and a database.
  const router = express.Router();
  router.use(createNativeHelperArtifactRouter(dist));
  const hashedAssetsPrefix = path.resolve(dist, "assets") + path.sep;
  router.use(
    express.static(dist, {
      index: false,
      maxAge: "1y",
      immutable: true,
      setHeaders: (res, filePath) => {
        if (!filePath.startsWith(hashedAssetsPrefix))
          res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  router.get(/^(?!\/api)/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(SPA);
  });
  const server = createServer(
    createRouteApp(router, { isProduction: () => true }),
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Synthetic HTTP fixture did not bind loopback");
  const port = address.port;
  return {
    api: supertest(server),
    // Superagent normalizes dot segments before transmission. Use an options
    // path to test the actual hostile bytes at this same synthetic HTTP edge.
    rawGet: (pathname: string) =>
      new Promise<{
        status: number;
        headers: IncomingHttpHeaders;
        text: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            method: "GET",
            path: pathname,
            agent: false,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      }),
  };
}

function expectNoSPA(text: string | undefined) {
  expect(text ?? "").not.toContain("synthetic-normal-SPA-marker");
  expect(text ?? "").not.toContain("synthetic-outside-root-marker");
}

describe("reserved native helper production artifacts", () => {
  it("missing optional helper document and bootstrap terminate as 404 errors without mounting the SPA", async () => {
    const { api } = await fixture();
    for (const resource of [
      NATIVE_HELPER_DOCUMENT_PATH,
      `${NATIVE_HELPER_ASSET_PREFIX}/bootstrap-AaBb1234.js`,
    ]) {
      const response = await api.get(resource).expect(404);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.body).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expectNoSPA(response.text);
    }
    const head = await api.head(NATIVE_HELPER_DOCUMENT_PATH).expect(404);
    expectNoSPA(head.text);
  });

  it("serves only the fixed helper HTML with revalidation and correct GET/HEAD MIME", async () => {
    const { api } = await fixture(true);
    const response = await api
      .get(`${NATIVE_HELPER_DOCUMENT_PATH}?fresh=1`)
      .expect(200);
    expect(response.text).toBe(HELPER);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["cache-control"]).toBe("no-cache");
    const head = await api.head(NATIVE_HELPER_DOCUMENT_PATH).expect(200);
    expect(head.headers["content-type"]).toMatch(/^text\/html/);
    expect(head.headers["cache-control"]).toBe("no-cache");
    expect(head.text).toBeUndefined();
    await api.post(NATIVE_HELPER_DOCUMENT_PATH).expect(404);
  });

  it("serves bootstrap and lazy assets from their fixed root with their MIME and immutable cache", async () => {
    const { api } = await fixture(true);
    for (const name of [
      "bootstrap-AaBb1234.js",
      "fiscal-CcDd5678.js",
      "helper-EeFf1234.css",
    ]) {
      const response = await api
        .get(`${NATIVE_HELPER_ASSET_PREFIX}/${name}`)
        .expect(200);
      expect(response.headers["content-type"]).toMatch(
        name.endsWith(".css") ? /^text\/css/ : /javascript/,
      );
      expect(response.headers["cache-control"]).toContain("max-age=31536000");
      expect(response.headers["cache-control"]).toContain("immutable");
      expectNoSPA(response.text);
    }
    const head = await api
      .head(`${NATIVE_HELPER_ASSET_PREFIX}/bootstrap-AaBb1234.js`)
      .expect(200);
    expect(head.headers["content-type"]).toMatch(/javascript/);
    expect(head.text).toBeUndefined();
  });

  it("missing assets, directory requests and helper subpaths cannot fall through or redirect", async () => {
    const { api } = await fixture(true);
    for (const resource of [
      NATIVE_HELPER_ASSET_PREFIX,
      `${NATIVE_HELPER_ASSET_PREFIX}/`,
      `${NATIVE_HELPER_ASSET_PREFIX}/nested`,
      `${NATIVE_HELPER_ASSET_PREFIX}/nested/`,
      `${NATIVE_HELPER_ASSET_PREFIX}/missing-lazy.js`,
      `${NATIVE_HELPER_DOCUMENT_PATH}/`,
      `${NATIVE_HELPER_DOCUMENT_PATH}/child`,
    ]) {
      const response = await api.get(resource).expect(404);
      expect(response.headers.location).toBeUndefined();
      expect(response.body).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expectNoSPA(response.text);
      expect(response.text).not.toContain("synthetic-directory-index-marker");
    }
    const hidden = await api
      .get(`${NATIVE_HELPER_ASSET_PREFIX}/.private`)
      .expect(403);
    expectNoSPA(hidden.text);
    expect(hidden.text).not.toContain("synthetic-hidden-marker");
  });

  it("rejects encoded, case and separator aliases before generic static resolution", async () => {
    const { api } = await fixture(true);
    for (const resource of [
      "/native%2dhelper.html",
      "/%6eative-helper.html",
      "/Native-Helper.html",
      "/native-helper.html%2fchild",
      "/%6eative-helper-assets/bootstrap-AaBb1234.js",
      "/native-helper-assets%2fbootstrap-AaBb1234.js",
      "/Native-Helper-Assets/bootstrap-AaBb1234.js",
      "/native-helper-assets//bootstrap-AaBb1234.js",
      "/native-helper-assets/%zz",
      "/native-helper-assets/%00",
      "/native-helper-assets%5cbootstrap-AaBb1234.js",
    ]) {
      const response = await api.get(resource).expect(404);
      expectNoSPA(response.text);
      expect(response.text).not.toContain("export const helper = true");
    }
  });

  it("encoded traversal cannot escape to the normal index or any other fixed-root file", async () => {
    const { rawGet } = await fixture(true);
    for (const resource of [
      "/native-helper-assets/%2e%2e/index.html",
      "/native-helper-assets/%2e%2e%2findex.html",
      "/native-helper-assets/%2e%2e/native-helper.html",
      "/native-helper-assets/%2e%2e/%2e%2e/outside-secret.txt",
      "/native-helper-assets/%2e%2e%5cindex.html",
      "/ordinary/%2e%2e/native-helper.html",
    ]) {
      const response = await rawGet(resource);
      expect(response.status, resource).toBe(404);
      expectNoSPA(response.text);
      expect(response.text).not.toContain(HELPER);
    }
  });

  it("preserves ordinary SPA routes and normal static assets, including similarly named routes", async () => {
    const { api } = await fixture(true);
    for (const resource of [
      "/transactions?new=1",
      "/native-helperish",
      "/native-helper-assets-extra",
      "/assets/missing-normal.js",
    ]) {
      const response = await api.get(resource).expect(200);
      expect(response.text).toBe(SPA);
      expect(response.headers["cache-control"]).toBe("no-cache");
    }
    const asset = await api.get("/assets/normal.js").expect(200);
    expect(asset.text).toBe("console.log('synthetic normal asset');");
    expect(asset.headers["cache-control"]).toContain("immutable");
    const apiMiss = await api.get("/api/missing").expect(404);
    expectNoSPA(apiMiss.text);
  });
});

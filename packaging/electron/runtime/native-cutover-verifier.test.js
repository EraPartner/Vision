"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { verifyNativeCutoverWorkflows } = require("./native-cutover-verifier");

test("native cutover verifier covers reads, idempotent write, Ollama behavior, and PDF", async () => {
  const calls = [];
  const request = async (_port, method, route, payload, options = {}) => {
    calls.push({ method, route, payload, options });
    if (route === "/health/detailed") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ database: { connected: true } })),
      };
    }
    if (route === "/api/settings/services_settings") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({ data: { value: { keepServicesOnQuit: false } } }),
        ),
      };
    }
    if (route === "/api/reports/financial") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/pdf" },
        body: Buffer.from("%PDF-test"),
      };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ data: { items: [] } })),
    };
  };

  assert.deepEqual(
    await verifyNativeCutoverWorkflows({ port: 3002, request }),
    { status: "verified" },
  );
  assert.ok(calls.some((call) => call.route.startsWith("/api/import/batches")));
  assert.ok(calls.some((call) => call.route === "/api/investments"));
  assert.ok(
    calls.some((call) => call.route.startsWith("/api/planned-transactions")),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "PUT" &&
        call.route === "/api/settings/services_settings",
    ),
  );
  assert.ok(calls.some((call) => call.route === "/api/ai/status"));
  assert.ok(calls.some((call) => call.route === "/api/reports/financial"));
});

test("native cutover verifier identifies the failing method and route", async () => {
  const request = async (_port, method, route) => {
    if (route === "/health/detailed") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ database: { connected: true } })),
      };
    }
    throw new Error("Native cutover verification returned HTTP 500");
  };

  await assert.rejects(
    verifyNativeCutoverWorkflows({ port: 3002, request }),
    /failed for GET \/api\/accounts: Native cutover verification returned HTTP 500/,
  );
});

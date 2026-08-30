"use strict";

const http = require("node:http");

function requestLoopback(
  port,
  method,
  route,
  payload = undefined,
  {
    timeoutMs = 30_000,
    allowedStatuses = [200],
    maxBytes = 16 * 1024 * 1024,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        timeout: timeoutMs,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy(
              new Error("Native cutover verification response is too large"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (!allowedStatuses.includes(response.statusCode)) {
            reject(
              new Error(
                `Native cutover verification returned HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Native cutover verification timed out")),
    );
    if (body) request.write(body);
    request.end();
  });
}

async function requestJson(request, port, method, route, payload, options) {
  let response;
  try {
    response = await request(port, method, route, payload, options);
  } catch (cause) {
    throw new Error(
      `Native cutover verification failed for ${method} ${route}: ${cause?.message || String(cause)}`,
      { cause },
    );
  }
  if (response.statusCode === 404) return { response, value: undefined };
  try {
    return { response, value: JSON.parse(response.body.toString("utf8")) };
  } catch (cause) {
    const error = new Error(
      `Native cutover verification received invalid JSON for ${method} ${route}`,
      { cause },
    );
    throw error;
  }
}

async function verifyNativeCutoverWorkflows({
  port,
  request = requestLoopback,
}) {
  const detailed = await requestJson(request, port, "GET", "/health/detailed");
  if (detailed.value?.database?.connected !== true) {
    throw new Error(
      "Native detailed health did not confirm database readiness",
    );
  }

  for (const route of [
    "/api/accounts",
    "/api/transactions?limit=1&offset=0",
    "/api/import/batches?limit=1&offset=0",
    "/api/investments",
    "/api/planned-transactions?limit=1&offset=0",
  ]) {
    await requestJson(request, port, "GET", route);
  }

  const settingsBefore = await requestJson(
    request,
    port,
    "GET",
    "/api/settings/services_settings",
  );
  const preservedValue = settingsBefore.value?.data?.value;
  if (!preservedValue || typeof preservedValue !== "object") {
    throw new Error("Native settings read did not return an object value");
  }
  await requestJson(request, port, "PUT", "/api/settings/services_settings", {
    value: preservedValue,
  });
  const settingsAfter = await requestJson(
    request,
    port,
    "GET",
    "/api/settings/services_settings",
  );
  if (
    JSON.stringify(settingsAfter.value?.data?.value) !==
    JSON.stringify(preservedValue)
  ) {
    throw new Error("Native settings write/read verification failed");
  }

  await requestJson(request, port, "GET", "/api/ai/status", undefined, {
    allowedStatuses: [200, 404],
  });

  let pdf;
  try {
    pdf = await request(
      port,
      "POST",
      "/api/reports/financial",
      {
        currency: "EUR",
        period: { kind: "rolling", months: 1 },
        sections: [],
        theme: { mode: "light" },
        excludedCategoryIds: [],
        excludedRecipientIds: [],
      },
      { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 },
    );
  } catch (cause) {
    throw new Error(
      `Native cutover verification failed for POST /api/reports/financial: ${cause?.message || String(cause)}`,
      { cause },
    );
  }
  if (
    !String(pdf.headers["content-type"] || "").includes("application/pdf") ||
    pdf.body.length < 5 ||
    pdf.body.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("Native report verification did not produce a PDF");
  }

  return { status: "verified" };
}

module.exports = { requestLoopback, verifyNativeCutoverWorkflows };

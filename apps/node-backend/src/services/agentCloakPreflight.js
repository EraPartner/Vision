import { getAgentCloakConfig } from "./agentCloakRuntimeConfig.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DISCLOSED_TEXT_FIELDS = [
  "question",
  "selectedSummary",
  "selectedEvidence",
];
const REFERENCE_TOKEN = /\[\[VR1:[a-z]+:[A-Za-z0-9_-]{24}\]\]/g;

/** @param {string} text */
export function maskAgentCloakReferenceTokens(text) {
  return text.replace(REFERENCE_TOKEN, (token) => " ".repeat(token.length));
}

/** @param {string} url @param {string} path */
function configuredEndpoint(url, path) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw Object.assign(new Error("AgentCloak URL is invalid"), {
      code: "AGENTCLOAK_CONFIGURATION_INVALID",
    });
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.pathname !== path ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Object.assign(
      new Error(`AgentCloak URL must be a loopback ${path} endpoint`),
      { code: "AGENTCLOAK_CONFIGURATION_INVALID" },
    );
  return endpoint.href;
}

/** @param {Response} response */
async function boundedMcpResponse(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES || !response.body?.getReader)
    throw new Error("AGENTCLOAK_RESPONSE_INVALID");
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (!["application/json", "text/event-stream"].includes(contentType))
    throw new Error("AGENTCLOAK_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error("AGENTCLOAK_RESPONSE_INVALID");
      if (contentType === "application/json") {
        chunks.push(Buffer.from(value));
        continue;
      }
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line[5] === " " ? 6 : 5))
          .join("\n");
        if (!data) continue;
        const message = JSON.parse(data);
        if (message?.id === 1) return message;
      }
    }
    if (contentType === "text/event-stream")
      throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * @param {string} text
 * @param {{ config?: { enabled: boolean, mode?: "mcp" | "desktop", desktopUrl?: string, timeoutMs: number }, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{start: number, end: number, label: string, text: string}>>}
 */
export async function detectAgentCloakDesktopSpans(
  text,
  { config, fetchImpl = globalThis.fetch, signal } = {},
) {
  const activeConfig = config ?? (await getAgentCloakConfig());
  if (!activeConfig?.enabled || activeConfig.mode !== "desktop") return [];
  if (
    !Number.isInteger(activeConfig.timeoutMs) ||
    activeConfig.timeoutMs < 100 ||
    activeConfig.timeoutMs > 60_000
  )
    throw Object.assign(new Error("AgentCloak Desktop is not configured"), {
      code: "AGENTCLOAK_CONFIGURATION_INVALID",
    });
  const endpoint = configuredEndpoint(
    activeConfig.desktopUrl || "http://127.0.0.1:8787/detect",
    "/detect",
  );
  const message = maskAgentCloakReferenceTokens(text);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, activeConfig.timeoutMs);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ text: message }),
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json")
    )
      throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    const data = await boundedMcpResponse(response);
    if (
      !Array.isArray(data?.spans) ||
      !data.spans.every(
        /** @param {unknown} candidate */ (candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const span = /** @type {Record<string, unknown>} */ (candidate);
          return (
            Number.isInteger(span.start) &&
            Number.isInteger(span.end) &&
            /** @type {number} */ (span.start) >= 0 &&
            /** @type {number} */ (span.end) >
              /** @type {number} */ (span.start) &&
            /** @type {number} */ (span.end) <= message.length &&
            typeof span.label === "string" &&
            span.label.length > 0 &&
            span.text ===
              message.slice(
                /** @type {number} */ (span.start),
                /** @type {number} */ (span.end),
              )
          );
        },
      )
    )
      throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    const spans =
      /** @type {Array<{start: number, end: number, label: string, text: string}>} */ (
        data.spans
      );
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1)
      if (ordered[index].start < ordered[index - 1].end)
        throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    for (const span of ordered)
      if (text.slice(span.start, span.end) !== span.text)
        throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    return ordered;
  } catch (error) {
    if (signal?.aborted)
      throw Object.assign(new Error("AgentCloak preflight was cancelled"), {
        code: "ABORTED",
      });
    throw Object.assign(
      new Error("AgentCloak Desktop could not verify the cloud text"),
      { code: "AGENTCLOAK_PREFLIGHT_FAILED", cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * @param {Record<string, unknown>} disclosedPayload
 * @param {{
 *   config?: { enabled: boolean, mode?: "mcp" | "desktop", url?: string, apiKey?: string, desktopUrl?: string, timeoutMs: number },
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function checkAgentCloakPreflight(
  disclosedPayload,
  { config, fetchImpl = globalThis.fetch, signal } = {},
) {
  const activeConfig = config ?? (await getAgentCloakConfig());
  if (!activeConfig?.enabled) return { enabled: false };
  const mode = activeConfig.mode ?? "mcp";
  if (
    (mode === "mcp" && (!activeConfig.url || !activeConfig.apiKey)) ||
    !Number.isInteger(activeConfig.timeoutMs) ||
    activeConfig.timeoutMs < 100 ||
    activeConfig.timeoutMs > 60_000
  )
    throw Object.assign(new Error("AgentCloak preflight is not configured"), {
      code: "AGENTCLOAK_CONFIGURATION_INVALID",
    });
  const endpoint =
    mode === "desktop"
      ? configuredEndpoint(
          activeConfig.desktopUrl || "http://127.0.0.1:8787/detect",
          "/detect",
        )
      : configuredEndpoint(activeConfig.url || "", "/mcp");
  for (const field of DISCLOSED_TEXT_FIELDS) {
    const original = disclosedPayload[field];
    if (typeof original !== "string" || !original) continue;
    if (mode === "desktop") {
      const spans = await detectAgentCloakDesktopSpans(original, {
        config: activeConfig,
        fetchImpl,
        signal,
      });
      if (spans.length > 0)
        throw Object.assign(
          new Error(
            `AgentCloak Desktop flagged ${field}; revise it before cloud disclosure`,
          ),
          { code: "AGENTCLOAK_SENSITIVE_TEXT" },
        );
      continue;
    }
    // The local reference map owns these tokens. AgentCloak checks the
    // surrounding text without learning or rewriting their identifiers.
    const message = original.replace(REFERENCE_TOKEN, "REFERENCE");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, activeConfig.timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "x-inc-agentcloak-api-key": activeConfig.apiKey || "",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "cloak", arguments: { message } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("AGENTCLOAK_RESPONSE_INVALID");
      const data = await boundedMcpResponse(response);
      const result = data?.result?.structuredContent;
      if (
        data?.jsonrpc !== "2.0" ||
        data?.id !== 1 ||
        data?.error ||
        data?.result?.isError ||
        typeof result?.result !== "string" ||
        typeof result?.id !== "string" ||
        !result.id
      )
        throw new Error("AGENTCLOAK_RESPONSE_INVALID");
      if (result.result !== message)
        throw Object.assign(
          new Error(
            `AgentCloak flagged ${field}; revise it or use Vision reference markers before cloud disclosure`,
          ),
          { code: "AGENTCLOAK_SENSITIVE_TEXT" },
        );
    } catch (error) {
      if (signal?.aborted)
        throw Object.assign(new Error("AgentCloak preflight was cancelled"), {
          code: "ABORTED",
        });
      if (error?.code === "AGENTCLOAK_SENSITIVE_TEXT") throw error;
      throw Object.assign(
        new Error("AgentCloak preflight could not verify the cloud text"),
        { code: "AGENTCLOAK_PREFLIGHT_FAILED", cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return { enabled: true, status: "passed" };
}

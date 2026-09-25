import settings from "../config/config.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DISCLOSED_TEXT_FIELDS = [
  "question",
  "selectedSummary",
  "selectedEvidence",
];
const REFERENCE_TOKEN = /\[\[VR1:[a-z]+:[A-Za-z0-9_-]{24}\]\]/g;

function configuredEndpoint(url) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw Object.assign(new Error("AgentCloak MCP URL is invalid"), {
      code: "AGENTCLOAK_CONFIGURATION_INVALID",
    });
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/mcp" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Object.assign(
      new Error("AgentCloak MCP URL must be a loopback /mcp endpoint"),
      { code: "AGENTCLOAK_CONFIGURATION_INVALID" },
    );
  return endpoint.href;
}

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

export async function checkAgentCloakPreflight(
  disclosedPayload,
  {
    config = settings.aiResearch.agentCloak,
    fetchImpl = globalThis.fetch,
    signal,
  } = {},
) {
  if (!config?.enabled) return { enabled: false };
  if (
    !config.url ||
    !config.apiKey ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 100 ||
    config.timeoutMs > 60_000
  )
    throw Object.assign(new Error("AgentCloak preflight is not configured"), {
      code: "AGENTCLOAK_CONFIGURATION_INVALID",
    });
  const endpoint = configuredEndpoint(config.url);
  for (const field of DISCLOSED_TEXT_FIELDS) {
    const original = disclosedPayload[field];
    if (typeof original !== "string" || !original) continue;
    // The local reference map owns these tokens. AgentCloak checks the
    // surrounding text without learning or rewriting their identifiers.
    const message = original.replace(REFERENCE_TOKEN, "REFERENCE");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, config.timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "x-inc-agentcloak-api-key": config.apiKey,
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

import { getAgentCloakConfig } from "./agentCloakRuntimeConfig.ts";

export interface AgentCloakSpan {
  start: number;
  end: number;
  label: string;
  text: string;
}

/** Parsed AgentCloak JSON body; every field is untrusted until checked. */
interface AgentCloakResponseBody {
  spans?: unknown;
  jsonrpc?: unknown;
  id?: unknown;
  error?: unknown;
  result?: {
    isError?: unknown;
    structuredContent?: { result?: unknown; id?: unknown };
  };
}

interface AgentCloakDetectConfig {
  enabled: boolean;
  mode?: "mcp" | "desktop";
  desktopUrl?: string;
  timeoutMs: number;
}

interface AgentCloakPreflightConfig extends AgentCloakDetectConfig {
  url?: string;
  apiKey?: string;
}

interface AgentCloakRequestOptions<C> {
  config?: C;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const DISCLOSED_TEXT_FIELDS = [
  "question",
  "selectedSummary",
  "selectedEvidence",
];
const REFERENCE_TOKEN = /\[\[VR1:[a-z]+:[A-Za-z0-9_-]{24}\]\]/g;

export function maskAgentCloakReferenceTokens(text: string) {
  return text.replace(REFERENCE_TOKEN, (token) => " ".repeat(token.length));
}

function configuredEndpoint(url: string, path: string) {
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

async function boundedMcpResponse(
  response: Response,
): Promise<AgentCloakResponseBody> {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES || !response.body?.getReader)
    throw new Error("AGENTCLOAK_RESPONSE_INVALID");
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (
    !contentType ||
    !["application/json", "text/event-stream"].includes(contentType)
  )
    throw new Error("AGENTCLOAK_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
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

export async function detectAgentCloakDesktopSpans(
  text: string,
  {
    config,
    fetchImpl = globalThis.fetch,
    signal,
  }: AgentCloakRequestOptions<AgentCloakDetectConfig> = {},
): Promise<AgentCloakSpan[]> {
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
      !data.spans.every((candidate: unknown): candidate is AgentCloakSpan => {
        if (!isRecord(candidate)) return false;
        const span = candidate;
        return (
          typeof span.start === "number" &&
          Number.isInteger(span.start) &&
          typeof span.end === "number" &&
          Number.isInteger(span.end) &&
          span.start >= 0 &&
          span.end > span.start &&
          span.end <= message.length &&
          typeof span.label === "string" &&
          span.label.length > 0 &&
          span.text === message.slice(span.start, span.end)
        );
      })
    )
      throw new Error("AGENTCLOAK_RESPONSE_INVALID");
    const spans: AgentCloakSpan[] = data.spans;
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    let previous: AgentCloakSpan | undefined;
    for (const span of ordered) {
      if (previous && span.start < previous.end)
        throw new Error("AGENTCLOAK_RESPONSE_INVALID");
      previous = span;
    }
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

export async function checkAgentCloakPreflight(
  disclosedPayload: Record<string, unknown>,
  {
    config,
    fetchImpl = globalThis.fetch,
    signal,
  }: AgentCloakRequestOptions<AgentCloakPreflightConfig> = {},
): Promise<{ enabled: false } | { enabled: true; status: "passed" }> {
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
      if (errorCode(error) === "AGENTCLOAK_SENSITIVE_TEXT") throw error;
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

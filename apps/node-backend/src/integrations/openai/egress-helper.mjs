import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 512 * 1024;

function outputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  if (!Array.isArray(data?.output)) return "";
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((item) => item?.type === "output_text")
    .map((item) => String(item.text ?? ""))
    .join("");
}

async function readBoundedJson(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body?.getReader) return response.json().catch(() => ({}));
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error.message === "RESPONSE_TOO_LARGE") throw error;
    return {};
  } finally {
    reader.releaseLock?.();
  }
}

export async function executeBrokerRequest(
  request,
  { fetchImpl = globalThis.fetch, apiKey = process.env.OPENAI_API_KEY } = {},
) {
  if (
    !request ||
    Object.keys(request).sort().join(",") !== "body,timeoutMs" ||
    typeof request.body !== "string" ||
    Buffer.byteLength(request.body) > MAX_INPUT_BYTES ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 100 ||
    request.timeoutMs > 60_000
  )
    return { ok: false, code: "INVALID_BROKER_INPUT" };
  let body;
  try {
    body = JSON.parse(request.body);
  } catch {
    return { ok: false, code: "INVALID_BROKER_INPUT" };
  }
  if (
    !body ||
    Object.keys(body).sort().join(",") !==
      "background,input,max_output_tokens,model,store,tools" ||
    body.store !== false ||
    body.background !== false ||
    !Array.isArray(body.tools) ||
    body.tools.length !== 0 ||
    typeof body.input !== "string" ||
    Buffer.byteLength(body.input) > MAX_INPUT_BYTES ||
    typeof body.model !== "string" ||
    body.model.length < 1 ||
    body.model.length > 200 ||
    !Number.isInteger(body.max_output_tokens) ||
    body.max_output_tokens < 64 ||
    body.max_output_tokens > 32_000 ||
    !apiKey
  )
    return { ok: false, code: "INVALID_BROKER_POLICY" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey || ""}`,
        "Content-Type": "application/json",
      },
      body: request.body,
      signal: controller.signal,
    });
    const data = await readBoundedJson(response);
    if (!response.ok)
      return {
        ok: false,
        code: `HTTP_${response.status}`,
        requestId: data.id ?? null,
      };
    return {
      ok: true,
      requestId: data.id ?? null,
      outputText: outputText(data),
      usage: data.usage ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error?.message === "RESPONSE_TOO_LARGE"
          ? "RESPONSE_TOO_LARGE"
          : error?.name === "AbortError"
            ? "TIMEOUT"
            : "NETWORK_ERROR",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const chunks = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_INPUT_BYTES) {
      process.stdout.write(
        JSON.stringify({ ok: false, code: "BROKER_INPUT_TOO_LARGE" }),
      );
      process.exitCode = 2;
      return;
    }
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.stdout.write(
      JSON.stringify({ ok: false, code: "INVALID_BROKER_INPUT" }),
    );
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify(await executeBrokerRequest(request)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

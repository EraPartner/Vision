/**
 * Apple Foundation Models as one more model behind the Ollama client.
 *
 * The packaged app ships `vision-apple-ai`, a small Swift helper that speaks
 * the Ollama /api/chat request and reply format over stdin/stdout. This module
 * wraps the client's fetch: a chat for {@link APPLE_FOUNDATION_MODEL} runs the
 * helper, /api/tags lists that model when the Mac supports it, and every other
 * request goes to Ollama unchanged.
 *
 * Apple's on-device model has a 4,096-token window for instructions, tools,
 * prompt and answer together, so requests are cut down before they reach it
 * (see {@link fitForAppleModel}).
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const APPLE_FOUNDATION_MODEL = "apple-foundation";

const CHECK_TTL_MS = 60_000;
// Budgets in characters (~4 per token) that leave ~1,000 tokens for the answer.
const MAX_TOOLS = 3;
const MAX_SYSTEM_CHARS = 4_500;
const MAX_MESSAGE_CHARS = 1_500;
const MAX_CONVERSATION_CHARS = 4_000;

interface ChatMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface ToolSchema {
  function?: { name?: string; description?: string };
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolSchema[] | undefined;
  [key: string]: unknown;
}

function appleHelperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== "darwin") return null;
  const candidate =
    env.APPLE_AI_HELPER ||
    (env.VISION_RUNTIME_ROOT
      ? path.join(env.VISION_RUNTIME_ROOT, "vision-apple-ai")
      : null);
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

let lastCheck: { at: number; available: Promise<boolean> } | null = null;

/** Whether the helper exists and reports the model ready (cached 60 s). */
function appleModelAvailable(): Promise<boolean> {
  if (lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS)
    return lastCheck.available;
  const helper = appleHelperPath();
  const available = helper
    ? new Promise<boolean>((resolve) => {
        execFile(helper, ["--check"], { timeout: 5_000 }, (error, stdout) => {
          try {
            const status: unknown = JSON.parse(stdout);
            resolve(
              !error &&
                typeof status === "object" &&
                status !== null &&
                "available" in status &&
                status.available === true,
            );
          } catch {
            resolve(false);
          }
        });
      })
    : Promise.resolve(false);
  lastCheck = { at: Date.now(), available };
  return available;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

function contentText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Keep the system prompt, the newest messages that fit, and the few tools
 * whose names and descriptions share the most words with the last question.
 */
function fitForAppleModel(body: ChatBody): ChatBody {
  const messages = body.messages ?? [];
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => ({
      ...message,
      content: truncate(contentText(message), MAX_SYSTEM_CHARS),
    }));
  const conversation: ChatMessage[] = [];
  let budget = MAX_CONVERSATION_CHARS;
  for (const message of messages.toReversed()) {
    if (message.role === "system") continue;
    const content = truncate(contentText(message), MAX_MESSAGE_CHARS);
    if (content.length > budget && conversation.length > 0) break;
    conversation.unshift({ ...message, content });
    budget -= content.length;
  }

  const question = contentText(
    messages.findLast((message) => message.role === "user") ?? {},
  );
  const stems = new Set(words(question).map((word) => word.slice(0, 5)));
  const tools = (body.tools ?? [])
    .map((tool) => {
      const haystack = words(
        `${tool.function?.name ?? ""} ${tool.function?.description ?? ""}`,
      );
      const score = haystack.filter((word) =>
        stems.has(word.slice(0, 5)),
      ).length;
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOOLS)
    .map(({ tool }) => tool);

  return {
    ...body,
    messages: [...system, ...conversation],
    tools: tools.length > 0 ? tools : undefined,
  };
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runHelper(
  helper: string,
  body: ChatBody,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
  // A helper that cannot start or exits early just ends stdout; the client
  // reports the empty or failed reply.
  child.once("error", () => {});
  child.stdin.on("error", () => {});
  const kill = () => child.kill();
  signal?.addEventListener("abort", kill, { once: true });
  child.once("close", () => signal?.removeEventListener("abort", kill));
  child.stdin.end(JSON.stringify(fitForAppleModel(body)));

  if (body.stream === true) {
    return new Response(Readable.toWeb(child.stdout) as ReadableStream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", resolve);
  });
  return new Response(Buffer.concat(chunks), {
    status: exitCode === 0 ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wrap an Ollama fetch so the Apple model is served by the Swift helper. */
export function withAppleFoundation(baseFetch: typeof fetch): typeof fetch {
  async function appleFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/chat" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as ChatBody;
      if (body.model === APPLE_FOUNDATION_MODEL) {
        const helper = appleHelperPath();
        if (!helper || !(await appleModelAvailable()))
          return errorResponse(
            503,
            "Apple Foundation Models are not available on this Mac",
          );
        return runHelper(helper, body, init.signal);
      }
    }
    if (url.pathname !== "/api/tags" || !(await appleModelAvailable()))
      return baseFetch(input, init);

    // List the Apple model with Ollama's models, or alone when Ollama is down.
    const appleEntry = {
      name: APPLE_FOUNDATION_MODEL,
      model: APPLE_FOUNDATION_MODEL,
      details: { family: "apple" },
    };
    let models: unknown[] = [];
    try {
      const response = await baseFetch(input, init);
      if (response.ok) {
        const data = (await response.json()) as { models?: unknown[] } | null;
        models = Array.isArray(data?.models) ? data.models : [];
      }
    } catch (error) {
      if (init?.signal?.aborted) throw error;
    }
    return new Response(JSON.stringify({ models: [...models, appleEntry] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return appleFetch;
}

export { fitForAppleModel as __fitForAppleModel };

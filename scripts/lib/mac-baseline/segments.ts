/**
 * Opt-in measurement segments for the Mac performance baseline
 * (`--segment <name>`): a window scroll on pages whose document scrolls, and a
 * mocked AI chat stream. Both run after the ledger scroll and inside the traced
 * pass; neither runs unless asked for, so the default run is unchanged.
 */

/** Segments `--segment` accepts, in the order they run. */
export const EXTRA_SEGMENTS = ["window-scroll", "chat-stream"] as const;
export type ExtraSegment = (typeof EXTRA_SEGMENTS)[number];

/** Parse repeatable, comma-separated `--segment` values. */
export function parseSegments(values: readonly string[]): ExtraSegment[] {
  const requested = new Set<string>();
  for (const value of values) {
    for (const name of value.split(",")) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      if (!(EXTRA_SEGMENTS as readonly string[]).includes(trimmed)) {
        throw new Error(
          `Unknown --segment ${trimmed}; use ${EXTRA_SEGMENTS.join(", ")}`,
        );
      }
      requested.add(trimmed);
    }
  }
  return EXTRA_SEGMENTS.filter((segment) => requested.has(segment));
}

// ── Window scroll ────────────────────────────────────────────────────────────

/**
 * Pages measured by the window-scroll segment. AppLayout lets the document
 * scroll (its topbar listens to window "scroll"), so these pages move the
 * cards under the sticky topbar's backdrop instead of an inner scroller.
 */
export const WINDOW_SCROLL_PAGES = ["/", "/statistics"] as const;
/** Distance each way; capped by --scroll-px (so --quick scrolls less). */
export const WINDOW_SCROLL_MAX_PX = 6000;

/**
 * Picks document.scrollingElement as the scroller and returns a point over the
 * main content column (not the sidebar), or null when the page cannot scroll.
 */
export const FIND_WINDOW_SCROLLER = `(() => {
  const el = document.scrollingElement ?? document.documentElement;
  if (el.scrollHeight <= el.clientHeight + 10) return null;
  globalThis.__visionPerfScroller = el;
  el.scrollTop = 0;
  const main = document.getElementById("main") ?? document.body;
  const rect = main.getBoundingClientRect();
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, innerWidth);
  return { x: (left + right) / 2, y: innerHeight / 2 };
})()`;

// ── Chat stream ──────────────────────────────────────────────────────────────

export const CHAT_STREAM_PAGE = "/ai-chat";
export const CHAT_STREAM_TOKENS = 300;
export const CHAT_STREAM_TOKENS_PER_SECOND = 20;
/** Model name the mock reports; never sent to a real Ollama. */
export const CHAT_MOCK_MODEL = "mac-baseline-mock";
/** Last streamed word, looked for in the transcript after completion. */
export const CHAT_END_MARKER = "mac-baseline-end";

export interface ChatMockState {
  /** Streams the mock served since it was installed. */
  streams: number;
  tokensSent: number;
  /** First token → terminal event, ms; null until a stream completes. */
  streamMs: number | null;
  /** Requests under /api/ai/ the mock let through to the real backend. */
  passedThrough: string[];
}

/**
 * Installs a page-side fetch shim that answers the AI chat endpoints the chat
 * page and aiChatStreamStore use, so a send runs the app's real path
 * (composer → useSendChatMessage → aiChatStreamStore.send → streamChat's SSE
 * reader → per-rAF token emits) without Ollama and without writing a
 * conversation to the database. The stream serves `tokens` token events at
 * `tokensPerSecond`, scheduled against the start time so timer jitter does not
 * stretch the stream. Other requests, and AI requests it does not mock, go to
 * the real fetch. RESTORE_CHAT_MOCK puts the real fetch back.
 */
export function chatStreamMockExpression(
  tokens = CHAT_STREAM_TOKENS,
  tokensPerSecond = CHAT_STREAM_TOKENS_PER_SECOND,
): string {
  return `(() => {
  globalThis.__visionPerfChatMock?.restore();
  const tokens = ${tokens};
  const interval = 1000 / ${tokensPerSecond};
  const model = ${JSON.stringify(CHAT_MOCK_MODEL)};
  const endMarker = ${JSON.stringify(CHAT_END_MARKER)};
  const realFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const words = "the ledger shows steady spending with a small rise in groceries and transport this month while savings stay on plan".split(" ");
  const conversations = new Map();
  const state = { streams: 0, tokensSent: 0, streamMs: null, passedThrough: [] };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let nextId = 0;
  const now = () => new Date().toISOString();
  const json = (data) =>
    new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const conversation = (id) => ({
    id, title: "mac-baseline stream", model, createdAt: now(), updatedAt: now(),
  });
  const message = (conversationId, role, content) => ({
    id: "mac-baseline-" + role + "-" + ++nextId,
    conversationId, role, content, toolName: null, status: "complete", createdAt: now(),
  });
  const frame = (event, data) =>
    encoder.encode("event: " + event + "\\ndata: " + JSON.stringify(data) + "\\n\\n");
  const stream = (body, signal) => {
    const id = String(body.conversationId);
    const detail = conversations.get(id) ?? { conversation: conversation(id), messages: [] };
    conversations.set(id, detail);
    const user = message(id, "user", String(body.message ?? ""));
    let timer;
    return new ReadableStream({
      start(controller) {
        state.streams += 1;
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          try { controller.error(new DOMException("Aborted", "AbortError")); } catch {}
          resolveDone({ completed: false });
        }, { once: true });
        controller.enqueue(frame("user_message", { message: user }));
        const start = performance.now();
        let sent = 0;
        let text = "";
        const tick = () => {
          if (signal?.aborted) return;
          const due = Math.min(tokens, Math.floor((performance.now() - start) / interval) + 1);
          while (sent < due) {
            const delta = (sent === tokens - 1 ? endMarker : words[sent % words.length]) + " ";
            text += delta;
            controller.enqueue(frame("token", delta));
            sent += 1;
            state.tokensSent += 1;
          }
          if (sent < tokens) {
            timer = setTimeout(tick, Math.max(0, start + sent * interval - performance.now()));
            return;
          }
          const assistant = message(id, "assistant", text.trim());
          detail.messages.push(user, assistant);
          detail.conversation = { ...detail.conversation, updatedAt: now() };
          controller.enqueue(frame("complete", {
            conversation: detail.conversation,
            assistantMessage: assistant,
            usage: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens },
            iterations: 1,
          }));
          controller.close();
          state.streamMs = Math.round(performance.now() - start);
          resolveDone({ completed: true });
        };
        tick();
      },
      cancel() {
        clearTimeout(timer);
        resolveDone({ completed: false });
      },
    });
  };
  const mocked = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/ai/")) return null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const readBody = async () => {
      const raw = init?.body ?? (request ? await request.clone().text() : "");
      try { return JSON.parse(typeof raw === "string" ? raw : ""); } catch { return {}; }
    };
    if (method === "GET" && path === "/api/ai/status") {
      return json({
        ok: true, baseUrl: "http://mac-baseline.invalid", displayUrl: "mac-baseline mock",
        modelCount: 1, error: null, code: null, hint: null, defaultModel: model, enabled: true,
      });
    }
    if (method === "GET" && path === "/api/ai/models") {
      return json({
        items: [{ name: model, size: null, family: null, parameterSize: null, quantization: null, modifiedAt: null }],
        total: 1,
      });
    }
    if (method === "GET" && path === "/api/ai/model/fit") {
      return json({ model, totalMemoryBytes: 8 * 1024 ** 3, weightBytes: null, kvBytesPerToken: null, maxNumCtx: null });
    }
    if (method === "POST" && (path === "/api/ai/model/warm" || path === "/api/ai/model/release")) {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/api/ai/conversations") {
      const items = [...conversations.values()].map((entry) => entry.conversation).reverse();
      return json({ items, total: items.length, limit: Number(url.searchParams.get("limit")) || 50, offset: 0 });
    }
    if (method === "POST" && path === "/api/ai/conversations") {
      const id = "mac-baseline-" + Date.now() + "-" + ++nextId;
      const detail = { conversation: conversation(id), messages: [] };
      conversations.set(id, detail);
      return json(detail);
    }
    const match = /^\\/api\\/ai\\/conversations\\/([^/]+)$/.exec(path);
    if (method === "GET" && match && conversations.has(decodeURIComponent(match[1]))) {
      return json(conversations.get(decodeURIComponent(match[1])));
    }
    if (method === "POST" && path === "/api/ai/chat/stream") {
      return new Response(stream(await readBody(), init?.signal ?? request?.signal), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    state.passedThrough.push(method + " " + path);
    return null;
  };
  const shim = async (input, init) => (await mocked(input, init)) ?? realFetch(input, init);
  globalThis.fetch = shim;
  globalThis.__visionPerfChatMock = {
    state,
    done,
    restore() {
      if (globalThis.fetch === shim) globalThis.fetch = realFetch;
      delete globalThis.__visionPerfChatMock;
    },
  };
  return true;
})()`;
}

export const CHAT_MOCK_STATE = `(() => {
  const mock = globalThis.__visionPerfChatMock;
  return mock ? { ...mock.state, passedThrough: [...new Set(mock.state.passedThrough)] } : null;
})()`;

/** Resolves with { completed } once the mocked stream ends. */
export const CHAT_MOCK_DONE = `globalThis.__visionPerfChatMock?.done ?? Promise.resolve({ completed: false })`;

export const RESTORE_CHAT_MOCK = `(() => {
  globalThis.__visionPerfChatMock?.restore();
  return true;
})()`;

/**
 * The chat composer's textarea. The AI page keeps the hidden Investigation
 * region (which has its own textarea) mounted before the chat region, so the
 * selector is limited to the visible region.
 */
const CHAT_TEXTAREA = '#main [role="region"]:not([hidden]) textarea';

/**
 * Waits (up to 15 s) for the chat composer to be enabled, which needs the
 * mocked status answer, then focuses it. True when it is ready.
 */
export const FOCUS_CHAT_COMPOSER = `new Promise((resolve) => {
  const started = performance.now();
  const check = () => {
    const el = document.querySelector(${JSON.stringify(`${CHAT_TEXTAREA}:not([disabled])`)});
    if (el) {
      el.focus();
      resolve(document.activeElement === el);
    } else if (performance.now() - started > 15000) resolve(false);
    else setTimeout(check, 100);
  };
  check();
})`;

/** Fallback when Enter did not send: click the composer's send button. */
export const CLICK_CHAT_SEND = `(() => {
  const button = document.querySelector(${JSON.stringify(CHAT_TEXTAREA)})?.parentElement?.querySelector("button:not([disabled])");
  button?.click();
  return Boolean(button);
})()`;

/** Whether the transcript shows the stream's last word after completion. */
export const CHAT_RENDERED = `(document.getElementById("main")?.innerText ?? "").includes(${JSON.stringify(CHAT_END_MARKER)})`;

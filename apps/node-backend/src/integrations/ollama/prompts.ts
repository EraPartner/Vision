/**
 * System prompt + history builder for Vision's local AI chat.
 *
 * Vision runs a local Ollama model with a small, fixed tool surface.
 * The system prompt must:
 *   - Enumerate the available tools (names only — full JSON Schema is sent
 *     separately via the `tools` field on /api/chat).
 *   - Forbid fabricating figures: numbers MUST come from a tool result.
 *   - Pin the language to English (v1).
 *   - Provide just enough domain context (EUR default, Belgian context,
 *     categories/recipients vocabulary) to avoid obvious model confusion.
 *
 * This module is pure — no DB, no I/O. It maps persisted message rows into
 * the `{role, content, tool_call_id?, tool_calls?, name?}` shape the Ollama
 * chat endpoint accepts.
 */

import type { AiMessageRow } from "../../types/rows.ts";

export type { AiMessageRow };

/** One entry of an Ollama `tool_calls[]` array; model-emitted, untrusted. */
export interface OllamaToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

/**
 * The shape sent to Ollama's /api/chat `messages` field. Mirrors
 * `OllamaMessage` in services/aiChatService.js — duplicated locally rather
 * than imported so this integrations-layer module doesn't reach up into
 * services/ for a type.
 */
export type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[] | undefined;
  name?: string | undefined;
};

const SYSTEM_PROMPT_TEMPLATE = `You are Vision's built-in financial assistant. You help a single user reason about their personal finances, budget, portfolio, planned transactions, and Belgian tax situation.

## Ground rules
1. You run locally. All data stays on the user's machine. Never suggest uploading data anywhere.
2. **Never invent figures.** Every number you cite (amounts, percentages, counts, dates) must come from a tool result in the current turn. If a tool hasn't returned it, call the tool — do not guess, do not extrapolate from memory.
3. Respond in English. The UI may be in Dutch, but your output is English v1.
4. Default currency is EUR unless a tool result says otherwise.
5. Be concise. Users want the answer, not a lecture. Two short paragraphs max, or a bullet list.
6. If the question is ambiguous, make a reasonable assumption, state it in one line, and answer — do not ask clarifying questions unless truly blocked.

## Tool use
You have access to a small set of read-only tools. Call them when you need concrete numbers.

Available tools: {{TOOL_NAMES}}

When you need data, emit a tool call with strictly valid JSON arguments that match the tool's schema. Do **not** wrap tool calls in prose. After the tool returns, read its \`data\` field and incorporate the numbers into your reply.

When the user asks for their insights digest, what's new, or anything unusual in their spending, call \`insightsDigest\` — it returns the pre-computed findings; narrate and prioritize them, never invent your own.

If a tool call returns \`{ok: false, error: ...}\`:
- If \`error.code == "VALIDATION_ERROR"\`, re-read the schema and retry once with corrected arguments.
- If \`error.code == "UNKNOWN_TOOL"\`, do not retry. Pick from the available tools listed above.
- If \`error.code == "TOOL_ERROR"\`, tell the user the data couldn't be loaded and suggest trying again.

Tool results include a \`meta.renderAs\` hint (\`table\`, \`line\`, \`bar\`, \`pie\`). The UI renders the visualization automatically — you do **not** need to re-describe the data row by row. Summarize the insight in one or two sentences.

## Dates
- "This year", "YTD" → Jan 1 of current year through today.
- "Last year" → full previous calendar year.
- "This month" → first of current month through today.
- Always pass ISO dates (\`YYYY-MM-DD\`) to tools.

## Categories and recipients
Transaction \`category_name\` is a user-defined string. Common examples: Groceries, Rent, Utilities, Salary, Dining. A null category means uncategorised spending — label it "Uncategorised" in prose.

## Portfolio
Portfolio tools use the same canonical calculations and configured reporting currency as Vision's screens. Never add or compare native-currency values directly. Keep these metrics distinct: income is dividends/interest/rent, proceeds are gross sale amounts, realized gain uses the configured cost-basis method, unrealized gain is the open-position value change, and total return includes the full canonical gain/loss result. The compatibility-named \`getReturnsForRange\` and \`getBestWorstPerformers\` tools return \`netIncome\`; they do not measure investment return or price performance.

## Safety
You cannot modify data. You cannot send transactions. You cannot reach the internet. If the user asks you to, explain politely that you're read-only.`;

const DEFAULT_CONTEXT_BUDGET_CHARS = 24_000;
const DEFAULT_TOOL_RESULT_CHARS = 6_000;
/**
 * History rows between moves of the replay start. Ollama reuses its KV cache
 * only for an unchanged prompt prefix, so the first replayed row must stay put
 * across turns instead of sliding with every new message.
 */
export const HISTORY_REPLAY_STEP = 8;

export interface BuildChatMessagesArgs {
  /** Registered tool names (for the system prompt). */
  toolNames: string[];
  /** Persisted `ai_messages` rows, oldest first. */
  history?: AiMessageRow[];
  /** The new user message text. */
  userInput: string;
  /** Cap on replayed history rows (default 30). */
  maxHistoryMessages?: number;
  /** Approximate full-prompt character budget. */
  contextBudgetChars?: number;
  /** Per-tool replay ceiling before data is summarized. */
  maxToolResultChars?: number;
  /**
   * Replay starts only at history indexes that are multiples of this, so the
   * first replayed row (and the cached prompt prefix) holds still between
   * moves. 1 (default) keeps the newest rows that fit, moving every turn.
   */
  historyStep?: number;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      ok: false,
      error: {
        code: "SERIALIZATION_ERROR",
        message: "Stored tool result could not be replayed",
      },
    });
  }
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1)}…`;
}

function summarizedValue(value: unknown, previewChars: number) {
  const text = jsonText(value);
  return {
    truncated: true,
    originalCharacters: text.length,
    preview: truncateText(text, previewChars),
  };
}

/**
 * Find the largest equal preview allowance that leaves the final JSON within
 * the configured limit.
 */
function fitJsonPreviews(
  build: (previewChars: number) => unknown,
  limit: number,
): string | null {
  if (jsonText(build(0)).length > limit) return null;
  let low = 0;
  let high = limit;
  let best = jsonText(build(0));
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = jsonText(build(middle));
    if (candidate.length <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Serialize an oversized tool payload as valid, bounded JSON. Preserve the
 * stable envelope keys. Prefer full meta/error values and compact only data;
 * if those values are themselves oversized, summarize them under their same
 * keys before falling back to explicit markers.
 */
function boundedToolEnvelope(result: Record<string, unknown>, limit: number) {
  const hasData = Object.hasOwn(result, "data");
  const hasMeta = Object.hasOwn(result, "meta");
  const hasError = Object.hasOwn(result, "error");
  const withFullEnvelope = (previewChars: number) => ({
    ...(Object.hasOwn(result, "ok") ? { ok: result.ok } : {}),
    ...(hasMeta ? { meta: result.meta } : {}),
    ...(hasError ? { error: result.error } : {}),
    ...(hasData
      ? { data: summarizedValue(result.data, previewChars) }
      : { truncated: true }),
  });
  const fullEnvelope = fitJsonPreviews(withFullEnvelope, limit);
  if (fullEnvelope !== null) return fullEnvelope;

  const withSummarizedEnvelope = (previewChars: number) => ({
    ...(Object.hasOwn(result, "ok") ? { ok: result.ok } : {}),
    ...(hasMeta ? { meta: summarizedValue(result.meta, previewChars) } : {}),
    ...(hasError ? { error: summarizedValue(result.error, previewChars) } : {}),
    ...(hasData
      ? { data: summarizedValue(result.data, previewChars) }
      : { truncated: true }),
  });
  const summarizedEnvelope = fitJsonPreviews(withSummarizedEnvelope, limit);
  if (summarizedEnvelope !== null) return summarizedEnvelope;

  const markers = jsonText({
    ...(Object.hasOwn(result, "ok") ? { ok: result.ok } : {}),
    ...(hasMeta ? { meta: "[truncated]" } : {}),
    ...(hasError ? { error: "[truncated]" } : {}),
    ...(hasData ? { data: "[truncated]" } : { truncated: true }),
  });
  if (markers.length <= limit) return markers;
  return null;
}

/** Decimal places kept on numbers shown to the model. */
const PROMPT_NUMBER_DECIMALS = 4;
/**
 * `meta` keys that only tell the UI which columns feed a chart; the model
 * never needs them (`renderAs` stays, the system prompt refers to it).
 */
const UI_ONLY_META_KEYS = new Set([
  "xField",
  "yField",
  "yFields",
  "labelField",
  "valueField",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Shrink a tool result for the model: drop object fields that are null,
 * undefined or "" and round numbers with more than four decimals (four
 * significant digits below 1). Numbers with four decimals or fewer are
 * returned as they are, so money stays exact.
 * Array items keep their positions.
 */
function compactForPrompt(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    // Below 1 (crypto quantities, rates) keep significant digits instead, so
    // 0.00012345 does not collapse to 0.0001.
    const rounded = Number(
      Math.abs(value) >= 1
        ? value.toFixed(PROMPT_NUMBER_DECIMALS)
        : value.toPrecision(PROMPT_NUMBER_DECIMALS),
    );
    return rounded === value ? value : rounded;
  }
  if (Array.isArray(value)) return value.map(compactForPrompt);
  if (!isPlainObject(value)) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === null || field === undefined || field === "") continue;
    compacted[key] = compactForPrompt(field);
  }
  return compacted;
}

/** Compact a whole tool envelope, also dropping its UI-only `meta` keys. */
function compactToolPayload(payload: unknown): unknown {
  try {
    const compacted = compactForPrompt(payload);
    if (isPlainObject(compacted) && isPlainObject(compacted.meta)) {
      const meta = Object.fromEntries(
        Object.entries(compacted.meta).filter(
          ([key]) => !UI_ONLY_META_KEYS.has(key),
        ),
      );
      return { ...compacted, meta };
    }
    return compacted;
  } catch {
    // Not plain JSON data (cyclic, say): jsonText reports it as before.
    return payload;
  }
}

/**
 * Serialize a tool envelope for model context with the same cap used for
 * persisted history and same-turn tool-loop replay. The model reads a leaner
 * copy (see compactForPrompt); persisted rows and the UI keep the original.
 */
export function serializeToolResultForPrompt(
  rawPayload: unknown,
  maxChars: number = DEFAULT_TOOL_RESULT_CHARS,
): string {
  const payload = compactToolPayload(rawPayload);
  const limit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : DEFAULT_TOOL_RESULT_CHARS;
  if (typeof payload === "string") return truncateText(payload, limit);

  const serialized = jsonText(payload);
  if (serialized.length <= limit) return serialized;

  if (typeof payload === "object" && payload !== null) {
    const bounded = boundedToolEnvelope(
      payload as Record<string, unknown>,
      limit,
    );
    if (bounded !== null) return bounded;
  }

  const genericSummary = fitJsonPreviews(
    (previewChars) => summarizedValue(payload, previewChars),
    limit,
  );
  if (genericSummary !== null) return genericSummary;

  if (limit >= 18) return '{"truncated":true}';
  if (limit >= 2) return "{}";
  return "0";
}

function approximateMessageChars(message: OllamaMessage) {
  return (
    (message.content?.length ?? 0) +
    (message.name?.length ?? 0) +
    (message.tool_calls ? jsonText(message.tool_calls).length : 0)
  );
}

/**
 * Preserve the newest history row when only part of it fits.
 */
function truncateMessageToBudget(
  message: OllamaMessage,
  remainingChars: number,
): OllamaMessage | null {
  if (remainingChars <= 0) return null;
  const fixedChars =
    (message.name?.length ?? 0) +
    (message.tool_calls ? jsonText(message.tool_calls).length : 0);
  const contentChars = Math.max(0, remainingChars - fixedChars);
  const content = message.content ?? "";
  if (content.length <= contentChars) return message;
  if (contentChars === 0) return { ...message, content: "" };
  const suffix = content.slice(-Math.max(0, contentChars - 1));
  return { ...message, content: `…${suffix}`.slice(-contentChars) };
}

/**
 * Build the system prompt string. `toolNames` is an array of strings — the
 * names from `getToolNames()` in the tool registry.
 */
function buildSystemPrompt(toolNames: string[]): string {
  const names =
    Array.isArray(toolNames) && toolNames.length > 0
      ? toolNames.join(", ")
      : "(none)";
  return SYSTEM_PROMPT_TEMPLATE.replace("{{TOOL_NAMES}}", names);
}

/**
 * Convert a persisted `ai_messages` row into the Ollama chat message shape.
 *
 * DB row shape (from aiChatRepository):
 *   {role, content, tool_name, tool_args, tool_result, status, ...}
 *
 * Ollama message shape:
 *   - user / assistant / system: {role, content}
 *   - tool:                       {role: 'tool', content: <stringified result>, name: <tool_name>}
 *   - assistant w/ tool calls:    {role: 'assistant', content: '', tool_calls: [...]}
 *
 * For persisted assistant rows, we only have the final text (`content`). We
 * don't replay prior tool_calls in history — the tool_result rows carry the
 * ground-truth numbers, which is what the model needs to stay grounded. This
 * means persisted history can contain a `role: 'tool'` message without the
 * preceding assistant `tool_calls` frame. Ollama accepts that shape; a stricter
 * future provider needs a history adapter or persisted assistant tool calls.
 */
function toOllamaMessage(
  row: AiMessageRow | null | undefined,
  {
    maxToolResultChars = DEFAULT_TOOL_RESULT_CHARS,
  }: { maxToolResultChars?: number } = {},
): OllamaMessage | null {
  if (!row || !row.role) return null;

  if (row.role === "tool") {
    // Only the camelCase fields: aiChatRepository's MESSAGE_COLUMNS aliases
    // these in SQL and the sole caller passes AiMessageRow[], so the snake_case
    // fallback that used to sit here could never fire.
    const payload = row.toolResult ?? {
      ok: false,
      error: { code: "MISSING", message: "No result persisted" },
    };
    return {
      role: "tool",
      name: row.toolName || "unknown",
      content: serializeToolResultForPrompt(payload, maxToolResultChars),
    };
  }

  return {
    role: row.role,
    content: row.content || "",
  };
}

/**
 * Build the full message array sent to Ollama for a chat turn.
 */
export function buildChatMessages({
  toolNames,
  history = [],
  userInput,
  maxHistoryMessages = 30,
  contextBudgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
  maxToolResultChars = DEFAULT_TOOL_RESULT_CHARS,
  historyStep = 1,
}: BuildChatMessagesArgs): OllamaMessage[] {
  const systemMessage: OllamaMessage = {
    role: "system",
    content: buildSystemPrompt(toolNames),
  };
  const userMessage: OllamaMessage | null =
    userInput && userInput.trim()
      ? { role: "user", content: userInput.trim() }
      : null;
  // Only the last `maxHistoryMessages` rows can be replayed; indexes stay
  // absolute so the step grid does not move as the conversation grows.
  const firstIndex = history.length - history.slice(-maxHistoryMessages).length;
  const window = history
    .slice(firstIndex)
    .map((row) => toOllamaMessage(row, { maxToolResultChars }));
  const candidates = window.filter((message): message is OllamaMessage =>
    Boolean(message),
  );
  const remainingChars = Math.max(
    0,
    contextBudgetChars -
      approximateMessageChars(systemMessage) -
      (userMessage ? approximateMessageChars(userMessage) : 0),
  );

  // Smallest step-aligned start whose rows fit the budget. Never reaches
  // beyond the window, so maxHistoryMessages still holds.
  const step = Math.max(1, Math.min(Math.floor(historyStep), window.length));
  let selectedHistory: OllamaMessage[] | null = null;
  let suffixChars = 0;
  const suffixCharsFrom: number[] = [];
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message) suffixChars += approximateMessageChars(message);
    suffixCharsFrom[i] = suffixChars;
  }
  for (let i = 0; i < window.length; i += 1) {
    if ((firstIndex + i) % step !== 0) continue;
    if ((suffixCharsFrom[i] ?? 0) <= remainingChars) {
      selectedHistory = window
        .slice(i)
        .filter((message): message is OllamaMessage => Boolean(message));
      break;
    }
  }

  // No aligned start fits: keep the newest rows that do, and trim the newest
  // one itself when it alone is over budget.
  if (selectedHistory === null) {
    selectedHistory = [];
    let left = remainingChars;
    for (const candidate of candidates.toReversed()) {
      const chars = approximateMessageChars(candidate);
      if (chars <= left) {
        selectedHistory.unshift(candidate);
        left -= chars;
        continue;
      }
      if (selectedHistory.length === 0) {
        const truncated = truncateMessageToBudget(candidate, left);
        if (truncated) selectedHistory.unshift(truncated);
      }
      break;
    }
  }

  return [
    systemMessage,
    ...selectedHistory,
    ...(userMessage ? [userMessage] : []),
  ];
}

export { buildSystemPrompt as __buildSystemPrompt, toOllamaMessage };

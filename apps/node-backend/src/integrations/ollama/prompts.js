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

/**
 * @typedef {import('../../types/rows.js').AiMessageRow} AiMessageRow
 */

/**
 * The shape sent to Ollama's /api/chat `messages` field. Mirrors
 * `OllamaMessage` in services/aiChatService.js — duplicated locally rather
 * than imported so this integrations-layer module doesn't reach up into
 * services/ for a type.
 * @typedef {{ role: string, content: string, tool_calls?: any[], name?: string }} OllamaMessage
 */

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
Holdings are aggregated from buy/sell portfolio transactions. A zero net position is excluded. Units may be fractional (crypto). \`marketValue = units * current_price\` in the investment's currency.

## Safety
You cannot modify data. You cannot send transactions. You cannot reach the internet. If the user asks you to, explain politely that you're read-only.`;

const DEFAULT_CONTEXT_BUDGET_CHARS = 24_000;
const DEFAULT_TOOL_RESULT_CHARS = 6_000;

/** @param {unknown} value */
function jsonText(value) {
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

/** @param {string} value @param {number} limit */
function truncateText(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1)}…`;
}

/** @param {unknown} value @param {number} previewChars */
function summarizedValue(value, previewChars) {
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
 * @param {(previewChars: number) => unknown} build
 * @param {number} limit
 * @returns {string|null}
 */
function fitJsonPreviews(build, limit) {
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
 * @param {Record<string, unknown>} result
 * @param {number} limit
 */
function boundedToolEnvelope(result, limit) {
  const hasData = Object.hasOwn(result, "data");
  const hasMeta = Object.hasOwn(result, "meta");
  const hasError = Object.hasOwn(result, "error");
  const withFullEnvelope = (previewChars) => ({
    ...(Object.hasOwn(result, "ok") ? { ok: result.ok } : {}),
    ...(hasMeta ? { meta: result.meta } : {}),
    ...(hasError ? { error: result.error } : {}),
    ...(hasData
      ? { data: summarizedValue(result.data, previewChars) }
      : { truncated: true }),
  });
  const fullEnvelope = fitJsonPreviews(withFullEnvelope, limit);
  if (fullEnvelope !== null) return fullEnvelope;

  const withSummarizedEnvelope = (previewChars) => ({
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

/**
 * Serialize a tool envelope for model context with the same cap used for
 * persisted history and same-turn tool-loop replay.
 * @param {unknown} payload
 * @param {number} [maxChars]
 */
export function serializeToolResultForPrompt(
  payload,
  maxChars = DEFAULT_TOOL_RESULT_CHARS,
) {
  const limit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : DEFAULT_TOOL_RESULT_CHARS;
  if (typeof payload === "string") return truncateText(payload, limit);

  const serialized = jsonText(payload);
  if (serialized.length <= limit) return serialized;

  if (typeof payload === "object" && payload !== null) {
    const bounded = boundedToolEnvelope(
      /** @type {Record<string, unknown>} */ (payload),
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

/** @param {OllamaMessage} message */
function approximateMessageChars(message) {
  return (
    (message.content?.length ?? 0) +
    (message.name?.length ?? 0) +
    (message.tool_calls ? jsonText(message.tool_calls).length : 0)
  );
}

/**
 * Preserve the newest history row when only part of it fits.
 * @param {OllamaMessage} message
 * @param {number} remainingChars
 * @returns {OllamaMessage|null}
 */
function truncateMessageToBudget(message, remainingChars) {
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
 * @param {string[]} toolNames
 * @returns {string}
 */
export function buildSystemPrompt(toolNames) {
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
 * @param {AiMessageRow|null|undefined} row
 * @param {{maxToolResultChars?: number}} [options]
 * @returns {OllamaMessage|null}
 */
export function toOllamaMessage(
  row,
  { maxToolResultChars = DEFAULT_TOOL_RESULT_CHARS } = {},
) {
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
 *
 * @param {object} args
 * @param {string[]} args.toolNames - registered tool names (for system prompt)
 * @param {AiMessageRow[]} args.history - persisted `ai_messages` rows, oldest first
 * @param {string}   args.userInput - the new user message text
 * @param {number}   [args.maxHistoryMessages] - cap (default 30)
 * @param {number}   [args.contextBudgetChars] - approximate full-prompt character budget
 * @param {number}   [args.maxToolResultChars] - per-tool replay ceiling before data is summarized
 * @returns {OllamaMessage[]}
 */
export function buildChatMessages({
  toolNames,
  history = [],
  userInput,
  maxHistoryMessages = 30,
  contextBudgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
  maxToolResultChars = DEFAULT_TOOL_RESULT_CHARS,
}) {
  const systemMessage = {
    role: "system",
    content: buildSystemPrompt(toolNames),
  };
  const userMessage =
    userInput && userInput.trim()
      ? { role: "user", content: userInput.trim() }
      : null;
  const candidates = history
    .slice(-maxHistoryMessages)
    .map((row) => toOllamaMessage(row, { maxToolResultChars }))
    .filter(Boolean);
  let remainingChars = Math.max(
    0,
    contextBudgetChars -
      approximateMessageChars(systemMessage) -
      (userMessage ? approximateMessageChars(userMessage) : 0),
  );
  /** @type {OllamaMessage[]} */
  const selectedHistory = [];

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const chars = approximateMessageChars(candidate);
    if (chars <= remainingChars) {
      selectedHistory.unshift(candidate);
      remainingChars -= chars;
      continue;
    }
    if (selectedHistory.length === 0) {
      const truncated = truncateMessageToBudget(candidate, remainingChars);
      if (truncated) selectedHistory.unshift(truncated);
    }
    break;
  }

  return [
    systemMessage,
    ...selectedHistory,
    ...(userMessage ? [userMessage] : []),
  ];
}

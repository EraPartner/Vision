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
 * `toOllamaMessage` below reads `row.tool_result`/`row.tool_name` as a
 * fallback alongside the real `AiMessageRow` fields `toolResult`/`toolName`.
 * aiChatRepository's `MESSAGE_COLUMNS` always aliases these to camelCase in
 * SQL (see types/rows.js `AiMessageRow`), and `buildChatMessages`'s only
 * caller (aiChatService.js) always passes `AiMessageRow[]` from
 * `aiChatRepository.getMessages`, so the snake_case branch is dead — no row
 * shape reaching this function has ever had `tool_result`/`tool_name`.
 * Typed here (rather than dropped) to keep this a pure annotation pass; see
 * orchestrator report for the dead-code finding.
 * @typedef {AiMessageRow & { tool_result?: any, tool_name?: string }} OllamaSourceRow
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

/**
 * Build the system prompt string. `toolNames` is an array of strings — the
 * names from `getToolNames()` in the tool registry.
 * @param {string[]} toolNames
 * @returns {string}
 */
export function buildSystemPrompt(toolNames) {
  const names = Array.isArray(toolNames) && toolNames.length > 0
    ? toolNames.join(', ')
    : '(none)';
  return SYSTEM_PROMPT_TEMPLATE.replace('{{TOOL_NAMES}}', names);
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
 * ground-truth numbers, which is what the model needs to stay grounded.
 * @param {OllamaSourceRow|null|undefined} row
 * @returns {OllamaMessage|null}
 */
export function toOllamaMessage(row) {
  if (!row || !row.role) return null;

  if (row.role === 'tool') {
    const payload = row.toolResult ?? row.tool_result
      ?? { ok: false, error: { code: 'MISSING', message: 'No result persisted' } };
    return {
      role: 'tool',
      name: row.toolName || row.tool_name || 'unknown',
      content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
  }

  return {
    role: row.role,
    content: row.content || '',
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
 * @returns {OllamaMessage[]}
 */
export function buildChatMessages({
  toolNames,
  history = [],
  userInput,
  maxHistoryMessages = 30,
}) {
  const trimmedHistory = history.slice(-maxHistoryMessages);
  const messages = [
    { role: 'system', content: buildSystemPrompt(toolNames) },
  ];

  for (const row of trimmedHistory) {
    const msg = toOllamaMessage(row);
    if (msg) messages.push(msg);
  }

  if (userInput && userInput.trim()) {
    messages.push({ role: 'user', content: userInput.trim() });
  }

  return messages;
}

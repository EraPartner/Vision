/**
 * The tuned shape of a chat request to the local model, shared by the chat
 * service and the evaluation/benchmark harness so both send the same thing.
 *
 * Apple's helper picks its own few tools and trims to its 4,096-token window
 * (integrations/ollama/appleFoundation.ts), so the Apple model keeps the full
 * request it had: every tool, the configured history budget, newest-first
 * replay, a fixed window and no keep_alive.
 */

import settings from "../../config/config.ts";
import { APPLE_FOUNDATION_MODEL } from "../../integrations/ollama/appleFoundation.ts";
import type { OllamaKeepAlive } from "../../integrations/ollama/client.ts";
import { HISTORY_REPLAY_STEP } from "../../integrations/ollama/prompts.ts";
import {
  ANSWER_RESERVE_TOKENS,
  charsForTokens,
  getContextTuner,
} from "../../integrations/ollama/tuning.ts";
import type {
  ContextChoice,
  ContextTuner,
} from "../../integrations/ollama/tuning.ts";
import { selectToolSchemas } from "./toolSelection.ts";
import type { SelectToolsArgs } from "./toolSelection.ts";

type ToolSchema = SelectToolsArgs["schemas"][number];

export function isAppleModel(model: string) {
  return model === APPLE_FOUNDATION_MODEL;
}

/** Tool schemas to send for this question (see toolSelection.ts). */
export function toolsForTurn(model: string, args: SelectToolsArgs) {
  return isAppleModel(model) ? args.schemas : selectToolSchemas(args);
}

/**
 * Budget for system prompt + history + question: what the largest allowed
 * window leaves after the tools, one tool result and the answer, so Ollama
 * never has to cut the prompt itself. Never above the configured budget, and
 * never below a third of it.
 */
export async function historyBudgetChars(
  model: string,
  tools: ToolSchema[],
  tuner: ContextTuner = getContextTuner(),
): Promise<number> {
  const configured = settings.aiChat.contextBudgetChars;
  if (isAppleModel(model)) return configured;
  const ceiling = await tuner.ceilingFor(model);
  const fitting =
    charsForTokens(ceiling - ANSWER_RESERVE_TOKENS) -
    JSON.stringify(tools).length -
    settings.aiChat.maxToolResultChars;
  return Math.min(configured, Math.max(Math.floor(configured / 3), fitting));
}

/**
 * History replay step for buildChatMessages: a start that moves in steps keeps
 * Ollama's cached prompt prefix across turns.
 */
export function historyStepFor(model: string) {
  return isAppleModel(model) ? 1 : HISTORY_REPLAY_STEP;
}

export interface ModelCallPlan {
  options: Record<string, unknown>;
  keepAlive: OllamaKeepAlive | undefined;
  context: ContextChoice;
}

/** Options and keep_alive for one model call with these messages and tools. */
export async function planModelCall(
  model: string,
  messages: unknown,
  tools: ToolSchema[],
  tuner: ContextTuner = getContextTuner(),
): Promise<ModelCallPlan> {
  const context = await tuner.choose(model, messages, tools);
  if (isAppleModel(model)) {
    return {
      options: { num_ctx: context.numCtx },
      keepAlive: undefined,
      context,
    };
  }
  return {
    options: { num_ctx: context.numCtx, num_predict: ANSWER_RESERVE_TOKENS },
    keepAlive: (await tuner.residencyFor(model)).active,
    context,
  };
}

import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import settings from "../config/config.ts";
import { APPLE_FOUNDATION_MODEL } from "../integrations/ollama/appleFoundation.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import { getContextTuner } from "../integrations/ollama/tuning.ts";

export interface ProviderGeneration {
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  provider: "ollama";
}

export interface ProviderGenerationInput {
  request: AiInvestigationRequest;
  messages: unknown[];
  signal?: AbortSignal;
}

function outputText(response: { content?: string } | null | undefined) {
  return (response?.content ?? "").trim();
}

/** Every investigation model pass runs on the configured Ollama endpoint. */
export async function generateLocal({
  request,
  messages,
  signal,
}: ProviderGenerationInput): Promise<ProviderGeneration> {
  const model = request.model ?? settings.ollama.defaultModel;
  const tuner = getContextTuner();
  const { numCtx } = await tuner.choose(model, messages);
  const keepAlive =
    model === APPLE_FOUNDATION_MODEL
      ? undefined
      : (await tuner.residencyFor(model)).active;
  const response = await getOllamaClient().chat({
    model,
    messages,
    options: { num_ctx: numCtx },
    keepAlive,
    signal,
  });
  return {
    text: outputText(response),
    usage: {
      inputTokens: response.promptEvalCount,
      outputTokens: response.evalCount,
    },
    provider: "ollama",
  };
}

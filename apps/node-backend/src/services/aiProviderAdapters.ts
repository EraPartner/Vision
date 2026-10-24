import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import settings from "../config/config.ts";
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
  return String(response?.content ?? "").trim();
}

/** Every investigation model pass runs on the configured Ollama endpoint. */
export async function generateLocal({
  request,
  messages,
  signal,
}: ProviderGenerationInput): Promise<ProviderGeneration> {
  const model = request.model ?? settings.ollama.defaultModel;
  const { numCtx } = await getContextTuner().choose(model, messages);
  const response = await getOllamaClient().chat({
    model,
    messages,
    options: { num_ctx: numCtx },
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

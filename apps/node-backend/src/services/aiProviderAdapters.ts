import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import settings from "../config/config.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";

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
  const response = await getOllamaClient().chat({
    model: request.model ?? undefined,
    messages,
    options: { num_ctx: settings.ollama.numCtx },
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

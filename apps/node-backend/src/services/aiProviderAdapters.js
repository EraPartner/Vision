import settings from "../config/config.js";
import { getOllamaClient } from "../integrations/ollama/client.js";
import { callOpenAiBroker } from "../integrations/openai/brokerClient.js";
import {
  assertPublicDisclosureText,
  bindDisclosureToRequest,
  buildDisclosurePreview,
} from "./cloudDisclosurePolicy.js";
import {
  reserveDisclosure,
  findUncertainDisclosure,
  updateDisclosureRecord,
} from "../repositories/aiDisclosureRepository.js";

function outputText(response) {
  return String(response?.content ?? response?.outputText ?? "").trim();
}

export function disclosurePayload(request) {
  const candidates = [
    request.savedAnalysisId ? "saved-analysis" : null,
    request.scope.workspaces.some((item) =>
      ["budgeting", "cross-workspace"].includes(item),
    )
      ? request.scope.dateFrom && request.scope.dateTo
        ? "cashflow-range"
        : "balances"
      : null,
    request.scope.workspaces.some((item) =>
      ["portfolio", "cross-workspace"].includes(item),
    )
      ? "holdings"
      : null,
    request.scope.workspaces.some((item) =>
      ["portfolio", "cross-workspace"].includes(item),
    ) &&
    request.scope.dateFrom &&
    request.scope.dateTo
      ? "portfolio-income-range"
      : null,
    request.scope.workspaces.some((item) =>
      ["research", "cross-workspace"].includes(item),
    )
      ? "documents"
      : null,
    request.researchMode === "public-web" ? "web" : null,
    ...(request.publicSymbols ?? []).flatMap((symbol) => [
      `quote-${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      `fundamentals-${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      `news-${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ]),
    ...(request.publicMacroQueries ?? []).map(
      (_, index) => `macro-search-${index + 1}`,
    ),
  ].filter(Boolean);
  const selectedSummaryMode = Boolean(request.selectedSummary);
  const selectedEvidenceMode = Boolean(request.selectedEvidence);
  if (!selectedSummaryMode && !selectedEvidenceMode) {
    if (!request.publicQuestion?.trim())
      throw Object.assign(
        new Error("A separately authored publicQuestion is required"),
        { code: "PUBLIC_QUESTION_REQUIRED" },
      );
    assertPublicDisclosureText(request.publicQuestion, "publicQuestion");
  }
  const disclosed = buildDisclosurePreview({
    ...(selectedSummaryMode || selectedEvidenceMode
      ? {}
      : {
          question: request.publicQuestion,
        }),
    publicSchema: selectedEvidenceMode
      ? "Vision selected-evidence synthesis v1. Use only the explicitly selected evidence. Return JSON only matching the Vision AI answer schema: {schemaVersion:1,status:'complete'|'qualified'|'abstained'|'partial',depth:'quick'|'detailed',language:'en'|'nl',summary:string,facts:{text:string,evidenceIds:string[]}[],calculations:{text:string,evidenceIds:string[]}[],interpretations:{text:string,evidenceIds:string[]}[],assumptions:string[],missingInformation:string[],conflicts:{description:string,evidenceIds:string[]}[],evidence:[],analysisReference:null}. Every fact, calculation, and interpretation must cite evidence id 'selected-evidence'. Do not request tools or additional data."
      : selectedSummaryMode
        ? "Vision investigation planner v1. Use only the explicitly selected summary. Return JSON only: {stepIds:string[]}. Select and order only candidate step ids supplied by the local orchestrator. Do not answer the question."
        : "Vision investigation planner v1. Return JSON only: {stepIds:string[]}. Select and order only candidate step ids supplied by the local orchestrator. Do not answer the question.",
    language: request.language,
    depth: request.depth,
    citations: selectedEvidenceMode ? ["selected-evidence"] : candidates,
    ...(request.selectedSummary
      ? { selectedSummary: request.selectedSummary }
      : {}),
    ...(request.selectedEvidence
      ? { selectedEvidence: request.selectedEvidence }
      : {}),
  });
  const maxOutputTokens = Math.min(
    request.depth === "detailed" ? 2400 : 900,
    32000,
  );
  return bindDisclosureToRequest(disclosed, {
    model: request.model || settings.aiResearch.openai.model,
    input: disclosed.serialized,
    store: false,
    background: false,
    tools: [],
    max_output_tokens: maxOutputTokens,
  });
}

function costMicros(inputTokens, outputTokens) {
  return Math.ceil(
    (inputTokens * settings.aiResearch.openai.inputMicrosPerMillion) /
      1_000_000 +
      (outputTokens * settings.aiResearch.openai.outputMicrosPerMillion) /
        1_000_000,
  );
}

function estimatedCostMicros(inputText, outputTokens) {
  // A UTF-8 byte is a conservative upper bound for tokenizer units across
  // compatible byte-level tokenizers. This intentionally over-reserves.
  return costMicros(Buffer.byteLength(String(inputText)), outputTokens);
}

/** @param {{jobId:string,request:any,messages:any[],signal?:AbortSignal}} input */
export async function generateWithProvider({
  jobId,
  request,
  messages,
  signal,
}) {
  if (request.route === "local") {
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
  if (!settings.aiResearch.openai.enabled)
    throw Object.assign(new Error("OpenAI API route is disabled"), {
      code: "OPENAI_DISABLED",
    });
  if (
    !(request.model || settings.aiResearch.openai.model) ||
    settings.aiResearch.openai.monthlyBudgetMicros <= 0 ||
    settings.aiResearch.openai.inputMicrosPerMillion <= 0 ||
    settings.aiResearch.openai.outputMicrosPerMillion <= 0
  )
    throw Object.assign(
      new Error(
        "OpenAI model and positive storage-independent spend controls must be configured",
      ),
      { code: "OPENAI_CONFIGURATION_INCOMPLETE" },
    );
  if (!request.grantId)
    throw Object.assign(new Error("An active disclosure grant is required"), {
      code: "GRANT_REQUIRED",
    });
  const preview = disclosurePayload(request);
  const maxOutputTokens = preview.payload.max_output_tokens;
  const cost = estimatedCostMicros(preview.serialized, maxOutputTokens);
  if (await findUncertainDisclosure(jobId))
    throw Object.assign(
      new Error(
        "A prior cloud send has an uncertain outcome and will not be replayed",
      ),
      { code: "UNCERTAIN_PRIOR_SEND" },
    );
  let lastError;
  const retryable = new Set([
    "TIMEOUT",
    "NETWORK_ERROR",
    "HTTP_429",
    "HTTP_500",
    "HTTP_502",
    "HTTP_503",
    "HTTP_504",
  ]);
  for (
    let attempt = 0;
    attempt <= settings.aiResearch.openai.maxRetries;
    attempt += 1
  ) {
    const record = await reserveDisclosure({
      grantId: request.grantId,
      jobId,
      preview,
      outputTokens: maxOutputTokens,
      costMicros: cost,
      monthlyBudgetMicros: settings.aiResearch.openai.monthlyBudgetMicros,
    });
    let helperReturned = false;
    try {
      await updateDisclosureRecord(record.id, { status: "sent" });
      const response = await callOpenAiBroker(
        {
          body: preview.serialized,
          timeoutMs: settings.aiResearch.openai.timeoutMs,
        },
        { signal },
      );
      helperReturned = true;
      if (
        !response.ok &&
        new Set(["NETWORK_ERROR", "TIMEOUT"]).has(response.code)
      )
        helperReturned = false;
      if (!response.ok)
        throw Object.assign(
          new Error("OpenAI request failed inside the egress helper"),
          { code: response.code },
        );
      const inputTokens = response.usage?.input_tokens ?? null;
      const outputTokens = response.usage?.output_tokens ?? null;
      await updateDisclosureRecord(record.id, {
        status: "completed",
        inputTokens,
        outputTokens,
        costMicros: costMicros(inputTokens ?? 0, outputTokens ?? 0),
        providerRequestId: response.requestId,
      });
      return {
        text: response.outputText,
        usage: { inputTokens, outputTokens },
        provider: "openai-api",
        disclosureRecordId: record.id,
      };
    } catch (error) {
      lastError = error;
      if (!helperReturned) {
        throw Object.assign(
          new Error(
            "The cloud send outcome is uncertain and will not be replayed automatically",
          ),
          { code: "UNCERTAIN_CLOUD_SEND", cause: error },
        );
      }
      await updateDisclosureRecord(record.id, {
        status: "failed",
        errorCode: error.code || "CLOUD_REQUEST_FAILED",
      });
      if (!retryable.has(error.code)) break;
    }
  }
  throw lastError;
}

/** Final evidence synthesis is intentionally local even when cloud planning was selected. */
export async function generateLocalSynthesis({ request, messages, signal }) {
  const response = await getOllamaClient().chat({
    model: request.route === "local" ? (request.model ?? undefined) : undefined,
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

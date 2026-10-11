import { aiAnalysisEditProposalSchema } from "@vision/types/aiResearch";
import type { AiAnalysisEditProposal } from "@vision/types/aiResearch";
import type {
  AnalysisDefinition,
  AnalysisVisualPlanSource,
} from "@vision/types/analysis";
import {
  __buildDefinition,
  getSavedAnalysis,
  updateSavedAnalysis,
} from "./savedAnalysisService.ts";
import type {
  SavedAnalysis,
  SavedAnalysisQuerySpec,
} from "./savedAnalysisService.ts";
import type { VisualAnalysisPlan } from "./analysisCatalog.ts";
import { getOllamaClient } from "../integrations/ollama/client.ts";
import settings from "../config/config.ts";
import { UpstreamError } from "../middleware/errorHandler.ts";

function visualPlanFromSource(
  source: AnalysisVisualPlanSource,
): VisualAnalysisPlan {
  return {
    datasetId: source.datasetId,
    fields: source.select
      .filter((entry) => entry.source.kind === "field")
      .map((entry) => entry.id),
    measures: source.select
      .filter((entry) => entry.source.kind === "metric")
      .map((entry) => entry.id),
    groups: source.groupBy,
    joins: source.joins.map((join) => join.pathId),
    filters: source.filters.map((filter) => ({
      fieldId:
        filter.left.datasetId === "accounts"
          ? `account.${filter.left.columnId}`
          : filter.left.columnId,
      operator: filter.operator,
      ...(filter.right?.kind === "literal"
        ? { value: filter.right.value }
        : {}),
    })),
    orderBy: source.orderBy.map(({ outputId, direction }) => ({
      id: outputId,
      direction,
    })),
    limit: source.limit,
  };
}

function querySpecFromDefinition(
  definition: AnalysisDefinition,
): SavedAnalysisQuerySpec {
  const source = definition.source;
  if (source.kind === "custom-sql")
    return {
      mode: "sql",
      sql: source.text,
      datasetIds: source.datasetIds,
      columns: definition.expectedResult.columns,
      ...(source.visualOrigin
        ? { visualOrigin: visualPlanFromSource(source.visualOrigin) }
        : {}),
    };
  return {
    mode: "visual",
    plan: visualPlanFromSource(source),
  };
}
function editable(saved: SavedAnalysis) {
  return {
    name: saved.name,
    workspace: saved.workspace,
    querySpec: querySpecFromDefinition(saved.definition),
    parameters: saved.parameters,
    charts: saved.charts,
    refreshMode: saved.refreshMode,
    sourceReferences: saved.sourceReferences,
  };
}
function segments(path: string) {
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function applyOperations<T>(
  input: T,
  operations: AiAnalysisEditProposal["operations"],
): T {
  const result = structuredClone(input);
  for (const operation of operations) {
    const parts = segments(operation.path);
    if (
      parts.some((part) =>
        ["__proto__", "prototype", "constructor"].includes(part),
      )
    )
      throw new Error("Proposal path contains a forbidden property");
    // A JSON-pointer walk over model-proposed paths: each hop may reach any
    // JSON value.
    let target: unknown = result;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, part))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      target = (target as Record<string, unknown>)[part];
    }
    const key = parts.at(-1);
    // `split` always yields at least one segment.
    if (key === undefined)
      throw new Error(`Proposal path does not exist: ${operation.path}`);
    // The last hop is not checked above, so `container` may be any JSON value
    // (even a primitive or null); the operations below behave on it exactly
    // as they did on the untyped cursor.
    const container = target as Record<string, unknown>;
    if (Array.isArray(container) && key !== "-") {
      if (!/^\d+$/.test(key) || Number(key) >= container.length)
        throw new Error(`Proposal array index is invalid: ${operation.path}`);
    }
    if (operation.op === "remove") {
      if (!Array.isArray(container) && !Object.hasOwn(container, key))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      if (Array.isArray(container)) container.splice(Number(key), 1);
      else delete container[key];
    } else if (
      Array.isArray(container) &&
      operation.op === "add" &&
      key === "-"
    )
      container.push(operation.value);
    else {
      if (operation.op === "replace" && !Object.hasOwn(container, key))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      container[key] = operation.value;
    }
  }
  return result;
}
export async function previewAnalysisProposal(value: unknown) {
  const proposal = aiAnalysisEditProposalSchema.parse(value);
  const saved = await getSavedAnalysis(proposal.savedAnalysisId);
  if (!saved)
    throw Object.assign(new Error("Saved analysis not found"), { status: 404 });
  if (saved.version !== proposal.baseVersion)
    throw Object.assign(
      new Error("Saved analysis changed since this proposal was created"),
      { status: 409, code: "ANALYSIS_VERSION_CONFLICT" },
    );
  const before = editable(saved);
  const after = applyOperations(before, proposal.operations);
  __buildDefinition({
    ...after,
    definitionId: saved.definitionId,
    version: saved.version + 1,
    formulas: after.parameters?.formulaModel?.formulas || [],
    assumptions: after.parameters?.formulaModel?.assumptions || [],
  });
  return { proposal, before, after, baseVersion: saved.version };
}

export async function generateAnalysisProposal({
  savedAnalysisId,
  instruction,
  model,
}: {
  savedAnalysisId: string;
  instruction: unknown;
  model?: string | null;
}) {
  const text = String(instruction || "").trim();
  if (!text || text.length > 2000)
    throw new Error("AI edit instruction must contain 1 to 2000 characters");
  const saved = await getSavedAnalysis(savedAnalysisId);
  if (!saved)
    throw Object.assign(new Error("Saved analysis not found"), { status: 404 });
  // The local model is an upstream: a failed call or a malformed answer is a
  // 502, not a fault in the caller's request.
  const chatRequest = {
    model: model || undefined,
    format: "json",
    options: { num_ctx: settings.ollama.numCtx },
    messages: [
      {
        role: "system",
        content:
          "Return only JSON with rationale and operations. Operations are RFC 6902-like add, replace, or remove edits. Allowed paths start with /name, /parameters, /charts, or /querySpec. Preserve fields not named by the user. Never calculate financial values; edit formulas or query scope for Vision to execute.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction: text,
          current: editable(saved),
        }),
      },
    ],
  };
  let response;
  try {
    response = await getOllamaClient().chat(chatRequest);
  } catch (error) {
    throw new UpstreamError(
      `Local model request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let candidate;
  try {
    candidate = JSON.parse(response.content);
  } catch {
    throw new UpstreamError(
      "The local model did not return a valid JSON proposal",
    );
  }
  const parsed = aiAnalysisEditProposalSchema.safeParse({
    schemaVersion: 1,
    savedAnalysisId: saved.id,
    baseVersion: saved.version,
    rationale: candidate?.rationale,
    operations: candidate?.operations,
  });
  if (!parsed.success)
    throw new UpstreamError(
      "The local model returned a proposal outside the edit contract",
    );
  const proposal = parsed.data;
  return previewAnalysisProposal(proposal);
}
export async function applyAnalysisProposal(value: unknown) {
  const preview = await previewAnalysisProposal(value);
  return updateSavedAnalysis(preview.proposal.savedAnalysisId, {
    ...preview.after,
    expectedVersion: preview.baseVersion,
  });
}

export {
  applyOperations as __applyOperations,
  querySpecFromDefinition as __querySpecFromDefinition,
};

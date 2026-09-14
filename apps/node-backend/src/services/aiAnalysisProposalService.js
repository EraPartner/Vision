import { aiAnalysisEditProposalSchema } from "@vision/types/aiResearch";
import {
  __buildDefinition,
  getSavedAnalysis,
  updateSavedAnalysis,
} from "./savedAnalysisService.js";
import { getOllamaClient } from "../integrations/ollama/client.js";
import settings from "../config/config.js";

function visualPlanFromSource(source) {
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
    orderBy: source.orderBy,
    limit: source.limit,
  };
}

function querySpecFromDefinition(definition) {
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
function editable(saved) {
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
function segments(path) {
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function applyOperations(input, operations) {
  const result = structuredClone(input);
  for (const operation of operations) {
    const parts = segments(operation.path);
    if (
      parts.some((part) =>
        ["__proto__", "prototype", "constructor"].includes(part),
      )
    )
      throw new Error("Proposal path contains a forbidden property");
    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, part))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      target = target[part];
    }
    const key = parts.at(-1);
    if (Array.isArray(target) && key !== "-") {
      if (!/^\d+$/.test(key) || Number(key) >= target.length)
        throw new Error(`Proposal array index is invalid: ${operation.path}`);
    }
    if (operation.op === "remove") {
      if (!Array.isArray(target) && !Object.hasOwn(target, key))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
    } else if (Array.isArray(target) && operation.op === "add" && key === "-")
      target.push(operation.value);
    else {
      if (operation.op === "replace" && !Object.hasOwn(target, key))
        throw new Error(`Proposal path does not exist: ${operation.path}`);
      target[key] = operation.value;
    }
  }
  return result;
}
export async function previewAnalysisProposal(value) {
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
}) {
  const text = String(instruction || "").trim();
  if (!text || text.length > 2000)
    throw new Error("AI edit instruction must contain 1 to 2000 characters");
  const saved = await getSavedAnalysis(savedAnalysisId);
  if (!saved)
    throw Object.assign(new Error("Saved analysis not found"), { status: 404 });
  const response = await getOllamaClient().chat({
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
  });
  let candidate;
  try {
    candidate = JSON.parse(response.content);
  } catch {
    throw new Error("The local model did not return a valid JSON proposal");
  }
  const proposal = aiAnalysisEditProposalSchema.parse({
    schemaVersion: 1,
    savedAnalysisId: saved.id,
    baseVersion: saved.version,
    rationale: candidate.rationale,
    operations: candidate.operations,
  });
  return previewAnalysisProposal(proposal);
}
export async function applyAnalysisProposal(value) {
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

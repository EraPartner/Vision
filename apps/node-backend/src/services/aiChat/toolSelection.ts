/**
 * Choose which tool schemas to send to the model for one chat turn.
 *
 * The 41 schemas are ~19k characters (~5.5k tokens) and are re-sent on every
 * tool-loop iteration, which is most of the prompt a local model has to read
 * before its first token. A turn sends the tools whose name and description
 * share words with the question (plus the rest of their area when the area is
 * small, so "my portfolio" also gets gains and performers), the tools this
 * conversation already used, and `getCategories` (other tools need its IDs). The system prompt still lists
 * every tool name and the dispatcher still runs any registered tool, so a
 * tool that was not sent stays callable; once called, its schema is added for
 * the rest of the turn (see `withCalledTools`). A follow-up ("now exclude
 * January") is matched together with the previous question. A question that
 * matches no tool gets every schema, as before.
 */

import type { getToolSchemas } from "./tools/index.ts";

type ToolSchema = ReturnType<typeof getToolSchemas>[number];

const MAX_MATCHED_TOOLS = 10;
const ALWAYS_SENT = ["getCategories"];
/** Areas sent whole once one of their tools matches; keep each small. */
const SMALL_AREAS: readonly (readonly string[])[] = [
  [
    "getPortfolioHoldings",
    "getReturnsForRange",
    "getDividendIncome",
    "getAssetAllocation",
    "getUnrealizedGains",
    "getBestWorstPerformers",
  ],
  [
    "getUpcomingPlanned",
    "getSubscriptionTotal",
    "getLoanSchedule",
    "getProjectedBalance",
    "getRecurringDetected",
  ],
  ["getTaxableIncomeSummary", "getCapitalGainsForYear", "getDeductibles"],
];
const STOP_WORDS = new Set([
  "about",
  "date",
  "does",
  "from",
  "have",
  "how",
  "into",
  "last",
  "lately",
  "many",
  "month",
  "much",
  "next",
  "range",
  "show",
  "that",
  "their",
  "them",
  "there",
  "this",
  "use",
  "user",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "year",
  "years",
  "your",
]);

function stems(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    .map((word) => word.slice(0, 5));
}

export interface SelectToolsArgs {
  schemas: ToolSchema[];
  question: string;
  /** The previous user message, so a short follow-up keeps its topic. */
  previousQuestion?: string | null | undefined;
  /** Tools called earlier in this conversation, oldest first. */
  usedTools?: Iterable<string>;
  /** Tools that must be sent (e.g. a server-side pre-call). */
  required?: Iterable<string>;
}

/** Schemas for this turn, in registry order so the prompt prefix is stable. */
export function selectToolSchemas({
  schemas,
  question,
  previousQuestion,
  usedTools = [],
  required = [],
}: SelectToolsArgs): ToolSchema[] {
  const asked = new Set(stems(`${question} ${previousQuestion ?? ""}`));
  const scored = schemas
    .map((schema) => ({
      name: schema.function.name,
      score: stems(
        `${schema.function.name} ${schema.function.description}`,
      ).filter((stem) => asked.has(stem)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_TOOLS);
  if (scored.length === 0) return schemas;

  const matched = new Set(scored.map(({ name }) => name));
  const chosen = new Set([
    ...ALWAYS_SENT,
    ...matched,
    ...SMALL_AREAS.filter((area) =>
      area.some((name) => matched.has(name)),
    ).flat(),
    ...usedTools,
    ...required,
  ]);
  return schemas.filter((schema) => chosen.has(schema.function.name));
}

/**
 * Add the schemas of registered tools the model called without having been
 * sent them, so a retry after a validation error sees the full schema.
 */
export function withCalledTools(
  sent: ToolSchema[],
  all: ToolSchema[],
  calledNames: Iterable<string>,
): ToolSchema[] {
  const names = new Set(sent.map((schema) => schema.function.name));
  let added = false;
  for (const name of calledNames) {
    if (names.has(name)) continue;
    if (!all.some((schema) => schema.function.name === name)) continue;
    names.add(name);
    added = true;
  }
  return added ? all.filter((schema) => names.has(schema.function.name)) : sent;
}

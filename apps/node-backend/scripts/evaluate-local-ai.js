#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import settings from "../src/config/config.js";
import { getOllamaClient } from "../src/integrations/ollama/client.js";
import { LOCAL_AI_EVALUATION_CASES } from "../src/services/aiEvaluation/localCases.js";
import {
  runLocalAiCase,
  scoreLocalAiRun,
  summarizeLocalAiEvaluation,
} from "../src/services/aiEvaluation/localReliability.js";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const model = option("--model", settings.ollama.defaultModel);
const repeats = Number(option("--repeats", "3"));
const output = option("--output", undefined);
if (!Number.isSafeInteger(repeats) || repeats < 1) {
  throw new Error("--repeats must be a positive integer");
}
const ollamaClient = getOllamaClient();
const models = await ollamaClient.listModels().catch((error) => {
  console.error(`Local AI unavailable: ${error.message}`);
  process.exitCode = 2;
  return [];
});

if (!models.some((candidate) => candidate.name === model)) {
  console.error(`Local AI model is unavailable: ${model}`);
  process.exit(2);
}

const scoredRuns = [];
for (const testCase of LOCAL_AI_EVALUATION_CASES) {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const startedAt = Date.now();
    try {
      const run = await runLocalAiCase({
        testCase,
        model,
        ollamaClient,
        numCtx: settings.ollama.numCtx,
      });
      scoredRuns.push({ ...scoreLocalAiRun(testCase, run), repeat });
    } catch (error) {
      scoredRuns.push({
        ...scoreLocalAiRun(testCase, {
          completed: false,
          answer: "",
          toolCalls: [],
          latencyMs: Date.now() - startedAt,
          residentMemoryBytes: null,
        }),
        repeat,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model,
  repeats,
  caseCount: LOCAL_AI_EVALUATION_CASES.length,
  summary: summarizeLocalAiEvaluation(scoredRuns),
  runs: scoredRuns,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  const target = path.resolve(output);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, serialized);
}
console.log(serialized.trimEnd());
if (!report.summary.accepted) process.exitCode = 1;

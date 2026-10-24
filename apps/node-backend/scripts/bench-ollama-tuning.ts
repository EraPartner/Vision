#!/usr/bin/env bun
/**
 * Before/after benchmark for the Ollama request tuning (Mac optimisation
 * plan, phase C). Run it on the Mac in your own Terminal with Ollama running:
 *
 *   cd apps/node-backend && bun scripts/bench-ollama-tuning.ts --model llama3.1:8b
 *
 * Every local evaluation case runs in two request shapes against the same
 * Ollama: `fixed` (what Vision sent before: all tool schemas, num_ctx 8192)
 * and `tuned` (what the chat service sends now: selected tools, a window sized
 * to the prompt and the Mac, a capped answer). Each run starts cold (the model
 * unloaded first) and is repeated once warm. It records Ollama's own timings,
 * prompt tokens, the first-token latency, the model's resident size from
 * /api/ps, and the evaluation's quality scores, then writes JSON and a
 * Markdown summary to perf-results/<timestamp>/ (git-ignored).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import settings from "../src/config/config.ts";
import { getOllamaClient } from "../src/integrations/ollama/client.ts";
import { getContextTuner } from "../src/integrations/ollama/tuning.ts";
import { LOCAL_AI_EVALUATION_CASES } from "../src/services/aiEvaluation/localCases.ts";
import {
  fixedWindowRequestShape,
  runLocalAiCase,
  scoreLocalAiRun,
  summarizeLocalAiEvaluation,
  tunedRequestShape,
  type LocalAiRequestShape,
  type LocalAiRun,
} from "../src/services/aiEvaluation/localReliability.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: settings.ollama.defaultModel },
    repeats: { type: "string", default: "3" },
    output: { type: "string" },
  },
});
const model = values.model;
const repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1)
  throw new Error("--repeats must be a positive integer");

const client = getOllamaClient();
const installed = await client.listModels();
if (!installed.some((entry) => entry.name === model)) {
  console.error(`Model not installed in Ollama: ${model}`);
  process.exit(2);
}

const SHAPES: Record<string, () => LocalAiRequestShape> = {
  fixed: () => fixedWindowRequestShape(8_192),
  tuned: () => tunedRequestShape(model),
};

async function unload() {
  await client.setModelResidency({ model, keepAlive: 0 });
  getContextTuner().forget(model);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const running = await client.listRunningModels();
    if (!running.some((entry) => entry.name === model)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Ollama did not unload ${model}`);
}

interface Sample {
  shape: string;
  caseId: string;
  repeat: number;
  state: "cold" | "warm";
  run: LocalAiRun;
}

const samples: Sample[] = [];
const startedAt = new Date();
for (const [shapeName, makeShape] of Object.entries(SHAPES)) {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const testCase of LOCAL_AI_EVALUATION_CASES) {
      const shape = makeShape();
      await unload();
      for (const state of ["cold", "warm"] as const) {
        const run = await runLocalAiCase({
          testCase,
          model,
          ollamaClient: client,
          shape,
        });
        samples.push({
          shape: shapeName,
          caseId: testCase.id,
          repeat,
          state,
          run,
        });
        console.error(
          `${shapeName} ${testCase.id} #${repeat} ${state}: first token ${run.firstTokenLatencyMs ?? "-"} ms, total ${run.latencyMs} ms, prompt ${run.iterations?.[0]?.promptEvalCount ?? "-"} tokens`,
        );
      }
    }
  }
}
await unload();

function stats(numbers: (number | null | undefined)[]) {
  const sorted = numbers
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    median: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? 0,
  };
}

const summary = Object.keys(SHAPES).map((shape) => {
  const of = (state: Sample["state"]) =>
    samples.filter((s) => s.shape === shape && s.state === state);
  const cold = of("cold");
  const warm = of("warm");
  return {
    shape,
    coldFirstTokenMs: stats(cold.map((s) => s.run.firstTokenLatencyMs)),
    warmFirstTokenMs: stats(warm.map((s) => s.run.firstTokenLatencyMs)),
    coldTotalMs: stats(cold.map((s) => s.run.latencyMs)),
    warmTotalMs: stats(warm.map((s) => s.run.latencyMs)),
    firstPromptTokens: stats(
      cold.map((s) => s.run.iterations?.[0]?.promptEvalCount),
    ),
    coldLoadMs: stats(cold.map((s) => s.run.iterations?.[0]?.loadDurationMs)),
    numCtx: stats(
      [...cold, ...warm].flatMap(
        (s) => s.run.iterations?.map((i) => i.numCtx) ?? [],
      ),
    ),
    residentBytes: stats(
      [...cold, ...warm].map((s) => s.run.residentMemoryBytes),
    ),
    quality: summarizeLocalAiEvaluation(
      [...cold, ...warm].map((s) => {
        const testCase = LOCAL_AI_EVALUATION_CASES.find(
          (c) => c.id === s.caseId,
        );
        if (!testCase) throw new Error(`unknown case ${s.caseId}`);
        return scoreLocalAiRun(testCase, s.run);
      }),
    ).metrics,
  };
});

const machine = {
  totalMemoryBytes: os.totalmem(),
  cpu: os.cpus()[0]?.model ?? null,
  platform: `${os.platform()} ${os.release()}`,
};
const outDir = path.resolve(
  values.output ??
    path.join(
      "..",
      "..",
      "perf-results",
      `${startedAt.toISOString().replace(/[:.]/g, "-")}-ollama`,
    ),
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "ollama-bench.json"),
  `${JSON.stringify({ model, repeats, machine, summary, samples }, null, 2)}\n`,
);

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
const cell = (
  value: ReturnType<typeof stats>,
  format = (n: number) => `${n}`,
) =>
  value
    ? `${format(value.median)} (${format(value.min)}–${format(value.max)})`
    : "–";
const rows = [
  ["Cold first token, ms", "coldFirstTokenMs"],
  ["Warm first token, ms", "warmFirstTokenMs"],
  ["Cold total, ms", "coldTotalMs"],
  ["Warm total, ms", "warmTotalMs"],
  ["First prompt, tokens", "firstPromptTokens"],
  ["Cold load, ms", "coldLoadMs"],
  ["num_ctx", "numCtx"],
] as const;
const lines = [
  `# Ollama tuning bench: ${model}`,
  "",
  `${startedAt.toISOString()} · ${gb(machine.totalMemoryBytes)} GB RAM · ${machine.cpu ?? "unknown CPU"} · ${repeats} repeats × ${LOCAL_AI_EVALUATION_CASES.length} cases. Cells: median (min–max).`,
  "",
  `| Metric | ${summary.map((s) => s.shape).join(" | ")} |`,
  `| --- | ${summary.map(() => "---").join(" | ")} |`,
  ...rows.map(
    ([label, key]) =>
      `| ${label} | ${summary.map((s) => cell(s[key])).join(" | ")} |`,
  ),
  `| Resident size, GB | ${summary.map((s) => cell(s.residentBytes, gb)).join(" | ")} |`,
  `| Completion rate | ${summary.map((s) => s.quality.completionRate.toFixed(2)).join(" | ")} |`,
  `| Tool selection rate | ${summary.map((s) => s.quality.toolSelectionRate.toFixed(2)).join(" | ")} |`,
  `| Grounded numbers rate | ${summary.map((s) => s.quality.groundedNumbersRate.toFixed(2)).join(" | ")} |`,
  "",
];
fs.writeFileSync(path.join(outDir, "ollama-bench.md"), lines.join("\n"));
console.log(lines.join("\n"));
console.log(`Saved to ${outDir}`);

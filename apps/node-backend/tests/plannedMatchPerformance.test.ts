import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { AutoLinkTxRow } from "../src/services/plannedMatchService.ts";
import {
  asRecipientId,
  asTransactionId,
} from "@vision/types/brands";

const mocks = vi.hoisted(() => ({
  plans: vi.fn(),
  clusters: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../src/repositories/plannedTransactionRepository.ts", () => ({
  default: { listActiveUnexecuted: mocks.plans },
}));
vi.mock("../src/repositories/transactionRepository.ts", () => ({
  default: {},
}));
vi.mock("../src/repositories/recipientRepository.ts", () => ({
  default: { getClusterRootMap: mocks.clusters },
}));
vi.mock("../src/repositories/settingsRepository.ts", async (original) => {
  const actual =
    await original<
      typeof import("../src/repositories/settingsRepository.ts")
    >();
  return {
    settingField: actual.settingField,
    default: {
      get: async () => ({ value: { autoClearPlannedOnMatch: true } }),
    },
  };
});
vi.mock("../src/services/plannedExecutionService.ts", () => ({
  executePlanned: mocks.execute,
}));
import * as matching from "../src/lib/plannedMatching.ts";
import { autoLinkTransactions } from "../src/services/plannedMatchService.ts";

type Plan = {
  id: number;
  recipient_cluster_id: number;
  currency: string;
  amount: string;
  planned_date: string;
};
const ymd = (days: number) =>
  new Date(Date.UTC(2025, 0, 1 + days)).toISOString().slice(0, 10);

function fixture() {
  const plans: Plan[] = Array.from({ length: 2400 }, (_, i) => ({
    id: i + 1,
    recipient_cluster_id: (i % 200) + 1,
    currency: ["EUR", "USD", "GBP"][Math.floor(i / 200) % 3]!,
    amount: String((Math.floor(i / 600) % 2 ? 1 : -1) * (20 + (i % 47))),
    planned_date: ymd(Math.floor(i / 1200) * 24 + (i % 9)),
  }));
  const txs: AutoLinkTxRow[] = plans
    .filter((_, i) => i % 3 === 0)
    .map((p, i) => ({
      id: asTransactionId(10_000 + i),
      recipient_id: asRecipientId(p.recipient_cluster_id),
      currency: i % 2 ? p.currency.toLowerCase() : p.currency,
      amount: p.amount,
      transaction_date: p.planned_date,
    }));
  // Both ambiguity directions must stay unlinked; these are not empty-match fixtures.
  plans.push(...plans.slice(0, 30).map((p, i) => ({ ...p, id: 3000 + i })));
  txs.push(
    ...txs.slice(30, 60).map((t, i) => ({ ...t, id: asTransactionId(20_000 + i) })),
  );
  // Same identity partition, amount/date just outside the documented tolerances.
  txs.push(
    ...txs.slice(60, 90).map((t, i) => ({
      ...t,
      id: asTransactionId(30_000 + i),
      amount: String(Number(t.amount) * 2),
      transaction_date: ymd(200),
    })),
  );
  return { plans, txs };
}

// Independent requirement oracle: exhaustive pairs, integer cents and UTC day
// differences. It imports neither the predicate nor the bucket/date helpers.
function exhaustive(plans: Plan[], txs: AutoLinkTxRow[]) {
  const matches = new Map<number, number[]>();
  const reverse = new Map<number, number[]>();
  let comparisons = 0;
  for (const tx of txs) {
    const candidates: number[] = [];
    for (const plan of plans) {
      comparisons++;
      if (
        plan.recipient_cluster_id !== tx.recipient_id ||
        plan.currency !== tx.currency?.toUpperCase()
      )
        continue;
      const p = Math.round(Number(plan.amount) * 100);
      const t = Math.round(Number(tx.amount) * 100);
      if (p === 0 || t === 0 || Math.sign(p) !== Math.sign(t)) continue;
      if (Math.abs(p - t) > Math.max(100, Math.abs(p) / 20)) continue;
      if (
        Math.abs(
          Date.parse(plan.planned_date) -
            Date.parse(String(tx.transaction_date)),
        ) >
        5 * 86_400_000
      )
        continue;
      candidates.push(plan.id);
      reverse.set(plan.id, [...(reverse.get(plan.id) ?? []), tx.id]);
    }
    matches.set(tx.id, candidates);
  }
  return {
    comparisons,
    links: txs.flatMap((tx) => {
      const ids = matches.get(tx.id)!;
      return ids.length === 1 && reverse.get(ids[0]!)?.length === 1
        ? [{ plannedTransactionId: ids[0]!, transactionId: tx.id }]
        : [];
    }),
  };
}

// Previous exhaustive candidate traversal, retaining the production predicate and
// both ambiguity maps. Fixtures use recipient IDs as cluster roots on both paths.
async function previousTraversal(
  plans: Plan[],
  txs: AutoLinkTxRow[],
  predicate: typeof matching.matchesTolerance,
) {
  const candidates = new Map<number, Plan[]>();
  const reverse = new Map<number, number[]>();
  for (const tx of txs) {
    const normalized = { ...tx, recipient_cluster_id: tx.recipient_id ?? null };
    const matched = plans.filter((plan) => predicate(plan, normalized));
    candidates.set(tx.id, matched);
    for (const plan of matched) {
      const ids = reverse.get(plan.id) ?? [];
      ids.push(tx.id);
      reverse.set(plan.id, ids);
    }
  }
  const links = [];
  for (const tx of txs) {
    const matched = candidates.get(tx.id)!;
    const plan = matched.length === 1 ? matched[0] : undefined;
    if (!plan || reverse.get(plan.id)?.length !== 1) continue;
    await mocks.execute({
      id: plan.id,
      executedTransactionId: tx.id,
      executionDate: tx.transaction_date,
      expectedOccurrence: plan.planned_date,
      hydrateResult: false,
    });
    links.push({ plannedTransactionId: plan.id, transactionId: tx.id });
  }
  return links;
}

it("measures the actual bucketed matcher against exhaustive mutual-uniqueness outcomes", async () => {
  const { plans, txs } = fixture();
  mocks.plans.mockResolvedValue(plans);
  mocks.clusters.mockResolvedValue(new Map());
  mocks.execute.mockResolvedValue({ duplicate: false });
  const realPredicate = matching.matchesTolerance;
  const predicate = vi.spyOn(matching, "matchesTolerance");
  const samples: Array<{
    bucketMs: number;
    exhaustiveMs: number;
    previousMs: number;
    candidates: number;
  }> = [];
  try {
    const oracle = exhaustive(plans, txs);
    expect(oracle.links.length).toBeGreaterThan(100);
    expect(oracle.links.length).toBeLessThan(800);
    await autoLinkTransactions(txs); // warm both traversal paths before collecting samples
    await previousTraversal(plans, txs, realPredicate);
    for (let run = 0; run < 3; run++) {
      predicate.mockClear();
      mocks.execute.mockClear();
      const start = performance.now();
      const actual = await autoLinkTransactions(txs);
      const bucketMs = performance.now() - start;
      const referenceStart = performance.now();
      const reference = exhaustive(plans, txs);
      const exhaustiveMs = performance.now() - referenceStart;
      expect(actual.links).toEqual(reference.links);
      expect(actual.autoLinkedCount).toBe(reference.links.length);
      expect(mocks.execute).toHaveBeenCalledTimes(reference.links.length);
      const candidates = predicate.mock.calls.length;
      expect(candidates).toBeGreaterThan(0); // ensures the real ESM import was instrumented
      expect(candidates).toBeLessThan(reference.comparisons / 100);
      const previousStart = performance.now();
      const previousLinks = await previousTraversal(plans, txs, realPredicate);
      const previousMs = performance.now() - previousStart;
      expect(previousLinks).toEqual(reference.links);
      samples.push({ bucketMs, exhaustiveMs, previousMs, candidates });
    }
    console.info(
      "planned matcher synthetic evidence",
      JSON.stringify({
        plannedRows: plans.length,
        transactionRows: txs.length,
        exhaustiveComparisons: oracle.comparisons,
        uniqueLinks: oracle.links.length,
        samples,
        medianMs: Object.fromEntries(
          ["bucketMs", "previousMs", "exhaustiveMs"].map((key) => [
            key,
            samples
              .map(
                (sample) =>
                  sample[key as "bucketMs" | "previousMs" | "exhaustiveMs"],
              )
              .sort((a, b) => a - b)[1],
          ]),
        ),
        limitation:
          "Local CPU only; mocked repositories/execution; no database or end-to-end speed claim; no elapsed-time gate",
      }),
    );
  } finally {
    predicate.mockRestore();
  }
});

it("keeps calendar windows across DST, leap day and year boundaries and rejects invalid days", async () => {
  const dates = [
    [new Date(2026, 2, 26), "2026-03-31"],
    [new Date(2026, 9, 23), "2026-10-28"],
    [new Date(2024, 1, 27), "2024-03-03"],
    [new Date(2025, 11, 28), "2026-01-02"],
    [new Date(1969, 11, 27), "1970-01-01"],
  ] as const;
  const plans = dates.map(([date], i) => ({
    id: i + 1,
    recipient_cluster_id: i + 1,
    amount: "-50",
    currency: "EUR",
    planned_date: date,
  }));
  mocks.plans.mockResolvedValue([
    ...plans,
    {
      id: 99,
      recipient_cluster_id: 99,
      amount: "-50",
      currency: "EUR",
      planned_date: "2026-02-30",
    },
  ]);
  mocks.clusters.mockResolvedValue(new Map());
  mocks.execute.mockResolvedValue({ duplicate: false });
  const txs = dates.map(([, date], i) => ({
    id: asTransactionId(i + 100),
    recipient_id: asRecipientId(i + 1),
    amount: "-50",
    currency: "EUR",
    transaction_date: date,
  }));
  const result = await autoLinkTransactions([
    ...txs,
    {
      id: asTransactionId(999),
      recipient_id: asRecipientId(99),
      amount: "-50",
      currency: "EUR",
      transaction_date: "2026-03-02",
    },
  ]);
  expect(result.links).toEqual(
    txs.map((tx, i) => ({ plannedTransactionId: i + 1, transactionId: tx.id })),
  );
  expect(
    (
      await autoLinkTransactions(
        txs.map((tx) => ({
          ...tx,
          transaction_date: ymd(
            Math.round(
              (Date.parse(tx.transaction_date) - Date.UTC(2025, 0, 1)) /
                86_400_000,
            ) + 1,
          ),
        })),
      )
    ).links,
  ).toEqual([]);
  expect(
    (
      await autoLinkTransactions([
        { ...txs[0]!, transaction_date: "not-a-date" },
      ])
    ).links,
  ).toEqual([]);
});

import { describe, it, expect } from "vitest";
import {
  buildInvestmentSummaryCorePartitioned,
  projectAssetTransferPartitions,
} from "@vision/shared-utils/portfolio";
import type {
  CostBasisMethod,
  PartitionedTxnLike,
} from "@vision/shared-utils/portfolio";
import { previewPortfolioAssetAdjustment } from "../src/services/portfolio/portfolioAssetAdjustmentService.ts";

const a = "a".repeat(64),
  b = "b".repeat(64),
  unrelated = "c".repeat(64);
const gift = (
  id: number,
  units: number,
  amount: number,
  source_record_hash: string,
) => ({
  id,
  type: "gift",
  date: `2020-01-0${id}`,
  account_id: 1,
  units,
  amount,
  currency: "EUR",
  fxMultiplier: 2,
  source_record_hash,
});
const reversal: PartitionedTxnLike = {
  id: 6,
  date: "2020-02-01",
  type: "asset_adjustment",
  account_id: 1,
  units: 7,
  adjustment_kind: "yield_reversal",
  basis_policy: "zero_yield_only",
  eligible_source_record_hashes: [a, b],
};
const origin: PartitionedTxnLike[] = [
  { ...gift(1, 10, 100, unrelated), type: "buy" },
  gift(2, 4, 0, a),
  gift(3, 6, 0, b),
  gift(4, 2, 80, unrelated),
  gift(5, 8, 0, unrelated),
];
const methods: CostBasisMethod[] = ["weighted_avg", "fifo", "lifo"];
const summary = (
  rows: readonly PartitionedTxnLike[],
  costBasisMethod: CostBasisMethod,
) =>
  buildInvestmentSummaryCorePartitioned(
    { asset_class: "crypto", current_price: 20 },
    rows,
    { costBasisMethod, todayYmd: "2020-12-31" },
  );

describe("source-backed asset adjustment replay", () => {
  it.each(methods)(
    "reverses only proven zero-basis yield units under %s",
    (method) => {
      const before = summary(origin, method),
        after = summary([...origin, reversal], method);
      expect(after.core.totalUnits.toNumber()).toBe(23);
      expect(after.core.totalInvested.eq(before.core.totalInvested)).toBe(true);
      expect(
        after.core.converted.totalInvested.eq(
          before.core.converted.totalInvested,
        ),
      ).toBe(true);
      expect(after.core.totalBuyCost.toNumber()).toBe(180);
      expect(after.core.realizedGain.toNumber()).toBe(0);
      const leg = projectAssetTransferPartitions([...origin, reversal], method)
        .get(1)!
        .at(-1)!;
      expect(leg.type).toBe("unit_reversal");
      expect(
        leg.consumedLots!.every(
          (l) => l.costBasis.eq(0) && [2, 3].includes(Number(l.acquisitionId)),
        ),
      ).toBe(true);
      expect(leg.consumedLots!.map((l) => Number(l.acquisitionId))).toEqual(
        method === "lifo" ? [3, 2] : [2, 3],
      );
      expect(leg.consumedLots!.map((l) => l.units.toNumber())).toEqual(
        { weighted_avg: [2.8, 4.2], fifo: [4, 3], lifo: [6, 1] }[method],
      );
    },
  );
  it.each(methods)(
    "keeps basis consistent through repeated custody and a later asset fee under %s",
    (method) => {
      const out = {
        id: 7,
        date: "2020-03-01",
        type: "asset_transfer",
        source_account_id: 1,
        destination_account_id: 2,
        units: 10,
      };
      const back = {
        ...out,
        id: 8,
        date: "2020-04-01",
        source_account_id: 2,
        destination_account_id: 1,
        units: 5,
      };
      const fee: PartitionedTxnLike = {
        id: 9,
        date: "2020-05-01",
        type: "asset_adjustment",
        account_id: 2,
        units: 1,
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
      };
      const rows = [...origin, reversal, out, back],
        before = summary(rows, method),
        after = summary([...rows, fee], method);
      const leg = projectAssetTransferPartitions([...rows, fee], method)
        .get(2)!
        .at(-1)!;
      expect(after.core.totalUnits.toNumber()).toBe(22);
      expect(
        after.core.totalInvested
          .plus(leg.assetFeeBasis!)
          .minus(before.core.totalInvested)
          .abs()
          .lt("0.02"),
      ).toBe(true);
      expect(
        after.core.converted.totalInvested
          .plus(leg.assetFeeBasisConv!)
          .minus(before.core.converted.totalInvested)
          .abs()
          .lt("0.02"),
      ).toBe(true);
      expect(after.core.totalSellProceeds.toNumber()).toBe(0);
      expect(after.core.totalBuyCost.toNumber()).toBe(180);
      expect(
        leg.consumedLots!.every((l) =>
          [1, 2, 3, 4, 5].includes(Number(l.acquisitionId)),
        ),
      ).toBe(true);
    },
  );
  it.each(methods)(
    "rejects unavailable proven yields without consuming real or unrelated gift basis under %s",
    (method) => {
      expect(() =>
        projectAssetTransferPartitions(
          [...origin, { ...reversal, units: 11 }],
          method,
        ),
      ).toThrow(/source-proven zero-basis/);
      expect(() =>
        projectAssetTransferPartitions(
          [...origin, { ...reversal, date: "2019-12-31" }],
          method,
        ),
      ).toThrow(/source-proven zero-basis/);
      expect(() =>
        projectAssetTransferPartitions(
          origin
            .map((r) => (r.id === 2 ? { ...r, amount: 10 } : r))
            .concat(reversal),
          method,
        ),
      ).toThrow(/source-proven zero-basis/);
    },
  );
  it("requires explicit zero policy and builds source eligibility from marked acquisitions", () => {
    const row = {
      id: 1,
      batch_id: 1,
      account_id: 1,
      investment_id: 1,
      tx_date: "2020-02-01",
      units: "7",
      source_record_hash: a,
      dedup_fingerprint: b,
      dedup_fingerprint_version: 1,
      asset_adjustment_details: {
        kind: "yield_reversal",
        basisPolicy: "zero_yield_only",
      },
    };
    expect(previewPortfolioAssetAdjustment(row).error).toBe(
      "unresolved_zero_yield_policy",
    );
    const prepared = previewPortfolioAssetAdjustment(
      { ...row, custom_config: { yield_basis_policy: "zero" } },
      undefined,
      {
        sourceRows: [
          {
            account_id: 1,
            investment_id: 1,
            source_record_hash: a,
            asset_adjustment_details: {
              kind: "yield_acquisition",
              basisPolicy: "zero",
            },
          },
        ],
      },
    );
    expect(prepared.event).toMatchObject({
      type: "asset_adjustment",
      account_id: 1,
      adjustment_kind: "yield_reversal",
      eligible_source_record_hashes: [a],
      amount: "0",
    });
    expect(
      previewPortfolioAssetAdjustment({
        ...row,
        asset_adjustment_details: {
          kind: "asset_fee",
          basisPolicy: "carried",
          accountId: 2,
        },
      }).event!.account_id,
    ).toBe(2);
  });
});

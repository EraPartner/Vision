import { describe, expect, it } from "vitest";
import {
  buildInvestmentSummaryCorePartitioned,
  calculateCostBasisByMethod,
  partitionOversellDeficits,
  projectAssetTransferPartitions,
} from "@vision/shared-utils/portfolio";
import {
  previewPortfolioAssetTransfer,
  validatePortfolioAssetTransferHistory,
} from "../src/services/portfolio/portfolioAssetTransferService.ts";

const buy = (id, date, account, units, amount, fxMultiplier = 1) => ({
  id,
  date,
  type: "buy",
  account_id: account,
  units,
  amount,
  fees: 0,
  taxes: 0,
  fxMultiplier,
});
const transfer = (
  id,
  date,
  units,
  fee_units = 0,
  source_account_id = 1,
  destination_account_id = 2,
) => ({
  id,
  date,
  type: "asset_transfer",
  units,
  fee_units,
  source_account_id,
  destination_account_id,
  amount: 0,
  fees: 0,
  taxes: 0,
});
const methods = ["weighted_avg", "fifo", "lifo"];
const summary = (rows, costBasisMethod) =>
  buildInvestmentSummaryCorePartitioned(
    { asset_class: "crypto", current_price: 100 },
    rows,
    { costBasisMethod, todayYmd: "2020-12-31", fxMultiplierNow: 5 },
  );

describe("dated asset transfer replay", () => {
  it.each(methods)(
    "preserves units, original basis and FX without contributed capital under %s",
    (method) => {
      const buys = [
        buy(1, "2020-01-01", 1, 10, 100, 2),
        buy(2, "2020-02-01", 1, 10, 300, 3),
      ];
      const before = summary(buys, method);
      const after = summary([...buys, transfer(3, "2020-03-01", 5)], method);
      expect(after.core.totalUnits.toNumber()).toBe(20);
      for (const field of [
        "totalInvested",
        "totalBuyCost",
        "totalSellProceeds",
        "realizedGain",
        "gainLoss",
      ]) {
        expect(
          after.core[field].minus(before.core[field]).abs().lt("0.00000001"),
        ).toBe(true);
        expect(
          after.core.converted[field]
            .minus(before.core.converted[field])
            .abs()
            .lt("0.00000001"),
        ).toBe(true);
      }
      expect(
        after.partitions.find((p) => p.accountId === 2).contributionKind,
      ).toBe("position");
      const destination = after.partitions.find((p) => p.accountId === 2).core;
      expect(destination.totalInvested.toNumber()).toBe(
        { weighted_avg: 100, fifo: 50, lifo: 150 }[method],
      );
      expect(destination.converted.totalInvested.toNumber()).toBe(
        { weighted_avg: 275, fifo: 100, lifo: 450 }[method],
      );
    },
  );

  it.each(methods)(
    "keeps acquisition order for subsequent destination sales under %s",
    (method) => {
      const rows = [
        buy(1, "2020-01-01", 1, 10, 100, 2),
        buy(2, "2020-02-01", 1, 10, 300, 3),
        buy(3, "2020-02-15", 2, 5, 200, 4),
        transfer(4, "2020-03-01", 5),
        {
          id: 5,
          date: "2020-04-01",
          type: "sell",
          account_id: 2,
          units: 5,
          amount: 500,
          fees: 0,
          taxes: 0,
          fxMultiplier: 5,
        },
      ];
      const result = summary(rows, method);
      expect(result.core.totalUnits.toNumber()).toBe(20);
      expect(result.core.realizedGain.toNumber()).toBe(
        { weighted_avg: 350, fifo: 450, lifo: 300 }[method],
      );
      expect(result.core.converted.realizedGain.toNumber()).toBe(
        { weighted_avg: 1962.5, fifo: 2400, lifo: 1700 }[method],
      );
      expect(result.core.totalBuyCost.toNumber()).toBe(600);
      expect(result.core.totalSellProceeds.toNumber()).toBe(500);
    },
  );

  it.each(methods)(
    "consumes verified asset fees once and carries net lot fragments under %s",
    (method) => {
      const result = summary(
        [buy(1, "2020-01-01", 1, 10, 100, 2), transfer(2, "2020-03-01", 5, 1)],
        method,
      );
      expect(result.core.totalUnits.toNumber()).toBe(9);
      expect(result.core.totalInvested.toNumber()).toBe(90);
      expect(result.core.converted.totalInvested.toNumber()).toBe(180);
      expect(result.core.realizedGain.toNumber()).toBe(-10);
      expect(result.core.converted.realizedGain.toNumber()).toBe(-20);
      expect(result.core.totalBuyCost.toNumber()).toBe(100);
      expect(result.core.totalSellProceeds.toNumber()).toBe(0);
      const destination = result.partitions.find((p) => p.accountId === 2).core;
      expect(destination.totalUnits.toNumber()).toBe(4);
      expect(destination.totalInvested.toNumber()).toBe(40);
    },
  );

  it.each(methods)(
    "preserves lots through round trips, splits and return of capital under %s",
    (method) => {
      const rows = [
        buy(1, "2020-01-01", 1, 10, 100, 2),
        transfer(2, "2020-02-01", 5),
        {
          id: 3,
          date: "2020-03-01",
          type: "split",
          units: 20,
          amount: 0,
          fees: 0,
          taxes: 0,
          account_id: 1,
        },
        {
          id: 4,
          date: "2020-04-01",
          type: "return_of_capital",
          amount: 20,
          units: 0,
          fees: 0,
          taxes: 0,
          account_id: 1,
        },
        transfer(5, "2020-05-01", 10, 0, 2, 1),
      ];
      const result = summary(rows, method);
      expect(result.core.totalUnits.toNumber()).toBe(20);
      expect(result.core.totalInvested.toNumber()).toBe(80);
      expect(result.core.converted.totalInvested.toNumber()).toBe(160);
      expect(result.core.totalBuyCost.toNumber()).toBe(100);
      expect(result.core.realizedGain.toNumber()).toBe(0);
    },
  );

  it("rejects insufficient source units and transfers before acquisition", () => {
    expect(() =>
      projectAssetTransferPartitions([
        buy(1, "2020-01-01", 1, 1, 100),
        transfer(2, "2020-02-01", 2),
      ]),
    ).toThrow(/exceeds source/);
    expect(() =>
      projectAssetTransferPartitions([
        buy(1, "2020-03-01", 1, 1, 100),
        transfer(2, "2020-02-01", 1),
      ]),
    ).toThrow(/exceeds source/);
  });
  it.each(methods)(
    "conserves method-specific basis through repeated moves after a return of capital under %s",
    (method) => {
      const origin = [
        buy(1, "2020-01-01", 1, 10, 10, 2),
        buy(2, "2020-01-02", 1, 10, 190, 3),
        {
          id: 3,
          date: "2020-02-01",
          type: "return_of_capital",
          account_id: 1,
          amount: 100,
          units: 0,
        },
      ];
      const before = summary(origin, method);
      const first = [...origin, transfer(4, "2020-03-01", 10)];
      const second = [...first, transfer(5, "2020-04-01", 10)];
      for (const rows of [first, second]) {
        const after = summary(rows, method);
        expect(after.core.totalUnits.toNumber()).toBe(20);
        expect(after.core.totalInvested.eq(before.core.totalInvested)).toBe(
          true,
        );
        expect(
          after.core.converted.totalInvested.eq(
            before.core.converted.totalInvested,
          ),
        ).toBe(true);
      }
      const afterFirst = summary(first, method);
      const destination = afterFirst.partitions.find((p) => p.accountId === 2);
      expect(destination.core.totalInvested.toNumber()).toBe(
        { weighted_avg: 50, fifo: 0, lifo: 140 }[method],
      );
      expect(destination.core.converted.totalInvested.toNumber()).toBe(
        { weighted_avg: 147.5, fifo: 0, lifo: 420 }[method],
      );
    },
  );
  it("validates destination sales and refuses unassigned acquisition guesses", () => {
    const rows = [
      buy(1, "2020-01-01", 1, 10, 100),
      transfer(2, "2020-02-01", 5),
      {
        id: 3,
        date: "2020-03-01",
        type: "sell",
        account_id: 2,
        units: 6,
        amount: 600,
      },
    ];
    expect(partitionOversellDeficits(rows).get(2)).toBe(1);
    expect(() => validatePortfolioAssetTransferHistory(rows)).toThrow(
      /oversell/,
    );
    expect(() =>
      validatePortfolioAssetTransferHistory([
        buy(1, "2020-01-01", null, 10, 100),
        transfer(2, "2020-02-01", 5),
      ]),
    ).toThrow(/original acquisitions/);
  });
  it("blocks missing destination and unproved fees before preparing canonical history", () => {
    const row = {
      id: 1,
      batch_id: 1,
      account_id: 1,
      investment_id: 1,
      tx_date: "2020-02-01",
      units: "5",
      asset_transfer_details: {
        direction: "out",
        basisStatus: "carried",
        feeUnits: "1",
      },
      source_record_hash: "a".repeat(64),
      dedup_fingerprint: "b".repeat(64),
      dedup_fingerprint_version: 1,
    };
    expect(previewPortfolioAssetTransfer(row).error).toBe(
      "unresolved_transfer_destination",
    );
    expect(
      previewPortfolioAssetTransfer({
        ...row,
        custom_config: { transfer_destination_account_id: 2 },
      }).event,
    ).toMatchObject({
      units: "5",
      fee_units: "1",
      source_account_id: 1,
      destination_account_id: 2,
    });
    expect(
      previewPortfolioAssetTransfer({
        ...row,
        custom_config: { transfer_destination_account_id: 2 },
        asset_transfer_details: { direction: "out", basisStatus: "unresolved" },
      }).error,
    ).toBe("unresolved_transfer_fee_basis");
  });
  it("prepares incoming custody from the explicit origin and blocks missing origins", () => {
    const row = {
      id: 1,
      batch_id: 1,
      account_id: 1,
      investment_id: 1,
      tx_date: "2020-02-01",
      units: "3",
      asset_transfer_details: { direction: "in", basisStatus: "carried" },
      source_record_hash: "a".repeat(64),
      dedup_fingerprint: "b".repeat(64),
      dedup_fingerprint_version: 1,
    };
    expect(previewPortfolioAssetTransfer(row).error).toBe(
      "unresolved_transfer_origin",
    );
    expect(
      previewPortfolioAssetTransfer({
        ...row,
        custom_config: { transfer_origin_account_id: 2 },
      }).event,
    ).toMatchObject({
      source_account_id: 2,
      destination_account_id: 1,
      units: "3",
      fee_units: "0",
    });
  });
});

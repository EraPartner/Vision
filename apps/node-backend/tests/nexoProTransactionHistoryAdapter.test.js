import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
import {
  parseNexoProSpotHistory,
  getNexoProSpotReconciliationEvidence,
} from "../src/services/portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import {
  portfolioIdentityBase,
  assignImportIdentities,
} from "../src/services/importIdentity.ts";
import { toDecimal } from "../src/lib/money.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/nexo-pro-spot-history.csv.fixture",
);
const headers =
  "id,timestamp,pair,side,type,price,executedPrice,triggerPrice,requestedAmount,filledAmount,tradingFee,feeCurrency,status,orderId";
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function csv(records, header = headers) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vision-nexo-pro-test-"),
  );
  directories.push(directory);
  const file = path.join(directory, "history.csv");
  await writeFile(file, `${header}\n${records.join("\n")}\n`);
  return file;
}
function record(overrides = {}) {
  const values = {
    id: "201",
    timestamp: "2025-02-10 23:59:59.123",
    pair: "SYN/EUR",
    side: "buy",
    type: "limit",
    price: "999",
    executedPrice: "2",
    triggerPrice: "",
    requestedAmount: "100",
    filledAmount: "10",
    tradingFee: "0.03",
    feeCurrency: "SYN",
    status: "completed",
    orderId: "PRO-SYNTHETIC-ORDER",
    ...overrides,
  };
  return headers
    .split(",")
    .map((column) => values[column])
    .join(",");
}

describe("Nexo Pro Spot portfolio adapter", () => {
  it("uses fills and executed price while skipping only cancelled orders without executions", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "nexo_pro_spot_history",
    });
    expect(rows).toHaveLength(8);
    expect(rows.skipped).toBe(1);
    expect(rows[0]).toMatchObject({
      typeRaw: "Buy",
      symbolRaw: "SYN",
      units: 9.97,
      pricePerUnit: 2,
      amount: 19.94,
      fees: 0.06,
      taxes: 0,
      currency: "EUR",
      fxRateToEur: null,
      sourceId: "nexo-pro:spot:order:PRO-ORDER-1",
      sourceAccountIdentity: null,
    });
    expect(rows.some((row) => row.sourceId.endsWith("PRO-ORDER-5"))).toBe(
      false,
    );
    expect(
      rows.find((row) => row.sourceId.endsWith("PRO-ORDER-6")),
    ).toMatchObject({
      typeRaw: "Buy",
      units: 2.997,
      pricePerUnit: 2.5,
      amount: 7.4925,
      fees: 0.0075,
    });
  });
  it("keeps base-fee buy cash principal plus fees equal to source gross, and holdings equal to net units", async () => {
    const rows = await parseNexoProSpotHistory(fixture);
    const buy = rows[0];
    expect(toDecimal(buy.amount).plus(buy.fees).eq("20")).toBe(true);
    expect(toDecimal(buy.units).plus("0.03").eq("10")).toBe(true);
    expect(toDecimal(buy.units).times(buy.pricePerUnit).eq(buy.amount)).toBe(
      true,
    );
    // Charging the fee after valuing gross filled units would wrongly spend 20.06.
    expect(buy.amount).not.toBe(20);
  });
  it("consumes base fees on sells without reducing source quote proceeds twice", async () => {
    const rows = await parseNexoProSpotHistory(fixture);
    const sell = rows[1];
    expect(sell).toMatchObject({
      typeRaw: "Sell",
      units: 4.01,
      pricePerUnit: 3,
      amount: 12.03,
      fees: 0.03,
    });
    expect(toDecimal(sell.amount).minus(sell.fees).eq("12")).toBe(true);
    expect(toDecimal(sell.units).minus("0.01").eq("4")).toBe(true);
    expect(toDecimal(sell.units).times(sell.pricePerUnit).eq(sell.amount)).toBe(
      true,
    );
  });
  it("handles fiat-quote fees without changing the filled asset quantity", async () => {
    const rows = await parseNexoProSpotHistory(fixture);
    expect(rows[2]).toMatchObject({
      typeRaw: "Buy",
      units: 5,
      pricePerUnit: 1.2,
      amount: 6,
      fees: 0.1,
      currency: "EUR",
    });
    expect(rows[3]).toMatchObject({
      typeRaw: "Sell",
      units: 2,
      pricePerUnit: 4,
      amount: 8,
      fees: 0.2,
      currency: "EUR",
    });
    expect(toDecimal(rows[2].amount).plus(rows[2].fees).eq("6.1")).toBe(true);
    expect(toDecimal(rows[3].amount).minus(rows[3].fees).eq("7.8")).toBe(true);
  });
  it("uses actual fills for native stopLoss sells regardless of trigger or limit instructions", async () => {
    const [sell] = await parseNexoProSpotHistory(
      await csv([
        record({
          type: "stopLoss",
          side: "sell",
          price: "90",
          triggerPrice: "100",
          executedPrice: "3",
          filledAmount: "4",
          tradingFee: "0.1",
          feeCurrency: "EUR",
        }),
      ]),
    );
    expect(sell).toMatchObject({
      typeRaw: "Sell",
      units: 4,
      pricePerUnit: 3,
      amount: 12,
      fees: 0.1,
    });
    expect(toDecimal(sell.amount).minus(sell.fees).eq("11.9")).toBe(true);
  });
  it("preserves literal records, quoted fields and fractional timestamp text", async () => {
    const source = record({
      id: '"201"',
      timestamp: '"2025-02-10 23:59:59.123"',
      requestedAmount: '"100"',
    });
    const [parsed] = await parseNexoProSpotHistory(await csv([source]));
    expect(parsed.rawData).toBe(source);
    expect(parsed.date).toEqual(new Date("2025-02-10T00:00:00.000Z"));
    expect(parsed.note).toContain("source timestamp retained");
  });
  it("uses immutable order IDs for reimports even if export id or formatting changes", async () => {
    const [a] = await parseNexoProSpotHistory(await csv([record()]));
    const [b] = await parseNexoProSpotHistory(
      await csv([
        record({ id: "999", executedPrice: "2.0000", filledAmount: "10.000" }),
      ]),
    );
    const identity = (row) =>
      assignImportIdentities(
        [
          {
            source_transaction_id: row.sourceId,
            source_account_identity: row.sourceAccountIdentity,
            currency: row.currency,
            route: "PORTFOLIO",
            raw_data: row.rawData,
          },
        ],
        (staged) =>
          portfolioIdentityBase(staged, {
            accountIdentity: "synthetic-account-uuid",
          }),
      )[0];
    expect(identity(a).fingerprint).toBe(identity(b).fingerprint);
    expect(identity(a).sourceRecordHash).not.toBe(identity(b).sourceRecordHash);
    expect(a.sourceId).toBe(b.sourceId);
  });
  it("allows a valid empty export without inventing transactions", async () => {
    const rows = await parseNexoProSpotHistory(await csv([]));
    expect(rows).toHaveLength(0);
    expect(rows.skipped).toBe(0);
  });
  it("retains third-token fees, crypto quotes and unfinalized fills as visible blocked rows", async () => {
    const rows = await parseNexoProSpotHistory(fixture);
    expect(rows.slice(-3).map((row) => row.typeRaw)).toEqual(
      Array(3).fill("Unsupported Nexo Pro Spot order"),
    );
    expect(rows.at(-3).note).toContain("third asset");
    expect(rows.at(-2)).toMatchObject({
      note: expect.stringContaining("crypto-quoted"),
      amount: null,
      currency: null,
      fxRateToEur: null,
    });
    expect(rows.at(-1).note).toContain("not final");
  });
  it.each([
    [
      {
        status: "completed",
        filledAmount: "",
        executedPrice: "",
        tradingFee: "",
      },
      "missing",
    ],
    [
      {
        status: "cancelled",
        filledAmount: "0",
        executedPrice: "",
        tradingFee: "0.01",
      },
      "without any fill",
    ],
    [{ tradingFee: "10" }, "entire filled quantity"],
    [{ tradingFee: "-0.1" }, "invalid"],
    [{ filledAmount: "-10" }, "invalid"],
    [{ executedPrice: "0" }, "missing"],
    [{ executedPrice: "NaN" }, "invalid"],
    [{ executedPrice: "1e9999" }, "numeric limits"],
    [{ executedPrice: "1e-9999" }, "numeric limits"],
    [{ side: "withdraw" }, "side"],
    [{ pair: "EUR/USD" }, "unambiguous"],
    [{ type: "derivative" }, "unsupported"],
    [{ tradingFee: "", feeCurrency: "" }, "explicit fee"],
    [
      { side: "sell", feeCurrency: "EUR", tradingFee: "20.01" },
      "exceeds its gross quote proceeds",
    ],
  ])(
    "blocks inconsistent financial fields %j",
    async (overrides, diagnostic) => {
      const [parsed] = await parseNexoProSpotHistory(
        await csv([record(overrides)]),
      );
      expect(parsed.typeRaw).toBe("Unsupported Nexo Pro Spot order");
      expect(parsed.note).toContain(diagnostic);
      expect(parsed.rawData).toBe(record(overrides));
    },
  );
  it("accepts an explicit zero fee with no fee currency", async () => {
    const [parsed] = await parseNexoProSpotHistory(
      await csv([record({ tradingFee: "0", feeCurrency: "" })]),
    );
    expect(parsed).toMatchObject({
      typeRaw: "Buy",
      units: 10,
      amount: 20,
      fees: 0,
    });
  });
  it.each([
    [{ timestamp: "2025-02-30 12:00:00.123" }, /invalid timestamp/],
    [{ timestamp: "2025-02-10 25:00:00.123" }, /invalid timestamp/],
    [{ orderId: "" }, /missing.*order identifier/],
  ])(
    "rejects invalid provenance identity or date %j",
    async (overrides, error) => {
      await expect(
        parseNexoProSpotHistory(await csv([record(overrides)])),
      ).rejects.toThrow(error);
    },
  );
  it("rejects conflicting or repeated snapshots of the same order within one export", async () => {
    await expect(
      parseNexoProSpotHistory(
        await csv([record(), record({ filledAmount: "9" })]),
      ),
    ).rejects.toThrow(/duplicate order identifier/);
  });
  it("validates the full schema even when an export has no transactions", async () => {
    await expect(
      parseNexoProSpotHistory(await csv([], "id,timestamp")),
    ).rejects.toThrow(/missing columns/);
    await expect(
      parseNexoProSpotHistory(await csv([], `${headers},id`)),
    ).rejects.toThrow(/duplicate column/);
    await expect(
      parseNexoProSpotHistory(
        await csv([], headers.split(",").reverse().join(",")),
      ),
    ).rejects.toThrow(/unsupported column order/);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "vision-nexo-pro-empty-"),
    );
    directories.push(directory);
    const file = path.join(directory, "empty.csv");
    await writeFile(file, "");
    await expect(parseNexoProSpotHistory(file)).rejects.toThrow(
      /missing its CSV header/,
    );
  });

  it("exposes exact gross-to-net source evidence for reconciliation", () => {
    expect(getNexoProSpotReconciliationEvidence(record())).toMatchObject({
      sourceOrderId: "PRO-SYNTHETIC-ORDER",
      sourceTimestamp: "2025-02-10 23:59:59.123",
      side: "buy",
      symbol: "SYN",
      currency: "EUR",
      unitPrice: "2",
      grossUnits: "10",
      netUnits: "9.97",
      feeUnits: "0.03",
      feeCurrency: "SYN",
      quoteFee: "0.06",
      grossQuoteAmount: "20",
      amount: "19.94",
    });
    expect(
      getNexoProSpotReconciliationEvidence(
        record({
          side: "sell",
          executedPrice: "3",
          filledAmount: "4",
          tradingFee: "0.01",
        }),
      ),
    ).toMatchObject({
      side: "sell",
      grossUnits: "4",
      netUnits: "4.01",
      feeUnits: "0.01",
      grossQuoteAmount: "12",
      amount: "12.03",
      quoteFee: "0.03",
    });
    expect(
      getNexoProSpotReconciliationEvidence(
        record({ feeCurrency: "EUR", tradingFee: "0.1" }),
      ),
    ).toMatchObject({
      grossUnits: "10",
      netUnits: "10",
      feeUnits: "0",
      quoteFee: "0.1",
      amount: "20",
    });
  });
  it("rejects source evidence from invalid, incomplete, or multiple records", () => {
    expect(
      getNexoProSpotReconciliationEvidence(record({ feeCurrency: "NEXO" })),
    ).toBeUndefined();
    expect(
      getNexoProSpotReconciliationEvidence(record({ status: "open" })),
    ).toBeUndefined();
    expect(
      getNexoProSpotReconciliationEvidence(record({ orderId: "" })),
    ).toBeUndefined();
    expect(
      getNexoProSpotReconciliationEvidence(`${record()}\n${record()}`),
    ).toBeUndefined();
    expect(
      getNexoProSpotReconciliationEvidence("not a Nexo Pro export"),
    ).toBeUndefined();
  });
});

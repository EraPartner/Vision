import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { parseNexoTransactionHistory } from "../src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/nexo-transaction-history.csv",
);

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function wrapperFixture(records) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vision-nexo-wrapper-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "history.csv");
  const header =
    "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Fee,Fee Currency,Details,Date / Time (UTC)";
  await writeFile(file, `${header}\n${records.join("\n")}\n`);
  return file;
}

describe("Nexo transaction history portfolio adapter", () => {
  it("records approved fiat-wrapper interest once in its native cash currency", async () => {
    const file = await wrapperFixture([
      "NX-EUR-INTEREST,Interest,EURX,2.5,EURX,2.5,$3,-,-,approved / synthetic interest,2026-01-07 15:00:00",
      "NX-GBP-INTEREST,Interest,GBPX,1.25,GBPX,1.25,$2,0,-,approved / synthetic interest,2026-01-08 15:00:00",
    ]);
    const rows = await parseNexoTransactionHistory(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      typeRaw: "Interest",
      symbolRaw: "",
      nameRaw: "",
      units: null,
      amount: 2.5,
      currency: "EUR",
      sourceId: "NX-EUR-INTEREST:income",
    });
    expect(rows[1]).toMatchObject({ amount: 1.25, currency: "GBP" });
    expect(rows.some((row) => row.typeRaw === "Gift")).toBe(false);
  });

  it.each([
    ["pending / interest", "2.5", "-", "EURX"],
    ["approved / interest", "2.4", "-", "EURX"],
    ["approved / interest", "2.5", "0.1", "EURX"],
    ["approved / interest", "2.5", "-", "USDX"],
  ])(
    "blocks unproven fiat interest instead of inventing units or dollars: %s",
    async (details, output, fee, inputCurrency) => {
      const file = await wrapperFixture([
        `NX-UNPROVEN,Interest,${inputCurrency},2.5,EURX,${output},$3,${fee},EURX,${details},2026-01-07 15:00:00`,
      ]);
      const rows = await parseNexoTransactionHistory(file);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        typeRaw: "Unsupported Nexo event: Interest",
        note: expect.stringContaining("unresolved approval, principal, or fee"),
      });
      expect(rows.skipped).toBe(0);
    },
  );

  it("parses conversions and preserves lifecycle rows for explicit review", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows).toHaveLength(13);
    expect(rows.skipped).toBe(0);
    expect(rows.filter((row) => row.typeRaw === "Buy")).toHaveLength(1);
    expect(rows.filter((row) => row.typeRaw === "Sell")).toHaveLength(1);
    expect(rows.find((row) => row.sourceId === "NX-TRADE-1")).toMatchObject({
      typeRaw: "Buy",
      symbolRaw: "EURX",
      units: 0.05,
      pricePerUnit: 2000,
      amount: 100,
      fees: 0.01,
      currency: "USD",
      sourceId: "NX-TRADE-1",
    });
    expect(rows.find((row) => row.sourceId === "NX-TRADE-2")).toMatchObject({
      typeRaw: "Sell",
      symbolRaw: "BTC",
      units: 0.01,
      pricePerUnit: 25000,
      fees: 1,
      sourceId: "NX-TRADE-2",
    });
    expect(
      rows.filter(
        (row) =>
          row.sourceId?.startsWith("NX-DUP") ||
          row.sourceId?.startsWith("NX-MOVE"),
      ),
    ).toHaveLength(4);
    expect(rows.find((row) => row.sourceId === "NX-DUP-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Exchange Deposited On",
      note: expect.stringContaining("explicit pairing review"),
    });
  });

  it("does not silently discard a conversion fee in another currency", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows.find((row) => row.sourceId === "NX-FEE-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Deposit To Exchange",
      note: expect.stringContaining("fee in EUR"),
    });
  });

  it("stages incomplete conversions for review instead of dropping them", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows.find((row) => row.sourceId === "NX-FAILED-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Deposit To Exchange",
      note: expect.stringContaining(
        "missing a distinct asset pair, units, or USD valuation",
      ),
    });
    expect(rows.skipped).toBe(0);
  });

  it("records interest income and units, top-ups, and unsafe withdrawals", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(
      rows.filter((row) => row.sourceId?.startsWith("NX-INCOME-1")),
    ).toEqual([
      expect.objectContaining({
        typeRaw: "Interest",
        amount: 4,
        sourceId: "NX-INCOME-1:income",
      }),
      expect.objectContaining({
        typeRaw: "Gift",
        units: 0.002,
        pricePerUnit: 2000,
        sourceId: "NX-INCOME-1:units",
      }),
    ]);
    expect(rows.find((row) => row.sourceId === "NX-TOPUP-1")).toMatchObject({
      typeRaw: "Gift",
      symbolRaw: "BTC",
      units: 0.003,
      amount: 0,
      assetTransfer: { direction: "in", basisStatus: "unresolved" },
    });
    expect(rows.find((row) => row.sourceId === "NX-OUT-1")).toMatchObject({
      typeRaw: "AssetTransfer",
      assetTransfer: {
        direction: "out",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: "0.001",
      },
    });
  });

  it("retains literal provenance and is selected by the format contract", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "nexo_transaction_history",
      encoding: "utf-8",
    });

    expect(rows[0].rawData).toContain("NX-TRADE-1,Deposit To Exchange");
    expect(rows[0].rawData).not.toContain("|");
  });
  it("carries configured incoming custody without inventing a purchase or network fee", async () => {
    const approved = await wrapperFixture([
      "NX-TOPUP-1,Top up Crypto,BTC,0.003,BTC,0.003,75,-,-,approved / synthetic return,2026-01-07 15:00:00",
    ]);
    const rows = await parseWithConfig(approved, {
      format: "nexo_transaction_history",
      transfer_origin_account_id: 2,
    });
    expect(rows.find((row) => row.sourceId === "NX-TOPUP-1")).toMatchObject({
      typeRaw: "AssetTransfer",
      symbolRaw: "BTC",
      units: 0.003,
      amount: 0,
      fees: 0,
      assetTransfer: {
        direction: "in",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: "0.003",
      },
    });
    const file = await wrapperFixture([
      "NX-TOPUP-FEE,Top up Crypto,BTC,0.003,BTC,0.003,60,0.001,BTC,approved / synthetic topup,2026-01-07 15:00:00",
    ]);
    expect(
      (
        await parseNexoTransactionHistory(file, {
          transfer_origin_account_id: 2,
        })
      )[0].typeRaw,
    ).toBe("Unsupported Nexo event: Top up Crypto");
  });
  it("accepts the explicit dash fee placeholder without inventing asset acquisition basis", async () => {
    const file = await wrapperFixture([
      "NX-OUT-DASH,Withdrawal,BTC,-0.001,BTC,0.001,25,-,-,approved / synthetic withdrawal,2026-01-07 15:00:00",
      "NX-FIAT-DASH,Deposit To Exchange,EUR,100,EURX,100,100,-,-,approved / synthetic deposit,2026-01-08 15:00:00",
      "NX-FIAT-PAIR,Exchange Deposited On,EUR,100,EUR,100,100,-,-,approved / synthetic deposit,2026-01-08 15:01:00",
    ]);
    const rows = await parseNexoTransactionHistory(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      typeRaw: "AssetTransfer",
      assetTransfer: { feeUnits: "0", receivedUnits: "0.001" },
    });
    expect(rows[1]).toMatchObject({
      typeRaw: "Deposit",
      amount: 100,
      currency: "EUR",
    });
    expect(rows.skipped).toBe(1);
  });
  it("retains approved equal-unit Pro sub-wallet movements as explicit audit-only history", async () => {
    const file = await wrapperFixture([
      "NX-PRO-IN,Transfer From Pro Wallet,BTC,0.01,BTC,0.01,300,-,-,approved / synthetic move,2026-01-07 15:00:00",
      "NX-PRO-OUT,Transfer To Pro Wallet,EURX,100,EURX,100,100,-,-,approved / synthetic move,2026-01-08 15:00:00",
      "NX-PRO-BAD,Transfer From Pro Wallet,BTC,0.01,BTC,0.02,600,-,-,approved / synthetic move,2026-01-09 15:00:00",
    ]);
    const rows = await parseNexoTransactionHistory(file);
    expect(rows.slice(0, 2).map((row) => row.typeRaw)).toEqual([
      "InternalMovement",
      "InternalMovement",
    ]);
    expect(rows[0]).toMatchObject({
      amount: 0,
      assetTransfer: { direction: "internal", basisStatus: "not_applicable" },
    });
    expect(rows[0].rawData).toContain("NX-PRO-IN,Transfer From Pro Wallet");
    expect(rows[2].typeRaw).toMatch(/^Unsupported/);
    expect(rows.skipped).toBe(0);
  });

  it("rejects a different CSV schema", async () => {
    await expect(
      parseNexoTransactionHistory(
        new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
      ),
    ).rejects.toThrow(/missing columns/);
  });

  it("imports approved fiat principal and additional fees once, with both lifecycle records as provenance", async () => {
    const file = await wrapperFixture([
      "D1,Deposit To Exchange,EUR,100,EURX,100,$110,1,EUR,approved / top up,2026-01-01 10:00:00",
      "DC1,Exchange Deposited On,EUR,100,EURX,100,$110,0,-,approved / wrapping,2026-01-01 10:00:00",
      "W1,Exchange To Withdraw,EURX,51,EUR,50,$55,1,EURX,approved / withdrawal,2026-01-02 10:00:00",
      "WC1,Withdraw Exchanged,EUR,-50,EUR,50,$55,0,-,approved / withdrawal,2026-01-02 10:16:42",
      "D2,Deposit To Exchange,EUR,25,EURX,0,$27.5,0,-,approved / top up,2026-01-03 10:00:00",
      "DC2,Exchange Deposited On,EUR,25,EURX,0,$27.5,0,-,approved / wrapping,2026-01-03 10:00:00",
      "R1,Exchange To Withdraw,EURX,20,EUR,20,$22,0,-,rejected / failed,2026-01-04 10:00:00",
    ]);
    const rows = await parseNexoTransactionHistory(file);
    expect(
      rows.map((row) => [row.typeRaw, row.amount, row.currency, row.symbolRaw]),
    ).toEqual([
      ["Deposit", 100, "EUR", ""],
      ["Fee", 1, "EUR", ""],
      ["Withdrawal", 50, "EUR", ""],
      ["Fee", 1, "EUR", ""],
      ["Deposit", 25, "EUR", ""],
    ]);
    expect(rows.skipped).toBe(4);
    expect(rows[0].rawData).toContain("D1,Deposit To Exchange");
    expect(rows[0].rawData).toContain("DC1,Exchange Deposited On");
    expect(rows[1].sourceId).toBe("D1:fee");
  });

  it("blocks missing, ambiguous, distant and cross-day cash companions", async () => {
    const cases = [
      [],
      [
        "C1,Exchange Deposited On,EUR,100,EURX,100,$110,0,-,approved / wrapping,2026-01-01 10:00:00",
        "C2,Exchange Deposited On,EUR,100,EURX,100,$110,0,-,approved / wrapping,2026-01-01 10:00:00",
      ],
      [
        "C1,Exchange Deposited On,EUR,100,EURX,100,$110,0,-,approved / wrapping,2026-01-01 10:31:00",
      ],
      [
        "C1,Exchange Deposited On,EUR,100,EURX,100,$110,0,-,approved / wrapping,2026-01-02 10:00:00",
      ],
    ];
    for (const companions of cases) {
      const file = await wrapperFixture([
        "D1,Deposit To Exchange,EUR,100,EURX,100,$110,0,-,approved / top up,2026-01-01 10:00:00",
        ...companions,
      ]);
      const rows = await parseNexoTransactionHistory(file);
      expect(rows.find((row) => row.sourceId === "D1")).toMatchObject({
        typeRaw: "Unsupported Nexo event: Deposit To Exchange",
        note: expect.stringContaining("no unique approved lifecycle companion"),
      });
      expect(rows.skipped).toBe(0);
    }
  });

  it("blocks a wrapper withdrawal whose principal and fee disagree", async () => {
    const file = await wrapperFixture([
      "W1,Exchange To Withdraw,EURX,52,EUR,50,$55,1,EURX,approved / withdrawal,2026-01-01 10:00:00",
      "WC1,Withdraw Exchanged,EUR,-50,EUR,50,$55,0,-,approved / withdrawal,2026-01-01 10:00:01",
    ]);
    const rows = await parseNexoTransactionHistory(file);
    expect(rows[0]).toMatchObject({
      typeRaw: "Unsupported Nexo event: Exchange To Withdraw",
      note: "Nexo cash principal and fee do not reconcile",
    });
    expect(rows[0].rawData).toContain("W1,Exchange To Withdraw");
    expect(rows[0].rawData).toContain("WC1,Withdraw Exchanged");
  });

  it("blocks unequal top-up principal and invalid fees without losing the companion evidence", async () => {
    for (const [output, fee] of [
      ["99", "0"],
      ["100", "broken"],
    ]) {
      const file = await wrapperFixture([
        `D1,Deposit To Exchange,EUR,100,EURX,${output},$110,${fee},EUR,approved / top up,2026-01-01 10:00:00`,
        `DC1,Exchange Deposited On,EUR,100,EURX,${output},$110,0,-,approved / wrapping,2026-01-01 10:00:00`,
      ]);
      const rows = await parseNexoTransactionHistory(file);
      expect(rows).toHaveLength(1);
      expect(rows[0].typeRaw).toBe(
        "Unsupported Nexo event: Deposit To Exchange",
      );
      expect(rows[0].rawData).toContain("DC1,Exchange Deposited On");
    }
  });
});

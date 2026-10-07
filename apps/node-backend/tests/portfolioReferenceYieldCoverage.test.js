import { describe, expect, it } from "vitest";
import { toDecimal } from "../src/lib/money.ts";
import { __computeSourceRecordHash } from "../src/services/importIdentity.js";
import { parsePortfolioPerformanceXml } from "../src/services/portfolioPerformanceXmlParser.js";
import { findNexoReferenceYieldGroups } from "../src/services/portfolioReferenceYieldCoverage.js";
import {
  portfolioPerformanceXml,
  ppEvent,
} from "./fixtures/portfolioPerformanceSynthetic.js";

function sourcePair(index, date, units, amount = "0.16") {
  const sourceId = `SYNTHETIC-INTEREST-${index}`;
  const raw = `${sourceId},Interest,ETH,${units},ETH,${units},$${amount},-,-,approved / synthetic interest,${date} 15:00:00`;
  const common = {
    batch_id: 1,
    status: "matched",
    route: "portfolio",
    investment_id: 1,
    account_id: 7,
    asset_class: "crypto",
    tx_date: date,
    amount,
    fees: "0",
    taxes: "0",
    currency: "USD",
    raw_data: raw,
    source_record_hash: __computeSourceRecordHash(raw),
    symbol_raw: "ETH",
    custom_config: { format: "nexo_transaction_history" },
  };
  return [
    {
      ...common,
      id: index * 2,
      row_index: index * 2,
      type: "gift",
      type_raw: "Gift",
      units,
      price_per_unit: toDecimal(amount).div(units).toDecimalPlaces(6).toFixed(),
      source_transaction_id: `${sourceId}:units`,
    },
    {
      ...common,
      id: index * 2 + 1,
      row_index: index * 2 + 1,
      type: "interest",
      type_raw: "Interest",
      units: null,
      price_per_unit: null,
      source_transaction_id: `${sourceId}:income`,
    },
  ];
}

const first = () => sourcePair(1, "2025-01-02", "0.00006271");
const second = () => sourcePair(2, "2025-01-03", "0.00006272");
const event = (over = {}) =>
  ppEvent({
    id: "synthetic-yield-group",
    date: "2025-01-02",
    shares: "0.00012543",
    amount: "0.21",
    currency: "EUR",
    ...over,
  });
const reference = (events = [event()]) =>
  parsePortfolioPerformanceXml(portfolioPerformanceXml({ events }));
const find = (over = {}) =>
  findNexoReferenceYieldGroups({
    reference: reference(),
    rows: [...first(), ...second()],
    accountMappings: new Map([["portfolio-one", 7]]),
    securityInvestments: new Map([["security-eth", { id: 1 }]]),
    ...over,
  });

describe("bounded Nexo grouped secondary yield coverage", () => {
  it("covers an exact consecutive-day unit aggregate and its unchanged paired income", () => {
    const rows = [...first(), ...second()];
    const before = JSON.stringify(rows);
    const result = find({ rows });
    expect(result.blockers).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].acquisitionRows).toEqual([rows[0], rows[2]]);
    expect(result.groups[0].incomeRows).toEqual([rows[1], rows[3]]);
    expect(result.groups[0].event.currency).toBe("EUR");
    expect(result.groups[0].acquisitionRows.map((row) => row.currency)).toEqual(
      ["USD", "USD"],
    );
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("supports a receipt dated on the last grouped source day", () => {
    expect(
      find({ reference: reference([event({ date: "2025-01-03" })]) }).groups,
    ).toHaveLength(1);
  });

  it("requires explicit proven account and investment mappings", () => {
    expect(find({ accountMappings: new Map() }).groups).toEqual([]);
    expect(
      find({ accountMappings: new Map([["portfolio-one", 8]]) }).groups,
    ).toEqual([]);
    expect(
      find({ securityInvestments: new Map([["security-eth", { id: 2 }]]) })
        .groups,
    ).toEqual([]);
    const rows = [...first(), ...second()];
    rows[2].account_id = rows[3].account_id = 8;
    expect(find({ rows }).groups).toEqual([]);
  });

  it("does not re-cover a receipt already matched individually", () => {
    expect(
      find({ alreadyCovered: new Set(["synthetic-yield-group"]) }).groups,
    ).toEqual([]);
  });

  it("blocks an aggregate that would consume an individually covered source receipt", () => {
    const result = find({
      reference: reference([
        event(),
        event({ id: "individual", shares: "0.00006271" }),
      ]),
      alreadyCovered: new Set(["individual"]),
    });
    expect(result.groups).toEqual([]);
    expect(result.blockers).toContainEqual({
      reason: "reference_ambiguous_yield_group",
      referenceTransactionId: "synthetic-yield-group",
    });
  });

  it("rejects a single receipt, wrong aggregate units and nonconsecutive dates", () => {
    expect(find({ rows: first() }).groups).toEqual([]);
    expect(
      find({ reference: reference([event({ shares: "0.00012544" })]) }).groups,
    ).toEqual([]);
    expect(
      find({ rows: [...first(), ...sourcePair(2, "2025-01-04", "0.00006272")] })
        .groups,
    ).toEqual([]);
  });

  it("does not choose an arbitrary subset from the local source days", () => {
    const rows = [
      ...first(),
      ...second(),
      ...sourcePair(3, "2025-01-03", "0.00000001"),
    ];
    expect(find({ rows }).groups).toEqual([]);
  });

  it.each([
    ["units", "0.00006270"],
    ["tx_date", "2025-01-01"],
    ["source_transaction_id", "TAMPERED:units"],
    ["source_record_hash", "a".repeat(64)],
    ["amount", "0.17"],
    ["price_per_unit", "1"],
    ["currency", "EUR"],
    ["symbol_raw", "BTC"],
    ["fx_rate_to_eur", "0.9"],
    ["fees", "1"],
    ["type_raw", "Buy"],
  ])(
    "fails closed when the staged %s disagrees with the literal source",
    (key, value) => {
      const rows = [...first(), ...second()];
      rows[0][key] = value;
      const result = find({ rows });
      expect(result.groups).toEqual([]);
      expect(result.blockers).toContainEqual(
        expect.objectContaining({
          reason: "reference_unproven_yield_source",
          rowId: 2,
        }),
      );
    },
  );

  it.each([
    ["pending / synthetic interest", "0.00006271", "-"],
    ["approved / synthetic interest", "0.00006270", "-"],
    ["approved / synthetic interest", "0.00006271", "0.00000001"],
  ])(
    "rejects unsupported literal approval, amount or fee: %s",
    (details, input, fee) => {
      const rows = [...first(), ...second()];
      const raw = `SYNTHETIC-INTEREST-1,Interest,ETH,${input},ETH,0.00006271,$0.16,${fee},ETH,${details},2025-01-02 15:00:00`;
      for (const row of rows.slice(0, 2)) {
        row.raw_data = raw;
        row.source_record_hash = __computeSourceRecordHash(raw);
      }
      expect(find({ rows }).groups).toEqual([]);
    },
  );

  it("requires exactly one income paired to each unchanged raw receipt", () => {
    const rows = [...first(), ...second()];
    expect(find({ rows: rows.filter((row) => row.id !== 3) }).groups).toEqual(
      [],
    );
    expect(find({ rows: [...rows, { ...rows[1], id: 8 }] }).groups).toEqual([]);
    rows[1].amount = "0.15";
    expect(find({ rows }).groups).toEqual([]);
  });

  it("rejects duplicate source IDs across batches", () => {
    const rows = [...first(), ...second()];
    const duplicate = first().map((row) => ({
      ...row,
      id: row.id + 20,
      batch_id: 2,
    }));
    const result = find({ rows: [...rows, ...duplicate] });
    expect(result.groups).toEqual([]);
    expect(
      result.blockers.some(
        (item) => item.reason === "reference_unproven_yield_source",
      ),
    ).toBe(true);
  });

  it("blocks two secondary candidates covering the same source receipts", () => {
    const result = find({
      reference: reference([event(), event({ id: "other" })]),
    });
    expect(result.groups).toEqual([]);
    expect(result.blockers).toEqual([
      {
        reason: "reference_ambiguous_yield_group",
        referenceTransactionId: "synthetic-yield-group",
      },
      {
        reason: "reference_ambiguous_yield_group",
        referenceTransactionId: "other",
      },
    ]);
  });

  it("blocks multiple whole source windows for one secondary receipt", () => {
    const rows = [
      ...sourcePair(1, "2025-01-01", "0.00000010"),
      ...sourcePair(2, "2025-01-02", "0.00000020"),
      ...sourcePair(3, "2025-01-03", "0.00000010"),
    ];
    const result = find({
      rows,
      reference: reference([event({ shares: "0.00000030" })]),
    });
    expect(result.groups).toEqual([]);
    expect(result.blockers).toEqual([
      {
        reason: "reference_ambiguous_yield_group",
        referenceTransactionId: "synthetic-yield-group",
      },
    ]);
  });

  it("blocks overlapping consecutive-day aggregate candidates", () => {
    const rows = [
      ...sourcePair(1, "2025-01-02", "0.00000010"),
      ...sourcePair(2, "2025-01-03", "0.00000020"),
      ...sourcePair(3, "2025-01-04", "0.00000030"),
    ];
    const ref = reference([
      event({ shares: "0.00000030" }),
      event({ id: "other", date: "2025-01-03", shares: "0.00000050" }),
    ]);
    const result = find({ rows, reference: ref });
    expect(result.groups).toEqual([]);
    expect(
      result.blockers.filter(
        (item) => item.reason === "reference_ambiguous_yield_group",
      ),
    ).toHaveLength(2);
  });

  it.each(["0.00012543", "0.00012500"])(
    "blocks insertion beside an unassigned legacy aggregate of %s units",
    (units) => {
      const result = find({
        history: [
          {
            id: 40,
            type: "gift",
            investment_id: 1,
            account_id: null,
            import_batch_id: null,
            date: "2025-01-02",
            units,
            amount: "0.21",
            currency: "EUR",
          },
        ],
      });
      expect(result.groups).toEqual([]);
      expect(result.blockers).toContainEqual({
        reason: "reference_existing_aggregate_yield_history",
        referenceTransactionId: "synthetic-yield-group",
        transactionId: 40,
        rowIds: [2, 4],
      });
    },
  );

  it("does not block unrelated individual or distant gifts", () => {
    const history = [
      {
        id: 40,
        type: "gift",
        investment_id: 1,
        date: "2025-01-02",
        units: "0.00006271",
      },
      {
        id: 41,
        type: "gift",
        investment_id: 1,
        date: "2024-12-01",
        units: "0.00012543",
      },
      {
        id: 42,
        type: "gift",
        investment_id: 2,
        date: "2025-01-02",
        units: "0.00012543",
      },
      {
        id: 43,
        type: "gift",
        investment_id: 1,
        account_id: 8,
        date: "2025-01-02",
        units: "0.00012543",
      },
    ];
    expect(find({ history }).blockers).toEqual([]);
    expect(find({ history }).groups).toHaveLength(1);
  });
});

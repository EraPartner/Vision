import { describe, expect, it } from "vitest";
import { __computeSourceRecordHash } from "../src/services/importIdentity.js";
import { parsePortfolioPerformanceXml } from "../src/services/portfolioPerformanceXmlParser.js";
import { planPortfolioImportReference } from "../src/services/portfolioImportReferenceService.js";
import {
  portfolioPerformanceXml,
  ppEvent,
} from "./fixtures/portfolioPerformanceSynthetic.js";
const columns =
  "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Currency_Pair,Amount,Trade_Price,Total,Fee,Fee_Currency,Trade_Value,Trade_Value_Currency,Starting_Balance,Starting_Balance_Currency,Closing_Balance,Closing_Balance_Currency".split(
    ",",
  );
const investments = [
  {
    id: 1,
    symbol: "ETH-EUR",
    name: "Synthetic Ether",
    asset_class: "crypto",
    currency: "EUR",
    price_provider_id: "ETH-EUR",
  },
];
function source(id, received, gross, start, end) {
  const cells = [
    "2025-01-01 12:00:00 UTC",
    "KM00000001",
    "ETH",
    "Withdrawal",
    `WITHDRAW-${id}`,
    "",
    "",
    received,
    "",
    "",
    "0.0003",
    "ETH",
    "",
    "",
    start,
    "ETH",
    end,
    "ETH",
  ];
  const literal = cells.join(",");
  return {
    id,
    batch_id: 1,
    row_index: id,
    status: "matched",
    route: "asset_transfer",
    investment_id: 1,
    account_id: 7,
    type: null,
    tx_date: "2025-01-01",
    units: gross,
    amount: "0",
    currency: "EUR",
    symbol_raw: "ETH",
    source_transaction_id: `WITHDRAW-${id}`,
    source_account_identity: "KM00000001",
    raw_data: literal,
    source_record_hash: __computeSourceRecordHash(literal),
    custom_config: {
      format: "kinesis_transaction_history",
      source_columns: columns,
      included_symbols: ["ETH"],
      transfer_destination_account_id: 8,
    },
    asset_transfer_details: {
      direction: "out",
      basisStatus: "carried",
      receivedUnits: received,
      feeUnits: "0.0003",
    },
  };
}
function fixture(fee = "0.00030003", extra = false) {
  const events = [
    ppEvent({ id: "gift", shares: "0.05", amount: "250" }),
    ...[
      ["a", "0.01"],
      ["b", "0.01999994"],
    ].flatMap(([id, shares]) => [
      ppEvent({
        id: `out-${id}`,
        type: "TRANSFER_OUT",
        pairId: `in-${id}`,
        shares,
      }),
      ppEvent({
        id: `in-${id}`,
        portfolioId: "portfolio-two",
        type: "TRANSFER_IN",
        pairId: `out-${id}`,
        shares,
      }),
      ppEvent({ id: `fee-${id}`, type: "DELIVERY_OUTBOUND", shares: fee }),
    ]),
    ...(extra
      ? [ppEvent({ id: "extra", type: "DELIVERY_OUTBOUND", shares: "0.0001" })]
      : []),
    ppEvent({ id: "metal", securityId: "security-metal", shares: "5" }),
  ];
  const reference = parsePortfolioPerformanceXml(
    portfolioPerformanceXml({
      events,
      securities: [
        {
          id: "security-eth",
          ticker: "ETH",
          name: "Synthetic Ether",
          currency: "EUR",
        },
        {
          id: "security-metal",
          ticker: "METAL",
          name: "Synthetic metal",
          currency: "USD",
        },
      ],
    }),
  );
  const gift = {
    ...source(0, "0.05", "0.05", "0", "0.05"),
    route: "portfolio",
    type: "gift",
    type_raw: "Gift",
    asset_transfer_details: { direction: "in", basisStatus: "unresolved" },
  };
  return {
    reference,
    rows: [
      gift,
      source(1, "0.01", "0.0103", "0.05", "0.0397"),
      source(2, "0.02", "0.0203", "0.0397", "0.0194"),
    ],
    investments,
  };
}
describe("literal grouped withdrawal reference coverage", () => {
  it("covers a complete net transfer and repeated fee representation while retaining exact broker quantities", () => {
    const input = fixture();
    const plan = planPortfolioImportReference(input);
    expect(plan.blockers).toEqual([]);
    expect(plan.supplemental).toEqual([]);
    expect(plan.coverage.outsideSelectedReferenceEvents).toBe(1);
    for (const row of input.rows.slice(1)) {
      const after = plan.corrections.find((c) => c.row.id === row.id).after;
      expect(after.units).toBe(row.units);
      expect(after.asset_transfer_details).toEqual(row.asset_transfer_details);
    }
  });
  it("blocks unproven, extra or materially different fee removals", () => {
    for (const input of [fixture("0.00031"), fixture("0.00030003", true)])
      expect(
        planPortfolioImportReference(input).blockers.length,
      ).toBeGreaterThan(0);
    const input = fixture();
    input.rows[2].source_record_hash = "0".repeat(64);
    expect(planPortfolioImportReference(input).blockers.length).toBeGreaterThan(
      0,
    );
  });
});

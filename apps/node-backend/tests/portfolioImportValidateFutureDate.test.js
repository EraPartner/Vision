import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";
// Future-dated portfolio rows used to pass validation and commit silently: a
// typo'd year or a settlement date ahead of today would skew every time-based
// portfolio calc. validate.js now rejects tx_date > today (app calendar).

vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/database/connection.js", () => ({
  query: vi.fn(),
}));

import { query } from "../src/database/connection.js";
import { validateBatch } from "../src/services/portfolioImportPipeline/validate.js";

/** Wire query() to respond by SQL shape, returning the given pending rows. */
function wireQuery(pending) {
  query.mockImplementation(async (sql) => {
    if (sql.includes("SET status = 'validating'")) return { rows: [] };
    if (sql.includes("FROM portfolio_import_batches")) {
      return {
        rows: [
          {
            default_asset_class: null,
            default_type: null,
            custom_config: {},
            is_brokerage: false,
          },
        ],
      };
    }
    if (sql.includes("FROM portfolio_import_staging_rows"))
      return { rows: pending };
    return { rows: [] }; // UNNEST update + counter updates
  });
}

function findUnnestUpdate() {
  return query.mock.calls.find(([sql]) => sql.includes("FROM unnest("));
}

describe("validateBatch — future-dated rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags a future-dated row as an error while validating a past-dated one", async () => {
    const pending = [
      {
        id: 1,
        row_index: 0,
        tx_date: new Date("2999-01-01T00:00:00Z"),
        type_raw: "buy",
        units: null,
        price_per_unit: null,
        amount: 100,
        raw_data: "future",
      },
      {
        id: 2,
        row_index: 1,
        tx_date: new Date("2020-01-01T00:00:00Z"),
        type_raw: "buy",
        units: null,
        price_per_unit: null,
        amount: 100,
        raw_data: "past",
      },
    ];
    wireQuery(pending);

    const result = await validateBatch({ batchId: 7 });

    expect(result).toMatchObject({ validated: 1, errors: 1, duplicates: 0 });

    const update = findUnnestUpdate();
    expect(update).toBeTruthy();
    const [, [ids, statuses, , , , errorMessages]] = update;
    const idx1 = ids.indexOf(1);
    const idx2 = ids.indexOf(2);
    expect(statuses[idx1]).toBe("error");
    expect(errorMessages[idx1]).toBe("transaction date is in the future");
    expect(statuses[idx2]).toBe("validated");
  });

  it("keeps repeated hashes validated for occurrence-aware commit deduplication", async () => {
    const repeated = {
      tx_date: new Date("2020-01-01T00:00:00Z"),
      type_raw: "buy",
      symbol_raw: "ACME",
      name_raw: "Acme",
      units: 2,
      price_per_unit: 50,
      amount: 100,
      raw_data: "byte-identical-fill",
    };
    wireQuery([
      { ...repeated, id: 1, row_index: 0 },
      { ...repeated, id: 2, row_index: 1 },
    ]);

    const result = await validateBatch({ batchId: 7 });

    expect(result).toEqual({ validated: 2, errors: 0, duplicates: 0 });
    const [, [, statuses, , , hashes]] = findUnnestUpdate();
    expect(statuses).toEqual(["validated", "validated"]);
    expect(hashes[0]).toBe(hashes[1]);
  });
});

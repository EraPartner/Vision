/** Capture a complete synthetic Kinesis statement exactly as staging does; no account data. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKinesisTransactionHistory } from "../../src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.js";
import { captureKinesisSourceContext } from "../../src/services/portfolioKinesisAdoptionScope.js";

export const KINESIS_COLUMNS = [
  "DateTime",
  "HIN",
  "Currency_Code",
  "Transaction_Type",
  "Transaction_ID",
  "Order_ID",
  "Currency_Pair",
  "Amount",
  "Trade_Price",
  "Total",
  "Fee",
  "Fee_Currency",
  "Trade_Value",
  "Trade_Value_Currency",
  "Starting_Balance",
  "Starting_Balance_Currency",
  "Closing_Balance",
  "Closing_Balance_Currency",
];

/**
 * Parse literal statement lines and return the batch configuration that the
 * stage pipeline records (`source_columns` and `kinesis_source_context`).
 * @param {string[]} lines literal CSV records without the header
 * @param {{ yield_basis_policy?: string }} [options]
 */
export async function capturedKinesisStatement(
  lines,
  { yield_basis_policy = "zero" } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "vision-kinesis-"));
  try {
    const path = join(dir, "statement.csv");
    await writeFile(
      path,
      `${[KINESIS_COLUMNS.join(","), ...lines].join("\n")}\n`,
    );
    const parsed = await parseKinesisTransactionHistory(path, {
      yield_basis_policy,
    });
    return {
      parsed,
      config: {
        source_columns: parsed.sourceColumns,
        kinesis_source_context: await captureKinesisSourceContext(path, parsed),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

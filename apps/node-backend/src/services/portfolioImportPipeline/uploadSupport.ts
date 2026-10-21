import { fileURLToPath } from "node:url";
import { detectPortfolioFileFormat } from "../../lib/portfolioUpload.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import { parseIbkrFundingHistory } from "./ibkrFundingHistoryAdapter.ts";
import { parseSaxoTransactionHistory } from "./saxoTransactionHistoryAdapter.ts";

/**
 * Reject unsupported workbook formats before a batch or staging rows are made.
 * Run the format adapter read-only so missing or ambiguous details cannot make
 * a batch first.
 */
export async function assertPortfolioUploadSupported(
  filePath: string | URL,
  config: { format?: string },
) {
  if (config.format === "ibkr_funding_history") {
    await parseIbkrFundingHistory(
      filePath instanceof URL ? fileURLToPath(filePath) : filePath,
    );
    return;
  }
  const format = await detectPortfolioFileFormat(filePath);
  if (format === "csv") return;
  if (format !== "xlsx" || config.format !== "saxo_transaction_history")
    throw new ValidationError(
      "Portfolio workbooks require supported Saxo XLSX transaction history or IBKR XLS/XLSX funding history",
    );
  await parseSaxoTransactionHistory(
    filePath instanceof URL ? fileURLToPath(filePath) : filePath,
  );
}

import { fileURLToPath } from "node:url";
import { detectPortfolioFileFormat } from "../../lib/portfolioUpload.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
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
  const format = await detectPortfolioFileFormat(filePath);
  if (format === "csv") return;
  if (format !== "xlsx" || config.format !== "saxo_transaction_history")
    throw new ValidationError(
      "Portfolio workbooks require supported Saxo XLSX transaction history",
    );
  await parseSaxoTransactionHistory(
    filePath instanceof URL ? fileURLToPath(filePath) : filePath,
  );
}

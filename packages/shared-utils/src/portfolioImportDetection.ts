/** Maintained statement detection shared by web and native backend probe. */
export type PortfolioImportSource =
  "ibkr" | "kinesis" | "nexo" | "nexo_pro" | "saxo";

export interface DetectedPortfolioImport {
  source: PortfolioImportSource;
  sourceAccountIdentities: string[];
}

const HEADER_SIGNATURES: Record<
  Exclude<PortfolioImportSource, "ibkr">,
  string[]
> = {
  kinesis: [
    "DateTime",
    "HIN",
    "Currency_Code",
    "Transaction_Type",
    "Transaction_ID",
    "Order_ID",
    "Starting_Balance",
    "Closing_Balance",
  ],
  nexo: [
    "Transaction",
    "Type",
    "Input Currency",
    "Input Amount",
    "Output Currency",
    "Output Amount",
    "USD Equivalent",
    "Date / Time (UTC)",
  ],
  nexo_pro: [
    "id",
    "timestamp",
    "pair",
    "side",
    "type",
    "executedPrice",
    "filledAmount",
    "tradingFee",
    "feeCurrency",
    "status",
    "orderId",
  ],
  saxo: [
    "Transactiedatum",
    "Rekening-ID",
    "Transactie-ID",
    "Transactietype",
    "Acties",
    "Boekingsbedrag",
    "Instrumentsymbool",
    "Instrumentvaluta",
  ],
};

function cell(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\u00a0", " ")
    .trim();
}

export function detectPortfolioImportRecords(
  records: readonly (readonly unknown[])[],
): DetectedPortfolioImport | undefined {
  const matches: DetectedPortfolioImport[] = [];
  for (const [index, row] of records.entries()) {
    const header = row.map(cell);
    if (
      header[0] === "Transaction History" &&
      header[1] === "Header" &&
      ["Date", "Symbol", "Transaction Type", "Quantity"].every((field) =>
        header.includes(field),
      )
    ) {
      matches.push({ source: "ibkr", sourceAccountIdentities: [] });
    }
    for (const source of ["kinesis", "nexo", "nexo_pro", "saxo"] as const) {
      if (!HEADER_SIGNATURES[source].every((field) => header.includes(field)))
        continue;
      const accountIndex = header.indexOf(
        source === "kinesis" ? "HIN" : source === "saxo" ? "Rekening-ID" : "",
      );
      const identities =
        accountIndex < 0
          ? []
          : [
              ...new Set(
                records
                  .slice(index + 1)
                  .map((record) => cell(record[accountIndex]))
                  .filter(Boolean),
              ),
            ];
      matches.push({ source, sourceAccountIdentities: identities });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

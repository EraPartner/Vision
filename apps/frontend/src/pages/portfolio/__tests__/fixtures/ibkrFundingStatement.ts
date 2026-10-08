import * as XLSX from "xlsx";

export function ibkrFundingStatement(format: "biff8" | "xlsx" = "biff8") {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
            [
                "Request Date",
                "Reference Number",
                "Method",
                "Account ID",
                "Account Title",
                "Delivering Institution",
                "From Account Number",
                "Routing Number",
                "Date Received",
                "Date Available for Trading",
                "Date Available for Withdrawal - Original Bank",
                "Date Available for Withdrawal - Other Bank",
                "Amount",
                "Status",
            ],
            [
                "2025-01-02",
                "SYNTHETIC-REFERENCE",
                "Wire",
                "SYNTHETIC-ACCOUNT",
                "Synthetic Owner",
                "Synthetic Bank",
                "SYNTHETIC-SOURCE",
                "",
                "2025-01-02",
                "2025-01-02",
                "2025-01-05",
                "2025-02-01",
                "USD 123.45",
                "Available",
            ],
        ]),
        "Deposit",
    );
    const bytes = XLSX.write(workbook, {
        type: "array",
        bookType: format,
    }) as ArrayBuffer;
    return new File(
        [bytes],
        format === "biff8" ? "funding.xls" : "funding.xlsx",
    );
}

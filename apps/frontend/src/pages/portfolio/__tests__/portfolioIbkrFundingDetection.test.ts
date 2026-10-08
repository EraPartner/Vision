// @vitest-environment jsdom
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import type { Account } from "@/types/api";
import {
    detectPortfolioImportFile,
    resolveDetectedPortfolioAccount,
} from "../portfolioImportDetection";

const headers = [
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
];
const record = () => [
    "2025-01-02",
    "SYNTHETIC-REF-1",
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
];

function file(
    rows = [record()],
    format: "biff8" | "xlsx" = "biff8",
    mutate?: (workbook: XLSX.WorkBook) => void,
) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([headers, ...rows]),
        "Deposit",
    );
    mutate?.(workbook);
    const bytes = XLSX.write(workbook, {
        type: "array",
        bookType: format,
    }) as ArrayBuffer;
    return new File(
        [bytes],
        format === "biff8" ? "transactions.xls" : "transactions.xlsx",
    );
}

describe("IBKR native funding workbook detection", () => {
    it.each(["biff8", "xlsx"] as const)(
        "detects %s by its exact source layout and resolves the broker",
        async (format) => {
            const detected = await detectPortfolioImportFile(
                file(undefined, format),
            );
            expect(detected).toEqual({
                source: "ibkr",
                sourceAccountIdentities: ["SYNTHETIC-ACCOUNT"],
                presetKey: "ibkr_funding_history",
            });
            const account = {
                id: 1,
                institution: "IBKR",
                name: "Investments",
                type: "brokerage",
                is_active: true,
            } as Account;
            expect(resolveDetectedPortfolioAccount(detected!, [account])).toBe(
                1,
            );
            expect(
                resolveDetectedPortfolioAccount(detected!, [
                    account,
                    { ...account, id: 2 },
                ]),
            ).toBeUndefined();
        },
    );

    it("detects both Deposit and Withdrawal sheets as one source", async () => {
        const statement = file(undefined, "xlsx", (workbook) => {
            XLSX.utils.book_append_sheet(
                workbook,
                XLSX.utils.aoa_to_sheet([
                    [
                        "Request Date",
                        "Reference Number",
                        "Method",
                        "Account ID",
                        "Account Title",
                        "Receiving Institution",
                        "Date Processed",
                        "Amount",
                        "Status",
                    ],
                    [
                        "2025-01-05",
                        "SYNTHETIC-REF-2",
                        "Wire",
                        "SYNTHETIC-ACCOUNT",
                        "Synthetic Owner",
                        "",
                        "2025-01-06",
                        "EUR 10.00",
                        "Sent",
                    ],
                ]),
                "Withdrawal",
            );
        });
        expect((await detectPortfolioImportFile(statement))?.presetKey).toBe(
            "ibkr_funding_history",
        );
    });

    it("does not select unproved status, amount, date or source identities", async () => {
        for (const [index, value] of [
            [13, "Pending"],
            [12, "123.45"],
            [12, "USD 0.00"],
            [12, "USD 1,23.45"],
            [12, "ZZZ 123.45"],
            [0, "2025-02-30"],
            [8, "2024-12-31"],
            [1, ""],
            [3, ""],
            [2, "Unknown"],
        ] as const) {
            const row = record();
            row[index] = value;
            expect(
                await detectPortfolioImportFile(file([row])),
            ).toBeUndefined();
        }
        expect(
            await detectPortfolioImportFile(file([record(), record()])),
        ).toBeUndefined();
        const other = record();
        other[1] = "SYNTHETIC-REF-2";
        other[3] = "SYNTHETIC-OTHER";
        expect(
            await detectPortfolioImportFile(file([record(), other])),
        ).toBeUndefined();
    });

    it("does not select altered workbook layouts, formulas or numeric account identifiers", async () => {
        for (const mutate of [
            (workbook: XLSX.WorkBook) => {
                workbook.Sheets.Deposit.N1.v = "Amount";
            },
            (workbook: XLSX.WorkBook) => {
                workbook.Sheets.Deposit.M2.f = '"USD 123.45"';
            },
            (workbook: XLSX.WorkBook) => {
                workbook.Sheets.Deposit.D2 = { t: "n", v: 123456 };
            },
            (workbook: XLSX.WorkBook) => {
                XLSX.utils.book_append_sheet(
                    workbook,
                    XLSX.utils.aoa_to_sheet([["Extra"]]),
                    "Other",
                );
            },
        ])
            expect(
                await detectPortfolioImportFile(
                    file(undefined, "xlsx", mutate),
                ),
            ).toBeUndefined();
        expect(
            await detectPortfolioImportFile(
                new File(["<html>fake export</html>"], "transactions.xls"),
            ),
        ).toBeUndefined();
    });
});

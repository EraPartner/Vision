// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/types/api";
import workbookFixtures from "./fixtures/portfolioDetectionWorkbooks";
import {
    detectPortfolioImportFile,
    detectPortfolioImportRecords,
    resolveDetectedPortfolioAccount,
} from "../portfolioImportDetection";

const nexoHeaders = [
    "Transaction",
    "Type",
    "Input Currency",
    "Input Amount",
    "Output Currency",
    "Output Amount",
    "USD Equivalent",
    "Date / Time (UTC)",
];
const kinesisHeaders = [
    "DateTime",
    "HIN",
    "Currency_Code",
    "Transaction_Type",
    "Transaction_ID",
    "Order_ID",
    "Starting_Balance",
    "Closing_Balance",
];
const saxoHeaders = [
    "Transactiedatum",
    "Rekening-ID",
    "Transactie-ID",
    "Transactietype",
    "Acties",
    "Boekingsbedrag",
    "Instrumentsymbool",
    "Instrumentvaluta",
];

const nativeHeaders = [
    "Date",
    "Type",
    "Symbol",
    "Units",
    "Amount",
    "Currency",
    "Source_ID",
    "Source_Account",
    "Note",
    "Receipt_JSON",
];
const nativeRow = (identity: string, type = "gift") => [
    "2025-01-01",
    type,
    "KAU",
    "1",
    "2",
    "USD",
    `synthetic-${identity}`,
    identity,
    "",
    "{}",
];

function account(
    id: number,
    institution: string,
    name: string,
    overrides: Partial<Account> = {},
): Account {
    return {
        id,
        institution,
        name,
        type: "brokerage",
        is_active: true,
        ...overrides,
    } as Account;
}

describe("automatic portfolio statement detection", () => {
    it("detects the exact native receipt schema and retains multiple physical identities for one logical wallet", () => {
        const detected = detectPortfolioImportRecords([
            nativeHeaders,
            nativeRow("SYNTHETIC-SENDER"),
            nativeRow("SYNTHETIC-WALLET", "asset_fee"),
        ]);
        expect(detected).toEqual({
            source: "native_receipts",
            sourceAccountIdentities: ["SYNTHETIC-SENDER", "SYNTHETIC-WALLET"],
        });
        expect(
            resolveDetectedPortfolioAccount(detected!, [
                account(1, "Kinesis", "Kinesis"),
                account(2, "Wallet", "CoolWallet"),
            ]),
        ).toBe(2);
        expect(
            resolveDetectedPortfolioAccount(detected!, [
                account(1, "Wallet", "SYNTHETIC-SENDER"),
            ]),
        ).toBeUndefined();
    });

    it("requires explicit native wallet routing without one exact active logical alias", () => {
        const detected = {
            source: "native_receipts" as const,
            sourceAccountIdentities: ["SYNTHETIC-ONE", "SYNTHETIC-TWO"],
        };
        expect(
            resolveDetectedPortfolioAccount(detected, [
                account(1, "CoolWallet", "Other wallet"),
            ]),
        ).toBeUndefined();
        expect(
            resolveDetectedPortfolioAccount(detected, [
                account(1, "Wallet", "CoolWallet", { is_active: false }),
            ]),
        ).toBeUndefined();
        expect(
            resolveDetectedPortfolioAccount(detected, [
                account(1, "Wallet", "CoolWallet"),
                account(2, "Wallet", "CoolWallet"),
            ]),
        ).toBeUndefined();
        expect(
            resolveDetectedPortfolioAccount(detected, [
                account(1, "Wallet", "Other", { display_name: " CoolWallet " }),
            ]),
        ).toBe(1);
    });

    it("rejects ordinary generic files, altered native headers and unsupported native event types", () => {
        for (const records of [
            [
                nativeHeaders.map((field) => ` ${field} `),
                nativeRow("SYNTHETIC"),
            ],
            [
                ["Date", "Type", "Symbol", "Units", "Amount", "Currency"],
                nativeRow("SYNTHETIC"),
            ],
            [
                [...nativeHeaders, "Extra"],
                [...nativeRow("SYNTHETIC"), "extra"],
            ],
            [[...nativeHeaders.slice(0, -1), "Note"], nativeRow("SYNTHETIC")],
            [nativeHeaders, nativeRow("SYNTHETIC", "buy")],
            [nativeHeaders],
            [nativeHeaders, [...nativeRow("SYNTHETIC").slice(0, -1), ""]],
        ])
            expect(detectPortfolioImportRecords(records)).toBeUndefined();
        const reordered = [...nativeHeaders].reverse();
        const row = nativeRow("SYNTHETIC");
        expect(
            detectPortfolioImportRecords([
                reordered,
                reordered.map((field) => row[nativeHeaders.indexOf(field)]),
            ])?.source,
        ).toBe("native_receipts");
    });
    it("detects Nexo Pro separately and resolves its unique Nexo account", () => {
        const detected = detectPortfolioImportRecords([
            [
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
        ]);
        expect(detected).toEqual({
            source: "nexo_pro",
            sourceAccountIdentities: [],
        });
        expect(
            resolveDetectedPortfolioAccount(detected!, [
                account(1, "Nexo", "Nexo"),
            ]),
        ).toBe(1);
        expect(
            resolveDetectedPortfolioAccount(detected!, [
                account(1, "Nexo", "One"),
                account(2, "Nexo", "Two"),
            ]),
        ).toBeUndefined();
    });
    it("detects a real Saxo XLSX and its exported account identity", async () => {
        const bytes = Uint8Array.from(atob(workbookFixtures.saxo), (value) =>
            value.charCodeAt(0),
        );
        await expect(
            detectPortfolioImportFile(new File([bytes], "history.xlsx")),
        ).resolves.toEqual({
            source: "saxo",
            sourceAccountIdentities: ["SYNTHETIC-ACCOUNT"],
        });
    });

    it("leaves a workbook with an unsupported Nexo signature unselected", async () => {
        const bytes = Uint8Array.from(
            atob(workbookFixtures.unsupportedNexo),
            (value) => value.charCodeAt(0),
        );
        await expect(
            detectPortfolioImportFile(new File([bytes], "history.xlsx")),
        ).resolves.toBeUndefined();
    });

    it("reads a browser File without requiring File.arrayBuffer", async () => {
        const file = new File([nexoHeaders.join(",")], "statement.csv");
        Object.defineProperty(file, "arrayBuffer", { value: undefined });
        await expect(detectPortfolioImportFile(file)).resolves.toEqual({
            source: "nexo",
            sourceAccountIdentities: [],
        });
    });

    it("inspects account identities after the former 262144-byte prefix", async () => {
        const text = [
            kinesisHeaders.join(","),
            `2026-01-01,HIN-ONE,KAU,buy,1,${"X".repeat(270_000)},0,1`,
            "2026-01-02,HIN-TWO,KAU,buy,2,2,0,1",
        ].join("\n");
        const detected = await detectPortfolioImportFile(
            new File([text], "statement.csv"),
        );
        expect(detected).toEqual({
            source: "kinesis",
            sourceAccountIdentities: ["HIN-ONE", "HIN-TWO"],
        });
        expect(
            resolveDetectedPortfolioAccount(detected!, [
                account(1, "Kinesis", "HIN-ONE"),
            ]),
        ).toBeUndefined();
    });

    it("rejects malformed quotes instead of repairing a partial statement", async () => {
        await expect(
            detectPortfolioImportFile(
                new File(
                    [nexoHeaders.join(","), '\n"unfinished'],
                    "statement.csv",
                ),
            ),
        ).rejects.toMatchObject({ code: "CSV_QUOTE_NOT_CLOSED" });
    });

    it("rejects files above the upload limit before reading their contents", async () => {
        const file = new File(["small fixture"], "oversize.csv");
        Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });
        const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
        try {
            await expect(detectPortfolioImportFile(file)).rejects.toThrow(
                "upload limit",
            );
            expect(read).not.toHaveBeenCalled();
        } finally {
            read.mockRestore();
        }
    });
    it("detects IBKR after metadata without using its filename", () => {
        expect(
            detectPortfolioImportRecords([
                ["Statement", "Header", "Field Name", "Field Value"],
                [
                    "Transaction History",
                    "Header",
                    "Date",
                    "Symbol",
                    "Transaction Type",
                    "Quantity",
                ],
            ]),
        ).toEqual({ source: "ibkr", sourceAccountIdentities: [] });
    });

    it.each([
        ["nexo", nexoHeaders],
        ["kinesis", kinesisHeaders],
        ["saxo", saxoHeaders],
    ] as const)("detects the %s header signature", (source, headers) => {
        expect(detectPortfolioImportRecords([headers])?.source).toBe(source);
    });

    it("normalizes Saxo non-breaking spaces and preserves exact source account identity", () => {
        const headers = saxoHeaders.map((header) => ` ${header} `);
        headers.push("Bk\u00a0Record\u00a0Id");
        expect(
            detectPortfolioImportRecords([
                headers,
                ["2026-01-01", "SYNTHETIC-ACCOUNT"],
            ]),
        ).toEqual({
            source: "saxo",
            sourceAccountIdentities: ["SYNTHETIC-ACCOUNT"],
        });
    });

    it("leaves unknown, partial, and ambiguous schemas unselected", () => {
        expect(
            detectPortfolioImportRecords([["Date", "Amount"]]),
        ).toBeUndefined();
        expect(
            detectPortfolioImportRecords([nexoHeaders.slice(0, -1)]),
        ).toBeUndefined();
        expect(
            detectPortfolioImportRecords([nexoHeaders, saxoHeaders]),
        ).toBeUndefined();
    });

    it("uses an exact exported identity before a broker-name match", () => {
        const detected = {
            source: "kinesis",
            sourceAccountIdentities: ["HIN-SYNTHETIC"],
        } as const;
        expect(
            resolveDetectedPortfolioAccount(
                {
                    ...detected,
                    sourceAccountIdentities: [
                        ...detected.sourceAccountIdentities,
                    ],
                },
                [
                    account(1, "Kinesis", "Another account"),
                    account(2, "Kinesis", "HIN-SYNTHETIC"),
                ],
            ),
        ).toBe(2);
    });

    it("uses a unique active broker institution when the exported identifier differs", () => {
        expect(
            resolveDetectedPortfolioAccount(
                { source: "saxo", sourceAccountIdentities: ["SYNTHETIC-ID"] },
                [
                    account(1, "Saxo", "Main account"),
                    account(2, "Saxo", "Closed account", { is_active: false }),
                ],
            ),
        ).toBe(1);
    });

    it("does not guess between accounts or collapse a multi-account statement", () => {
        const accounts = [account(1, "Nexo", "One"), account(2, "Nexo", "Two")];
        expect(
            resolveDetectedPortfolioAccount(
                { source: "nexo", sourceAccountIdentities: [] },
                accounts,
            ),
        ).toBeUndefined();
        expect(
            resolveDetectedPortfolioAccount(
                { source: "saxo", sourceAccountIdentities: ["A", "B"] },
                [account(3, "Saxo", "A")],
            ),
        ).toBeUndefined();
        expect(
            resolveDetectedPortfolioAccount(
                { source: "saxo", sourceAccountIdentities: [] },
                [account(4, "Saxo", "Bank account", { type: "checking" })],
            ),
        ).toBeUndefined();
    });
});

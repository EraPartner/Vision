import { parse } from "csv-parse/browser/esm/sync";
import type { Account } from "@/types/api";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";

export type PortfolioImportSource =
    "ibkr" | "kinesis" | "nexo" | "nexo_pro" | "saxo";

export interface DetectedPortfolioImport {
    source: PortfolioImportSource;
    sourceAccountIdentities: string[];
}

// Match the upload endpoint's limit before reading a complete statement.
const MAX_STATEMENT_BYTES = 50 * 1024 * 1024;

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
    for (let index = 0; index < records.length; index++) {
        const header = records[index].map(cell);
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
            if (
                !HEADER_SIGNATURES[source].every((field) =>
                    header.includes(field),
                )
            )
                continue;
            const accountIndex = header.indexOf(
                source === "kinesis"
                    ? "HIN"
                    : source === "saxo"
                      ? "Rekening-ID"
                      : "",
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

export function resolveDetectedPortfolioAccount(
    detected: DetectedPortfolioImport,
    accounts: readonly Account[],
): number | undefined {
    const eligible = activeBrokerAccounts(accounts);
    const sourceIds = new Set(
        detected.sourceAccountIdentities.map((value) => value.toLowerCase()),
    );
    // Multiple source accounts cannot be assigned to a single destination by guesswork.
    if (sourceIds.size > 1) return undefined;
    const exact = eligible.filter((account) =>
        [account.name, account.display_name].some(
            (value) => value && sourceIds.has(value.trim().toLowerCase()),
        ),
    );
    if (exact.length) return exact.length === 1 ? exact[0].id : undefined;
    const aliases: Record<PortfolioImportSource, string[]> = {
        ibkr: ["ibkr", "interactive brokers"],
        kinesis: ["kinesis", "kinesis money"],
        nexo: ["nexo"],
        nexo_pro: ["nexo pro", "nexo"],
        saxo: ["saxo", "saxo bank"],
    };
    const byBroker = eligible.filter((account) =>
        [account.institution, account.name].some(
            (value) =>
                value &&
                aliases[detected.source].includes(value.trim().toLowerCase()),
        ),
    );
    return byBroker.length === 1 ? byBroker[0].id : undefined;
}

export async function detectPortfolioImportFile(
    file: File,
): Promise<DetectedPortfolioImport | undefined> {
    if (file.size > MAX_STATEMENT_BYTES)
        throw new Error("Portfolio statement exceeds the upload limit");
    const bytes = await readFileBytes(file);
    if (file.name.toLowerCase().endsWith(".xlsx")) {
        const { default: readExcelFile } =
            await import("read-excel-file/browser");
        const sheets = await readExcelFile(bytes, {
            parseNumber: (value) => value,
        });
        const matches = sheets
            .map((sheet) => detectPortfolioImportRecords(sheet.data))
            .filter((match) => match !== undefined);
        return matches.length === 1 && matches[0].source === "saxo"
            ? matches[0]
            : undefined;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
    }
    const options = {
        bom: true,
        relax_column_count: true,
        skip_empty_lines: true,
    };
    // Account identity must include every row; a prefix could conceal a second
    // source account and assign its transactions to the wrong broker account.
    const records = parse(text, options) as string[][];
    return detectPortfolioImportRecords(records);
}

async function readFileBytes(file: File): Promise<ArrayBuffer> {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () =>
            reject(reader.error ?? new Error("File read failed"));
        reader.onabort = () => reject(new Error("File read cancelled"));
        reader.readAsArrayBuffer(file);
    });
}

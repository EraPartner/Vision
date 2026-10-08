import { parse } from "csv-parse/browser/esm/sync";
import type { Account } from "@/types/api";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";

export type PortfolioImportSource =
    "ibkr" | "kinesis" | "nexo" | "nexo_pro" | "saxo" | "native_receipts";

export interface DetectedPortfolioImport {
    source: PortfolioImportSource;
    sourceAccountIdentities: string[];
    presetKey?: "ibkr_funding_history";
}

// Match the upload endpoint's limit before reading a complete statement.
const MAX_STATEMENT_BYTES = 50 * 1024 * 1024;
const MAX_WORKBOOK_CELLS = 500000;
const FUNDING_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

const IBKR_FUNDING_HEADERS = {
    Deposit: [
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
    Withdrawal: [
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
};

const HEADER_SIGNATURES: Record<
    Exclude<PortfolioImportSource, "ibkr" | "native_receipts">,
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

const NATIVE_RECEIPT_COLUMNS = [
    "Date",
    "Type",
    "Symbol",
    "Units",
    "Amount",
    "Currency",
    "Source_ID",
    "Source_Account",
    "Receipt_JSON",
    "Note",
];

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
            index === 0 &&
            header.length === NATIVE_RECEIPT_COLUMNS.length &&
            records[index].every((value, field) => value === header[field]) &&
            new Set(header).size === header.length &&
            NATIVE_RECEIPT_COLUMNS.every((field) => header.includes(field)) &&
            records.length > 1 &&
            records
                .slice(1)
                .every(
                    (record) =>
                        record.length === header.length &&
                        [
                            "gift",
                            "asset_fee",
                            "asset_transfer_witness",
                        ].includes(cell(record[header.indexOf("Type")])) &&
                        ["Source_ID", "Source_Account", "Receipt_JSON"].every(
                            (field) => cell(record[header.indexOf(field)]),
                        ),
                )
        ) {
            matches.push({
                source: "native_receipts",
                sourceAccountIdentities: [
                    ...new Set(
                        records
                            .slice(1)
                            .map((record) =>
                                cell(record[header.indexOf("Source_Account")]),
                            ),
                    ),
                ],
            });
        }
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
    if (detected.source === "native_receipts") {
        // Native receipt addresses can belong to several wallets in one logical
        // account. They are evidence, not broker account aliases.
        const wallets = eligible.filter((account) =>
            [account.name, account.display_name].some(
                (value) => value?.trim().toLowerCase() === "coolwallet",
            ),
        );
        return wallets.length === 1 ? wallets[0].id : undefined;
    }
    const source = detected.source;
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
    const aliases: Record<
        Exclude<PortfolioImportSource, "native_receipts">,
        string[]
    > = {
        ibkr: ["ibkr", "interactive brokers"],
        kinesis: ["kinesis", "kinesis money"],
        nexo: ["nexo"],
        nexo_pro: ["nexo pro", "nexo"],
        saxo: ["saxo", "saxo bank"],
    };
    const byBroker = eligible.filter((account) =>
        [account.institution, account.name].some(
            (value) =>
                value && aliases[source].includes(value.trim().toLowerCase()),
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
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith(".xls") || fileName.endsWith(".xlsx")) {
        const signature = new Uint8Array(
            bytes,
            0,
            Math.min(8, bytes.byteLength),
        );
        const xls =
            signature.length === 8 &&
            [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
                (value, index) => value === signature[index],
            );
        const xlsx =
            signature.length >= 4 &&
            [0x50, 0x4b, 0x03, 0x04].every(
                (value, index) => value === signature[index],
            );
        if (!xls && !xlsx) return undefined;
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(bytes, {
            type: "array",
            cellDates: false,
            cellFormula: true,
            cellText: false,
            bookVBA: true,
            WTF: true,
        });
        const funding = detectIbkrFundingWorkbook(workbook, XLSX.utils);
        if (funding) return funding;
        if (
            xls ||
            workbook.SheetNames.some((name) =>
                Object.hasOwn(IBKR_FUNDING_HEADERS, name),
            )
        )
            return undefined;
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

function detectIbkrFundingWorkbook(
    workbook: import("xlsx").WorkBook,
    utils: typeof import("xlsx").utils,
): DetectedPortfolioImport | undefined {
    if (
        workbook.vbaraw ||
        !workbook.SheetNames.length ||
        workbook.SheetNames.length > 2 ||
        new Set(workbook.SheetNames).size !== workbook.SheetNames.length ||
        workbook.Workbook?.Sheets?.some((sheet) => sheet.Hidden)
    )
        return undefined;
    const identities = new Set<string>();
    const references = new Set<string>();
    let cellCount = 0;
    for (const sheetName of workbook.SheetNames) {
        if (!Object.hasOwn(IBKR_FUNDING_HEADERS, sheetName)) return undefined;
        const sheet = workbook.Sheets[sheetName];
        if (
            !sheet["!ref"] ||
            sheet["!merges"]?.length ||
            (sheet["!type"] && sheet["!type"] !== "sheet")
        )
            return undefined;
        const range = utils.decode_range(sheet["!ref"]);
        cellCount += (range.e.r + 1) * (range.e.c + 1);
        if (
            range.s.r !== 0 ||
            range.s.c !== 0 ||
            range.e.c > 99 ||
            cellCount > MAX_WORKBOOK_CELLS
        )
            return undefined;
        for (const [coordinate, value] of Object.entries(sheet)) {
            if (
                !coordinate.startsWith("!") &&
                (value.f != null ||
                    value.F != null ||
                    !["s", "z"].includes(value.t))
            )
                return undefined;
        }
        const records = utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            raw: true,
            defval: null,
        });
        const headers =
            IBKR_FUNDING_HEADERS[
                sheetName as keyof typeof IBKR_FUNDING_HEADERS
            ];
        if (JSON.stringify(records[0]) !== JSON.stringify(headers))
            return undefined;
        for (const record of records.slice(1)) {
            if (record.every((value) => value == null || value === ""))
                continue;
            if (
                record.length !== headers.length ||
                record.some(
                    (value) => value != null && typeof value !== "string",
                )
            )
                return undefined;
            const field = (key: string) => cell(record[headers.indexOf(key)]);
            const original = (key: string) => record[headers.indexOf(key)];
            if (
                [
                    "Request Date",
                    "Reference Number",
                    "Method",
                    "Account ID",
                    "Account Title",
                    "Amount",
                    "Status",
                ].some((key) => !field(key) || field(key) !== original(key))
            )
                return undefined;
            const requested = field("Request Date");
            const completed = field(
                sheetName === "Deposit" ? "Date Received" : "Date Processed",
            );
            if (
                ![requested, completed].every(validIsoDate) ||
                completed < requested ||
                field("Method") !== "Wire" ||
                field("Status") !==
                    (sheetName === "Deposit" ? "Available" : "Sent") ||
                !/^[A-Z][A-Z0-9-]{2,49}$/.test(field("Account ID")) ||
                !/^[A-Za-z0-9-]{1,100}$/.test(field("Reference Number")) ||
                !/^[A-Z]{3} (?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}$/.test(
                    field("Amount"),
                ) ||
                !FUNDING_CURRENCIES.has(field("Amount").slice(0, 3)) ||
                Number(field("Amount").slice(4).replaceAll(",", "")) <= 0
            )
                return undefined;
            const reference = `${field("Account ID")}\u0000${field("Reference Number")}`;
            if (references.has(reference)) return undefined;
            references.add(reference);
            identities.add(field("Account ID"));
        }
    }
    return references.size && identities.size === 1
        ? {
              source: "ibkr",
              sourceAccountIdentities: [...identities],
              presetKey: "ibkr_funding_history",
          }
        : undefined;
}

function validIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return (
        Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
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

import { parse } from "csv-parse/browser/esm/sync";
import type { Account } from "@/types/api";
import { activeBrokerAccounts } from "@/features/portfolio/manualTradeBroker";

import { detectPortfolioImportRecords } from "@vision/shared-utils/portfolio-import-detection";
import type {
    DetectedPortfolioImport,
    PortfolioImportSource,
} from "@vision/shared-utils/portfolio-import-detection";
import type { AccountId } from "@vision/types/brands";
export { detectPortfolioImportRecords } from "@vision/shared-utils/portfolio-import-detection";
export type { DetectedPortfolioImport } from "@vision/shared-utils/portfolio-import-detection";
const MAX_STATEMENT_BYTES = 50 * 1024 * 1024;

export function resolveDetectedPortfolioAccount(
    detected: DetectedPortfolioImport,
    accounts: readonly Account[],
): AccountId | undefined {
    const eligible = activeBrokerAccounts(accounts);
    const source = detected.source;
    const sourceIds = new Set(
        detected.sourceAccountIdentities.map((value) => value.toLowerCase()),
    );
    // Multiple source accounts cannot be assigned to a single destination by guesswork.
    if (sourceIds.size > 1) return undefined;
    const exact = eligible.filter((account) =>
        [account.name, account.display_name].some(
            (value) => !!value && sourceIds.has(value.trim().toLowerCase()),
        ),
    );
    if (exact.length > 0) return exact.length === 1 ? exact[0]?.id : undefined;
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
                !!value && aliases[source].includes(value.trim().toLowerCase()),
        ),
    );
    return byBroker.length === 1 ? byBroker[0]?.id : undefined;
}

export async function detectPortfolioImportFile(
    file: File,
): Promise<DetectedPortfolioImport | undefined> {
    if (file.size > MAX_STATEMENT_BYTES)
        throw new Error("Portfolio statement exceeds the upload limit");
    const bytes = await readFileBytes(file);
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith(".xlsx")) {
        const signature = new Uint8Array(
            bytes,
            0,
            Math.min(4, bytes.byteLength),
        );
        const xlsx =
            signature.length === 4 &&
            [0x50, 0x4b, 0x03, 0x04].every(
                (value, index) => value === signature[index],
            );
        if (!xlsx) return undefined;
        const { default: readExcelFile } =
            await import("read-excel-file/browser");
        const sheets = await readExcelFile(bytes, {
            parseNumber: (value) => value,
        });
        const matches = sheets
            .map((sheet) => detectPortfolioImportRecords(sheet.data))
            .filter((match) => match !== undefined);
        const [match] = matches;
        return matches.length === 1 && match?.source === "saxo"
            ? match
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
    const records = parse(text, options);
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

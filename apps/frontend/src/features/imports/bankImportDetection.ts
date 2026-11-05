/**
 * Recognise which bank (or saved custom parser) wrote a statement, from the
 * head of the file, before anything is uploaded (ADR-268). Built-in formats
 * use the same signatures as the backend adapters; a saved parser fits when
 * every column it maps appears in the header row it would read.
 */
import { parse } from "csv-parse/browser/esm/sync";
import {
    decodePreviewBytes,
    parseCsvText,
} from "@vision/shared-utils/csv-preview";
import {
    BANK_DETECTION_PEEK_BYTES,
    detectBankImportFormats,
    matchesSavedBankParser,
    resolveBankImportDetection,
    type BankImportDetection,
} from "@vision/shared-utils/bank-import-detection";
import type { SavedParserConfig } from "@/lib/api/imports";

export type { BankImportDetection } from "@vision/shared-utils/bank-import-detection";

export async function detectBankImportFile(
    file: File,
    savedParsers: readonly SavedParserConfig[],
): Promise<BankImportDetection> {
    const slice = file.slice(0, BANK_DETECTION_PEEK_BYTES);
    const bytes = new Uint8Array(await readBytes(slice));
    const partial = slice.size < file.size;
    // UTF-8 with the importers' Latin-1 fallback, as the header preview reads it.
    const formats = detectBankImportFormats(
        decodePreviewBytes(bytes, "utf-8", partial),
    );
    const saved = savedParsers
        .filter((parser) => {
            try {
                const { headers } = parseCsvText(
                    decodePreviewBytes(bytes, parser.config.encoding, partial),
                    parser.config.separator,
                    parser.config.skipRows,
                    (input, options) => parse(input, options),
                );
                return matchesSavedBankParser(headers, parser.config);
            } catch {
                // A parser whose settings cannot read this file does not fit it.
                return false;
            }
        })
        .map((parser) => `saved:${parser.id}`);
    return resolveBankImportDetection(formats, saved);
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        // readAsArrayBuffer sets `result` to an ArrayBuffer; its type is a union with string.
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () =>
            reject(reader.error ?? new Error("File read failed"));
        reader.readAsArrayBuffer(blob);
    });
}

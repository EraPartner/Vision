// Browser File/crypto adapter; inference, export and bounds are shared with native APIs.
import { parse } from "csv-parse/browser/esm/sync";
import {
    parseScenarioCsvText,
    SCENARIO_CSV_MAX_BYTES,
} from "@vision/shared-utils/analysis/interchange";
export { analysisResultCsv } from "@vision/shared-utils/analysis/interchange";
export type {
    ScenarioAttachment,
    ScenarioColumnType,
    AnalysisScenarioModel,
} from "@vision/shared-utils/analysis/interchange";
export async function parseScenarioCsv(file: File) {
    if (file.size > SCENARIO_CSV_MAX_BYTES)
        throw new Error("Scenario CSV exceeds the 1 MB limit");
    return parseScenarioCsvText({
        text: await file.text(),
        fileName: file.name,
        size: file.size,
        importedAt: () => new Date().toISOString(),
        parse: (text, options) => parse(text, options) as string[][],
        sha256: async (text) => {
            const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(text),
            );
            return [...new Uint8Array(digest)]
                .map((value) => value.toString(16).padStart(2, "0"))
                .join("");
        },
    });
}

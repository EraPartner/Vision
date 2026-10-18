// Browser adapter retains the existing synchronous workbook entry points.
import { importAnalysisWorkbook as importSharedWorkbook } from "@vision/shared-utils/analysis/workbook";
export { analysisResultWorkbook } from "@vision/shared-utils/analysis/workbook";
export type {
    AnalysisWorkbookContext,
    ImportedAnalysisWorkbook,
} from "@vision/shared-utils/analysis/workbook";
export function importAnalysisWorkbook(bytes: Uint8Array) {
    return importSharedWorkbook(bytes, (source) =>
        new DOMParser().parseFromString(source, "application/xml"),
    );
}

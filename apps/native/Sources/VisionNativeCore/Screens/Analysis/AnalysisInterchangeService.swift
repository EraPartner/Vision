import Foundation

public protocol AnalysisInterchangeService: Sendable {
    func analysisImport(file: AnalysisInterchangeFile, format: String) async throws -> AnalysisAttachment
    func analysisExport(result: AnalysisResult, context: TaxValue, format: String) async throws -> AnalysisExportFile
}
/// Interchange runs in the app from the Swift port of the shared TypeScript (`AnalysisInterchange`):
/// there is no `/api/analysis/interchange/*` endpoint, so the client only provides the seam.
extension APIClient: AnalysisInterchangeService {
    public func analysisImport(file: AnalysisInterchangeFile, format: String) async throws -> AnalysisAttachment {
        try AnalysisInterchange.importAttachment(file: file, format: format)
    }
    public func analysisExport(result: AnalysisResult, context: TaxValue, format: String) async throws
        -> AnalysisExportFile
    { try AnalysisInterchange.exportFile(result: result, context: context, format: format) }
}

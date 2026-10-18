import Foundation

public protocol AnalysisInterchangeService: Sendable {
    func analysisImport(file: AnalysisInterchangeFile, format: String) async throws -> AnalysisAttachment
    func analysisExport(result: AnalysisResult, context: TaxValue, format: String) async throws -> AnalysisExportFile
}
extension APIClient: AnalysisInterchangeService {
    public func analysisImport(file: AnalysisInterchangeFile, format: String) async throws -> AnalysisAttachment {
        let request = try AnalysisInterchangeImportRequest(file: file, format: format)
        let response = try await send(request)
        guard response["format"] == .string(format),
            let attachment = response["attachment"], let count = response["formulaCells"]?.decimalValue,
            count >= 0, count <= 9_007_199_254_740_991, NSDecimalNumber(decimal: count).decimalValue == count,
            count == Decimal(NSDecimalNumber(decimal: count).intValue)
        else { throw AnalysisAttachment.invalid() }
        let value = try AnalysisAttachment(raw: attachment)
        guard format != "csv" || !value.rows.isEmpty else { throw AnalysisAttachment.invalid() }
        return value
    }
    public func analysisExport(result: AnalysisResult, context: TaxValue, format: String) async throws
        -> AnalysisExportFile
    {
        let request = try AnalysisInterchangeExportRequest(result: result.raw, context: context, format: format)
        let response = try await downloadResponse(request)
        let contentType =
            format == "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        let serverType = response.headers.first { $0.key.lowercased() == "content-type" }?.value
        guard serverType?.lowercased().hasPrefix(contentType) == true else {
            throw APIError.contract(.init(endpoint: request.path, issues: ["Unexpected analysis export content type"]))
        }
        let name = context["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "analysis"
        let filename: String
        if format == "csv" {
            filename =
                name.replacingOccurrences(of: #"[^a-zA-Z0-9_-]+"#, with: "-", options: .regularExpression).lowercased()
                + ".csv"
        } else {
            filename = name + ".xlsx"
        }
        return AnalysisExportFile(filename: filename, data: response.body, contentType: contentType)
    }
}
public struct AnalysisInterchangeImportRequest: APIOperation {
    public typealias Response = TaxValue
    public static let operationId = "importAnalysisInterchange"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/analysis/interchange/import"
    public let multipart: MultipartFormData
    public init(file: AnalysisInterchangeFile, format: String) throws {
        guard ["csv", "xlsx"].contains(format), file.data.count <= (format == "csv" ? 1_000_000 : 10_000_000) else {
            throw APIError.invalidRequest("Analysis file exceeds the import limit")
        }
        var form = MultipartFormData()
        form.append(
            file: "file", filename: file.name,
            contentType: format == "csv"
                ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: file.data)
        form.append("format", format)
        multipart = form
    }
    public var path: String { Self.pathTemplate }
    public var contentType: String { multipart.contentType }
    public func encodedBody() throws -> Data? { multipart.encoded() }
}
public struct AnalysisInterchangeExportRequest: APIOperation {
    public typealias Response = Data
    public static let operationId = "exportAnalysisInterchange"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/analysis/interchange/export"
    public let multipart: MultipartFormData
    public init(result: TaxValue, context: TaxValue, format: String) throws {
        guard ["csv", "xlsx"].contains(format) else { throw APIError.invalidRequest("Invalid analysis export format") }
        let body = try APIBody.encode(TaxValue.object(["result": result, "context": context]))
        guard body.count <= 64 * 1024 * 1024 else {
            throw APIError.invalidRequest("Analysis export exceeds the file limit")
        }
        var form = MultipartFormData()
        form.append(file: "file", filename: "analysis.json", contentType: "application/json", data: body)
        form.append("format", format)
        multipart = form
    }
    public var path: String { Self.pathTemplate }
    public var contentType: String { multipart.contentType }
    public func encodedBody() throws -> Data? { multipart.encoded() }
}

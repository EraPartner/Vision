import Foundation

public struct NativeReportRequest: Equatable, Sendable {
    public let type: NativeReportType
    public let body: TaxValue
    public init(type: NativeReportType, body: TaxValue) {
        self.type = type
        self.body = body
    }
}

/// `ReportDocument` (ADR-234): the print-ready report the reports endpoints answer with. The
/// backend renders no PDF; the client prints `html` itself.
public struct NativeReportDocument: Decodable, Equatable, Sendable {
    /// `vision-<type>-YYYY-MM-DD.pdf`, dated in the application time zone.
    public let filename: String
    /// A complete A4 document starting with `<!DOCTYPE html>`: inline styles, no scripts.
    public let html: String
    /// The Chromium print footer (page numbers) of the web renderer.
    public let footerTemplate: String

    public init(filename: String, html: String, footerTemplate: String) {
        self.filename = filename
        self.html = html
        self.footerTemplate = footerTemplate
    }
}

/// A printed report: the PDF bytes under the document's own file name.
public struct NativeReportFile: Equatable, Sendable {
    public let filename: String
    public let pdf: Data
    public init(filename: String, pdf: Data) {
        self.filename = filename
        self.pdf = pdf
    }
}

/// Turns a report document into PDF bytes (the web's `printToPdf`); the app target provides it.
public typealias NativeReportPDFRenderer = @MainActor @Sendable (NativeReportDocument) async throws -> Data

public protocol NativeReportService: Sendable {
    func generate(_ request: NativeReportRequest) async throws -> NativeReportFile
}

/// The reports endpoints answer a `ReportDocument` in the success envelope. One attempt, like the
/// web's `postReportDownload`; the document is then printed locally.
public struct NativeReportsAPIService: NativeReportService {
    private let client: APIClient
    private let render: NativeReportPDFRenderer
    public init(
        client: APIClient,
        render: @escaping NativeReportPDFRenderer = { _ in
            throw APIError.invalidRequest("Report printing is unavailable")
        }
    ) {
        self.client = client
        self.render = render
    }
    public func generate(_ request: NativeReportRequest) async throws -> NativeReportFile {
        let operation = NativeReportPDFOperation(request: request)
        let response = try await client.downloadResponse(operation, fallbackMessage: "Report download failed")
        let document = try APIClient.decode(
            response, as: NativeReportDocument.self, label: "POST \(operation.path)"
        ).get()
        return NativeReportFile(filename: document.filename, pdf: try await render(document))
    }
}

public struct NativeReportPDFOperation: APIOperation {
    public typealias Response = NativeReportDocument
    public static let operationId = "generateNativeReportPDF"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/reports/{type}"
    public let request: NativeReportRequest
    public init(request: NativeReportRequest) { self.request = request }
    public var path: String { "/api/reports/\(request.type.rawValue)" }
    public func encodedBody() throws -> Data? { try APIBody.encode(request.body) }
}

import Foundation

public struct NativeReportRequest: Equatable, Sendable {
    public let type: NativeReportType
    public let body: TaxValue
    public init(type: NativeReportType, body: TaxValue) {
        self.type = type
        self.body = body
    }
}

public protocol NativeReportService: Sendable {
    func generate(_ request: NativeReportRequest) async throws -> APIResponse
}

/// The existing reports endpoints return PDF bytes, rather than APIClient's JSON envelope.
public struct NativeReportsAPIService: NativeReportService {
    private let client: APIClient
    public init(client: APIClient) { self.client = client }
    public func generate(_ request: NativeReportRequest) async throws -> APIResponse {
        try await client.downloadResponse(
            NativeReportPDFOperation(request: request), fallbackMessage: "Report download failed")
    }
}

public struct NativeReportPDFOperation: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = "generateNativeReportPDF"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/reports/{type}"
    public let request: NativeReportRequest
    public init(request: NativeReportRequest) { self.request = request }
    public var path: String { "/api/reports/\(request.type.rawValue)" }
    public func encodedBody() throws -> Data? { try APIBody.encode(request.body) }
}

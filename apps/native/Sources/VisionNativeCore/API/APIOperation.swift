import Foundation

/// An HTTP method of an OpenAPI operation.
public enum HTTPMethod: String, Sendable, CaseIterable {
    case get = "GET"
    case put = "PUT"
    case post = "POST"
    case delete = "DELETE"
    case patch = "PATCH"
    case head = "HEAD"
    case options = "OPTIONS"

    /// The methods `apiRequest` in apps/frontend/src/lib/api/client.ts retries.
    public var isIdempotent: Bool {
        switch self {
        case .get, .put, .delete, .head, .options: return true
        case .post, .patch: return false
        }
    }
}

/// One OpenAPI operation. `scripts/native-openapi.ts` generates a conforming struct per
/// allow-listed operationId (`OpenAPIOperations`); `APIClient.send` performs it.
public protocol APIOperation: Sendable {
    /// The envelope's `data`, decoded; `JSONValue` when the spec leaves it untyped.
    associatedtype Response: Decodable & Sendable
    static var operationId: String { get }
    static var method: HTTPMethod { get }
    static var pathTemplate: String { get }
    /// The path with its parameters filled in and percent-encoded.
    var path: String { get }
    var queryItems: [URLQueryItem] { get }
    /// The JSON request body, or `nil` for none.
    func encodedBody() throws -> Data?
}

extension APIOperation {
    public var queryItems: [URLQueryItem] { [] }
    public func encodedBody() throws -> Data? { nil }
}

/// The response of an operation without a JSON body; it accepts any body.
public struct APIEmpty: Decodable, Equatable, Sendable {
    public init() {}

    public init(from decoder: any Decoder) throws {}
}

/// Query and path values in the form the backend's query parsers accept.
public enum APIQuery {
    public static func value(_ value: String) -> String { value }
    public static func value(_ value: Int) -> String { String(value) }
    public static func value(_ value: Bool) -> String { value ? "true" : "false" }
    /// `Decimal`'s description always uses `.` as the decimal separator.
    public static func value(_ value: Decimal) -> String { value.description }
}

public enum APIPath {
    /// Characters a path segment keeps unescaped (RFC 3986 `pchar` without `/`).
    private static let segmentCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@")

    /// `encodeURIComponent`-style escaping for one path segment, so a value can never
    /// add a segment or a query.
    public static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: segmentCharacters) ?? ""
    }
}

public enum APIBody {
    public static func encode<Body: Encodable>(_ body: Body) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(body)
    }
}

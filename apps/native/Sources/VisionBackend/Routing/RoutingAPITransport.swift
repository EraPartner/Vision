import Foundation
import VisionNativeCore

/// The operations the Swift backend serves in-process (ADR-270 decision 2). Moving an
/// operation is one reviewed change: its id here and its handler in `InProcessBackend.live`.
/// Every other operation still goes to the Bun backend.
public enum PortedOperations {
    public static let ids: Set<String> = [
        "getTags", "createTag", "getSettings", "getSetting", "saveSetting", "saveSettings", "getExchangeRates",
        "refreshExchangeRates", "getAccounts", "createAccount", "updateAccount", "deleteAccount",
        "setAccountStatementBalance", "getCategoryTree", "createCategoryNode", "updateCategoryNode",
        "deleteCategoryNode", "mergeCategoryNode", "getCategories", "createCategory",
    ]
}

/// One request as a handler sees it: the matched operation, its decoded path parameters,
/// the query and the body.
public struct InProcessRequest: Sendable {
    // lint:allow raw-id an OpenAPI operationId, not an entity identifier
    public let operationId: String
    public let method: HTTPMethod
    public let pathParameters: [String: String]
    public let queryItems: [URLQueryItem]
    public let headers: [String: String]
    public let body: Data?

    /// The query value of `name` as the routes read it: Express's `req.query` holds an array for a
    /// repeated key, which `String()`, `parseInt` and `looseString` see comma-joined.
    public func query(_ name: String) -> String? {
        let values = queryItems.filter { $0.name == name }.map { $0.value ?? "" }
        return values.isEmpty ? nil : values.joined(separator: ",")
    }
}

/// `querystring.parse` of Node, Express 5's default query parser: pairs split on `&`, the first
/// `=` splits name from value, `+` is a space, and `%XX` escapes decode as UTF-8 bytes (invalid
/// sequences become U+FFFD and a malformed escape stays as written). Empty pairs (`&&`) are
/// skipped; at most 1,000 pairs are read.
enum NodeQueryString {
    static func parse(_ query: String) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        for pair in query.split(separator: "&", omittingEmptySubsequences: true).prefix(1000) {
            let name: Substring
            let value: Substring
            if let equals = pair.firstIndex(of: "=") {
                name = pair[..<equals]
                value = pair[pair.index(after: equals)...]
            } else {
                name = pair
                value = ""
            }
            items.append(URLQueryItem(name: unescape(name), value: unescape(value)))
        }
        return items
    }

    static func unescape(_ text: Substring) -> String {
        var bytes: [UInt8] = []
        let source = Array(text.utf8)
        var index = 0
        while index < source.count {
            let byte = source[index]
            if byte == UInt8(ascii: "+") {
                bytes.append(UInt8(ascii: " "))
            } else if byte == UInt8(ascii: "%"), index + 2 < source.count,
                let high = hexValue(source[index + 1]), let low = hexValue(source[index + 2])
            {
                bytes.append(high << 4 | low)
                index += 2
            } else {
                bytes.append(byte)
            }
            index += 1
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
        default: return nil
        }
    }
}

/// The Swift handler of one ported operation: the request in, the same status and JSON
/// envelope the TypeScript route answers with out.
public typealias InProcessHandler = @Sendable (InProcessRequest) async throws -> APIResponse

/// The ported operations' handlers, matched by method and path template.
public struct InProcessBackend: Sendable {
    struct Route: Sendable {
        // lint:allow raw-id an OpenAPI operationId, not an entity identifier
        let operationId: String
        let method: HTTPMethod
        /// Template segments; `{name}` captures one path segment.
        let segments: [String]
        let handler: InProcessHandler
    }

    private(set) var routes: [Route] = []
    /// Whether the handlers can run: false while the app has no database file of its own (a
    /// debug build pointed at another backend), and every request then goes to the fallback.
    let isActive: @Sendable () async -> Bool

    public init(isActive: @escaping @Sendable () async -> Bool = { true }) {
        self.isActive = isActive
    }

    /// The handlers the app uses: one per id in `PortedOperations.ids`, in inventory order.
    public static func live(
        database: BackendDatabase, fetcher: any ProviderFetching = URLSessionProviderFetcher()
    ) -> InProcessBackend {
        live(database: database, fetcher: fetcher, views: MaterializedViewRefresher(database: database))
    }

    static func live(
        database: BackendDatabase, fetcher: any ProviderFetching, views: MaterializedViewRefresher
    ) -> InProcessBackend {
        var backend = InProcessBackend(isActive: { await database.isConfigured })
        TagsArea.register(&backend, database: database)
        SettingsArea.register(&backend, database: database)
        ExchangeRatesArea.register(&backend, database: database, fetcher: fetcher)
        AccountsArea.register(&backend, database: database)
        CategoriesArea.register(&backend, database: database, views: views)
        return backend
    }

    public var operationIds: Set<String> { Set(routes.map(\.operationId)) }

    /// Serves `Operation` with `handler`, using the generated operation's method and template.
    public mutating func register<Operation: APIOperation>(
        _ operation: Operation.Type, _ handler: @escaping InProcessHandler
    ) {
        routes.append(
            Route(
                operationId: Operation.operationId, method: Operation.method,
                segments: Self.segments(Operation.pathTemplate), handler: handler))
    }

    static func segments(_ path: String) -> [String] {
        path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
    }

    /// The route and path parameters for a request, or nil when no ported operation matches.
    func match(_ request: APIRequest) -> (Route, [String: String])? {
        guard let components = URLComponents(url: request.url, resolvingAgainstBaseURL: false) else { return nil }
        let path = Self.segments(components.percentEncodedPath)
        for route in routes where route.method == request.method && route.segments.count == path.count {
            var parameters: [String: String] = [:]
            var matched = true
            for (template, segment) in zip(route.segments, path) {
                if template.hasPrefix("{"), template.hasSuffix("}") {
                    guard let value = segment.removingPercentEncoding, !value.isEmpty else {
                        matched = false
                        break
                    }
                    parameters[String(template.dropFirst().dropLast())] = value
                } else if template != segment {
                    matched = false
                    break
                }
            }
            if matched { return (route, parameters) }
        }
        return nil
    }
}

/// The app's API transport during the backend port: ported operations run in-process, the
/// rest go to the Bun backend over loopback HTTP through `fallback`.
public struct RoutingAPITransport: APITransport, APIStreamTransport {
    private let backend: InProcessBackend
    private let fallback: any APITransport
    private let streamFallback: any APIStreamTransport

    public init(
        backend: InProcessBackend, fallback: any APITransport, streamFallback: any APIStreamTransport
    ) {
        self.backend = backend
        self.fallback = fallback
        self.streamFallback = streamFallback
    }

    public func send(_ request: APIRequest) async throws -> APIResponse {
        guard let (route, parameters) = backend.match(request), await backend.isActive() else {
            return try await fallback.send(request)
        }
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
        let items = NodeQueryString.parse(query)
        return try await route.handler(
            InProcessRequest(
                operationId: route.operationId, method: request.method, pathParameters: parameters,
                queryItems: items, headers: request.headers, body: request.body))
    }

    /// No event-stream operation is ported yet, so every stream goes to Bun.
    public func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        try await streamFallback.stream(request, receive: receive)
    }
}

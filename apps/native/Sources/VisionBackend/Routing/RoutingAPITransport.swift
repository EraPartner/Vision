import Foundation
import VisionNativeCore

/// The operations the Swift backend serves in-process (ADR-270 decision 2). Moving an
/// operation is one reviewed change: its id here and its handler in `InProcessBackend.live`.
/// Every other operation still goes to the Bun backend.
public enum PortedOperations {
    public static let ids: Set<String> = [
        "getTags", "createTag", "getSettings", "getSetting", "saveSetting", "saveSettings",
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

    /// The query value of `name`; the last one wins, like Express's `req.query` for a repeated key.
    public func query(_ name: String) -> String? {
        queryItems.last { $0.name == name }?.value
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
    public static func live(database: BackendDatabase) -> InProcessBackend {
        var backend = InProcessBackend(isActive: { await database.isConfigured })
        TagsArea.register(&backend, database: database)
        SettingsArea.register(&backend, database: database)
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
        let items = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
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

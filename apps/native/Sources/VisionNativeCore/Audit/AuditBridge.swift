import Foundation

/// Sends one request to the backend's private audit bridge (`AuditRequest`): `POST
/// /api/internal/audit/<endpoint>` with the per-launch bearer token. Returns the
/// envelope's `data`; anything but `200 { ok: true, data }` throws.
public protocol AuditBridgeTransport: Sendable {
    func send(_ endpoint: String, _ payload: JSONValue) async throws -> JSONValue
}

public struct AuditBridgeError: Error, Equatable, Sendable, LocalizedError {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// `auditRequest` in `packaging/electron/runtime/native.ts` over URLSession: loopback
/// only, a 10-second timeout, at most 4 MiB for `read` and 16 KiB for every other answer.
public struct URLSessionAuditBridge: AuditBridgeTransport {
    public static let tokenPattern = "[0-9a-f]{64}"
    private let token: String
    private let port: @Sendable () async -> Int
    private let session: URLSession

    public init(
        token: String, port: @escaping @Sendable () async -> Int,
        session: URLSession = URLSession(configuration: .ephemeral)
    ) {
        self.token = token
        self.port = port
        self.session = session
    }

    public static func maximumResponseBytes(_ endpoint: String) -> Int {
        endpoint == "read" ? 4 * 1024 * 1024 : 16_384
    }

    public func send(_ endpoint: String, _ payload: JSONValue) async throws -> JSONValue {
        let port = await port()
        guard let url = URL(string: "http://\(RuntimeConstants.loopbackHost):\(port)/api/internal/audit/\(endpoint)")
        else {
            throw AuditBridgeError("Audit bridge URL is invalid")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(try payload.compactJSONString().utf8)
        let (data, response) = try await session.data(for: request)
        guard data.count <= Self.maximumResponseBytes(endpoint) else {
            throw AuditBridgeError("Audit bridge response is too large")
        }
        return try Self.unwrap(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }

    /// The `{ ok: true, data }` envelope of a 200 answer.
    public static func unwrap(status: Int, body: Data) throws -> JSONValue {
        guard let parsed = try? JSONValue.parse(body), status == 200, parsed["ok"] == .bool(true),
            let data = parsed["data"], data.isTruthy
        else {
            throw AuditBridgeError("Audit bridge rejected request")
        }
        return data
    }
}

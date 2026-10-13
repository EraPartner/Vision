import Foundation

/// One HTTP exchange, as the transport sees it.
public struct APIRequest: Equatable, Sendable {
    public var method: HTTPMethod
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    public var timeout: TimeInterval

    public init(method: HTTPMethod, url: URL, headers: [String: String], body: Data?, timeout: TimeInterval) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
    }
}

public struct APIResponse: Equatable, Sendable {
    public var status: Int
    public var body: Data
    /// The response headers, names lowercased (a bulk export's `x-exported-count`).
    public var headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }
}

/// A decoded success value and its original envelope metadata (provider, cache source, request id).
public struct APIDataSnapshot<Value: Sendable>: Sendable {
    public let data: Value
    public let meta: JSONValue?

    public init(data: Value, meta: JSONValue? = nil) {
        self.data = data
        self.meta = meta
    }
}

/// Sends one request. Tests use a fake; the app uses `URLSessionAPITransport`.
public protocol APITransport: Sendable {
    /// Throws `APIError.timedOut`, `APIError.network` or `CancellationError`.
    func send(_ request: APIRequest) async throws -> APIResponse
}

public struct URLSessionAPITransport: APITransport {
    let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    public func send(_ request: APIRequest) async throws -> APIResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.timeoutInterval = request.timeout
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        for (field, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }
        urlRequest.httpBody = request.body
        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else { throw APIError.network("Invalid response") }
            var headers: [String: String] = [:]
            for (name, value) in http.allHeaderFields {
                headers[String(describing: name).lowercased()] = String(describing: value)
            }
            return APIResponse(status: http.statusCode, body: data, headers: headers)
        } catch let error as URLError {
            switch error.code {
            case .timedOut: throw APIError.timedOut
            case .cancelled: throw CancellationError()
            default: throw APIError.network(error.localizedDescription)
            }
        }
    }
}

/// `ApiErrorCode` in packages/types/src/errors.ts.
public enum APIErrorCode: String, Sendable, CaseIterable {
    case validationError = "VALIDATION_ERROR"
    case notFound = "NOT_FOUND"
    case conflict = "CONFLICT"
    case unauthorized = "UNAUTHORIZED"
    case forbidden = "FORBIDDEN"
    case rateLimited = "RATE_LIMITED"
    case internalServerError = "INTERNAL_SERVER_ERROR"
    case badGateway = "BAD_GATEWAY"
    case gatewayTimeout = "GATEWAY_TIMEOUT"
    case serviceUnavailable = "SERVICE_UNAVAILABLE"
    case appError = "APP_ERROR"
}

/// `ApiClientError`: a non-2xx response, from the ADR-026 failure envelope.
public struct APIClientError: Error, Equatable, Sendable {
    public let status: Int
    public let code: APIErrorCode
    public let message: String
    public let details: JSONValue?
    public let requestId: String?

    public init(status: Int, code: APIErrorCode, message: String, details: JSONValue? = nil, requestId: String? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.requestId = requestId
    }
}

/// `ApiContractError`: a success body that does not decode as the generated model.
/// `issues` holds `path: problem` strings only, never the offending values.
public struct APIContractError: Error, Equatable, Sendable {
    public let endpoint: String
    public let issues: [String]

    public init(endpoint: String, issues: [String]) {
        self.endpoint = endpoint
        self.issues = issues
    }
}

public enum APIError: Error, Equatable, Sendable, LocalizedError {
    case client(APIClientError)
    case contract(APIContractError)
    case timedOut
    case network(String)
    /// No backend URL yet: the runtime is still starting or failed.
    case backendUnavailable
    case invalidRequest(String)

    public var errorDescription: String? {
        switch self {
        case .client(let error): return error.message
        case .contract(let error):
            return "Response contract violation for \(error.endpoint): \(error.issues.joined(separator: "; "))"
        case .timedOut: return "Request timed out"
        case .network(let message): return message
        case .backendUnavailable: return "The Vision backend is not running."
        case .invalidRequest(let label): return "Invalid request: \(label)"
        }
    }

    /// The `nonRetryable` rule of `apiRequest`: contract errors and client errors whose
    /// code says that repeating the request cannot help.
    public var isRetryable: Bool {
        switch self {
        case .contract, .backendUnavailable, .invalidRequest:
            return false
        case .client(let error):
            switch error.code {
            case .validationError, .rateLimited, .unauthorized, .forbidden, .notFound, .conflict: return false
            default: return true
            }
        case .timedOut, .network:
            return true
        }
    }
}

/// The Swift counterpart of `apiRequest` in apps/frontend/src/lib/api/client.ts: the same
/// headers, envelope unwrapping, error shape, timeout and retry policy, over the
/// generated `APIOperation`s.
public struct APIClient: Sendable {
    /// `DEFAULT_TIMEOUT_MS`.
    public static let defaultTimeout: TimeInterval = 30
    /// `MAX_RETRIES`.
    public static let defaultMaxRetries = 2
    /// `RETRYABLE_STATUS_CODES`.
    public static let retryableStatuses: Set<Int> = [408, 429, 502, 503, 504]

    private let baseURL: @Sendable () async -> URL?
    private let adminToken: @Sendable () async -> String?
    private let transport: any APITransport
    private let sharedAIReadFlights = NativeSettingsAIReadFlights()
    private let streamTransport: any APIStreamTransport
    private let sleep: @Sendable (Duration) async throws -> Void
    private let jitter: @Sendable () -> Double
    private let makeRequestId: @Sendable () -> String
    public let maxRetries: Int
    public let timeout: TimeInterval

    /// - Parameters:
    ///   - baseURL: the running backend's origin; `nil` while it is not ready.
    ///   - adminToken: the admin Bearer token of the current session, if one is stored.
    ///   - jitter: a value in `0..<1`, scaled to the 200 ms backoff jitter.
    public init(
        baseURL: @escaping @Sendable () async -> URL?,
        adminToken: @escaping @Sendable () async -> String? = { nil },
        transport: any APITransport = URLSessionAPITransport(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        requestId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
        maxRetries: Int = APIClient.defaultMaxRetries,
        timeout: TimeInterval = APIClient.defaultTimeout,
        streamTransport: any APIStreamTransport = URLSessionAPITransport()
    ) {
        self.baseURL = baseURL
        self.adminToken = adminToken
        self.transport = transport
        self.streamTransport = streamTransport
        self.sleep = sleep
        self.jitter = jitter
        self.makeRequestId = requestId
        self.maxRetries = maxRetries
        self.timeout = timeout
    }

    /// `backoffDelay`: 500 ms × 2^attempt plus up to 200 ms of jitter, at most 30 s.
    public static func backoff(attempt: Int, jitter: Double) -> Duration {
        let milliseconds = min(500 * pow(2, Double(attempt)) + max(0, min(1, jitter)) * 200, 30_000)
        return .milliseconds(Int(milliseconds.rounded()))
    }

    /// `${API_BASE_URL}${endpoint}`: the path is appended to the base URL's path, and query
    /// values are escaped like `URLSearchParams`, so a `+` stays a plus sign.
    public static func url(base: URL, path: String, queryItems: [URLQueryItem]) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false), path.hasPrefix("/") else {
            return nil
        }
        var prefix = components.percentEncodedPath
        while prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + path
        components.percentEncodedQuery = nil
        if !queryItems.isEmpty {
            components.percentEncodedQueryItems = queryItems.map { item in
                URLQueryItem(name: queryEscape(item.name), value: item.value.map(queryEscape))
            }
        }
        components.fragment = nil
        return components.url
    }

    private static let queryCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func queryEscape(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: queryCharacters) ?? ""
    }

    /// Performs the operation and returns the envelope's `data`. Throws `APIError`, or
    /// `CancellationError` when the task is cancelled.
    /// Shares only concurrent status/model reads; callers own their source freshness and invalidation.
    public func coalescedAIRead<Value: Codable & Sendable>(
        key: String, load: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        guard let origin = await baseURL() else { throw APIError.backendUnavailable }
        return try await sharedAIReadFlights.value(origin: origin.absoluteString, key: key, load: load)
    }
    public func invalidateSharedAIReads(keys: [String]) async {
        guard let origin = await baseURL() else { return }
        await sharedAIReadFlights.invalidate(origin: origin.absoluteString, keys: keys)
    }

    public func send<Operation: APIOperation>(_ operation: Operation) async throws -> Operation.Response {
        try await perform(operation, preservingMeta: false).data
    }

    /// Source mutations such as conditional Settings PUTs disable retries: a lost
    /// acknowledgement must not replay a write against a baseline that may be stale.
    public func send<Operation: APIOperation>(_ operation: Operation, retries: Int) async throws -> Operation.Response {
        try await perform(operation, preservingMeta: false, retryLimit: retries).data
    }

    /// Retains metadata from a success envelope with the same transport, decoding and retry policy.
    public func sendWithMeta<Operation: APIOperation>(_ operation: Operation) async throws
        -> APIDataSnapshot<Operation.Response>
    {
        try await perform(operation, preservingMeta: true)
    }

    private func perform<Operation: APIOperation>(
        _ operation: Operation, preservingMeta: Bool, retryLimit: Int? = nil
    ) async throws
        -> APIDataSnapshot<Operation.Response>
    {
        let method = Operation.method
        let label = "\(method.rawValue) \(operation.path)"
        guard let base = await baseURL() else { throw APIError.backendUnavailable }
        guard let url = Self.url(base: base, path: operation.path, queryItems: operation.queryItems) else {
            throw APIError.invalidRequest(label)
        }
        let body: Data?
        do {
            body = try operation.encodedBody()
        } catch {
            throw APIError.invalidRequest(label)
        }
        // One correlation id for every attempt, like `apiRequest`.
        let headers = await requestHeaders(contentType: operation.contentType)
        let request = APIRequest(method: method, url: url, headers: headers, body: body, timeout: timeout)
        let retries = method.isIdempotent ? max(0, retryLimit ?? maxRetries) : 0
        var lastError = APIError.network("Request failed")

        for attempt in 0...retries {
            if attempt > 0 {
                try await sleep(Self.backoff(attempt: attempt - 1, jitter: jitter()))
            }
            let outcome: Result<APIDataSnapshot<Operation.Response>, APIError>
            do {
                let response = try await transport.send(request)
                if Self.retryableStatuses.contains(response.status), attempt < retries {
                    lastError = .network("Server returned \(response.status)")
                    continue
                }
                outcome = Self.decode(response, as: Operation.Response.self, label: label).map { data in
                    let body = preservingMeta ? try? JSONValue.parse(response.body) : nil
                    let meta = body?["ok"] == .bool(true) ? body?["meta"] : nil
                    return APIDataSnapshot(data: data, meta: meta)
                }
            } catch let error as APIError {
                outcome = .failure(error)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                outcome = .failure(.network(error.localizedDescription))
            }
            switch outcome {
            case .success(let value):
                return value
            case .failure(let error):
                lastError = error
                if !error.isRetryable || attempt >= retries { throw error }
            }
        }
        throw lastError
    }

    /// `requestBlob`: a file the endpoint answers with (an export) instead of a JSON envelope.
    /// One attempt, like the web's `rawFetch`; a non-2xx answer throws its failure envelope
    /// with `fallbackMessage`.
    public func download<Operation: APIOperation>(_ operation: Operation, fallbackMessage: String = "Export failed")
        async throws -> Data
    {
        try await downloadResponse(operation, fallbackMessage: fallbackMessage).body
    }

    /// `requestBlobWithResponse`: `download` with the response headers (a bulk export's
    /// `X-Exported-Count`).
    public func downloadResponse<Operation: APIOperation>(
        _ operation: Operation, fallbackMessage: String = "Export failed"
    ) async throws -> APIResponse {
        let label = "\(Operation.method.rawValue) \(operation.path)"
        guard let base = await baseURL() else { throw APIError.backendUnavailable }
        guard let url = Self.url(base: base, path: operation.path, queryItems: operation.queryItems) else {
            throw APIError.invalidRequest(label)
        }
        let body: Data?
        do {
            body = try operation.encodedBody()
        } catch {
            throw APIError.invalidRequest(label)
        }
        let headers = await requestHeaders(contentType: operation.contentType)
        let request = APIRequest(method: Operation.method, url: url, headers: headers, body: body, timeout: timeout)
        let response: APIResponse
        do {
            response = try await transport.send(request)
        } catch let error as APIError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard (200..<300).contains(response.status) else {
            throw APIError.client(
                Self.envelopeError(status: response.status, body: response.body, fallbackMessage: fallbackMessage))
        }
        return response
    }

    /// The idle timeout of an event stream: the web's stream `fetch` has none, and a large
    /// file can stage for a while between progress events.
    public static let streamTimeout: TimeInterval = 600

    /// A `POST` whose answer is a Server-Sent Events stream (`readSseStream`): each event goes
    /// to `onEvent` as it arrives. A non-2xx answer throws its failure envelope with
    /// `fallbackMessage`. Not retried. Cancelling the task closes the connection and throws
    /// `CancellationError`.
    public func streamEvents(
        path: String, body: MultipartFormData, fallbackMessage: String,
        onEvent: (ServerSentEvent) async throws -> Void
    ) async throws {
        try await streamResponse(
            path: path, body: body.encoded(), contentType: body.contentType,
            fallbackMessage: fallbackMessage, onEvent: onEvent)
    }

    /// Chat sends JSON while file staging sends multipart; both retain the same SSE transport
    /// and failure envelope. A POST stream has one attempt, including ambiguous failures.
    public func streamJSONEvents(
        path: String, body: Data, fallbackMessage: String,
        onEvent: (ServerSentEvent) async throws -> Void
    ) async throws {
        try await streamResponse(
            path: path, body: body, contentType: "application/json",
            fallbackMessage: fallbackMessage, onEvent: onEvent)
    }

    private func streamResponse(
        path: String, body: Data, contentType: String, fallbackMessage: String,
        onEvent: (ServerSentEvent) async throws -> Void
    ) async throws {
        let label = "POST \(path)"
        guard let base = await baseURL() else { throw APIError.backendUnavailable }
        guard let url = Self.url(base: base, path: path, queryItems: []) else { throw APIError.invalidRequest(label) }
        var headers = await requestHeaders(contentType: contentType)
        headers["Accept"] = "text/event-stream"
        let request = APIRequest(
            method: .post, url: url, headers: headers, body: body, timeout: Self.streamTimeout)
        var parser = ServerSentEventParser()
        // The transport maps its own failures to `APIError` or `CancellationError`; an error
        // `onEvent` throws passes through.
        let response = try await streamTransport.stream(request) { chunk in
            for event in parser.feed(chunk) { try await onEvent(event) }
        }
        guard (200..<300).contains(response.status) else {
            throw APIError.client(
                Self.envelopeError(status: response.status, body: response.body, fallbackMessage: fallbackMessage))
        }
        for event in parser.finish() { try await onEvent(event) }
    }

    /// The headers of every request: the body type, one correlation id and, when the session
    /// stored one, the admin token (without it the backend's loopback allowlist applies, as
    /// in the web app).
    func requestHeaders(contentType: String) async -> [String: String] {
        var headers = ["Content-Type": contentType, "X-Request-Id": makeRequestId()]
        if let token = await adminToken()?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            headers["Authorization"] = "Bearer \(token)"
        }
        return headers
    }

    /// A finished response: the unwrapped `data` of a 2xx, else the failure envelope.
    static func decode<Value: Decodable>(_ response: APIResponse, as type: Value.Type, label: String)
        -> Result<Value, APIError>
    {
        guard (200..<300).contains(response.status) else {
            return .failure(.client(envelopeError(status: response.status, body: response.body)))
        }
        if response.status == 204 || response.body.isEmpty && Value.self == APIEmpty.self {
            return decodeNull(as: type, label: label)
        }
        guard (try? JSONSerialization.jsonObject(with: response.body, options: [.fragmentsAllowed])) != nil else {
            // `response.json()` rejects; apiRequest treats that like a network failure.
            return .failure(.network("The response is not JSON"))
        }
        let decoder = JSONDecoder()
        let endpoint = label.split(separator: "?").first.map(String.init) ?? label
        // `unwrapEnvelope`: `{ ok: true, data }` yields `data`; any other body is used as is.
        if let probe = try? decoder.decode(EnvelopeProbe.self, from: response.body), probe.ok == .bool(true) {
            do {
                let envelope = try decoder.decode(EnvelopeData<Value>.self, from: response.body)
                if let data = envelope.data { return .success(data) }
                return decodeNull(as: type, label: label)
            } catch let error as DecodingError {
                return .failure(.contract(APIContractError(endpoint: endpoint, issues: issues(error, dropping: 1))))
            } catch {
                return .failure(.contract(APIContractError(endpoint: endpoint, issues: ["(root): Invalid value"])))
            }
        }
        do {
            return .success(try decoder.decode(Value.self, from: response.body))
        } catch let error as DecodingError {
            return .failure(.contract(APIContractError(endpoint: endpoint, issues: issues(error, dropping: 0))))
        } catch {
            return .failure(.contract(APIContractError(endpoint: endpoint, issues: ["(root): Invalid value"])))
        }
    }

    /// An absent `data` (or a 204): only types that accept JSON `null` decode.
    private static func decodeNull<Value: Decodable>(as type: Value.Type, label: String) -> Result<Value, APIError> {
        if let value = try? JSONDecoder().decode(Value.self, from: Data("null".utf8)) { return .success(value) }
        let endpoint = label.split(separator: "?").first.map(String.init) ?? label
        return .failure(.contract(APIContractError(endpoint: endpoint, issues: ["(root): Required"])))
    }

    /// `formatIssuePath` for a decoding error; the problem is named, the value is not.
    static func issues(_ error: DecodingError, dropping prefix: Int) -> [String] {
        func path(_ codingPath: [any CodingKey]) -> String {
            var out = ""
            for key in codingPath.dropFirst(prefix) {
                if let index = key.intValue {
                    out += "[\(index)]"
                } else {
                    out += out.isEmpty ? key.stringValue : ".\(key.stringValue)"
                }
            }
            return out.isEmpty ? "(root)" : out
        }
        switch error {
        case .keyNotFound(let key, let context):
            return ["\(path(context.codingPath + [key])): Required"]
        case .valueNotFound(_, let context):
            return ["\(path(context.codingPath)): Required"]
        case .typeMismatch(_, let context):
            return ["\(path(context.codingPath)): Invalid type"]
        case .dataCorrupted(let context):
            return ["\(path(context.codingPath)): Invalid value"]
        @unknown default:
            return ["(root): Invalid value"]
        }
    }

    /// `STATUS_FALLBACK_CODE`.
    static let statusFallbackCodes: [Int: APIErrorCode] = [
        400: .validationError, 401: .unauthorized, 403: .forbidden, 404: .notFound, 409: .conflict,
        422: .validationError, 429: .rateLimited, 502: .badGateway, 503: .serviceUnavailable, 504: .gatewayTimeout,
    ]

    /// `parseEnvelopeError`: the failure envelope when it carries a non-blank code and
    /// message, else the status fallback.
    public static func envelopeError(status: Int, body: Data, fallbackMessage: String = "Request failed")
        -> APIClientError
    {
        let fallbackCode = statusFallbackCodes[status] ?? (status >= 500 ? .internalServerError : .appError)
        let parsed = try? JSONValue.parse(body)
        if let parsed, parsed["ok"] == .bool(false), let error = parsed["error"], error.objectValue != nil,
            let code = error["code"]?.stringValue, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let message = error["message"]?.stringValue,
            !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return APIClientError(
                status: status, code: APIErrorCode(rawValue: code) ?? fallbackCode, message: message,
                details: error["details"], requestId: parsed["meta"]?["requestId"]?.stringValue)
        }
        return APIClientError(status: status, code: fallbackCode, message: "\(fallbackMessage) (status \(status))")
    }
}

/// Reads only `ok`, to tell an envelope from a bare body.
private struct EnvelopeProbe: Decodable {
    let ok: JSONValue?
}

private struct EnvelopeData<Value: Decodable>: Decodable {
    let data: Value?

    enum CodingKeys: String, CodingKey {
        case data
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        data = try container.decodeIfPresent(Value.self, forKey: .data)
    }
}

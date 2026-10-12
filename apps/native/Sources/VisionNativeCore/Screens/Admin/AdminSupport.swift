import Foundation
import Observation

/// The admin API calls of `/admin`, `/admin/providers` and `/admin/endpoints`
/// (apps/frontend/src/lib/api/admin.ts), so tests can use a fake.
public protocol AdminService: Sendable {
    /// `getDbStats()`.
    func databaseStats() async throws -> OpenAPI.DbStats
    /// `getProviderHealth()`: the rows of the `{items, total}` body.
    func providerHealth() async throws -> [OpenAPI.ProviderHealth]
    /// `probeProvider(provider)`.
    func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult
    /// `getRequestMetrics()`: the rows of the `{items, total}` body.
    func requestMetrics() async throws -> [OpenAPI.RouteMetric]
    /// `getEndpointManifest()`: the rows of the `{items, total}` body.
    func endpointManifest() async throws -> [OpenAPI.EndpointEntry]
}

extension APIClient: AdminService {
    public func databaseStats() async throws -> OpenAPI.DbStats {
        try await send(OpenAPIOperations.AdminDatabaseStats())
    }

    public func providerHealth() async throws -> [OpenAPI.ProviderHealth] {
        try await send(OpenAPIOperations.AdminProvidersHealth()).items
    }

    public func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult {
        try await send(OpenAPIOperations.AdminProviderProbe(provider: provider))
    }

    public func requestMetrics() async throws -> [OpenAPI.RouteMetric] {
        try await send(OpenAPIOperations.AdminMetricsRequests()).items
    }

    public func endpointManifest() async throws -> [OpenAPI.EndpointEntry] {
        try await send(OpenAPIOperations.AdminListEndpoints()).items
    }
}

/// One React Query `useQuery` of an admin page: the last data and the last error kept side
/// by side (a failed refetch keeps the data), a `staleTime`, and one request at a time.
@MainActor
@Observable
public final class ScreenQuery<Value: Sendable & Equatable> {
    public private(set) var data: Value?
    public private(set) var error: APIError?
    /// A request is in flight (`isFetching`).
    public private(set) var isFetching = false

    public let staleAfter: TimeInterval
    @ObservationIgnored private let load: @Sendable () async throws -> Value
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?

    public init(
        staleAfter: TimeInterval, now: @escaping @Sendable () -> Date = { Date() },
        load: @escaping @Sendable () async throws -> Value
    ) {
        self.staleAfter = staleAfter
        self.now = now
        self.load = load
    }

    /// `isLoading`: no result yet, neither data nor an error.
    public var isLoading: Bool { data == nil && error == nil }

    /// The page mounted: fetch unless a successful result younger than `staleAfter` exists.
    public func appear() async {
        if let fetchedAt, error == nil, now().timeIntervalSince(fetchedAt) < staleAfter { return }
        await refetch()
    }

    /// `invalidateQueries`: the next `appear()` fetches again.
    public func invalidate() {
        fetchedAt = nil
    }

    /// `refetch()`: a second caller awaits the request in flight.
    public func refetch() async {
        if let inFlight {
            await inFlight.value
            return
        }
        await start()
    }

    /// `invalidateQueries` on a mounted query: cancel the request in flight, whose answer may
    /// predate a change, and fetch again.
    public func invalidateAndRefetch() async {
        fetchedAt = nil
        inFlight?.cancel()
        await start()
    }

    private func start() async {
        let request = Task { await run() }
        inFlight = request
        await request.value
        if inFlight == request { inFlight = nil }
    }

    /// A cancelled request leaves the state to the request that replaced it.
    private func run() async {
        isFetching = true
        let result: Result<Value, any Error>
        do {
            result = .success(try await load())
        } catch {
            result = .failure(error)
        }
        guard !Task.isCancelled else { return }
        isFetching = false
        switch result {
        case .success(let value):
            data = value
            error = nil
            fetchedAt = now()
        case .failure(is CancellationError):
            return
        case .failure(let failure as APIError):
            error = failure
            fetchedAt = nil
        case .failure(let failure):
            error = .network(failure.localizedDescription)
            fetchedAt = nil
        }
    }
}

/// `apiErrorToMessage` (apps/frontend/src/lib/api/errorMessage.ts) for `APIError`.
public enum APIErrorMessage {
    /// `MACHINE_MESSAGE_PATTERNS`: transport sentences that are never shown verbatim.
    static let machinePatterns = [
        "^Validation error:", "\\(status \\d{3}\\)$", "^Server returned \\d{3}$", "^Request failed$",
        "^Request timed out$", "^Failed to fetch$", "^Load failed$", "^NetworkError", "^Network request failed$",
        "^The user aborted a request", "^signal is aborted", "^Too many requests\\.",
    ]

    /// `isAuthoredMessage`.
    public static func isAuthored(_ message: String) -> Bool {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return !machinePatterns.contains { pattern in
            trimmed.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    static func key(for code: APIErrorCode) -> String? {
        switch code {
        case .rateLimited: return "apiError.rateLimited"
        case .internalServerError, .badGateway, .serviceUnavailable: return "apiError.server"
        case .validationError: return "apiError.validation"
        case .notFound: return "apiError.notFound"
        case .conflict: return "apiError.conflict"
        case .unauthorized: return "apiError.unauthorized"
        case .forbidden: return "apiError.forbidden"
        case .appError: return "apiError.unknown"
        case .gatewayTimeout: return nil
        }
    }

    /// The text to show for an error.
    public static func text(_ error: APIError, strings: any Localizing) -> String {
        switch error {
        case .client(let failure):
            if failure.code == .rateLimited, let seconds = retryAfter(failure.details) {
                return strings.t("apiError.rateLimitedIn", ["seconds": String(seconds)])
            }
            let neverPassThrough: Set<APIErrorCode> = [
                .rateLimited, .internalServerError, .badGateway, .serviceUnavailable,
            ]
            let passThrough = !neverPassThrough.contains(failure.code) && (400..<500).contains(failure.status)
            if passThrough && isAuthored(failure.message) {
                return failure.message.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return strings.t(key(for: failure.code) ?? (failure.status >= 500 ? "apiError.server" : "apiError.unknown"))
        case .contract:
            return strings.t("apiError.server")
        case .timedOut:
            return strings.t("apiError.timeout")
        case .network(let message):
            // The retry-exhaustion sentinel of `apiRequest`.
            if let range = message.range(of: "^Server returned (\\d{3})$", options: .regularExpression),
                let status = Int(message[range].suffix(3))
            {
                if status == 429 { return strings.t("apiError.rateLimited") }
                return strings.t(status >= 500 ? "apiError.server" : "apiError.unknown")
            }
            return strings.t("apiError.network")
        case .backendUnavailable:
            return strings.t("apiError.network")
        case .invalidRequest:
            return strings.t("apiError.unknown")
        }
    }

    /// `readRetryAfter`: a positive `retry_after` in seconds, rounded up.
    static func retryAfter(_ details: JSONValue?) -> Int? {
        guard let raw = details?["retry_after"] else { return nil }
        let seconds: Double?
        switch raw {
        case .int(let value): seconds = Double(value)
        case .double(let value): seconds = value
        case .string(let text): seconds = Double(text.trimmingCharacters(in: .whitespaces))
        default: seconds = nil
        }
        guard let seconds, seconds.isFinite, seconds > 0 else { return nil }
        return Int(seconds.rounded(.up))
    }
}

/// `AdminErrorState`: the auth alert on 401 or 403, else the page's title over the
/// humanized error.
public enum AdminErrorState: Equatable, Sendable {
    /// `admin.authError.*` with the "Go to admin token" link to `/admin`.
    case authentication
    case message(title: String, body: String)

    public static let tokenRoute = "/admin"

    public init(error: APIError, fallbackTitle: String, strings: any Localizing) {
        if case .client(let failure) = error, failure.status == 401 || failure.status == 403 {
            self = .authentication
        } else {
            self = .message(title: fallbackTitle, body: APIErrorMessage.text(error, strings: strings))
        }
    }
}

/// Posts toasts with increasing ids.
struct NoticeCounter {
    private var count = 0

    mutating func make(
        _ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil
    ) -> ScreenNotice {
        count += 1
        return ScreenNotice(id: count, kind: kind, key: key, variables: variables, detail: detail)
    }
}

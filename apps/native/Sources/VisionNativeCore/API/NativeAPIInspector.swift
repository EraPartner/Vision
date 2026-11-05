import Foundation
import Observation

/// `ApiRequestEvent` (lib/devtools/apiEventBus.ts): only what the web inspector captures.
/// Never headers, bodies or the base URL; `endpoint` is the path with its query.
public struct APIInspectorEvent: Equatable, Sendable, Identifiable {
    public enum Phase: String, Sendable { case start, success, error }

    /// The `X-Request-Id`, shared by every attempt of one request.
    public let requestId: String
    public let method: HTTPMethod
    public let endpoint: String
    public let startedAt: Date
    public let attempt: Int
    public let phase: Phase
    public let durationMs: Double?
    public let status: Int?
    public let errorCode: String?
    public let errorMessage: String?

    public var id: String { "\(requestId)#\(attempt)" }

    public init(
        requestId: String, method: HTTPMethod, endpoint: String, startedAt: Date, attempt: Int, phase: Phase,
        durationMs: Double? = nil, status: Int? = nil, errorCode: String? = nil, errorMessage: String? = nil
    ) {
        self.requestId = requestId
        self.method = method
        self.endpoint = endpoint
        self.startedAt = startedAt
        self.attempt = attempt
        self.phase = phase
        self.durationMs = durationMs
        self.status = status
        self.errorCode = errorCode
        self.errorMessage = errorMessage
    }
}

/// The admin-mode API Inspector and query panel: `apiRequestLog`, `queryMetrics` and the
/// in-memory state of `ApiInspector`. Nothing is persisted.
@MainActor @Observable public final class NativeAPIInspectorModel {
    public enum Tab: String, CaseIterable, Sendable { case requests, metrics, queries }

    public struct EndpointStats: Equatable, Sendable, Identifiable {
        public let key: String
        public let count: Int
        public let errorCount: Int
        public let p50: Double
        public let p95: Double
        public var id: String { key }
    }

    /// The native counterpart of a React Query cache entry: one GET endpoint.
    public struct QueryEntry: Equatable, Sendable, Identifiable {
        public let key: String
        public var fetchCount: Int
        public var errorCount: Int
        public var lastStatus: Int?
        public var lastUpdated: Date?
        public var isFetching: Bool
        public var lastError: String?
        public var id: String { key }
    }

    public static let ringCapacity = 200
    /// The most endpoints `queries` tracks. A paged ledger asks for a new URL per page, so the
    /// table would otherwise grow with every offset ever requested.
    public static let queryCapacity = 400
    public static let slowThresholdMs = 1000.0

    public var isOpen = false
    public var tab: Tab = .requests
    public var filter = ""
    public var selectedID: String?
    public private(set) var log: [APIInspectorEvent] = []
    public private(set) var inFlight: [APIInspectorEvent] = []
    public private(set) var completed: [APIInspectorEvent] = []
    public private(set) var mutationSuccess = 0
    public private(set) var mutationError = 0
    public private(set) var queries: [String: QueryEntry] = [:]
    @ObservationIgnored private var attempts: [String: Int] = [:]

    public init() {}

    public func toggle() { isOpen.toggle() }

    /// `apiRequestLog.handleEvent` plus `queryMetrics`' completed ring, newest first.
    public func record(_ event: APIInspectorEvent) {
        inFlight.removeAll { $0.requestId == event.requestId }
        if event.phase == .start {
            inFlight.insert(event, at: 0)
        } else {
            log.insert(event, at: 0)
            if log.count > Self.ringCapacity { log.removeLast(log.count - Self.ringCapacity) }
            completed.insert(event, at: 0)
            if completed.count > Self.ringCapacity { completed.removeLast(completed.count - Self.ringCapacity) }
            if event.method != .get {
                if event.phase == .success { mutationSuccess += 1 } else { mutationError += 1 }
            }
        }
        if event.method == .get { recordQuery(event) }
        if selectedID != nil, log.isEmpty, inFlight.isEmpty { selectedID = nil }
    }

    /// One attempt index per correlation id, as `apiRequest` counts its attempts.
    func nextAttempt(for requestId: String) -> Int {
        let attempt = attempts[requestId] ?? 0
        attempts[requestId] = attempt + 1
        if attempts.count > Self.ringCapacity * 4 { attempts.removeAll() }
        return attempt
    }

    private func recordQuery(_ event: APIInspectorEvent) {
        var entry =
            queries[event.endpoint]
            ?? QueryEntry(
                key: event.endpoint, fetchCount: 0, errorCount: 0, lastStatus: nil, lastUpdated: nil,
                isFetching: false, lastError: nil)
        switch event.phase {
        case .start:
            entry.isFetching = true
            entry.fetchCount += 1
        case .success:
            entry.isFetching = false
            entry.lastStatus = event.status
            entry.lastUpdated = event.startedAt.addingTimeInterval((event.durationMs ?? 0) / 1000)
            entry.lastError = nil
        case .error:
            entry.isFetching = false
            entry.lastStatus = event.status
            entry.errorCount += 1
            entry.lastError = event.errorMessage
        }
        if queries[event.endpoint] == nil, queries.count >= Self.queryCapacity { evictQuery() }
        queries[event.endpoint] = entry
    }

    /// Drops the entry fetched longest ago that is not fetching now.
    private func evictQuery() {
        let idle = queries.values.filter { !$0.isFetching }
        guard let oldest = idle.min(by: { ($0.lastUpdated ?? .distantPast) < ($1.lastUpdated ?? .distantPast) })
        else { return }
        queries[oldest.key] = nil
    }

    /// `resetQueryMetrics()` + `clearApiRequestLog()`.
    public func reset() {
        log = []
        inFlight = []
        completed = []
        mutationSuccess = 0
        mutationError = 0
        queries = [:]
        selectedID = nil
    }

    /// RequestList: in-flight first, then the log, de-duplicated by attempt, filtered by a
    /// case-insensitive substring of the endpoint or method.
    public var visibleEvents: [APIInspectorEvent] {
        var seen = Set<String>()
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return (inFlight + log).filter { event in
            guard seen.insert(event.id).inserted else { return false }
            guard !needle.isEmpty else { return true }
            return event.endpoint.lowercased().contains(needle) || event.method.rawValue.lowercased().contains(needle)
        }
    }

    public var selectedEvent: APIInspectorEvent? {
        guard let selectedID else { return nil }
        return (inFlight + log).first { $0.id == selectedID }
    }

    public var totalRequests: Int { completed.count }
    public var errorCount: Int { completed.filter { $0.phase == .error }.count }
    public var errorRate: Double { totalRequests == 0 ? 0 : Double(errorCount) / Double(totalRequests) }

    public var slowRequests: [APIInspectorEvent] {
        completed.filter { $0.phase == .success && ($0.durationMs ?? 0) >= Self.slowThresholdMs }
    }

    /// `getTopEndpoints`: count descending, nearest-rank p50/p95 without interpolation, top 20.
    public var topEndpoints: [EndpointStats] {
        var durations: [String: [Double]] = [:]
        var errors: [String: Int] = [:]
        var order: [String] = []
        for event in completed {
            let key = "\(event.method.rawValue) \(event.endpoint)"
            if event.phase == .error { errors[key, default: 0] += 1 }
            guard let duration = event.durationMs else { continue }
            if durations[key] == nil { order.append(key) }
            durations[key, default: []].append(duration)
        }
        let stats = order.map { key -> EndpointStats in
            let sorted = (durations[key] ?? []).sorted()
            func rank(_ fraction: Double) -> Double {
                sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * fraction))]
            }
            return EndpointStats(
                key: key, count: sorted.count, errorCount: errors[key] ?? 0, p50: rank(0.5), p95: rank(0.95))
        }
        return Array(stats.enumerated().sorted { lhs, rhs in
            lhs.element.count != rhs.element.count ? lhs.element.count > rhs.element.count : lhs.offset < rhs.offset
        }.map(\.element).prefix(20))
    }

    public var sortedQueries: [QueryEntry] {
        queries.values.sorted { ($0.lastUpdated ?? .distantPast) > ($1.lastUpdated ?? .distantPast) }
    }
}

/// Records every attempt the wrapped transport sends into the inspector: a start event,
/// then success (2xx) or error with the envelope's code and message, as `apiRequest`
/// emits them. Only the request's method, path, query and correlation id are read.
public struct NativeAPIInspectorTransport: APITransport {
    private let base: any APITransport
    private let inspector: NativeAPIInspectorModel
    private let now: @Sendable () -> Date

    public init(
        base: any APITransport, inspector: NativeAPIInspectorModel, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.base = base
        self.inspector = inspector
        self.now = now
    }

    public func send(_ request: APIRequest) async throws -> APIResponse {
        let requestId = request.headers["X-Request-Id"] ?? UUID().uuidString.lowercased()
        let method = request.method
        let endpoint = Self.endpoint(request.url)
        let startedAt = now()
        let inspector = inspector
        let attempt = await MainActor.run {
            let attempt = inspector.nextAttempt(for: requestId)
            inspector.record(
                .init(
                    requestId: requestId, method: method, endpoint: endpoint, startedAt: startedAt, attempt: attempt,
                    phase: .start))
            return attempt
        }
        func finish(_ phase: APIInspectorEvent.Phase, status: Int?, code: String?, message: String?) async {
            let duration = now().timeIntervalSince(startedAt) * 1000
            await MainActor.run {
                inspector.record(
                    .init(
                        requestId: requestId, method: method, endpoint: endpoint, startedAt: startedAt,
                        attempt: attempt, phase: phase, durationMs: duration, status: status, errorCode: code,
                        errorMessage: message))
            }
        }
        do {
            let response = try await base.send(request)
            if (200..<300).contains(response.status) {
                await finish(.success, status: response.status, code: nil, message: nil)
            } else {
                let error = APIClient.envelopeError(status: response.status, body: response.body)
                await finish(.error, status: response.status, code: error.code.rawValue, message: error.message)
            }
            return response
        } catch is CancellationError {
            await finish(.error, status: nil, code: nil, message: "Cancelled")
            throw CancellationError()
        } catch APIError.timedOut {
            await finish(.error, status: nil, code: nil, message: "Request timed out")
            throw APIError.timedOut
        } catch {
            await finish(.error, status: nil, code: nil, message: "Network error")
            throw error
        }
    }

    /// The path with its query, relative to the backend, like the web's `endpoint`.
    static func endpoint(_ url: URL) -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.path }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        return components.percentEncodedQuery.map { path + "?" + $0 } ?? path
    }
}

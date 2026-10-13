import Foundation
import Observation

/// The two exchange-rates API calls, so tests can use a fake.
public protocol ExchangeRatesService: Sendable {
    /// `getExchangeRates({ dbOnly: true })`.
    func exchangeRates() async throws -> OpenAPI.ExchangeRates
    /// `refreshExchangeRates()`.
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage
}

extension APIClient: ExchangeRatesService {
    public func exchangeRates() async throws -> OpenAPI.ExchangeRates {
        try await send(OpenAPIOperations.GetExchangeRates(dbOnly: true))
    }

    public func refreshExchangeRates() async throws -> OpenAPI.InfoMessage {
        try await send(OpenAPIOperations.RefreshExchangeRates())
    }
}

/// A toast: `toast.success` / `toast.error` with a catalog key, its `t()` variables and
/// an optional `description` line.
public struct ScreenNotice: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case success
        case error
        /// `toast.info`.
        case info
    }

    public let id: Int
    public let kind: Kind
    public let key: String
    public let variables: [String: String]
    /// The toast's `description`, shown as is.
    public let detail: String?

    public init(id: Int, kind: Kind, key: String, variables: [String: String] = [:], detail: String? = nil) {
        self.id = id
        self.kind = kind
        self.key = key
        self.variables = variables
        self.detail = detail
    }
}

/// The state of the Exchange rates screen: `useExchangeRatesQuery` plus the refresh
/// mutation of `ExchangeRatesPage`.
@MainActor
@Observable
public final class ExchangeRatesModel {
    public enum Phase: Equatable, Sendable {
        /// Nothing requested yet.
        case idle
        /// The first request, with no data yet (`isLoading`).
        case loading
        case loaded(OpenAPI.ExchangeRates)
        /// The last request failed (`error`); the page shows the error view.
        case failed
    }

    /// `staleTime` of `useExchangeRatesQuery`.
    public static let staleAfter: TimeInterval = 10 * 60

    public private(set) var phase: Phase = .idle
    /// A request is in flight (`isFetching`).
    public private(set) var isFetching = false
    /// The refresh call is in flight (`refreshMutation.isPending`).
    public private(set) var isRefreshPending = false
    public private(set) var notice: ScreenNotice?

    @ObservationIgnored private let service: any ExchangeRatesService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var notices = NoticeCounter()

    public init(service: any ExchangeRatesService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }

    /// `isRefreshing`: the spinner, and the empty-state button's disabled state.
    public var isRefreshing: Bool { isRefreshPending || isFetching }

    /// `isLoading`: no result yet.
    public var isLoading: Bool {
        switch phase {
        case .idle, .loading: return true
        case .loaded, .failed: return false
        }
    }

    /// The header button: `disabled={isRefreshing || isLoading}`.
    public var isRefreshDisabled: Bool { isRefreshing || isLoading }

    public var data: OpenAPI.ExchangeRates? {
        if case .loaded(let data) = phase { return data }
        return nil
    }

    /// The screen appeared: fetch unless a result younger than `staleAfter` is cached.
    public func appear() async {
        if let fetchedAt, phase != .failed, now().timeIntervalSince(fetchedAt) < Self.staleAfter { return }
        await fetch()
    }

    /// The error view's Retry: `refetch()`.
    public func retry() async {
        await fetch()
    }

    /// Refresh: `POST /api/exchange-rates/refresh`, then a refetch on success.
    public func refresh() async {
        guard !isRefreshPending else { return }
        isRefreshPending = true
        do {
            _ = try await service.refreshExchangeRates()
            post(.success, "exchangeRates.refreshSuccess")
            isRefreshPending = false
            await fetch()
        } catch {
            isRefreshPending = false
            post(.error, "exchangeRates.refreshError")
        }
    }

    /// The toast was shown.
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }

    /// One request at a time, like a React Query fetch: a second caller (the view's `.task`
    /// and a test, or Retry during a refetch) awaits the request in flight instead of
    /// returning before it settles. The phase changes only when the request ends.
    private func fetch() async {
        if let inFlight {
            await inFlight.value
            return
        }
        let request = Task { await run() }
        inFlight = request
        await request.value
        inFlight = nil
    }

    private func run() async {
        isFetching = true
        if case .idle = phase { phase = .loading }
        defer { isFetching = false }
        do {
            let data = try await service.exchangeRates()
            phase = .loaded(data)
            fetchedAt = now()
        } catch is CancellationError {
            if case .loading = phase { phase = .idle }
        } catch {
            phase = .failed
            fetchedAt = nil
        }
    }

    private func post(_ kind: ScreenNotice.Kind, _ key: String) {
        notice = notices.make(kind, key)
    }
}

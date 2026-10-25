import Foundation
import Observation

@MainActor
@Observable
public final class TaxDashboardModel {
    public private(set) var data: TaxDashboardData?
    public private(set) var error: String?
    public private(set) var isFetching = false
    public var isLoading: Bool { isFetching && data == nil }
    @ObservationIgnored private let service: any TaxDashboardService
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private var context: String?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(service: any TaxDashboardService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.clock = now
    }
    public func invalidate(clearData: Bool = true) {
        revision = UUID()
        task?.cancel()
        task = nil
        fetchedAt = nil
        isFetching = false
        if clearData { data = nil }
    }
    public func load(
        year: Int? = nil, currency: CurrencyCode, now: Date? = nil, calendar: Calendar = .current, force: Bool = false
    ) async {
        let today = now ?? clock()
        let key = "\(year.map(String.init) ?? "live")|\(currency)|\(StatisticsWindow.day(today, calendar: calendar))"
        if context != key {
            invalidate()
            data = nil
            error = nil
            context = key
        }
        if !force, let fetchedAt, clock().timeIntervalSince(fetchedAt) < 30 { return }
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        isFetching = true
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let exclusions = try await service.homeExclusions(scope: "statistics")
                guard token == revision, !Task.isCancelled else { return }
                let query = StatisticsQuery(
                    currency: currency.rawValue, window: .rolling24, exclusions: exclusions, today: today, calendar: calendar)
                let value = try await service.taxDashboard(year: year, query: query)
                guard token == revision, !Task.isCancelled else { return }
                guard value.currency == currency, year == nil || value.year == year else {
                    throw APIError.contract(
                        APIContractError(
                            endpoint: "/api/belgian-tax/dashboard",
                            issues: ["year/currency: does not match the requested context"]))
                }
                data = value
                error = nil
                fetchedAt = clock()
            } catch {
                guard token == revision, !Task.isCancelled else { return }
                // Failed filter resolution must never label an old filter set's tax chart as current.
                data = nil
                self.error = error.localizedDescription
            }
        }
        self.task = task
        await task.value
        guard revision == token else { return }
        self.task = nil
        isFetching = false
    }
}

import Foundation
import Observation

/// Year selection and request state. Every displayed tax figure comes from the backend.
@MainActor
@Observable
public final class TaxOverviewModel {
    public private(set) var overview: OpenAPI.BelgianTaxOverview?
    public private(set) var error: String?
    public private(set) var isFetching = false
    public var isLoading: Bool { isFetching && overview == nil }
    public var isFrozen: Bool { overview?.calculationSource == "frozen" }

    @ObservationIgnored private let service: any TaxComputationService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var requestedYear: Int?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(service: any TaxComputationService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }

    public func invalidate() {
        revision = UUID()
        task?.cancel()
        task = nil
        fetchedAt = nil
        isFetching = false
    }

    public func load(year: Int? = nil, force: Bool = false) async {
        if year != requestedYear {
            invalidate()
            overview = nil
            error = nil
            requestedYear = year
        }
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 30 { return }
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
                let value = try await service.taxOverview(year: year)
                guard token == revision, !Task.isCancelled else { return }
                guard value.year == (year ?? value.liveYear) else {
                    throw APIError.contract(
                        APIContractError(
                            endpoint: "/api/belgian-tax/overview", issues: ["year: does not match the requested year"]))
                }
                overview = value
                error = nil
                fetchedAt = now()
            } catch {
                guard token == revision, !Task.isCancelled else { return }
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

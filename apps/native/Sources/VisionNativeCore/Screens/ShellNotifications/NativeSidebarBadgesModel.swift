import Foundation
import Observation

/// The three server counts behind `NavItemBadge`; the planned-due count is the shared
/// Upcoming banner's visible rows.
public protocol NativeSidebarBadgeService: Sendable {
    func sidebarNeedsCategoryCount() async throws -> Int
    func sidebarInsightsCount() async throws -> OpenAPI.InsightsCountData
    func sidebarMonitorUnreadCount() async throws -> Int
}

private struct MonitorUnreadCount: Decodable, Sendable {
    let unreadCount: Int
}

extension APIClient: NativeSidebarBadgeService {
    /// `useNeedsCategoryCount`: the list endpoint's total for a one-row uncategorised page.
    public func sidebarNeedsCategoryCount() async throws -> Int {
        try await send(OpenAPIOperations.GetTransactions(limit: 1, active: true, uncategorised: true), retries: 0)
            .total
    }
    public func sidebarInsightsCount() async throws -> OpenAPI.InsightsCountData {
        try await send(
            InsightRequest<OpenAPIOperations.GetInsightsCount, OpenAPI.InsightsCountData>(
                OpenAPIOperations.GetInsightsCount(), query: []),
            retries: 0)
    }
    /// The persisted unread count is calculated server-side across every inbox page.
    public func sidebarMonitorUnreadCount() async throws -> Int {
        let operation = OpenAPIOperations.ListAnalysisMonitorNotifications(offset: 0)
        let value: MonitorUnreadCount = try await send(
            InsightRequest(operation, query: operation.queryItems), retries: 0)
        return value.unreadCount
    }
}

/// `NavItemBadge`'s query policies: counts are fresh for 30 seconds (needs-category),
/// the monitor inbox refetches every 60 seconds and a pending insight projection is
/// polled every 2 seconds. A failed read keeps the last count, as a React Query refetch
/// keeps its data; a first failure shows no count.
@MainActor @Observable public final class NativeSidebarBadgesModel {
    public private(set) var needsCategory = 0
    public private(set) var insights = 0
    public private(set) var monitors = 0

    @ObservationIgnored private let service: any NativeSidebarBadgeService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var needsCategoryReadAt: Date?
    @ObservationIgnored private var insightsReadAt: Date?
    @ObservationIgnored private var insightsPending = false
    @ObservationIgnored private var monitorsReadAt: Date?

    static let needsCategoryFresh: TimeInterval = 30
    static let insightsFresh: TimeInterval = 60
    static let insightsPendingPoll: TimeInterval = 2
    static let monitorsInterval: TimeInterval = 60

    public init(service: any NativeSidebarBadgeService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }

    /// The shown count for a badge; `plannedDue` is the Upcoming banner's visible row count.
    public func count(for badge: NavBadge, plannedDue: Int) -> Int {
        switch badge {
        case .needsCategory: return needsCategory
        case .plannedDue: return plannedDue
        case .insights: return insights
        case .monitors: return monitors
        }
    }

    /// Reads every count whose policy says it is due; `force` refetches all (invalidation).
    public func refresh(force: Bool = false) async {
        let current = now()
        func due(_ readAt: Date?, _ interval: TimeInterval) -> Bool {
            force || readAt.map { current.timeIntervalSince($0) >= interval } ?? true
        }
        let category = due(needsCategoryReadAt, Self.needsCategoryFresh)
        let insight = due(insightsReadAt, insightsPending ? Self.insightsPendingPoll : Self.insightsFresh)
        let monitor = due(monitorsReadAt, Self.monitorsInterval)
        await withTaskGroup(of: Void.self) { group in
            if category { group.addTask { await self.loadNeedsCategory() } }
            if insight { group.addTask { await self.loadInsights() } }
            if monitor { group.addTask { await self.loadMonitors() } }
        }
    }

    /// Runs for the sidebar's lifetime and ends when its task is cancelled.
    public func run() async {
        while !Task.isCancelled {
            await refresh()
            let pause = insightsPending ? Self.insightsPendingPoll : min(Self.needsCategoryFresh, Self.monitorsInterval)
            try? await Task.sleep(for: .seconds(pause))
        }
    }

    private func loadNeedsCategory() async {
        needsCategoryReadAt = now()
        if let value = try? await service.sidebarNeedsCategoryCount() { needsCategory = max(0, value) }
    }

    private func loadInsights() async {
        insightsReadAt = now()
        guard let value = try? await service.sidebarInsightsCount() else { return }
        insightsPending = value.status == .pending
        // Only a ready projection shows a count; pending never exposes a stale one.
        insights = value.status == .ready ? max(0, value.count ?? 0) : 0
    }

    private func loadMonitors() async {
        monitorsReadAt = now()
        if let value = try? await service.sidebarMonitorUnreadCount() { monitors = max(0, value) }
    }
}

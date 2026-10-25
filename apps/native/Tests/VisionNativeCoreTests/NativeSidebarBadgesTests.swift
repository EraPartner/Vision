import Foundation
import Testing

@testable import VisionNativeCore

private actor FakeSidebarBadgeService: NativeSidebarBadgeService {
    var needsCategory: Result<Int, APIError> = .success(3)
    var insights: Result<OpenAPI.InsightsCountData, APIError> = .success(.init(count: 4, status: .ready))
    var monitors: Result<Int, APIError> = .success(2)
    private(set) var reads: [String] = []

    func set(
        needsCategory: Result<Int, APIError>? = nil, insights: Result<OpenAPI.InsightsCountData, APIError>? = nil,
        monitors: Result<Int, APIError>? = nil
    ) {
        if let needsCategory { self.needsCategory = needsCategory }
        if let insights { self.insights = insights }
        if let monitors { self.monitors = monitors }
    }

    func sidebarNeedsCategoryCount() async throws -> Int {
        reads.append("needsCategory")
        return try needsCategory.get()
    }
    func sidebarInsightsCount() async throws -> OpenAPI.InsightsCountData {
        reads.append("insights")
        return try insights.get()
    }
    func sidebarMonitorUnreadCount() async throws -> Int {
        reads.append("monitors")
        return try monitors.get()
    }
}

private final class BadgesTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}

@MainActor @Suite struct NativeSidebarBadgesTests {
    @Test func readsEveryCountAndPlannedDueComesFromTheUpcomingBanner() async {
        let service = FakeSidebarBadgeService()
        let model = NativeSidebarBadgesModel(service: service)
        await model.refresh()
        #expect(model.count(for: .needsCategory, plannedDue: 7) == 3)
        #expect(model.count(for: .insights, plannedDue: 7) == 4)
        #expect(model.count(for: .monitors, plannedDue: 7) == 2)
        #expect(model.count(for: .plannedDue, plannedDue: 7) == 7)
    }

    @Test func freshCountsAreNotReadAgainUntilTheirPolicyExpires() async {
        let service = FakeSidebarBadgeService()
        let clock = BadgesTestClock()
        let model = NativeSidebarBadgesModel(service: service, now: { clock.now })
        await model.refresh()
        clock.advance(29)
        await model.refresh()
        #expect(await service.reads.count == 3)
        clock.advance(1)
        await model.refresh()
        // Needs-category is stale after 30 s; insights after 60 s; monitors every 60 s.
        #expect(await service.reads.filter { $0 == "needsCategory" }.count == 2)
        #expect(await service.reads.filter { $0 == "insights" }.count == 1)
        clock.advance(30)
        await model.refresh()
        #expect(await service.reads.filter { $0 == "insights" }.count == 2)
        #expect(await service.reads.filter { $0 == "monitors" }.count == 2)
        await model.refresh(force: true)
        #expect(await service.reads.count == 10)
    }

    @Test func aPendingProjectionShowsNoCountAndIsPolledEveryTwoSeconds() async {
        let service = FakeSidebarBadgeService()
        await service.set(insights: .success(.init(count: 9, status: .pending)))
        let clock = BadgesTestClock()
        let model = NativeSidebarBadgesModel(service: service, now: { clock.now })
        await model.refresh()
        #expect(model.insights == 0)
        clock.advance(2)
        await service.set(insights: .success(.init(count: 5, status: .ready)))
        await model.refresh()
        #expect(model.insights == 5)
        await service.set(insights: .success(.init(count: 6, status: .unavailable)))
        await model.refresh(force: true)
        #expect(model.insights == 0)
    }

    @Test func aFailedReadKeepsTheLastCountAndAFirstFailureShowsNone() async {
        let service = FakeSidebarBadgeService()
        await service.set(monitors: .failure(.backendUnavailable))
        let model = NativeSidebarBadgesModel(service: service)
        await model.refresh()
        #expect(model.monitors == 0 && model.needsCategory == 3)
        await service.set(needsCategory: .failure(.backendUnavailable))
        await model.refresh(force: true)
        #expect(model.needsCategory == 3)
    }
}

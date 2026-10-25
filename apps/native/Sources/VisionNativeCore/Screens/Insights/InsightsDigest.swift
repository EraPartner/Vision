import Foundation
import Observation

public struct StatisticsDigest: Decodable, Equatable, Sendable {
    public struct NewSubscription: Decodable, Equatable, Sendable, Identifiable {
        public let recipientId: Int
        public let recipientName: String
        public let latestAmount: Decimal
        public let currency: String
        public let detectedPattern: String
        public let predictedNext: String
        public var id: Int { recipientId }
        public var dismissal: JSONValue {
            .object(["kind": .string("subscription_new"), "recipient_id": .int(recipientId)])
        }
    }
    public struct PriceChange: Decodable, Equatable, Sendable, Identifiable {
        public let recipientId: Int
        public let recipientName: String
        public let previousAmount: Decimal
        public let newAmount: Decimal
        public let percentChange: Decimal
        public let direction: String
        public let currency: String
        public var id: Int { recipientId }
        public var dismissal: JSONValue {
            .object(["kind": .string("subscription_price_change"), "recipient_id": .int(recipientId)])
        }
    }
    public struct Outlier: Decodable, Equatable, Sendable, Identifiable {
        public let categoryId: Int
        public let categoryName: String
        public let monthKey: String
        public let comparisonEndDay: Int
        public let currentAmount: Decimal
        public let baselineMedian: Decimal
        public let deviation: Decimal
        public let direction: String
        public var id: String { "\(categoryId):\(monthKey)" }
        public var dismissal: JSONValue {
            .object([
                "kind": .string("category_outlier"), "category_id": .int(categoryId), "month_key": .string(monthKey),
            ])
        }
    }
    public struct Subscriptions: Decodable, Equatable, Sendable {
        public let new: [NewSubscription]
        public let priceChanges: [PriceChange]
    }
    public let subscriptionCreep: Subscriptions
    public let categoryOutliers: [Outlier]
    public let cashForecast: OpenAPI.CashForecastInsight?
    public var findingCount: Int {
        subscriptionCreep.new.count + subscriptionCreep.priceChanges.count + categoryOutliers.count
    }
}

public protocol StatisticsDigestService: Sendable {
    func statisticsDigest() async throws -> StatisticsDigest
    func dismissStatisticsInsight(_ body: JSONValue) async throws
}
extension APIClient: StatisticsDigestService {
    public func statisticsDigest() async throws -> StatisticsDigest {
        try await send(
            InsightRequest<OpenAPIOperations.GetInsightsDigest, StatisticsDigest>(
                OpenAPIOperations.GetInsightsDigest(), query: []))
    }
    public func dismissStatisticsInsight(_ body: JSONValue) async throws {
        _ = try await send(OpenAPIOperations.DismissInsight(body: body))
    }
}

@MainActor
@Observable
public final class StatisticsDigestModel {
    public private(set) var data: StatisticsDigest?
    public private(set) var error: String?
    public private(set) var isLoading = true
    public private(set) var dismissing: Set<String> = []
    public var expanded = false
    @ObservationIgnored private let service: any StatisticsDigestService
    @ObservationIgnored private var loadedAt: Date?
    @ObservationIgnored private var task: Task<Void, Never>?
    public init(service: any StatisticsDigestService) { self.service = service }
    init(printSnapshot value: NativeStatisticsPrintSnapshot) {
        service = APIClient(baseURL: { nil })
        data = value.digest
        error = value.digestError
        expanded = value.digestExpanded
        isLoading = false
    }
    public func load(force: Bool = false) async {
        if !force, let loadedAt, Date().timeIntervalSince(loadedAt) < 30 { return }
        if let task {
            await task.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                self.data = try await self.service.statisticsDigest()
                self.error = nil
                self.loadedAt = Date()
            } catch let error as APIError {
                if case .contract = error { self.error = error.localizedDescription }
            } catch {}
            self.isLoading = false
        }
        self.task = task
        await task.value
        self.task = nil
    }
    public func dismiss(_ body: JSONValue, key: String) async {
        guard !dismissing.contains(key) else { return }
        dismissing.insert(key)
        do {
            try await service.dismissStatisticsInsight(body)
            await load(force: true)
        } catch { self.error = error.localizedDescription }
        dismissing.remove(key)
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Tax dashboard server data")
struct TaxDashboardTests {
    private static let fixture = #"""
        {"year":2025,"currency":"EUR","isHistorical":false,"hasIncomeSources":true,"hasStatsData":true,"isEmpty":false,
         "portfolioTaxesForYear":123456789012345.67,"totalTaxIncludingPortfolio":123456789012345.89,"totalTaxIncludingPropertyEstimate":null,
         "yearlyIncome":[{"year":"2025","income":0.1234567890123456789,"estimatedTax":0.02,"netAfterTax":0.1034567890123456789,"isApproximated":false}],
         "monthlyIncomeTax":[{"period":"2025-01","income":5000,"estimatedTax":200}],"recordedIncomeByPartner":{"A":3500,"B":1500},
         "yearCalculations":[{"year":2025,"calculation":{"totalPIT":0.02},"isFiled":true,"hasFrozenCalculation":true,"isCurrent":true,"hasSnapshot":true,"hasTransactions":true}],
         "currentInputs":{"employmentType":"employee","grossAnnualIncome":5000,"otherTaxableIncome":0,"professionalExpenseMethod":"lump_sum","actualProfessionalExpenses":0,"dependentChildren":0,"dependentOtherPersons":0,"isDisabled":false,"isSpouseDisabled":false},
         "exportProfile":{"taxYear":2025,"grossAnnualIncome":0.1234567890123456789},"suggestions":[],"householdBreakdownRows":[],"rules":[]}
        """#
    static func value() throws -> TaxDashboardData {
        try JSONDecoder().decode(TaxDashboardData.self, from: Data(fixture.utf8))
    }

    @Test func decodeRetainsDecimalAndUnavailableHistoricalFields() throws {
        let data = try Self.value()
        #expect(data.portfolioTaxesForYear == Decimal(string: "123456789012345.67"))
        #expect(data.yearlyIncome[0].income == Decimal(string: "0.1234567890123456789"))
        #expect(data.totalTaxIncludingPropertyEstimate == nil)
        #expect(data.yearCalculations[0].calculation.grossIncome == nil)
        #expect(data.exportProfile["grossAnnualIncome"] == .number(Decimal(string: "0.1234567890123456789")!))
    }

    @Test @MainActor func filtersResolveBeforeDashboardAndCurrencyChangeClearsData() async throws {
        let service = TaxDashboardFixture(value: try Self.value())
        let model = TaxDashboardModel(service: service)
        await model.load(year: 2025, currency: "EUR")
        #expect(model.data?.year == 2025)
        #expect(await service.events == ["filters:statistics", "dashboard:EUR"])
        #expect(await service.exclusions == InsightExclusions(categoryIds: [7], recipientIds: [8]))
        await model.load(year: 2025, currency: "USD")
        #expect(model.data == nil)
        #expect(model.error != nil)
    }

    @Test @MainActor func invalidationRejectsLateDataAndClearsPreviousValues() async throws {
        let service = TaxDashboardFixture(value: try Self.value())
        let model = TaxDashboardModel(service: service)
        await model.load(year: 2025, currency: "EUR")
        await service.pause()
        let old = Task { await model.load(year: 2025, currency: "EUR", force: true) }
        await service.waitUntilPending()
        model.invalidate(clearData: true)
        #expect(model.data == nil)
        await service.resume()
        await old.value
        #expect(model.data == nil)
        #expect(!model.isFetching)
    }
}
private actor TaxDashboardFixture: TaxDashboardService {
    let value: TaxDashboardData
    var events: [String] = []
    var exclusions: InsightExclusions?
    private var paused = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var pendingObserver: CheckedContinuation<Void, Never>?
    init(value: TaxDashboardData) { self.value = value }
    func homeExclusions(scope: String) async throws -> InsightExclusions {
        events.append("filters:\(scope)")
        return InsightExclusions(categoryIds: [7], recipientIds: [8])
    }
    func taxDashboard(year: Int?, query: StatisticsQuery) async throws -> TaxDashboardData {
        events.append("dashboard:\(query.currency)")
        exclusions = query.exclusions
        if paused {
            await withCheckedContinuation {
                continuation = $0
                pendingObserver?.resume()
                pendingObserver = nil
            }
        }
        return value
    }
    func pause() { paused = true }
    func waitUntilPending() async {
        if continuation != nil { return }
        await withCheckedContinuation { pendingObserver = $0 }
    }
    func resume() {
        paused = false
        continuation?.resume()
        continuation = nil
    }
}

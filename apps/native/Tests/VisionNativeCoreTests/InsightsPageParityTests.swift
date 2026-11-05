import Foundation
import Testing

@testable import VisionNativeCore

/// Home and Insights parity with the React pages: the pivot's group order, the forecast's
/// "With planned" default and the month-year label of the forecast subtitle.
@Suite("Home and Insights page parity")
struct InsightsPageParityTests {
    private static let pivotJSON =
        #"{"categoryPivot":{"2026-09":[{"categoryId":1,"categoryName":"FINANCE:Fees","categoryPathIds":[1,2],"categoryPathSegments":["FINANCE","Fees"],"total":-50,"income":0,"expense":-50,"transactionCount":1},{"categoryId":3,"categoryName":"INCOME:Salary","categoryPathIds":[3,4],"categoryPathSegments":["INCOME","Salary"],"total":5000,"income":5000,"expense":0,"transactionCount":1},{"categoryId":5,"categoryName":"HOUSING:Mortgage","categoryPathIds":[5,6],"categoryPathSegments":["HOUSING","Mortgage"],"total":-1200,"income":0,"expense":-1200,"transactionCount":1}]}}"#

    private func snapshot() throws -> StatisticsSnapshot {
        let decoder = JSONDecoder()
        return StatisticsSnapshot(
            monthly: try decoder.decode(InsightMonthlySummary.self, from: Data(#"{"months":[]}"#.utf8)),
            pivot: try decoder.decode(StatisticsCategoryPivot.self, from: Data(Self.pivotJSON.utf8)),
            recipients: try decoder.decode(
                StatisticsRecipientInsights.self, from: Data(#"{"topMerchants":[],"monthOverMonth":[]}"#.utf8)),
            recipientYears: try decoder.decode(
                StatisticsRecipientYears.self, from: Data(#"{"recipientsByYear":{}}"#.utf8)))
    }

    @Test func pivotGroupsAreOrderedByTotalLikeTheWebTableNotAlphabetically() throws {
        let absolute = try snapshot().categoryGroups(metric: .absolute, periods: ["2026-09"])
        #expect(absolute.map(\.name) == ["INCOME", "HOUSING", "FINANCE"])
        let income = try snapshot().categoryGroups(metric: .income, periods: ["2026-09"])
        #expect(income.map(\.name) == ["INCOME"])
    }

    @Test func netPivotGroupsAreOrderedByMagnitude() throws {
        let net = try snapshot().categoryGroups(metric: .net, periods: ["2026-09"])
        #expect(net.map(\.name) == ["INCOME", "HOUSING", "FINANCE"])
        #expect(net.map(\.total) == [5000, -1200, -50])
    }

    @Test func theForecastStartsWithoutPlannedPaymentsLikeTheWebSwitch() {
        #expect(InsightForecastOptions().includePlanned == false)
        #expect(
            InsightForecastOptions().queryItems.first { $0.name == "include_planned" }?.value == "false")
    }

    @Test func theForecastSubtitleMonthFollowsTheAppDateFormat() {
        #expect(VisionFormat.appMonthYear("2026-10", format: .dayMonthYearSlash) == "10/2026")
        #expect(VisionFormat.appMonthYear("2026-10", format: .monthDayYearSlash) == "10/2026")
        #expect(VisionFormat.appMonthYear("2026-10", format: .isoDate) == "2026-10")
        #expect(VisionFormat.appMonthYear("2026-10", format: .dayMonthYearDot) == "10.2026")
        #expect(VisionFormat.appMonthYear("2026-10", format: .dayMonthYearDash) == "10-2026")
        #expect(VisionFormat.appMonthYear("soon", format: .isoDate) == "soon")
    }
}

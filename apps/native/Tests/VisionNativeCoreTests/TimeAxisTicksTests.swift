import Foundation
import Testing
@testable import VisionNativeCore

/// The market chart's date ticks follow d3 `scaleTime().ticks(n)`.
struct TimeAxisTicksTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Brussels")!
        return calendar
    }()

    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    @Test func oneYearAtNineTicksIsMonthly() {
        let ticks = TimeAxisTicks.values(
            from: date("2025-11-14T00:00:00Z"), to: date("2026-11-14T00:00:00Z"), count: 9, calendar: calendar)
        #expect(ticks.count == 12)
        #expect(ticks.allSatisfy { calendar.component(.day, from: $0) == 1 })
    }

    @Test func oneMonthAtNineTicksIsEveryOtherDay() {
        let ticks = TimeAxisTicks.values(
            from: date("2026-10-14T00:00:00Z"), to: date("2026-11-14T00:00:00Z"), count: 9, calendar: calendar)
        #expect(ticks.count == 16)
        #expect(ticks.allSatisfy { (calendar.component(.day, from: $0) - 1) % 2 == 0 })
    }

    @Test func decadesStepByNiceYears() {
        let ticks = TimeAxisTicks.values(
            from: date("2000-01-01T00:00:00Z"), to: date("2026-11-14T00:00:00Z"), count: 9, calendar: calendar)
        #expect(ticks.map { calendar.component(.year, from: $0) } == Array(stride(from: 2002, through: 2026, by: 2)))
    }

    @Test func emptyRangeHasNoTicks() {
        let now = date("2026-11-14T00:00:00Z")
        #expect(TimeAxisTicks.values(from: now, to: now, count: 9, calendar: calendar).isEmpty)
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct VisionFormatLocalDayTests {
    @Test func dateOverloadWithoutAZoneUsesTheCurrentLocalCalendarDay() throws {
        let instant = try #require(VisionFormat.parseTimestamp("2026-01-01T00:30:00Z"))
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        #expect(VisionFormat.appDate(instant, format: .isoDate) == formatter.string(from: instant))
    }
    @Test func anInstantUsesTheRequestedDayAndAppDateStyleAcrossMidnight() throws {
        let instant = try #require(VisionFormat.parseTimestamp("2025-12-31T23:30:00Z"))
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let losAngeles = try #require(TimeZone(identifier: "America/Los_Angeles"))
        #expect(VisionFormat.appDate(instant, format: .isoDate, timeZone: tokyo) == "2026-01-01")
        #expect(VisionFormat.appDate(instant, format: .dayMonthYearSlash, timeZone: tokyo) == "01/01/2026")
        #expect(VisionFormat.appDate(instant, format: .monthDayYearSlash, timeZone: losAngeles) == "12/31/2025")
        #expect(VisionFormat.appDate(instant, format: .dayMonthYearDot, timeZone: losAngeles) == "31.12.2025")
    }
    @Test func upcomingTomorrowIsACalendarDayAcrossTheSpringClockChange() throws {
        let newYork = try #require(TimeZone(identifier: "America/New_York"))
        let today = try #require(VisionFormat.parseTimestamp("2026-03-08T04:30:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = newYork
        let tomorrow = try #require(calendar.date(byAdding: .day, value: 1, to: today))
        #expect(VisionFormat.appDate(today, format: .isoDate, timeZone: newYork) == "2026-03-07")
        #expect(VisionFormat.appDate(tomorrow, format: .isoDate, timeZone: newYork) == "2026-03-08")
        #expect(tomorrow.timeIntervalSince(today) == 23 * 60 * 60)
    }
    @Test func aStoredLedgerDayIsNotShiftedByTheFormattingZone() throws {
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let losAngeles = try #require(TimeZone(identifier: "America/Los_Angeles"))
        #expect(VisionFormat.appDate("2026-01-01", format: .isoDate, timeZone: tokyo) == "2026-01-01")
        #expect(VisionFormat.appDate("2026-01-01", format: .isoDate, timeZone: losAngeles) == "2026-01-01")
    }
}

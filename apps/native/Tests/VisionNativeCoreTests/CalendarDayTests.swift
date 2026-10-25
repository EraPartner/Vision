import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct CalendarDayTests {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return calendar
    }

    @Test func aRealDayParsesAndPrintsAsItWasWritten() throws {
        let day = try #require(CalendarDay(String("2026-10-25")))
        #expect(day.year == 2026)
        #expect(day.month == 10)
        #expect(day.day == 25)
        #expect(day.description == "2026-10-25")
    }

    @Test func leapDaysExistOnlyInLeapYears() {
        #expect(CalendarDay(String("2024-02-29")) != nil)
        #expect(CalendarDay(String("2000-02-29")) != nil)
        #expect(CalendarDay(String("2023-02-29")) == nil)
        #expect(CalendarDay(String("1900-02-29")) == nil)
    }

    @Test func daysThatDoNotExistAreRejected() {
        #expect(CalendarDay(String("2024-02-30")) == nil)
        #expect(CalendarDay(String("2024-04-31")) == nil)
        #expect(CalendarDay(String("2024-13-01")) == nil)
        #expect(CalendarDay(String("2024-00-10")) == nil)
        #expect(CalendarDay(String("2024-01-00")) == nil)
        #expect(CalendarDay(year: 2024, month: 1, day: 32) == nil)
    }

    @Test func onlyTenByteYearMonthDayTextIsAccepted() {
        let rejected = [
            "", "2024-1-5", "15/01/2024", "2024-01-15T10:30:00Z", "2024-01-15 ", " 2024-01-15",
            "2024/01/15", "abcd-ef-gh", "\u{FF12}\u{FF10}\u{FF12}\u{FF14}-01-15",
        ]
        for text in rejected {
            #expect(CalendarDay(text) == nil, "\(text) should be rejected")
        }
    }

    @Test func validatingThrowsTheOffendingText() throws {
        #expect(throws: CalendarDayError.invalid("soon")) {
            _ = try CalendarDay(validating: "soon")
        }
        #expect(try CalendarDay(validating: "2026-01-02").description == "2026-01-02")
    }

    @Test func aDecodeAndEncodeRoundTripKeepsTheText() throws {
        let data = Data("\"2024-02-29\"".utf8)
        let day = try JSONDecoder().decode(CalendarDay.self, from: data)
        #expect(day == CalendarDay(year: 2024, month: 2, day: 29))
        #expect(try JSONEncoder().encode(day) == data)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CalendarDay.self, from: Data("\"2024-02-30\"".utf8))
        }
    }

    @Test func daysOrderChronologically() throws {
        let earlier = try #require(CalendarDay(String("2025-12-31")))
        let later = try #require(CalendarDay(String("2026-01-01")))
        #expect(earlier < later)
        #expect(!(later < earlier))
        #expect([later, earlier].sorted() == [earlier, later])
    }

    @Test func aDayConvertsToADateInTheCalendarGiven() throws {
        let day = try #require(CalendarDay(String("2026-03-08")))
        let date = try #require(day.date(in: utc))
        let parts = utc.dateComponents([.year, .month, .day, .hour], from: date)
        #expect(parts.year == 2026)
        #expect(parts.month == 3)
        #expect(parts.day == 8)
        #expect(parts.hour == 0)
        #expect(CalendarDay(date, in: utc) == day)
    }

    @Test func theUnixEpochIsTheFirstOf1970() {
        #expect(CalendarDay.unixEpoch.description == "1970-01-01")
        #expect(CalendarDay.unixEpoch.date(in: utc)?.timeIntervalSince1970 == 0)
    }

    @Test func monthLengthsFollowTheLeapRule() {
        #expect(CalendarDay.daysInMonth(year: 2024, month: 2) == 29)
        #expect(CalendarDay.daysInMonth(year: 2023, month: 2) == 28)
        #expect(CalendarDay.daysInMonth(year: 2023, month: 4) == 30)
        #expect(CalendarDay.isLeapYear(2000))
        #expect(!CalendarDay.isLeapYear(2100))
    }

    @Test func aDayInAQueryIsItsWireText() throws {
        let day = try #require(CalendarDay(String("2026-10-25")))
        #expect(APIQuery.value(day) == "2026-10-25")
    }
}

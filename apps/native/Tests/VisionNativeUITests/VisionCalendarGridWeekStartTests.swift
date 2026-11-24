import Foundation
import Testing
import VisionNativeCore

@testable import VisionNativeUI

/// The month grid honors `AppSettings.startOfWeek` (web `DatePicker`'s
/// `weekStartsOnFromSetting`), not the system calendar's own first weekday.
@MainActor
@Suite("Vision calendar grid week start")
struct VisionCalendarGridWeekStartTests {
    private static var gregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }

    @Test func settingPicksTheWeeksFirstDay() {
        #expect(VisionCalendarGrid.weekday(from: StartOfWeek.sunday) == 1)
        #expect(VisionCalendarGrid.weekday(from: StartOfWeek.monday) == 2)
        #expect(VisionCalendarGrid.weekday(from: StartOfWeek.unknown("Saturday")) == 2)
        #expect(StartOfWeek.sunday.firstWeekday == 1)
        #expect(StartOfWeek.monday.firstWeekday == 2)
    }

    @Test func anUnknownWeekdayFallsBackToTheCalendar() {
        #expect(VisionCalendarGrid.normalWeekday(9, calendar: Self.gregorian) == Self.gregorian.firstWeekday)
        #expect(VisionCalendarGrid.normalWeekday(0, calendar: Self.gregorian) == Self.gregorian.firstWeekday)
    }

    /// A month that starts on a Sunday leads zero cells for sunday-first and six for monday-first.
    @Test func gridStartLeadsFromTheChosenWeekday() throws {
        let calendar = Self.gregorian
        let march = try #require(calendar.date(from: DateComponents(year: 2026, month: 3, day: 1)))
        let sundayLead = try #require(VisionCalendarGrid.gridStart(march, in: calendar, firstWeekday: 1))
        let mondayLead = try #require(VisionCalendarGrid.gridStart(march, in: calendar, firstWeekday: 2))
        #expect(calendar.isDate(sundayLead, inSameDayAs: march))
        let leadWeek = try #require(calendar.date(from: DateComponents(year: 2026, month: 2, day: 23)))
        #expect(calendar.isDate(mondayLead, inSameDayAs: leadWeek))
    }

    /// A month that starts on a Monday is the mirrored boundary: no lead for monday-first, six for sunday-first.
    @Test func gridStartLeadsFromTheChosenWeekdayOnTheOppositeBoundary() throws {
        let calendar = Self.gregorian
        let june = try #require(calendar.date(from: DateComponents(year: 2026, month: 6, day: 1)))
        let sundayLead = try #require(VisionCalendarGrid.gridStart(june, in: calendar, firstWeekday: 1))
        let mondayLead = try #require(VisionCalendarGrid.gridStart(june, in: calendar, firstWeekday: 2))
        #expect(calendar.isDate(mondayLead, inSameDayAs: june))
        let leadWeek = try #require(calendar.date(from: DateComponents(year: 2026, month: 5, day: 31)))
        #expect(calendar.isDate(sundayLead, inSameDayAs: leadWeek))
    }

    /// The grid is always six full weeks whose first row starts on the chosen weekday.
    @Test func gridDaysCoverSixWeeksFromTheChosenWeekday() throws {
        let calendar = Self.gregorian
        let march = try #require(calendar.date(from: DateComponents(year: 2026, month: 3, day: 1)))
        let sunday = VisionCalendarGrid.gridDays(from: march, in: calendar, firstWeekday: 1)
        let monday = VisionCalendarGrid.gridDays(from: march, in: calendar, firstWeekday: 2)
        #expect(sunday.count == 42 && calendar.component(.weekday, from: sunday[0]) == 1)
        #expect(monday.count == 42 && calendar.component(.weekday, from: monday[0]) == 2)
    }

    @Test func weekdayRowStartsOnTheChosenDay() {
        let symbols = Self.gregorian.shortWeekdaySymbols
        let sunday = VisionCalendarGrid.rotatedSymbols(symbols, firstWeekday: 1)
        let monday = VisionCalendarGrid.rotatedSymbols(symbols, firstWeekday: 2)
        #expect(sunday.first == "Sun" && sunday.last == "Sat")
        #expect(monday.first == "Mon" && monday.last == "Sun")
    }
}

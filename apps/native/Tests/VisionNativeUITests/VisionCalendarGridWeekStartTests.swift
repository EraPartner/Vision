import Foundation
import Testing

@testable import VisionNativeUI
@testable import VisionNativeCore

/// The month grid honors `AppSettings.startOfWeek` (web `DatePicker`'s
/// `weekStartsOnFromSetting`), not the system calendar's own first weekday.
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
        #expect(
            calendar.isDate(
                mondayLead, inSameDayAs: try #require(calendar.date(from: DateComponents(year: 2026, month: 2, day: 23)))
            ))
    }

    /// A month that starts on a Monday is the mirrored boundary: no lead for monday-first, six for sunday-first.
    @Test func gridStartLeadsFromTheChosenWeekdayOnTheOppositeBoundary() throws {
        let calendar = Self.gregorian
        let june = try #require(calendar.date(from: DateComponents(year: 2026, month: 6, day: 1)))
        let sundayLead = try #require(VisionCalendarGrid.gridStart(june, in: calendar, firstWeekday: 1))
        let mondayLead = try #require(VisionCalendarGrid.gridStart(june, in: calendar, firstWeekday: 2))
        #expect(calendar.isDate(mondayLead, inSameDayAs: june))
        #expect(
            calendar.isDate(
                sundayLead, inSameDayAs: try #require(calendar.date(from: DateComponents(year: 2026, month: 5, day: 31)))
            ))
    }

    @Test func weekdayRowStartsOnTheChosenDay() {
        let symbols = Self.gregorian.shortWeekdaySymbols
        let sunday = VisionCalendarGrid.rotatedSymbols(symbols, firstWeekday: 1)
        let monday = VisionCalendarGrid.rotatedSymbols(symbols, firstWeekday: 2)
        #expect(sunday.first == "Sun" && sunday.last == "Sat")
        #expect(monday.first == "Mon" && monday.last == "Sun")
    }

    @Test func weekdayRowIsLocalizedAndStartsOnTheChosenDay() {
        let dutch = VisionCalendarGrid.weekdaySymbolRow(
            calendar: Self.gregorian, locale: Locale(identifier: "nl_NL"), firstWeekday: 2)
        #expect(dutch.first == "ma" && dutch.last == "zo")
        let sundayEnglish = VisionCalendarGrid.weekdaySymbolRow(
            calendar: Self.gregorian, locale: Locale(identifier: "en_US"), firstWeekday: 1)
        #expect(sundayEnglish.first == "Su" && sundayEnglish.last == "Sa")
    }

    /// The grid is always six full weeks whose first row starts on the chosen weekday.
    @Test func gridDaysCoverSixWeeksFromTheChosenWeekday() throws {
        let calendar = Self.gregorian
        let march = try #require(calendar.date(from: DateComponents(year: 2026, month: 3, day: 1)))
        let sunday = VisionCalendarGrid.gridDays(from: march, in: calendar, firstWeekday: 1)
        let monday = VisionCalendarGrid.gridDays(from: march, in: calendar, firstWeekday: 2)
        let weekday = { calendar.component(.weekday, from: $0) }
        #expect(sunday.count == 42 && weekday(sunday[0]) == 1)
        #expect(monday.count == 42 && weekday(monday[0]) == 2)
        let lastSunday = try #require(calendar.date(byAdding: .day, value: 41, to: sunday[0]))
        #expect(calendar.isDate(lastSunday, inSameDayAs: sunday[41]))
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

/// A gate a fake call waits on until the test opens it.
final class CallGate: Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation

    init() {
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        self.stream = stream
        self.continuation = continuation
    }

    func wait() async {
        for await _ in stream { return }
    }

    func open() {
        continuation.finish()
    }
}

/// A planned-payments service over an in-memory list that records every call.
actor FakePlannedService: PlannedPaymentsService {
    private(set) var rows: [OpenAPI.PlannedTransaction]
    private(set) var loads: [Bool] = []
    /// `"id:isActive"` per update.
    private(set) var updates: [String] = []
    private(set) var deletes: [Int] = []
    private(set) var lookups: [Int] = []
    private var loadFailures = 0
    private var updateFails = false
    private var deleteFails = false
    private var transactions: [Int: OpenAPI.Transaction] = [:]
    private var failingLookups: Set<Int> = []
    private var loadGate: CallGate?
    private var lookupGate: CallGate?
    private var updateGate: CallGate?

    init(rows: [OpenAPI.PlannedTransaction] = []) {
        self.rows = rows
    }

    func failLoads(_ count: Int) { loadFailures = count }
    func failUpdates(_ fail: Bool) { updateFails = fail }
    func failDeletes(_ fail: Bool) { deleteFails = fail }
    func holdLoads(_ gate: CallGate?) { loadGate = gate }
    func holdLookups(_ gate: CallGate?) { lookupGate = gate }
    func holdUpdates(_ gate: CallGate?) { updateGate = gate }

    func setTransactions(_ list: [OpenAPI.Transaction], failing: Set<Int> = []) {
        transactions = Dictionary(uniqueKeysWithValues: list.map { transaction in (transaction.id, transaction) })
        failingLookups = failing
    }

    func plannedPayments(includePaused: Bool) async throws -> [OpenAPI.PlannedTransaction] {
        loads.append(includePaused)
        if let loadGate { await loadGate.wait() }
        if loadFailures > 0 {
            loadFailures -= 1
            throw APIError.network("offline")
        }
        return includePaused ? rows : rows.filter { row in row.isActive }
    }

    func setPlannedPaymentActive(id: Int, isActive: Bool) async throws -> OpenAPI.PlannedTransaction {
        updates.append("\(id):\(isActive)")
        if let updateGate { await updateGate.wait() }
        if updateFails { throw APIError.network("offline") }
        guard let index = rows.firstIndex(where: { row in row.id == id }) else { throw APIError.network("missing") }
        let updated = PlannedFixture.copy(rows[index], isActive: isActive)
        rows[index] = updated
        return updated
    }

    func deletePlannedPayment(id: Int) async throws {
        deletes.append(id)
        if deleteFails { throw APIError.network("offline") }
        rows.removeAll { row in row.id == id }
    }

    func transaction(id: Int) async throws -> OpenAPI.Transaction? {
        lookups.append(id)
        if let lookupGate { await lookupGate.wait() }
        if failingLookups.contains(id) { throw APIError.network("offline") }
        return transactions[id]
    }
}

enum PlannedFixture {
    /// Brussels time; "today" is Monday 12 October 2026, 10:00.
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Brussels") ?? TimeZone(secondsFromGMT: 3600)!
        return calendar
    }

    static var today: Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 12, hour: 10)) ?? Date(timeIntervalSince1970: 0)
    }

    static func row(
        id: Int, name: String? = nil, date: String = "2026-10-14", amount: Decimal = -50, currency: String? = "EUR",
        recipient: String? = nil, category: String? = nil, url: String? = nil, recurring: Bool = false,
        pattern: String? = nil, isLoan: Bool? = nil, loanTermMonths: Int? = nil, isExecuted: Bool = false,
        lastExecutedDate: String? = nil, executedTransactionId: Int? = nil, executionCount: Int = 0,
        executions: [OpenAPI.PlannedTransactionExecution]? = nil, isActive: Bool = true
    ) -> OpenAPI.PlannedTransaction {
        OpenAPI.PlannedTransaction(
            id: id, plannedDate: date, recipientName: recipient, memo: name ?? "Payment \(id)", amount: amount,
            currency: currency, categoryName: category, url: url, isRecurring: recurring, recurrencePattern: pattern,
            isLoan: isLoan, loanTermMonths: loanTermMonths, isExecuted: isExecuted, lastExecutedDate: lastExecutedDate,
            executedTransactionId: executedTransactionId, executionCount: executionCount, executions: executions,
            isActive: isActive, links: [])
    }

    static func copy(_ row: OpenAPI.PlannedTransaction, isActive: Bool) -> OpenAPI.PlannedTransaction {
        OpenAPI.PlannedTransaction(
            id: row.id, plannedDate: row.plannedDate, bankAccount: row.bankAccount, accountId: row.accountId,
            recipientId: row.recipientId, recipientName: row.recipientName, memo: row.memo, amount: row.amount,
            currency: row.currency, categoryId: row.categoryId, categoryName: row.categoryName, comment: row.comment,
            url: row.url, isRecurring: row.isRecurring, recurrencePattern: row.recurrencePattern,
            recurrenceEndDate: row.recurrenceEndDate, maxOccurrences: row.maxOccurrences, isLoan: row.isLoan,
            loanType: row.loanType, loanPrincipal: row.loanPrincipal,
            loanAnnualInterestRate: row.loanAnnualInterestRate,
            loanTermMonths: row.loanTermMonths, loanStartDate: row.loanStartDate, loanPaymentDay: row.loanPaymentDay,
            loanRegularPaymentAmount: row.loanRegularPaymentAmount, loanFirstPaymentDate: row.loanFirstPaymentDate,
            loanSchedule: row.loanSchedule, isExecuted: row.isExecuted, lastExecutedDate: row.lastExecutedDate,
            executedTransactionId: row.executedTransactionId, executionCount: row.executionCount,
            executions: row.executions, tags: row.tags, isActive: isActive, createdAt: row.createdAt,
            updatedAt: "2026-10-12T08:00:00.000Z", links: row.links)
    }

    static func execution(_ transactionId: Int, _ date: String) -> OpenAPI.PlannedTransactionExecution {
        OpenAPI.PlannedTransactionExecution(
            id: transactionId * 10, executedTransactionId: transactionId, executionDate: date)
    }

    static func transaction(
        _ id: Int, date: String = "2026-10-01", memo: String? = nil, recipient: String? = nil, category: String? = nil,
        amount: Decimal = -50
    ) -> OpenAPI.Transaction {
        OpenAPI.Transaction(
            id: id, transactionDate: date, recipientName: recipient, memo: memo, amount: amount, currency: "EUR",
            categoryName: category, links: [])
    }

    static func payment(_ row: OpenAPI.PlannedTransaction, currency: String = "EUR") -> PlannedPayment {
        PlannedPayment(row, defaultCurrency: currency)
    }

    static func rates() -> OpenAPI.ExchangeRates {
        OpenAPI.ExchangeRates(
            totalRates: 2,
            rates: [
                OpenAPI.ExchangeRate(
                    currency: "USD", rateToEur: Decimal(string: "1.0842")!, rateDate: "2026-10-09",
                    fetchedAt: "2026-10-09T15:05:00.000Z"),
                OpenAPI.ExchangeRate(
                    currency: "JPY", rateToEur: 0, rateDate: "2026-10-09", fetchedAt: "2026-10-09T15:05:00.000Z"),
            ],
            source: "database", isStale: false, lastFetchedAt: nil)
    }

    @MainActor
    static func model(
        _ service: FakePlannedService, clock: TestClock? = nil,
        rates: [Result<OpenAPI.ExchangeRates, APIError>] = [],
        editing: FakePlannedEditingService = FakePlannedEditingService(),
        pickers: FakePickerService = FakePickerService(), dismissals: PlannedDismissalStore = .memory()
    ) -> PlannedPaymentsModel {
        let time = clock ?? TestClock()
        return PlannedPaymentsModel(
            service: service, editing: editing, pickers: pickers,
            rates: ExchangeRatesModel(service: FakeExchangeRatesService(rates: rates)), dismissals: dismissals,
            calendar: calendar, now: { time.now }, retryDelay: .zero)
    }

    @MainActor
    static func idleModel() -> PlannedPaymentsModel {
        model(FakePlannedService())
    }

    static func close(_ left: Decimal, _ right: Decimal) -> Bool {
        abs(left - right) < Decimal(string: "0.000001")!
    }
}

// MARK: Rows and figures

@Suite struct PlannedPaymentMappingTests {
    @Test func theRowNamesFallBackFromMemoToPayeeToUnnamed() {
        let named = PlannedFixture.payment(PlannedFixture.row(id: 1, name: "Rent", recipient: "Landlord"))
        #expect(named.name == "Rent")
        let payee = PlannedFixture.payment(PlannedFixture.row(id: 2, name: "", recipient: "Landlord"))
        #expect(payee.name == "Landlord")
        let wire = OpenAPI.PlannedTransaction(
            id: 3, plannedDate: "2026-10-14T00:00:00.000Z", amount: 5, isRecurring: false, isExecuted: false,
            executionCount: 0, isActive: true, links: [])
        let unnamed = PlannedPayment(wire, defaultCurrency: "CHF")
        #expect(unnamed.name == "Unnamed payment")
        #expect(unnamed.currency == "CHF")
        #expect(unnamed.dueDate == "2026-10-14")
        #expect(unnamed.executions.isEmpty)
        #expect(!unnamed.isLoan)
    }

    @Test func recurrencePatternsBecomeFrequencies() {
        let weekly = PlannedPayment.recurrence("WEEKLY")
        #expect(weekly.frequency == .weekly)
        #expect(weekly.customDays == nil)
        let custom = PlannedPayment.recurrence("every 14 days")
        #expect(custom.frequency == .custom)
        #expect(custom.customDays == 14)
        #expect(PlannedPayment.recurrence("custom").frequency == .monthly)
        #expect(PlannedPayment.recurrence(nil).frequency == .monthly)
        #expect(PlannedPayment.recurrence("soon").frequency == .monthly)
        let oneTime = PlannedFixture.payment(PlannedFixture.row(id: 1, pattern: "weekly"))
        #expect(oneTime.frequency == nil)
    }

    @Test func theRecurrenceColumnSaysLoanTermFrequencyOrOneTime() {
        let strings = DictionaryStrings(
            language: .en,
            table: [
                "plannedPage.loanTerm.other": "{count} months", "plannedPage.oneTime": "One-time",
                "plannedPage.everyNDays": "Every {n} days", "plannedPage.freq.weekly": "Weekly",
                "plannedPage.executedCount": "Paid {n} times",
            ])
        let loan = PlannedFixture.payment(
            PlannedFixture.row(id: 1, recurring: true, pattern: "monthly", isLoan: true, loanTermMonths: 24))
        #expect(loan.recurrenceText(strings) == "24 months")
        #expect(loan.showsRepeat)
        let oneTime = PlannedFixture.payment(PlannedFixture.row(id: 2))
        #expect(oneTime.recurrenceText(strings) == "One-time")
        #expect(!oneTime.showsRepeat)
        #expect(oneTime.executedText(strings) == nil)
        let custom = PlannedFixture.payment(PlannedFixture.row(id: 3, recurring: true, pattern: "10"))
        #expect(custom.recurrenceText(strings) == "Every 10 days")
        let weekly = PlannedFixture.payment(
            PlannedFixture.row(id: 4, recurring: true, pattern: "weekly", executionCount: 3))
        #expect(weekly.recurrenceText(strings) == "Weekly")
        #expect(weekly.executedText(strings) == "Paid 3 times")
    }

    @Test func linksAreSafeAndPaidRowsLinkToTheirTransaction() {
        #expect(PlannedLinks.safeURL(" https://example.com/bill ")?.absoluteString == "https://example.com/bill")
        #expect(PlannedLinks.safeURL("//example.com/a")?.absoluteString == "https://example.com/a")
        #expect(PlannedLinks.safeURL("example.com") == nil)
        #expect(PlannedLinks.safeURL("javascript:alert(1)") == nil)
        #expect(PlannedLinks.safeURL("ftp://example.com") == nil)
        #expect(PlannedLinks.safeURL("   ") == nil)
        #expect(PlannedLinks.safeURL(nil) == nil)
        let paid = PlannedFixture.payment(PlannedFixture.row(id: 1, isExecuted: true, executedTransactionId: 42))
        #expect(paid.linkedTransactionRoute == "/transactions?transaction_id=42")
        #expect(paid.isStruckThrough)
        let paused = PlannedFixture.payment(PlannedFixture.row(id: 2, isActive: false))
        #expect(paused.isStruckThrough)
        #expect(paused.linkedTransactionRoute == nil)
    }

    @Test func theRawFieldsAreWhatTheTableSearchesAndSorts() {
        let payment = PlannedFixture.payment(
            PlannedFixture.row(id: 1, name: "Rent", amount: -40, category: "Housing", recurring: true))
        #expect(payment.rawValue("name") == .text("Rent"))
        #expect(payment.rawValue("amount") == .number(-40))
        #expect(payment.rawValue("amount").string == "-40")
        #expect(payment.rawValue("due_date") == .text("2026-10-14"))
        #expect(payment.rawValue("is_recurring") == .bool(true))
        #expect(payment.rawValue("is_recurring").string == "true")
        #expect(payment.rawValue("category") == .text("Housing"))
        #expect(payment.rawValue("is_executed") == .bool(false))
        #expect(payment.rawValue("actions") == TableRawValue.none)
        let uncategorised = PlannedFixture.payment(PlannedFixture.row(id: 2))
        #expect(uncategorised.rawValue("category").string == nil)
    }
}

@Suite struct PlannedDueDateTests {
    let calendar = PlannedFixture.calendar
    let today = PlannedFixture.today

    func state(_ text: String?) -> PlannedDueState {
        PlannedDueState(dueDate: text, today: today, calendar: calendar)
    }

    @Test func theBadgeCountsLocalCalendarDays() {
        #expect(state("2026-10-12") == .today)
        #expect(state("2026-10-12T23:30:00Z") == .today)
        #expect(state("2026-10-11") == .overdue)
        #expect(state("2026-10-13") == .tomorrow)
        #expect(state("2026-10-14") == .inDays(2))
        #expect(state("2026-10-19") == .inDays(7))
        #expect(state("2026-10-20") == .date(PlannedDay(year: 2026, month: 10, day: 20)))
        #expect(state(nil) == .noDate)
        #expect(state("") == .noDate)
        #expect(state("soon") == .invalid)
        #expect(state("2026-x-01") == .invalid)
    }

    @Test func overflowingMonthsAndDaysRollOverLikeTheDateConstructor() {
        #expect(state("2026-13-01") == .date(PlannedDay(year: 2027, month: 1, day: 1)))
        #expect(state("2026-10-") == .overdue)
        #expect(state("2026-02-30") == .overdue)
        #expect(state("2026-10-40") == .date(PlannedDay(year: 2026, month: 11, day: 9)))
    }

    @Test func theBadgeTextUsesTheKeysAndTheAppDateFormat() {
        let strings = DictionaryStrings(language: .en, table: ["plannedPage.due.inDays": "in {n} days"])
        #expect(PlannedDueState.inDays(3).text(strings, format: .dayMonthYearSlash) == "in 3 days")
        #expect(PlannedDueState.today.text(strings, format: .dayMonthYearSlash) == "plannedPage.due.today")
        let day = PlannedDay(year: 2026, month: 11, day: 9)
        #expect(
            PlannedDueState.date(day).text(strings, format: .dayMonthYearSlash)
                == VisionFormat.appDate(year: 2026, month: 11, day: 9, format: .dayMonthYearSlash))
    }
}

@Suite struct PlannedFiguresTests {
    let converter = PlannedCurrencyConverter(rates: PlannedFixture.rates(), target: "EUR")

    @Test func conversionUsesStoredRatesOnlyAndSkipsMissingOrZeroRates() {
        #expect(converter.ratesToEur["USD"] == Decimal(string: "1.0842"))
        #expect(converter.convert(-100, from: "usd") == Decimal(-100) * Decimal(string: "1.0842")!)
        // No stored rate: unavailable, never converted at a built-in constant.
        #expect(converter.convert(10, from: "GBP") == nil)
        #expect(converter.convert(10, from: nil) == 10)
        #expect(converter.convert(10, from: "XYZ") == nil)
        #expect(converter.convert(10, from: "JPY") == nil)
        let toUSD = PlannedCurrencyConverter(rates: PlannedFixture.rates(), target: "USD")
        #expect(toUSD.convert(10, from: "EUR") == Decimal(10) / Decimal(string: "1.0842")!)
        #expect(toUSD.convert(10, from: "usd") == 10)
        let noRates = PlannedCurrencyConverter(rates: nil, target: "EUR")
        #expect(noRates.convert(10, from: "USD") == nil)
        #expect(noRates.convert(10, from: "XYZ") == nil)
        let sameUnknown = PlannedCurrencyConverter(rates: nil, target: "XYZ")
        #expect(sameUnknown.convert(10, from: "xyz") == 10)
    }

    @Test func theStripBucketsEightDaysOfActivePaymentsWithTheirTotal() {
        let rows = [
            PlannedFixture.row(id: 1, name: "Small", date: "2026-10-12", amount: -10),
            PlannedFixture.row(id: 2, name: "Rent", date: "2026-10-12", amount: -200),
            PlannedFixture.row(id: 3, name: "Gym", date: "2026-10-12", amount: -50),
            PlannedFixture.row(id: 4, name: "Paused", date: "2026-10-12", amount: -999, isActive: false),
            PlannedFixture.row(id: 5, name: "Odd", date: "2026-10-15", amount: -5, currency: "XYZ"),
            PlannedFixture.row(id: 6, name: "Cloud", date: "2026-10-19", amount: -100, currency: "USD"),
            PlannedFixture.row(id: 7, name: "Later", date: "2026-10-20", amount: -1),
            PlannedFixture.row(id: 8, name: "Past", date: "2026-10-11", amount: -1),
            PlannedFixture.row(id: 9, name: "Broken", date: "soon", amount: -1),
        ]
        let strip = PlannedStrip(
            payments: rows.map { row in PlannedFixture.payment(row) }, today: PlannedFixture.today,
            calendar: PlannedFixture.calendar, converter: converter)
        #expect(strip.buckets.count == PlannedStrip.windowDays)
        #expect(strip.buckets[0].isToday)
        #expect(!strip.buckets[1].isToday)
        #expect(strip.buckets[0].items.map { payment in payment.name } == ["Rent", "Gym", "Small"])
        #expect(strip.buckets[0].shown.map { payment in payment.name } == ["Rent", "Gym"])
        #expect(strip.buckets[0].overflow == 1)
        #expect(strip.buckets[3].items.map { payment in payment.name } == ["Odd"])
        #expect(strip.buckets[7].items.map { payment in payment.name } == ["Cloud"])
        #expect(strip.buckets[7].day == 19)
        #expect(strip.dueCount == 5)
        let expected = Decimal(-260) + Decimal(-100) * Decimal(string: "1.0842")!
        #expect(strip.windowTotal == PlannedConvertedTotal(total: expected, unavailableCount: 1))
        #expect(strip.from == PlannedDay(year: 2026, month: 10, day: 12))
        #expect(strip.to == PlannedDay(year: 2026, month: 10, day: 19))
        let strings = DictionaryStrings(language: .en, table: ["plannedPage.next7.range": "{from} – {to}"])
        #expect(strip.rangeText(strings, format: .dayMonthYearSlash).contains(" – "))
    }

    @Test func anEmptyWindowHasEightEmptyTiles() {
        let strip = PlannedStrip(
            payments: [], today: PlannedFixture.today, calendar: PlannedFixture.calendar, converter: converter)
        #expect(strip.buckets.count == 8)
        #expect(strip.dueCount == 0)
        #expect(strip.windowTotal == PlannedConvertedTotal(total: 0, unavailableCount: 0))
        #expect(strip.buckets.allSatisfy { bucket in bucket.items.isEmpty && bucket.overflow == 0 })
    }

    @Test func estimatedMonthlyWeighsActiveRecurringRowsByFrequency() {
        let rows = [
            PlannedFixture.row(id: 1, amount: -10, recurring: true, pattern: "weekly"),
            PlannedFixture.row(id: 2, amount: -100, recurring: true, pattern: nil),
            PlannedFixture.row(id: 3, amount: -1200, recurring: true, pattern: "yearly"),
            PlannedFixture.row(id: 4, amount: -20, recurring: true, pattern: "every 15 days"),
            PlannedFixture.row(id: 5, amount: -300, recurring: true, pattern: "quarterly"),
            PlannedFixture.row(id: 6, amount: 1, recurring: true, pattern: "daily"),
            PlannedFixture.row(id: 7, amount: -10, recurring: true, pattern: "biweekly"),
            PlannedFixture.row(id: 8, amount: -500, recurring: true, pattern: "monthly", isActive: false),
            PlannedFixture.row(id: 9, amount: -700),
            PlannedFixture.row(id: 10, amount: -5, currency: "XYZ", recurring: true, pattern: "monthly"),
        ]
        let total = PlannedTotals.monthly(rows.map { row in PlannedFixture.payment(row) }, converter: converter)
        // -43.3 - 100 - 100 - 40 - 100 + 30 - 21.7
        #expect(PlannedFixture.close(total.total, Decimal(string: "-375")!))
        #expect(total.unavailableCount == 1)
        #expect(PlannedFrequency.custom.monthlyMultiplier(customIntervalDays: 0) == 1)
        #expect(PlannedFrequency.custom.monthlyMultiplier(customIntervalDays: nil) == 1)
    }
}

// MARK: Table query

@Suite struct LocalTableQueryTests {
    struct Row: Equatable {
        let name: String
        let amount: Decimal
        let category: String?
        let flag: Bool

        func value(_ key: String) -> TableRawValue {
            switch key {
            case "name": return .text(name)
            case "amount": return .number(amount)
            case "category": return category.map { text in TableRawValue.text(text) } ?? TableRawValue.none
            case "flag": return .bool(flag)
            default: return .none
            }
        }
    }

    let rows = [
        Row(name: "Rent", amount: -1000, category: "Housing", flag: true),
        Row(name: "Insurance 10", amount: -300, category: nil, flag: false),
        Row(name: "gym", amount: -40, category: "Sport", flag: true),
        Row(name: "Insurance 9", amount: -200, category: "Housing", flag: false),
    ]
    let keys = ["name", "amount", "category", "flag"]

    func names(_ query: LocalTableQuery) -> [String] {
        query.apply(rows, keys: keys) { row, key in row.value(key) }.map { row in row.name }
    }

    @Test func searchMatchesAnyColumnCaseInsensitivelyOnlyWhenItHasText() {
        var query = LocalTableQuery()
        query.search = "INSUR"
        #expect(names(query) == ["Insurance 10", "Insurance 9"])
        query.search = "   "
        #expect(names(query) == ["Rent", "Insurance 10", "gym", "Insurance 9"])
        #expect(query.isNarrowed)
        query.search = "-40"
        #expect(names(query) == ["gym"])
        query.search = "true"
        #expect(names(query) == ["Rent", "gym"])
    }

    @Test func sortCyclesAscendingDescendingAndOffWithNumericText() {
        var query = LocalTableQuery()
        query.toggleSort("name")
        #expect(query.sort == LocalTableSort(key: "name", ascending: true))
        #expect(names(query) == ["gym", "Insurance 9", "Insurance 10", "Rent"])
        query.toggleSort("name")
        #expect(names(query) == ["Rent", "Insurance 10", "Insurance 9", "gym"])
        query.toggleSort("name")
        #expect(query.sort == nil)
        #expect(names(query) == ["Rent", "Insurance 10", "gym", "Insurance 9"])
        query.toggleSort("amount")
        #expect(names(query) == ["Rent", "Insurance 10", "Insurance 9", "gym"])
        query.toggleSort("category")
        #expect(query.sort == LocalTableSort(key: "category", ascending: true))
        // No category sorts as "", first; equal values keep their order.
        #expect(names(query) == ["Insurance 10", "Rent", "Insurance 9", "gym"])
        query.toggleSort("flag")
        #expect(names(query) == ["Insurance 10", "Insurance 9", "Rent", "gym"])
    }

    @Test func columnFiltersKeepTheirPlaceAndClearAllResetsEverything() {
        var query = LocalTableQuery()
        #expect(!query.showsClearAll)
        query.setFilter("category", to: "hous")
        query.setFilter("name", to: "rent")
        #expect(names(query) == ["Rent"])
        #expect(query.activeFilterCount == 2)
        query.setFilter("category", to: "sport")
        #expect(query.filters.map { filter in filter.key } == ["category", "name"])
        #expect(query.filter(for: "category") == "sport")
        #expect(names(query).isEmpty)
        query.setFilter("name", to: "")
        #expect(query.filters.map { filter in filter.key } == ["category"])
        #expect(names(query) == ["gym"])
        query.toggleSort("amount")
        #expect(query.showsClearAll)
        query.clearAll()
        #expect(query == LocalTableQuery())
        query.toggleSort("amount")
        #expect(query.showsClearAll)
        #expect(!query.isNarrowed)
    }

    @Test func filterValuesAreDistinctNonBlankAndInNumericOrder() {
        let values = LocalTableQuery.uniqueValues(rows, key: "name") { row, key in row.value(key) }
        #expect(values == ["gym", "Insurance 9", "Insurance 10", "Rent"])
        let categories = LocalTableQuery.uniqueValues(rows, key: "category") { row, key in row.value(key) }
        #expect(categories == ["Housing", "Sport"])
        let flags = LocalTableQuery.uniqueValues(rows, key: "flag") { row, key in row.value(key) }
        #expect(flags == ["false", "true"])
        #expect(LocalTableQuery.matchingValues(["Housing", "Sport"], search: "SPO") == ["Sport"])
        #expect(LocalTableQuery.matchingValues(["Housing", "Sport"], search: "") == ["Housing", "Sport"])
    }
}

// MARK: Model

@MainActor
@Suite struct PlannedPaymentsModelTests {
    static let rows = [
        PlannedFixture.row(
            id: 1, name: "Rent", amount: -1000, category: "Housing", recurring: true, pattern: "monthly"),
        PlannedFixture.row(id: 2, name: "Gym", amount: -40, category: "Sport", recurring: true, pattern: "monthly"),
        PlannedFixture.row(id: 3, name: "Old plan", amount: -15, isActive: false),
    ]

    @Test func theListLoadsOncePerShowAllViewAndRefetchesWhenStale() async {
        let service = FakePlannedService(rows: Self.rows)
        let clock = TestClock()
        let model = PlannedFixture.model(service, clock: clock)
        #expect(model.isLoading)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(!model.isLoading)
        #expect(model.payments.map { payment in payment.id } == [1, 2])
        #expect(model.tablePayments.count == 2)
        clock.advance(20)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(await service.loads == [false])
        await model.appear(showAll: true, defaultCurrency: "EUR")
        #expect(model.showAll)
        #expect(model.payments.map { payment in payment.id } == [1, 2, 3])
        #expect(model.tablePayments.count == 3)
        #expect(await service.loads == [false, true])
        clock.advance(11)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(await service.loads == [false, true, false])
        await model.appear(showAll: true, defaultCurrency: "EUR")
        #expect(await service.loads == [false, true, false])
    }

    @Test func concurrentAppearsShareOneRequest() async {
        let service = FakePlannedService(rows: Self.rows)
        let gate = CallGate()
        await service.holdLoads(gate)
        let model = PlannedFixture.model(service)
        let first = Task { await model.appear(showAll: false, defaultCurrency: "EUR") }
        while await service.loads.isEmpty { await Task.yield() }
        let second = Task { await model.retry() }
        // Let the second caller reach the request in flight.
        for _ in 0..<10 { await Task.yield() }
        gate.open()
        await first.value
        await second.value
        #expect(await service.loads == [false])
        #expect(model.payments.count == 2)
    }

    @Test func aFailedLoadShowsTheErrorUntilRetrySucceeds() async {
        let service = FakePlannedService(rows: Self.rows)
        // `retry: 1`: the error shows only after the second attempt fails too.
        await service.failLoads(2)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(model.error == .network("offline"))
        #expect(!model.isLoading)
        #expect(model.payments.isEmpty)
        #expect(await service.loads.count == 2)
        // A failed answer is never fresh: appearing again fetches.
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(model.error == nil)
        #expect(model.payments.count == 2)
        await service.failLoads(2)
        await model.retry()
        #expect(model.error == .network("offline"))
        await model.retry()
        #expect(model.error == nil)
        #expect(await service.loads.count == 6)
    }

    @Test func oneFailedAttemptIsRetriedOnceWithoutAnError() async {
        let service = FakePlannedService(rows: Self.rows)
        await service.failLoads(1)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(model.error == nil)
        #expect(model.payments.count == 2)
        #expect(await service.loads == [false, false])
    }

    @Test func aDefaultCurrencyChangeMapsTheCachedRowsAgain() async {
        let service = FakePlannedService(rows: [PlannedFixture.row(id: 1, currency: nil)])
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(model.payments.first?.currency == "EUR")
        await model.appear(showAll: false, defaultCurrency: "USD")
        #expect(model.payments.first?.currency == "USD")
        #expect(model.converter.target == "USD")
        #expect(await service.loads.count == 1)
    }

    @Test func theFiguresUseTheSharedRatesAndToday() async {
        let service = FakePlannedService(rows: [
            PlannedFixture.row(
                id: 1, date: "2026-10-12", amount: -100, currency: "USD", recurring: true, pattern: "monthly"),
            PlannedFixture.row(id: 2, date: "2026-10-13", amount: -5, currency: "XYZ"),
        ])
        let model = PlannedPaymentsModel(
            service: service, editing: FakePlannedEditingService(), pickers: FakePickerService(),
            rates: ExchangeRatesModel(service: FakeExchangeRatesService(rates: [.success(PlannedFixture.rates())])),
            dismissals: .memory(), calendar: PlannedFixture.calendar, now: { PlannedFixture.today })
        await model.appear(showAll: false, defaultCurrency: "EUR")
        #expect(!model.isRatesLoading)
        let usd = Decimal(-100) * Decimal(string: "1.0842")!
        #expect(model.strip.dueCount == 2)
        #expect(model.strip.windowTotal == PlannedConvertedTotal(total: usd, unavailableCount: 1))
        #expect(model.estimatedMonthly == PlannedConvertedTotal(total: usd, unavailableCount: 0))
        let first = model.payments[0]
        #expect(model.dueState(first) == .today)
        #expect(model.dueState(model.payments[1]) == .tomorrow)
    }

    @Test func searchSortAndFiltersNarrowTheTableAndPickTheEmptyState() async {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        model.table.toggleSort(PlannedColumn.amount.rawValue)
        #expect(model.visibleRows.map { payment in payment.name } == ["Rent", "Gym"])
        model.table.toggleSort(PlannedColumn.amount.rawValue)
        #expect(model.visibleRows.map { payment in payment.name } == ["Gym", "Rent"])
        model.table.search = "hous"
        #expect(model.visibleRows.map { payment in payment.name } == ["Rent"])
        model.table.search = ""
        model.table.setFilter(PlannedColumn.category.rawValue, to: "sport")
        #expect(model.visibleRows.map { payment in payment.name } == ["Gym"])
        #expect(model.filterValues(.category) == ["Housing", "Sport"])
        #expect(model.filterValues(.recurrence) == ["true"])
        model.table.setFilter(PlannedColumn.category.rawValue, to: "nothing")
        #expect(model.visibleRows.isEmpty)
        #expect(model.emptyState == .noFilterResults)
        model.disappear()
        #expect(model.table == LocalTableQuery())
        #expect(model.visibleRows.count == 2)
    }

    @Test func theEmptyStateSaysNoPaymentsOrAllPaused() async {
        let empty = PlannedFixture.model(FakePlannedService())
        await empty.appear(showAll: false, defaultCurrency: "EUR")
        #expect(empty.visibleRows.isEmpty)
        #expect(empty.emptyState == .noPayments)
        let service = FakePlannedService(rows: [PlannedFixture.row(id: 1)])
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        await model.toggleActive(model.payments[0])
        // The paused row stays cached but leaves the table without show_all.
        #expect(model.payments.count == 1)
        #expect(model.tablePayments.isEmpty)
        #expect(model.emptyState == .allPaused)
    }

    @Test func pauseUpdatesTheRowInPlaceAndUndoResumesIt() async throws {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        let rent = model.payments[0]
        await model.toggleActive(rent)
        #expect(await service.updates == ["1:false"])
        #expect(model.payments[0].isActive == false)
        #expect(model.payments[0].wire.updatedAt == "2026-10-12T08:00:00.000Z")
        let notice = try #require(model.notice)
        #expect(notice.key == "plannedPage.toast.paused")
        #expect(notice.kind == .success)
        #expect(notice.detail == "Rent")
        #expect(model.undo == PlannedUndo(noticeID: notice.id, paymentID: 1, restoreActive: true))
        #expect(model.duration(of: notice) == PlannedPaymentsModel.undoDuration)
        #expect(!model.actionLoading)
        await model.undoToggle()
        #expect(await service.updates == ["1:false", "1:true"])
        #expect(model.payments[0].isActive)
        #expect(model.notice == nil)
        #expect(model.undo == nil)
        await model.undoToggle()
        #expect(await service.updates.count == 2)
        #expect(await service.loads == [false])
    }

    @Test func resumeSaysResumedAndTheToastTimeoutDropsTheUndo() async throws {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: true, defaultCurrency: "EUR")
        let paused = model.payments[2]
        #expect(!model.canMarkAsPaid(paused))
        await model.toggleActive(paused)
        let notice = try #require(model.notice)
        #expect(notice.key == "plannedPage.toast.resumed")
        #expect(model.payments[2].isActive)
        model.clearNotice(notice.id)
        #expect(model.notice == nil)
        #expect(model.undo == nil)
        await model.undoToggle()
        #expect(await service.updates == ["3:true"])
    }

    @Test func globalUndoRestoresCapturedStatusAfterNavigationAndAReadThatOmitsThePausedRow() async {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        let center = NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false)
        model.attachNotices(center)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        await model.toggleActive(model.payments[0])
        model.disappear()
        await model.retry()
        #expect(!model.payments.contains { $0.id == 1 })
        #expect(await center.consumeUndo())
        #expect(await service.updates == ["1:false", "1:true"])
        #expect(await center.consumeUndo() == false)
    }

    @Test func aFailedToggleLeavesTheRowAndSaysSo() async throws {
        let service = FakePlannedService(rows: Self.rows)
        await service.failUpdates(true)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        await model.toggleActive(model.payments[0])
        let notice = try #require(model.notice)
        #expect(notice.key == "plannedPage.toggleFailed")
        #expect(notice.kind == .error)
        #expect(model.duration(of: notice) == PlannedPaymentsModel.noticeDuration)
        #expect(model.undo == nil)
        #expect(model.payments[0].isActive)
    }

    @Test func deleteAsksFirstThenRemovesTheRow() async throws {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        let gym = model.payments[1]
        model.requestDelete(gym)
        #expect(model.pendingDelete == gym)
        model.cancelDelete()
        #expect(model.pendingDelete == nil)
        await model.confirmDelete()
        #expect(await service.deletes.isEmpty)
        model.requestDelete(gym)
        await model.confirmDelete()
        #expect(await service.deletes == [2])
        #expect(model.pendingDelete == nil)
        #expect(model.payments.map { payment in payment.id } == [1])
        let notice = try #require(model.notice)
        #expect(notice.key == "plannedPage.toast.deleted")
        #expect(notice.variables == ["name": "Gym"])
        #expect(model.undo == nil)
        #expect(await service.loads == [false])
    }

    @Test func aMutationWritesToTheViewItStartedOn() async throws {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: true, defaultCurrency: "EUR")
        await model.appear(showAll: false, defaultCurrency: "EUR")
        let gate = CallGate()
        await service.holdUpdates(gate)
        let gym = model.payments[1]
        let pause = Task { await model.toggleActive(gym) }
        while await service.updates.isEmpty { await Task.yield() }
        // The route's `show_all` changes while Pause is in flight.
        await model.appear(showAll: true, defaultCurrency: "EUR")
        gate.open()
        await pause.value
        let shown = try #require(model.lists[false]?.payments)
        let other = try #require(model.lists[true]?.payments)
        #expect(shown.first(where: { payment in payment.id == 2 })?.isActive == false)
        #expect(other.first(where: { payment in payment.id == 2 })?.isActive == true)
        #expect(await service.loads == [true, false])
    }

    @Test func aFailedDeleteKeepsTheRow() async throws {
        let service = FakePlannedService(rows: Self.rows)
        await service.failDeletes(true)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        model.requestDelete(model.payments[0])
        await model.confirmDelete()
        #expect(model.payments.count == 2)
        #expect(try #require(model.notice).key == "plannedPage.deleteFailed")
        #expect(!model.actionLoading)
    }

    @Test func theEditorAndLinkHooksRecordTheirRequests() async {
        let service = FakePlannedService(rows: Self.rows)
        let model = PlannedFixture.model(service)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        model.openEditor(for: nil)
        #expect(model.editorRequest == PlannedEditorRequest(id: 1, payment: nil))
        model.openEditor(for: model.payments[0])
        #expect(model.editorRequest == PlannedEditorRequest(id: 2, payment: model.payments[0]))
        model.dismissEditor()
        #expect(model.editorRequest == nil)
        #expect(model.canMarkAsPaid(model.payments[0]))
        model.openLinkDialog(for: model.payments[1])
        #expect(model.linkRequest == model.payments[1])
        model.openHistory()
        #expect(model.isHistoryPresented)
        model.disappear()
        #expect(model.linkRequest == nil)
        #expect(!model.isHistoryPresented)
    }
}

// MARK: Payment history

@MainActor
@Suite struct PlannedHistoryTests {
    static let payments = [
        PlannedFixture.row(
            id: 1, name: "Rent", recurring: true, pattern: "monthly", executionCount: 2,
            executions: [PlannedFixture.execution(11, "2026-09-01"), PlannedFixture.execution(12, "2026-10-01")]),
        PlannedFixture.row(id: 2, name: "Gym", date: "2026-08-15", isExecuted: true, executedTransactionId: 13),
        PlannedFixture.row(id: 3, name: "Zero", isExecuted: true, executedTransactionId: 0),
        PlannedFixture.row(
            id: 4, name: "Fails", isExecuted: true, lastExecutedDate: "2026-07-01", executedTransactionId: 14),
        PlannedFixture.row(id: 5, name: "Gone", isExecuted: true, executedTransactionId: 15),
    ].map { row in PlannedFixture.payment(row) }

    @Test func historyListsEveryExecutionNewestFirstAndMarksFailures() async {
        let service = FakePlannedService()
        await service.setTransactions(
            [
                PlannedFixture.transaction(11, date: "2026-09-02", memo: "September rent", category: "Housing"),
                PlannedFixture.transaction(12, date: "2026-10-02", recipient: "Landlord", category: "Housing"),
                PlannedFixture.transaction(13, date: "2026-08-15"),
            ],
            failing: [14])
        let model = PlannedFixture.model(service)
        let history = model.history
        await history.load(payments: Self.payments)
        #expect(Set(await service.lookups) == [11, 12, 13, 14, 15])
        #expect(history.entries.map { entry in entry.transactionId } == [12, 11, 13])
        #expect(history.entries.map { entry in entry.executionDate } == ["2026-10-01", "2026-09-01", "2026-08-15"])
        #expect(history.failed)
        #expect(!history.isLoading)
        let strings = DictionaryStrings(language: .en, table: ["plannedPage.link.txFallback": "Transaction #{id}"])
        #expect(history.entries[0].title(strings) == "Landlord")
        #expect(history.entries[1].title(strings) == "September rent")
        #expect(history.entries[2].title(strings) == "Transaction #13")
        #expect(history.entries[0].route == "/transactions?transaction_id=12")
        #expect(history.entries[0].plannedPaymentName == "Rent")
        let detail = history.entries[0].detail(format: .dayMonthYearSlash)
        #expect(detail.hasPrefix("Landlord · Housing · "))
        #expect(history.entries[2].detail(format: .dayMonthYearSlash).contains("·") == false)
    }

    @Test func retryAfterAFailureLoadsAgain() async {
        let service = FakePlannedService()
        await service.setTransactions([PlannedFixture.transaction(13)], failing: [13])
        let model = PlannedFixture.model(service)
        let payments = [Self.payments[1]]
        await model.history.load(payments: payments)
        #expect(model.history.failed)
        #expect(model.history.entries.isEmpty)
        await service.setTransactions([PlannedFixture.transaction(13)])
        await model.history.load(payments: payments)
        #expect(!model.history.failed)
        #expect(model.history.entries.count == 1)
    }

    @Test func noExecutionsMeansAnEmptyHistoryWithoutRequests() async {
        let service = FakePlannedService()
        let model = PlannedFixture.model(service)
        await model.history.load(payments: [PlannedFixture.payment(PlannedFixture.row(id: 1))])
        #expect(model.history.entries.isEmpty)
        #expect(!model.history.isLoading)
        #expect(!model.history.failed)
        #expect(await service.lookups.isEmpty)
    }

    @Test func closingTheDialogDropsAnAnswerInFlight() async {
        let service = FakePlannedService()
        await service.setTransactions([PlannedFixture.transaction(13)])
        let gate = CallGate()
        await service.holdLookups(gate)
        let model = PlannedFixture.model(service)
        model.openHistory()
        let payments = [Self.payments[1]]
        let load = Task { await model.history.load(payments: payments) }
        while await service.lookups.isEmpty { await Task.yield() }
        #expect(model.history.isLoading)
        model.closeHistory()
        #expect(!model.isHistoryPresented)
        #expect(!model.history.isLoading)
        gate.open()
        await load.value
        #expect(model.history.entries.isEmpty)
        #expect(!model.history.isLoading)
    }

    @Test func aRefetchThatChangedTheExecutionsLoadsAgainInsteadOfSharing() async {
        let service = FakePlannedService()
        await service.setTransactions([
            PlannedFixture.transaction(13, date: "2026-08-15"), PlannedFixture.transaction(16, date: "2026-10-01"),
        ])
        let gate = CallGate()
        await service.holdLookups(gate)
        let model = PlannedFixture.model(service)
        let before = [
            PlannedFixture.payment(
                PlannedFixture.row(id: 2, name: "Gym", date: "2026-08-15", isExecuted: true, executedTransactionId: 13))
        ]
        // The same payment id after Mark as paid: a new linked transaction.
        let after = [
            PlannedFixture.payment(
                PlannedFixture.row(id: 2, name: "Gym", date: "2026-10-01", isExecuted: true, executedTransactionId: 16))
        ]
        let first = Task { await model.history.load(payments: before) }
        while await service.lookups.isEmpty { await Task.yield() }
        await service.holdLookups(nil)
        await model.history.load(payments: after)
        #expect(await service.lookups == [13, 16])
        #expect(model.history.entries.map { entry in entry.transactionId } == [16])
        gate.open()
        await first.value
        #expect(model.history.entries.map { entry in entry.transactionId } == [16])
    }
}

// MARK: Route and shell

@MainActor
@Suite struct PlannedRouteTests {
    @Test func showAllRoundTripsThroughTheRoute() throws {
        let route = try #require(NativeRoute("/planned?show_all=true"))
        #expect(route.path == "/planned")
        #expect(PlannedPaymentsRoute.showAll(in: route))
        #expect(NativeScreen.screen(forPath: route.path) == .plannedPayments)
        #expect(!PlannedPaymentsRoute.showAll(in: try #require(NativeRoute("/planned?show_all=1"))))
        #expect(!PlannedPaymentsRoute.showAll(in: try #require(NativeRoute("/planned"))))
        #expect(PlannedPaymentsRoute.showAllValue(true) == "true")
        #expect(PlannedPaymentsRoute.showAllValue(false) == nil)
    }

    func makeShell(settings: NativeAppSettings) -> NativeShellModel {
        NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { settings })
    }

    @Test func plannedIsNativeWithoutAdminModeOnceSettingsLoad() async throws {
        let shell = makeShell(settings: NativeAppSettings(adminMode: false))
        shell.show(try #require(NativeRoute("/planned?show_all=true")))
        #expect(shell.detail == .loading)
        await shell.settingsSettled()
        #expect(shell.detail == .native(.plannedPayments))
        // Without admin mode an admin route goes home instead.
        shell.show(try #require(NativeRoute("/admin/exchange-rates")))
        await shell.settingsSettled()
        #expect(shell.route == .home)
        shell.show(try #require(NativeRoute("/planned")))
        #expect(shell.detail == .native(.plannedPayments))
    }

    @Test func theViewMenuReplacesTheRoute() async throws {
        let shell = makeShell(settings: NativeAppSettings(adminMode: true))
        shell.show(try #require(NativeRoute("/planned")))
        await shell.settingsSettled()
        shell.replaceQuery(PlannedPaymentsRoute.showAllParameter, with: PlannedPaymentsRoute.showAllValue(true))
        #expect(shell.route.string == "/planned?show_all=true")
        #expect(PlannedPaymentsRoute.showAll(in: shell.route))
        #expect(shell.nativeNavigationLocation.raw == "/planned?show_all=true")
        shell.replaceQuery(PlannedPaymentsRoute.showAllParameter, with: PlannedPaymentsRoute.showAllValue(false))
        #expect(shell.route.string == "/planned")
        #expect(shell.nativeNavigationLocation.raw == "/planned")
        #expect(shell.detail == .native(.plannedPayments))
    }
}

@Suite struct PlannedSettingsTests {
    @Test func theDefaultCurrencyIsReadWhenItIsAThreeLetterCode() {
        #expect(NativeAppSettings.defaults.defaultCurrency == "EUR")
        #expect(NativeAppSettings.migrate(.object(["defaultCurrency": .string("USD")])).defaultCurrency == "USD")
        #expect(NativeAppSettings.migrate(.object(["defaultCurrency": .string("chf")])).defaultCurrency == "chf")
        #expect(NativeAppSettings.migrate(.object(["defaultCurrency": .string("EURO")])).defaultCurrency == "EUR")
        #expect(NativeAppSettings.migrate(.object(["defaultCurrency": .string("U5D")])).defaultCurrency == "EUR")
        #expect(NativeAppSettings.migrate(.object(["defaultCurrency": .int(1)])).defaultCurrency == "EUR")
    }

    @Test func signedAmountsShowTheirSign() {
        let locale = NumberFormat.us.locale
        let plus = VisionFormat.currency(12, code: "EUR", locale: locale, fractionDigits: 2, signed: true)
        #expect(plus.hasPrefix("+"))
        #expect(plus.contains("12.00"))
        let minus = VisionFormat.currency(-12, code: "EUR", locale: locale, fractionDigits: 2, signed: true)
        #expect(minus.contains("-") || minus.contains("−"))
        let zero = VisionFormat.currency(0, code: "EUR", locale: locale, fractionDigits: 2, signed: true)
        #expect(!zero.contains("+"))
        #expect(VisionFormat.currency(12, code: "EUR", locale: locale, fractionDigits: 2) == "€12.00")
    }
}

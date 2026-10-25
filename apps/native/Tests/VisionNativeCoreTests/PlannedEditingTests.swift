import Foundation
import Testing
@testable import VisionNativeCore

/// The planned-payment sheet, Mark as paid, match suggestions and recurring detection calls
/// over in-memory answers, recording every call.
actor FakePlannedEditingService: PlannedEditingService {
    private(set) var created: [OpenAPI.PlannedTransactionCreate] = []
    private(set) var tracked: [PlannedTrackBody] = []
    private(set) var patches: [Int: [PlannedPaymentPatch]] = [:]
    /// `"id:transactionId:executionDate"` per execute.
    private(set) var executed: [String] = []
    private(set) var candidateQueries: [PlannedLinkQuery] = []
    private(set) var suggestionCalls = 0
    private(set) var patternCalls = 0
    private(set) var settingReads = 0
    private(set) var savedValues: [JSONValue] = []
    private(set) var savedBaselines: [JSONValue] = []
    private var writesFail = false
    private var savesFail = false
    private var suggestionAnswer: [PlannedMatchSuggestion] = []
    private var patternAnswer: Result<[PlannedRecurringPattern], APIError> = .success([])
    private var candidateAnswer: [OpenAPI.Transaction] = []
    private var settingAnswer: Result<OpenAPI.Setting, APIError> = .failure(FakePlannedEditingService.notFound)
    private var candidateGate: CallGate?
    private var patternGate: CallGate?
    private var suggestionGate: CallGate?

    static let notFound = APIError.client(APIClientError(status: 404, code: .notFound, message: "Setting not found"))

    func failWrites(_ fail: Bool) { writesFail = fail }
    func failSaves(_ fail: Bool) { savesFail = fail }
    func setSuggestions(_ items: [PlannedMatchSuggestion]) { suggestionAnswer = items }
    func setPatterns(_ answer: Result<[PlannedRecurringPattern], APIError>) { patternAnswer = answer }
    func setCandidates(_ list: [OpenAPI.Transaction]) { candidateAnswer = list }
    func setSetting(_ answer: Result<OpenAPI.Setting, APIError>) { settingAnswer = answer }
    func holdCandidates(_ gate: CallGate?) { candidateGate = gate }
    func holdPatterns(_ gate: CallGate?) { patternGate = gate }
    func holdSuggestions(_ gate: CallGate?) { suggestionGate = gate }

    func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws -> OpenAPI.PlannedTransaction {
        created.append(body)
        if writesFail { throw APIError.network("offline") }
        return OpenAPI.PlannedTransaction(
            id: 100 + created.count, plannedDate: body.plannedDate, accountId: body.accountId,
            recipientId: body.recipientId, memo: body.memo, amount: body.amount, currency: body.currency,
            categoryId: body.categoryId, isRecurring: body.isRecurring ?? false,
            recurrencePattern: body.recurrencePattern, isLoan: body.isLoan, isExecuted: false, executionCount: 0,
            isActive: true, links: [])
    }

    func trackPlannedPayment(_ body: PlannedTrackBody) async throws -> OpenAPI.PlannedTransaction {
        tracked.append(body)
        if writesFail { throw APIError.network("offline") }
        return OpenAPI.PlannedTransaction(
            id: 200 + tracked.count, plannedDate: body.plannedDate, accountId: body.accountId,
            recipientId: body.recipientId, memo: body.memo, amount: body.amount, currency: body.currency,
            categoryId: body.categoryId, isRecurring: true, recurrencePattern: body.recurrencePattern, isExecuted: false,
            executionCount: 0, isActive: true, links: [])
    }

    func updatePlannedPayment(id: Int, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction {
        patches[id, default: []].append(patch)
        if writesFail { throw APIError.network("offline") }
        return OpenAPI.PlannedTransaction(
            id: id, plannedDate: patch.plannedDate ?? "2026-10-14", accountId: patch.accountId, memo: patch.memo,
            amount: patch.amount ?? 0, currency: patch.currency, isRecurring: patch.isRecurring ?? false,
            recurrencePattern: patch.recurrencePattern, isExecuted: false, executionCount: 0,
            isActive: patch.isActive ?? true, links: [])
    }

    func executePlannedPayment(id: Int, transactionId: Int, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    {
        executed.append("\(id):\(transactionId):\(executionDate ?? "-")")
        if writesFail { throw APIError.network("offline") }
        return OpenAPI.PlannedTransaction(
            id: id, plannedDate: "2026-11-14", memo: "Executed \(id)", amount: -950, currency: "EUR",
            isRecurring: true, recurrencePattern: "monthly", isExecuted: true, executedTransactionId: transactionId,
            executionCount: 1, isActive: true, links: [])
    }

    func matchSuggestions() async throws -> [PlannedMatchSuggestion] {
        suggestionCalls += 1
        if let suggestionGate { await suggestionGate.wait() }
        return suggestionAnswer
    }

    func recurringPatterns() async throws -> [PlannedRecurringPattern] {
        patternCalls += 1
        if let patternGate { await patternGate.wait() }
        return try patternAnswer.get()
    }

    func linkCandidates(_ query: PlannedLinkQuery) async throws -> [OpenAPI.Transaction] {
        candidateQueries.append(query)
        if let candidateGate { await candidateGate.wait() }
        return candidateAnswer
    }

    func setting(key: String) async throws -> OpenAPI.Setting {
        settingReads += 1
        return try settingAnswer.get()
    }

    func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        savedValues.append(value)
        savedBaselines.append(expected)
        if savesFail { throw APIError.network("offline") }
        return OpenAPI.Setting(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }
}

/// The picker lists over fixed answers.
actor FakePickerService: PickerDataService {
    private(set) var recipientSearches: [String?] = []
    private(set) var recipientLookups: [Int] = []
    private(set) var accountLoads = 0
    private(set) var tagLoads = 0
    private(set) var createdTags: [String] = []
    private var recipientList: [OpenAPI.Recipient]
    private var accountList: [OpenAPI.Account]
    private var categoryList: [OpenAPI.CategoryNode]
    private var tagList: [OpenAPI.Tag]

    init(
        recipients: [OpenAPI.Recipient] = [], accounts: [OpenAPI.Account] = [], categories: [OpenAPI.CategoryNode] = [],
        tags: [OpenAPI.Tag] = []
    ) {
        recipientList = recipients
        accountList = accounts
        categoryList = categories
        tagList = tags
    }

    func recipients(search: String?, limit: Int) async throws -> [OpenAPI.Recipient] {
        recipientSearches.append(search)
        guard let search else { return recipientList }
        return recipientList.filter { $0.name.lowercased().contains(search.lowercased()) }
    }

    func recipient(id: Int) async throws -> OpenAPI.Recipient {
        recipientLookups.append(id)
        guard let found = recipientList.first(where: { $0.id == id }) else { throw APIError.network("missing") }
        return found
    }

    func accounts() async throws -> [OpenAPI.Account] {
        accountLoads += 1
        return accountList
    }

    func categories() async throws -> [OpenAPI.CategoryNode] { categoryList }

    func tags() async throws -> [OpenAPI.Tag] {
        tagLoads += 1
        return tagList
    }

    func createTag(slug: String, color: String?) async throws {
        createdTags.append(slug)
        tagList.append(OpenAPI.Tag(id: 900 + tagList.count, slug: slug, color: color, isActive: true, createdAt: "", updatedAt: ""))
    }
}

enum EditingFixture {
    static let today = PlannedDay(year: 2026, month: 10, day: 12)

    static func recipient(_ id: Int, _ name: String, primary: Int? = nil) -> OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: name, primaryRecipientId: primary, isActive: true, createdAt: "2026-01-01", links: [])
    }

    static func account(_ id: Int, _ name: String, display: String? = nil) -> OpenAPI.Account {
        OpenAPI.Account(
            id: id, name: name, displayName: display, currency: "EUR", type: "checking", liquidityClass: "cash",
            spendable: true, inNetWorth: true, taxWrapper: "none", owner: "self", multiCurrencyCash: false,
            hasCashSleeve: false, isActive: true, createdAt: "2026-01-01", updatedAt: "2026-01-01")
    }

    static func category(_ id: Int, _ path: [String], active: Bool = true) -> OpenAPI.CategoryNode {
        OpenAPI.CategoryNode(
            id: id, name: path.last ?? "", pathIds: [id], path: path, categoryName: path.last ?? "",
            depth: path.count - 1, isActive: active, hierarchyOnly: false, legacyCompatible: true)
    }

    static func tag(_ id: Int, _ slug: String) -> OpenAPI.Tag {
        OpenAPI.Tag(id: id, slug: slug, color: "hsl(210, 62%, 50%)", isActive: true, createdAt: "", updatedAt: "")
    }

    static func pattern(
        _ recipientId: Int, _ name: String, direction: String = "expense", detected: String = "monthly",
        interval: Int = 30, amount: Decimal = 42, accountId: Int? = 7, changes: [PlannedRecurringPattern.AmountChange] = [],
        planned: Bool = false, confidence: Decimal = 90
    ) -> PlannedRecurringPattern {
        PlannedRecurringPattern(
            recipientId: recipientId, recipientName: name, direction: direction, detectedPattern: detected,
            intervalDays: interval, occurrences: 4, latestAmount: amount, currency: "EUR", categoryId: 4,
            categoryName: "Leisure", accountId: accountId, predictedNext: "2026-11-01", amountChanges: changes,
            isAlreadyPlanned: planned, confidence: confidence)
    }

    static let change = PlannedRecurringPattern.AmountChange(
        date: "2026-09-01", previousAmount: 10, newAmount: 12, percentChange: 20, direction: "increased")

    static func suggestion(_ plannedId: Int) -> PlannedMatchSuggestion {
        PlannedMatchSuggestion(planned: .init(id: plannedId), candidates: [])
    }

    static func setting(_ ids: [Int]) -> OpenAPI.Setting {
        let value = JSONValue.array(ids.map { JSONValue.int($0) })
        return OpenAPI.Setting(
            key: PlannedDismissalStore.key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }

    static let strings = DictionaryStrings(language: .en, table: [:])

    @MainActor
    static func form(
        _ initial: PlannedPayment? = nil, settings: NativeAppSettings = .defaults
    ) -> PlannedPaymentFormModel {
        PlannedPaymentFormModel(
            id: 1, initial: initial, settings: settings, today: today, calendar: PlannedFixture.calendar)
    }

    /// A loaded page over `rows`.
    @MainActor
    static func page(
        _ rows: [OpenAPI.PlannedTransaction], editing: FakePlannedEditingService = FakePlannedEditingService(),
        pickers: FakePickerService = FakePickerService(), dismissals: PlannedDismissalStore = .memory(),
        clock: TestClock = TestClock()
    ) async -> PlannedPaymentsModel {
        let model = PlannedFixture.model(
            FakePlannedService(rows: rows), clock: clock, editing: editing, pickers: pickers, dismissals: dismissals)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        return model
    }
}

// MARK: Input parsing

@Suite struct PlannedFormInputTests {
    @Test func numbersParseInTheAppFormat() {
        #expect(LocaleNumber.parse("1.234,56", format: .eu) == Decimal(string: "1234.56"))
        #expect(LocaleNumber.parse("1,234.56", format: .us) == Decimal(string: "1234.56"))
        #expect(LocaleNumber.parse("1'234.5", format: .ch) == Decimal(string: "1234.5"))
        #expect(LocaleNumber.parse("€ 12,5", format: .eu) == Decimal(string: "12.5"))
        #expect(LocaleNumber.parse("(12)", format: .us) == -12)
        #expect(LocaleNumber.parse("1,23,456.7", format: .in) == Decimal(string: "123456.7"))
        #expect(LocaleNumber.parse("12a", format: .us) == nil)
        #expect(LocaleNumber.parse("1.2.3", format: .us) == nil)
        #expect(LocaleNumber.parseOrZero("", format: .eu) == 0)
        #expect(LocaleNumber.editable(Decimal(string: "12.5"), format: .eu) == "12,5")
        #expect(LocaleNumber.editable(Decimal(string: "12.5"), format: .us) == "12.5")
        #expect(LocaleNumber.editable(nil, format: .us).isEmpty)
    }

    @Test func integersFollowParseIntAndNumber() {
        #expect(JSInteger.parse(" 12abc") == 12)
        #expect(JSInteger.parse("-3") == -3)
        #expect(JSInteger.parse("abc") == nil)
        #expect(JSInteger.parse("") == nil)
        #expect(JSInteger.number("2.5") == Decimal(string: "2.5"))
        #expect(JSInteger.number("") == nil)
        #expect(JSInteger.number("five") == nil)
    }

    @Test func slugsAndTypedDates() {
        #expect(TagSlug.slugify("  Hello   World! ") == "hello-world")
        #expect(TagSlug.slugify("--Café--bar--") == "caf-bar")
        #expect(AppDateInput.parse("31/12/2026", format: .dayMonthYearSlash) == PlannedDay(year: 2026, month: 12, day: 31))
        #expect(AppDateInput.parse("12/31/2026", format: .monthDayYearSlash) == PlannedDay(year: 2026, month: 12, day: 31))
        #expect(AppDateInput.parse("2026-02-29", format: .isoDate) == nil)
        #expect(AppDateInput.parse("2028-02-29", format: .isoDate) == PlannedDay(year: 2028, month: 2, day: 29))
        #expect(AppDateInput.parse("1/2/2026", format: .dayMonthYearSlash) == nil)
        #expect(AppDateInput.parse("2026-12-31", format: .dayMonthYearSlash) == nil)
        let day = PlannedDay(year: 2026, month: 10, day: 1)
        #expect(day.adding(days: -14, calendar: PlannedFixture.calendar).ymd == "2026-09-17")
        #expect(PlannedDay(ymd: "2026-10-01T00:00:00.000Z", calendar: PlannedFixture.calendar) == day)
    }

    @Test func anEmptyDateDraftClearsAnOptionalFieldAndKeepsARequiredOne() {
        let day = PlannedDay(year: 2026, month: 10, day: 1)
        let iso = AppDateFormat.isoDate
        #expect(AppDateInput.commit("", current: day, format: iso, allowClear: true) == .clear)
        #expect(AppDateInput.commit("  ", current: day, format: iso, allowClear: false) == .keep)
        #expect(AppDateInput.commit("", current: nil, format: iso, allowClear: true) == .keep)
        #expect(AppDateInput.commit("", current: nil, format: iso, allowClear: false) == .keep)
        #expect(AppDateInput.commit("2026-10-01", current: day, format: iso, allowClear: false) == .keep)
        let next = PlannedDay(year: 2026, month: 10, day: 2)
        #expect(AppDateInput.commit("2026-10-02", current: day, format: iso, allowClear: false) == .set(next))
        #expect(AppDateInput.commit("2026-10-02", current: nil, format: iso, allowClear: true) == .set(next))
        #expect(AppDateInput.commit("02/10/2026", current: day, format: iso, allowClear: true) == .invalid)
    }
}

// MARK: The planned-payment sheet

@MainActor
@Suite struct PlannedPaymentFormTests {
    @Test func aBlockedSubmitRevealsTheErrorsAndFocusesTheFirstInvalidField() throws {
        let form = EditingFixture.form()
        #expect(form.titleKey == "plannedForm.newTitle")
        #expect(form.submitKey == "plannedForm.createPayment")
        #expect(form.dueDate == EditingFixture.today)
        #expect(form.currency == "EUR")
        #expect(!form.isDirty)
        #expect(form.visibleErrorKey(.name) == nil)
        #expect(form.submit() == nil)
        #expect(form.errorsRevealed)
        #expect(form.focusField == .name)
        #expect(form.focusToken == 1)
        #expect(form.visibleErrorKey(.name) == "plannedForm.nameRequired")
        #expect(form.visibleErrorKey(.amount) == "plannedForm.amountRequired")
        #expect(form.visibleErrorKey(.bank) == "portfolio.move.selectAccount")
        #expect(form.visibleErrorKey(.dueDate) == nil)
        form.name = "  Rent "
        form.setDueDate(nil)
        #expect(form.submit() == nil)
        #expect(form.focusField == .amount)
        #expect(form.focusToken == 2)
        #expect(form.visibleErrorKey(.name) == nil)
        #expect(form.visibleErrorKey(.dueDate) == "validation.required")
        form.amount = "950"
        form.setDueDate(EditingFixture.today)
        form.pickAccount(name: "Main", id: 7)
        let submission = try #require(form.submit())
        #expect(submission.name == "Rent")
        #expect(submission.create.memo == "Rent")
        #expect(submission.create.amount == -950)
        #expect(submission.create.accountId == 7)
        #expect(submission.create.plannedDate == "2026-10-12")
        #expect(submission.create.currency == "EUR")
        #expect(submission.create.isRecurring == false)
        #expect(submission.create.recurrencePattern == nil)
        #expect(submission.create.tags == nil)
        #expect(submission.create.comment == nil)
        #expect(submission.create.url == nil)
        #expect(submission.patch.isActive == true)
        form.resetErrors()
        #expect(form.visibleErrorKey(.bank) == nil)
    }

    @Test func theHintNamesTheFirstMissingField() {
        let form = EditingFixture.form()
        #expect(form.hintKey == "plannedForm.hint.name")
        form.name = "Rent"
        #expect(form.hintKey == "plannedForm.hint.amount")
        form.amount = "1"
        #expect(form.hintKey == "plannedForm.hint.bank")
        form.pickAccount(name: "Main", id: 7)
        #expect(form.hintKey == "plannedForm.hint.readyAdd")
    }

    @Test func directionOwnsTheSignAndALoanIsAlwaysAnExpense() throws {
        let form = EditingFixture.form()
        form.name = "Salary"
        form.amount = "-2.500,50"
        form.pickAccount(name: "Main", id: 7)
        form.direction = .income
        #expect(try #require(form.submit()).create.amount == Decimal(string: "2500.5"))
        form.direction = .expense
        #expect(try #require(form.submit()).create.amount == Decimal(string: "-2500.5"))
        form.amount = "0"
        #expect(try #require(form.submit()).create.amount == 0)
        form.amount = "100"
        form.direction = .income
        form.isLoan = true
        form.loanPrincipal = "1000"
        form.loanRate = "2"
        form.loanTermMonths = "12"
        #expect(form.effectiveDirection == .expense)
        #expect(form.effectiveRecurring)
        #expect(!form.showsRecurrenceFields)
        #expect(form.directionHelpKey == "plannedForm.directionLoanDesc")
        #expect(try #require(form.submit()).create.amount == -100)
    }

    @Test func aLoanSendsItsTermsAndNoRecurrence() throws {
        let form = EditingFixture.form()
        form.name = "Car loan"
        form.pickAccount(name: "Main", id: 7)
        form.isLoan = true
        form.isRecurring = false
        // A loan needs no amount, but its principal, rate and term.
        #expect(form.errorKey(.amount) == nil)
        #expect(form.submit() == nil)
        #expect(form.focusField == .loanPrincipal)
        form.loanPrincipal = "10.000,50"
        form.loanRate = "3,5"
        form.loanTermMonths = "700"
        #expect(form.submit() == nil)
        #expect(form.focusField == .loanTerm)
        #expect(form.visibleErrorKey(.loanTerm) == "plannedForm.loanTermInvalid")
        form.loanTermMonths = "240"
        #expect(form.loanPaymentDayPlaceholder == "12")
        let first = try #require(form.submit())
        #expect(first.create.isLoan == true)
        #expect(first.create.isRecurring == true)
        #expect(first.create.recurrencePattern == nil)
        #expect(first.create.loanType == .amortizing)
        #expect(first.create.loanPrincipal == Decimal(string: "10000.5"))
        #expect(first.create.loanAnnualInterestRate == Decimal(string: "3.5"))
        #expect(first.create.loanTermMonths == 240)
        #expect(first.create.loanStartDate == "2026-10-12")
        #expect(first.create.loanPaymentDay == 12)
        #expect(first.create.amount == 0)
        form.loanPaymentDay = "28"
        form.loanType = .interestOnly
        let second = try #require(form.submit())
        #expect(second.create.loanPaymentDay == 28)
        #expect(second.patch.loanType == .interestOnly)
        #expect(second.patch.recurrenceEndDate == nil)
    }

    @Test func recurrenceSendsThePatternAndClearedBoundsAsNull() throws {
        let form = EditingFixture.form()
        form.name = "Gym"
        form.amount = "40"
        form.pickAccount(name: "Main", id: 7)
        form.isRecurring = true
        form.frequency = .custom
        #expect(form.showsCustomDays)
        #expect(form.submit() == nil)
        #expect(form.focusField == .customDays)
        #expect(form.visibleErrorKey(.customDays) == "plannedForm.customDaysInvalid")
        form.customDays = "10"
        form.endDate = PlannedDay(year: 2027, month: 6, day: 30)
        form.maxOccurrences = "12"
        let custom = try #require(form.submit())
        #expect(custom.create.recurrencePattern == "every 10 days")
        #expect(custom.create.recurrenceEndDate == "2027-06-30")
        #expect(custom.create.maxOccurrences == 12)
        form.frequency = .weekly
        form.endDate = nil
        form.maxOccurrences = ""
        let weekly = try #require(form.submit())
        #expect(weekly.create.recurrencePattern == "weekly")
        #expect(weekly.create.recurrenceEndDate == nil)
        let clearedEnd: String?? = .some(nil)
        let clearedMax: Int?? = .some(nil)
        #expect(weekly.patch.recurrenceEndDate == clearedEnd)
        #expect(weekly.patch.maxOccurrences == clearedMax)
        let encoded = try APIBody.encode(weekly.patch)
        let json = try #require(String(data: encoded, encoding: .utf8))
        #expect(json.contains("\"recurrence_end_date\":null"))
        #expect(json.contains("\"max_occurrences\":null"))
        // A one-time payment leaves the bounds out of the patch.
        form.isRecurring = false
        let oneTime = try #require(form.submit())
        let once = try #require(String(data: try APIBody.encode(oneTime.patch), encoding: .utf8))
        #expect(!once.contains("recurrence_end_date"))
        #expect(!once.contains("max_occurrences"))
        #expect(once.contains("\"is_recurring\":false"))
    }

    @Test func anEditStartsFromTheRowAndTracksItsChanges() throws {
        let row = OpenAPI.PlannedTransaction(
            id: 5, plannedDate: "2026-11-01T00:00:00.000Z", bankAccount: "Main", accountId: 3, recipientId: 9,
            memo: "Gym", amount: Decimal(string: "-40.5")!, currency: "USD", categoryId: 4, comment: "note",
            url: "https://example.com", isRecurring: true, recurrencePattern: "every 14 days",
            recurrenceEndDate: "2027-01-01", maxOccurrences: 6, isExecuted: false, executionCount: 0,
            tags: [OpenAPI.TransactionTagRef(id: 1, slug: "sport", isActive: true)], isActive: false, links: [])
        let form = EditingFixture.form(PlannedFixture.payment(row), settings: NativeAppSettings(numberFormat: .eu))
        #expect(form.isEditing)
        #expect(form.titleKey == "plannedForm.editTitle")
        #expect(form.submitKey == "plannedForm.saveChanges")
        #expect(form.amount == "40,5")
        #expect(form.direction == .expense)
        #expect(form.currency == "USD")
        #expect(form.dueDate == PlannedDay(year: 2026, month: 11, day: 1))
        #expect(form.frequency == .custom)
        #expect(form.customDays == "14")
        #expect(form.endDate == PlannedDay(year: 2027, month: 1, day: 1))
        #expect(form.maxOccurrences == "6")
        #expect(form.tags == ["sport"])
        #expect(form.hintKey == "plannedForm.hint.readyEdit")
        #expect(!form.isDirty)
        form.name = "Gym+"
        #expect(form.isDirty)
        form.name = "Gym"
        #expect(!form.isDirty)
        form.tags = ["sport", "health"]
        #expect(form.isDirty)
        let submission = try #require(form.submit())
        #expect(submission.patch.isActive == false)
        #expect(submission.patch.recipientId == 9)
        #expect(submission.patch.categoryId == 4)
        #expect(submission.patch.amount == Decimal(string: "-40.5"))
        #expect(submission.patch.recurrencePattern == "every 14 days")
        let end: String?? = .some("2027-01-01")
        #expect(submission.patch.recurrenceEndDate == end)
        let maximum: Int?? = .some(6)
        #expect(submission.patch.maxOccurrences == maximum)
        #expect(submission.patch.tags == ["sport", "health"])
        #expect(submission.patch.comment == "note")
    }
}

// MARK: The sheet on the page

@MainActor
@Suite struct PlannedEditorFlowTests {
    @Test func addPaymentCreatesAndEditUpdatesTheRow() async throws {
        let editing = FakePlannedEditingService()
        let model = await EditingFixture.page([PlannedFixture.row(id: 1, name: "Rent")], editing: editing)
        model.openEditor(for: nil)
        let form = try #require(model.editor)
        #expect(!form.isEditing)
        #expect(!model.leaveGuard.hasUnsavedChanges())
        form.name = "Netflix"
        #expect(model.leaveGuard.hasUnsavedChanges())
        form.amount = "12,99"
        form.pickAccount(name: "Main", id: 7)
        await model.saveEditor(strings: EditingFixture.strings)
        #expect(await editing.created.count == 1)
        #expect(model.editor == nil)
        #expect(model.payments.map { $0.name } == ["Rent", "Netflix"])
        #expect(model.notice?.key == "plannedPage.toast.created")
        #expect(model.notice?.variables["name"] == "Netflix")
        #expect(!model.leaveGuard.hasUnsavedChanges())

        model.openEditor(for: model.payments[0])
        let edit = try #require(model.editor)
        #expect(edit.isEditing)
        edit.amount = "1000"
        edit.pickAccount(name: "Main", id: 7)
        await model.saveEditor(strings: EditingFixture.strings)
        #expect(await editing.patches[1]?.count == 1)
        #expect(model.payments[0].amount == -1000)
        #expect(model.notice?.key == "plannedPage.toast.updated")
        #expect(model.editor == nil)
    }

    @Test func aBlockedOrFailedSaveKeepsTheSheetOpen() async throws {
        let editing = FakePlannedEditingService()
        let model = await EditingFixture.page([], editing: editing)
        model.openEditor(for: nil)
        let form = try #require(model.editor)
        await model.saveEditor(strings: EditingFixture.strings)
        #expect(await editing.created.isEmpty)
        #expect(form.errorsRevealed)
        #expect(model.editor === form)
        form.name = "Rent"
        form.amount = "950"
        form.pickAccount(name: "Main", id: 7)
        await editing.failWrites(true)
        await model.saveEditor(strings: EditingFixture.strings)
        #expect(model.notice?.key == "plannedPage.saveFailed")
        #expect(model.editor === form)
        #expect(!model.actionLoading)
        // Cancel closes without saving.
        model.dismissEditor()
        #expect(model.editor == nil)
        #expect(await editing.created.count == 1)
    }

    @Test func leavingThePageWithEditsAsksFirstAndDiscardCloses() async throws {
        let model = await EditingFixture.page([PlannedFixture.row(id: 1)])
        let shell = NativeShellModel(
            strings: EditingFixture.strings, theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(), planned: model, imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { NativeAppSettings() })
        shell.show(try #require(NativeRoute("/planned")))
        await shell.settingsSettled()
        shell.setLeaveGuard(model.leaveGuard)
        // An untouched sheet does not hold the navigation.
        model.openEditor(for: nil)
        #expect(!shell.hasGuardedUnsavedChanges)
        model.editor?.name = "Draft"
        #expect(shell.hasGuardedUnsavedChanges)
        shell.navigate(to: "/transactions")
        #expect(shell.leaveConfirmation?.path == "/transactions")
        shell.stayOnPage()
        #expect(model.editor?.name == "Draft")
        shell.navigate(to: "/transactions")
        shell.leavePage()
        #expect(model.editor == nil)
        #expect(shell.route.path == "/transactions")
        shell.removeLeaveGuard(id: PlannedPaymentsRoute.path)
        #expect(!shell.hasGuardedUnsavedChanges)
    }
}

// MARK: Mark as paid

@MainActor
@Suite struct PlannedLinkTests {
    static let row = OpenAPI.PlannedTransaction(
        id: 1, plannedDate: "2026-10-14", bankAccount: "BE12", recipientId: 9, recipientName: "Landlord",
        memo: "Rent", amount: -950, currency: "EUR", isRecurring: true, recurrencePattern: "monthly",
        isExecuted: false, executionCount: 0, isActive: true, links: [])

    static let candidates = [
        PlannedFixture.transaction(1, date: "2026-10-01", memo: "Rent October", amount: -950),
        PlannedFixture.transaction(2, date: "2026-10-02", memo: "Coffee", amount: Decimal(string: "-3.5")!),
        PlannedFixture.transaction(3, date: "2026-10-13T00:00:00.000Z", recipient: "Landlord", amount: -960),
    ]

    @Test func theDialogStartsTwoWeeksBeforeTheDueDateAndSearchesThePayeeCluster() async throws {
        let editing = FakePlannedEditingService()
        let pickers = FakePickerService(recipients: [EditingFixture.recipient(9, "Landlord", primary: 2)])
        let model = await EditingFixture.page([Self.row], editing: editing, pickers: pickers)
        model.openLinkDialog(for: model.payments[0])
        let link = try #require(model.link)
        #expect(link.filters.startDate == "2026-09-30")
        #expect(link.filters.endDate.isEmpty)
        #expect(link.filters.recipientName == "Landlord")
        #expect(link.filters.bankAccount == "BE12")
        #expect(!link.includesLinked)
        await link.resolveCluster()
        await link.resolveCluster()
        #expect(await pickers.recipientLookups == [9])
        #expect(link.filters.recipientId == 2)
        #expect(link.includesLinked)
        #expect(link.filters.operation.recipientId == 2)
        #expect(link.filters.operation.recipientName == nil)
        link.setRecipientName("Land")
        #expect(!link.includesLinked)
        #expect(link.filters.operation.recipientName == "Land")
        link.setRecipientName("")
        #expect(link.filters.operation.recipientName == "Landlord")
        #expect(link.filters.operation.limit == 50)
        #expect(link.filters.operation.active == true)
        #expect(link.filters.operation.uncategorised == nil)
        link.setUncategorised(true)
        link.setActiveOnly(false)
        #expect(link.filters.operation.uncategorised == true)
        #expect(link.filters.operation.active == false)
        link.setStartDate(nil)
        link.setEndDate(PlannedDay(year: 2026, month: 10, day: 31))
        #expect(link.filters.operation.startDate == nil)
        #expect(link.filters.operation.endDate == "2026-10-31")
    }

    @Test func searchAndAmountMatchFilterTheCandidatesLocally() async throws {
        let editing = FakePlannedEditingService()
        await editing.setCandidates(Self.candidates)
        let model = await EditingFixture.page([Self.row], editing: editing)
        model.openLinkDialog(for: model.payments[0])
        let link = try #require(model.link)
        #expect(link.isLoading)
        await link.load()
        #expect(!link.isLoading)
        // Tolerance 5 %: 950 ± 47.50.
        #expect(link.visibleCandidates.map { $0.id } == [1, 3])
        link.setMatchAmount(false)
        #expect(link.visibleCandidates.map { $0.id } == [1, 2, 3])
        // The amount match and tolerance are local: no refetch.
        await link.load()
        #expect(await editing.candidateQueries.count == 1)
        link.search = "RENT"
        #expect(link.visibleCandidates.map { $0.id } == [1])
        link.search = "landlord"
        #expect(link.visibleCandidates.map { $0.id } == [3])
        link.search = "3.5"
        #expect(link.visibleCandidates.map { $0.id } == [2])
        link.search = ""
        link.setMatchAmount(true)
        link.setToleranceInput("0")
        // At least one unit of tolerance.
        #expect(link.visibleCandidates.map { $0.id } == [1])
        link.setToleranceInput("abc")
        #expect(link.filters.amountTolerancePct == 0)
        link.commitTolerance()
        #expect(link.toleranceInput == "0")
        link.setToleranceInput("-1")
        link.commitTolerance()
        #expect(link.toleranceInput == "0")
        // A filter change refetches.
        link.setBankAccount("BE99")
        await link.load()
        #expect(await editing.candidateQueries.count == 2)
        #expect(await editing.candidateQueries.last?.bankAccount == "BE99")
    }

    @Test func twoLoadsForTheSameFiltersShareOneRequest() async throws {
        let editing = FakePlannedEditingService()
        let gate = CallGate()
        await editing.holdCandidates(gate)
        await editing.setCandidates(Self.candidates)
        let model = await EditingFixture.page([Self.row], editing: editing)
        model.openLinkDialog(for: model.payments[0])
        let link = try #require(model.link)
        let first = Task { await link.load() }
        let second = Task { await link.load() }
        while await editing.candidateQueries.isEmpty { await Task.yield() }
        gate.open()
        await first.value
        await second.value
        #expect(await editing.candidateQueries.count == 1)
        #expect(link.candidates.count == 3)
    }

    @Test func linkAndMarkAsPaidExecutesWithTheTransactionDate() async throws {
        let editing = FakePlannedEditingService()
        await editing.setCandidates(Self.candidates)
        let model = await EditingFixture.page([Self.row], editing: editing)
        model.openLinkDialog(for: model.payments[0])
        let link = try #require(model.link)
        await link.load()
        #expect(!link.canExecute)
        link.select(3)
        #expect(link.selectedTransaction?.id == 3)
        #expect(link.executionDate == "2026-10-13")
        #expect(link.canExecute)
        #expect(PlannedLinkModel.title(Self.candidates[2], strings: EditingFixture.strings) == "Landlord")
        #expect(PlannedLinkModel.detail(Self.candidates[2], format: .isoDate) == "Landlord · 2026-10-13")
        let unnamed = OpenAPI.Transaction(id: 8, transactionDate: "", amount: 1, links: [])
        #expect(PlannedLinkModel.title(unnamed, strings: EditingFixture.strings) == "plannedPage.link.txFallback")
        #expect(PlannedLinkModel.detail(unnamed, format: .isoDate).isEmpty)
        await editing.failWrites(true)
        await model.executeLink(strings: EditingFixture.strings)
        #expect(model.notice?.key == "plannedPage.link.executeFailed")
        #expect(model.link === link)
        #expect(!link.isExecuting)
        await editing.failWrites(false)
        await model.executeLink(strings: EditingFixture.strings)
        #expect(await editing.executed == ["1:3:2026-10-13", "1:3:2026-10-13"])
        #expect(model.link == nil)
        #expect(model.notice?.key == "plannedPage.toast.executed")
        #expect(model.payments[0].isExecuted)
        await model.suggestionsRefresh?.value
        #expect(await editing.suggestionCalls == 1)
        // Cancel drops the selection with the dialog.
        model.openLinkDialog(for: model.payments[0])
        #expect(model.link?.selectedTransactionId == nil)
        model.dismissLinkDialog()
        #expect(model.link == nil)
    }

    @Test func markAsPaidToastsAndClosesBeforeTheSuggestionsRefetchAnswers() async throws {
        let editing = FakePlannedEditingService()
        await editing.setCandidates(Self.candidates)
        await editing.setSuggestions([EditingFixture.suggestion(1)])
        let gate = CallGate()
        await editing.holdSuggestions(gate)
        let model = await EditingFixture.page([Self.row], editing: editing)
        model.openLinkDialog(for: model.payments[0])
        let link = try #require(model.link)
        await link.load()
        link.select(1)
        await model.executeLink(strings: EditingFixture.strings)
        #expect(model.link == nil)
        #expect(model.notice?.key == "plannedPage.toast.executed")
        #expect(model.suggestions.isEmpty)
        gate.open()
        let refresh = try #require(model.suggestionsRefresh)
        await refresh.value
        #expect(await editing.suggestionCalls == 1)
        #expect(model.suggestions.count == 1)
    }
}

// MARK: Match suggestions

@MainActor
@Suite struct PlannedMatchSuggestionTests {
    @Test func reviewOpensMarkAsPaidForTheFirstLoadedSuggestion() async throws {
        let editing = FakePlannedEditingService()
        await editing.setSuggestions([EditingFixture.suggestion(2), EditingFixture.suggestion(1)])
        let clock = TestClock()
        let model = await EditingFixture.page(
            [PlannedFixture.row(id: 1), PlannedFixture.row(id: 2)], editing: editing, clock: clock)
        await model.loadSuggestions()
        #expect(model.suggestions.count == 2)
        // Fresh for five minutes.
        await model.loadSuggestions()
        #expect(await editing.suggestionCalls == 1)
        clock.advance(301)
        await model.loadSuggestions()
        #expect(await editing.suggestionCalls == 2)
        model.reviewSuggestion()
        #expect(model.link?.payment.id == 2)
    }

    @Test func reviewDoesNothingWhenThePaymentIsNotLoaded() async throws {
        let editing = FakePlannedEditingService()
        await editing.setSuggestions([EditingFixture.suggestion(99), EditingFixture.suggestion(1)])
        let model = await EditingFixture.page([PlannedFixture.row(id: 1)], editing: editing)
        await model.loadSuggestions()
        model.reviewSuggestion()
        #expect(model.link == nil)
        await editing.setSuggestions([])
        await model.loadSuggestions(force: true)
        #expect(model.suggestions.isEmpty)
        model.reviewSuggestion()
        #expect(model.link == nil)
    }
}

// MARK: Recurring detection

@MainActor
@Suite struct PlannedRecurringTests {
    static let patterns = [
        EditingFixture.pattern(1, "Gym", changes: [EditingFixture.change]),
        EditingFixture.pattern(2, "Rent", planned: true),
        EditingFixture.pattern(3, "Spotify"),
    ]

    func model(_ editing: FakePlannedEditingService, store: PlannedDismissalStore, clock: TestClock = TestClock())
        -> PlannedRecurringModel
    {
        PlannedRecurringModel(service: editing, store: store, now: { clock.now })
    }

    @Test func dismissalsMergeThisMacWithTheSettingAndHideThePayee() async {
        let editing = FakePlannedEditingService()
        await editing.setPatterns(.success(Self.patterns))
        await editing.setSetting(.success(EditingFixture.setting([3])))
        let store = PlannedDismissalStore.memory("[5]")
        let recurring = model(editing, store: store)
        #expect(recurring.display == .hidden)
        await recurring.load()
        #expect(recurring.dismissed == [5, 3])
        #expect(store.read() == "[5,3]")
        #expect(recurring.visiblePatterns.map { $0.recipientId } == [1])
        #expect(recurring.amountAlerts.map { $0.recipientId } == [1])
        #expect(recurring.display == .cards)
        recurring.dismiss(1)
        #expect(recurring.dismissed == [5, 3, 1])
        #expect(store.read() == "[5,3,1]")
        #expect(recurring.display == .caughtUp)
        await recurring.settle()
        #expect(await editing.savedValues == [.array([.int(5), .int(3), .int(1)])])
        #expect(await editing.savedBaselines.first == EditingFixture.setting([3]).expected)
        // The next save goes against the saved value.
        recurring.dismiss(2)
        await recurring.settle()
        #expect(
            await editing.savedBaselines.last
                == .object(["exists": .bool(true), "value": .array([.int(5), .int(3), .int(1)])]))
        // Dismissing a payee twice does nothing.
        recurring.dismiss(2)
        await recurring.settle()
        #expect(await editing.savedValues.count == 2)
        // The reset clears both copies.
        recurring.resetDismissals()
        #expect(recurring.dismissed.isEmpty)
        #expect(store.read() == "[]")
        await recurring.settle()
        #expect(await editing.savedValues.last == .array([]))
        #expect(recurring.visiblePatterns.map { $0.recipientId } == [1, 3])
    }

    @Test func aMissingSettingIsCreatedAndAnUnreadableOneIsNotWritten() async {
        let missing = FakePlannedEditingService()
        let first = model(missing, store: .memory())
        await first.load()
        #expect(first.dismissed.isEmpty)
        first.dismiss(4)
        await first.settle()
        #expect(await missing.savedBaselines == [.object(["exists": .bool(false)])])

        let offline = FakePlannedEditingService()
        await offline.setSetting(.failure(.network("offline")))
        let store = PlannedDismissalStore.memory("[7]")
        let second = model(offline, store: store)
        await second.load()
        #expect(second.dismissed == [7])
        second.dismiss(4)
        await second.settle()
        #expect(store.read() == "[7,4]")
        #expect(await offline.savedValues.isEmpty)
    }

    @Test func aRejectedSaveStopsLaterSavesButKeepsTheLocalCopy() async {
        let editing = FakePlannedEditingService()
        await editing.setSetting(.success(EditingFixture.setting([])))
        await editing.failSaves(true)
        let store = PlannedDismissalStore.memory()
        let recurring = model(editing, store: store)
        await recurring.load()
        recurring.dismiss(1)
        recurring.dismiss(2)
        await recurring.settle()
        #expect(await editing.savedValues.count == 1)
        #expect(store.read() == "[1,2]")
        #expect(recurring.dismissed == [1, 2])
    }

    @Test func patternsLoadOnceWhileFreshAndAFailureHidesThePanel() async {
        let editing = FakePlannedEditingService()
        let gate = CallGate()
        await editing.holdPatterns(gate)
        await editing.setPatterns(.success(Self.patterns))
        let clock = TestClock()
        let recurring = model(editing, store: .memory(), clock: clock)
        let first = Task { await recurring.load() }
        let second = Task { await recurring.load() }
        while await editing.patternCalls == 0 { await Task.yield() }
        #expect(recurring.display == .loading || recurring.display == .hidden)
        gate.open()
        await first.value
        await second.value
        #expect(await editing.patternCalls == 1)
        #expect(await editing.settingReads == 1)
        await editing.holdPatterns(nil)
        await recurring.load()
        #expect(await editing.patternCalls == 1)
        clock.advance(301)
        await recurring.load()
        #expect(await editing.patternCalls == 2)
        #expect(await editing.settingReads == 1)
        await editing.setPatterns(.failure(.contract(APIContractError(endpoint: "x", issues: []))))
        await recurring.reloadPatterns()
        #expect(recurring.display == .hidden)
        await editing.setPatterns(.success([EditingFixture.pattern(2, "Rent", planned: true)]))
        await recurring.reloadPatterns()
        #expect(recurring.display == .caughtUp)
    }

    @Test func trackCreatesARecurringPaymentAndRefreshes() async throws {
        let editing = FakePlannedEditingService()
        await editing.setPatterns(.success(Self.patterns))
        let service = FakePlannedService(rows: [PlannedFixture.row(id: 1)])
        let model = PlannedFixture.model(service, editing: editing)
        await model.appear(showAll: false, defaultCurrency: "EUR")
        await model.recurring.load()
        await model.track(EditingFixture.pattern(3, "Spotify", amount: Decimal(string: "-9.99")!), strings: EditingFixture.strings)
        let body = try #require(await editing.tracked.first)
        #expect(body.plannedDate == "2026-11-01")
        #expect(body.amount == Decimal(string: "-9.99"))
        #expect(body.recipientId == 3)
        #expect(body.memo == "recurring.autoDetectedMemo")
        #expect(body.accountId == 7)
        #expect(body.categoryId == 4)
        #expect(body.isRecurring == true)
        #expect(body.recurrencePattern == "monthly")
        #expect(model.notice?.key == "recurring.toast.created")
        #expect(await editing.patternCalls == 2)
        #expect(await service.loads.count == 2)
        let income = EditingFixture.pattern(4, "Employer", direction: "income", detected: "custom", interval: 10, amount: 3000)
        await model.track(income, strings: EditingFixture.strings)
        let second = try #require(await editing.tracked.last)
        #expect(second.amount == 3000)
        #expect(second.recurrencePattern == "every 10 days")
        await editing.failWrites(true)
        await model.track(income, strings: EditingFixture.strings)
        #expect(model.notice?.key == "recurring.toast.failed")
    }

    @Test func patternsDecodeAndLabel() throws {
        let body = try JSONValue.parse(
            Data(
                """
                {"patterns":[{"recipientId":3,"recipientName":"Spotify","direction":"expense","detectedPattern":"fortnightly",
                "intervalDays":14,"occurrences":5,"latestAmount":9.99,"currency":"EUR","categoryId":null,"categoryName":null,
                "accountId":null,"predictedNext":"2026-11-01","amountChanges":[],"isAlreadyPlanned":false,"confidence":65}],
                "total":1}
                """.utf8))
        let list = try PlannedRecurringPattern.list(from: body)
        #expect(list.count == 1)
        #expect(list[0].latestAmount == Decimal(string: "9.99"))
        #expect(list[0].confidenceLevel == .medium)
        #expect(list[0].patternLabel(EditingFixture.strings) == "fortnightly")
        // A pattern without an account leaves `account_id` out, like the web's `undefined`.
        let track = list[0].trackBody(memo: "m")
        #expect(track.accountId == nil)
        let encoded = try JSONValue.parse(try APIBody.encode(track))
        let fields = try #require(encoded.objectValue)
        #expect(fields["account_id"] == nil)
        #expect(fields["recipient_id"] == .int(3))
        #expect(fields["is_recurring"] == .bool(true))
        #expect(fields["recurrence_pattern"] == .string("fortnightly"))
        #expect(EditingFixture.pattern(1, "A", confidence: 80).confidenceLevel == .high)
        #expect(EditingFixture.pattern(1, "A", confidence: 59).confidenceLevel == .low)
        #expect(EditingFixture.pattern(1, "A").patternLabel(EditingFixture.strings) == "recurring.pattern.monthly")
        #expect(throws: APIError.self) { try PlannedRecurringPattern.list(from: .object(["items": .array([])])) }
        #expect(PlannedDismissalStore.ids(.array([.int(1), .string("2"), .int(0), .int(-3), .double(1.5), .string("x")])) == [1, 2])
        #expect(PlannedDismissalStore.ids(.object([:])).isEmpty)
        #expect(PlannedDismissalStore.memory("not json").load().isEmpty)
        #expect(PlannedRecurringModel.merge([1, 2], [2, 3]) == [1, 2, 3])
    }
}

// MARK: Pickers

@MainActor
@Suite struct PickerDataTests {
    static func service() -> FakePickerService {
        FakePickerService(
            recipients: [EditingFixture.recipient(1, "Landlord"), EditingFixture.recipient(2, "Gym")],
            accounts: [EditingFixture.account(7, "Main", display: "Everyday"), EditingFixture.account(8, "Savings")],
            categories: [
                EditingFixture.category(4, ["Leisure"]), EditingFixture.category(5, ["Leisure", "Sport"]),
                EditingFixture.category(6, ["Old"], active: false),
            ],
            tags: [EditingFixture.tag(1, "sport"), EditingFixture.tag(2, "health")])
    }

    @Test func theListsLoadOnceAndLabelTheSelection() async {
        let service = Self.service()
        let pickers = PickerDataModel(service: service)
        let first = Task { await pickers.load() }
        let second = Task { await pickers.load() }
        await first.value
        await second.value
        #expect(await service.accountLoads == 1)
        #expect(pickers.isLoaded)
        #expect(pickers.recipientName(2) == "Gym")
        #expect(pickers.recipientName(nil) == nil)
        #expect(pickers.activeCategories.map { $0.id } == [4, 5])
        #expect(pickers.categoryLabel(5) == "Leisure / Sport")
        #expect(pickers.categoryLabel(6) == nil)
        #expect(pickers.categoryName(6) == "Old")
        #expect(pickers.accountLabel(name: " main ") == "Everyday")
        #expect(pickers.accountLabel(name: "Savings") == "Savings")
        #expect(pickers.accountLabel(name: "Closed") == "Closed")
        #expect(pickers.accountLabel(name: "") == nil)
        pickers.reset()
        await pickers.load()
        #expect(await service.accountLoads == 2)
    }

    @Test func recipientSearchGoesToTheServerOncePerText() async {
        let service = Self.service()
        let pickers = PickerDataModel(service: service)
        await pickers.load()
        #expect(pickers.recipients(matching: " ").count == 2)
        #expect(pickers.recipients(matching: "land").isEmpty)
        await pickers.searchRecipients(" land ")
        await pickers.searchRecipients("land")
        #expect(pickers.recipients(matching: "land").map { $0.id } == [1])
        #expect(await service.recipientSearches == [nil, "land"])
        await pickers.resolveRecipient(1)
        await pickers.resolveRecipient(1)
        #expect(await service.recipientLookups == [1])
    }

    @Test func tagsSuggestAddAndCreate() async {
        let service = Self.service()
        let pickers = PickerDataModel(service: service)
        await pickers.load()
        #expect(pickers.tagSuggestions(typed: "", selected: ["sport"]).map { $0.slug } == ["health"])
        #expect(pickers.tagSuggestions(typed: "SPO", selected: []).map { $0.slug } == ["sport"])
        var state = TagInputState(selected: [])
        state.typed = "Sport"
        let added = state.commit(existing: pickers.tags)
        #expect(added == .added)
        #expect(state.selected == ["sport"])
        #expect(state.typed.isEmpty)
        state.typed = "Day Trip!"
        #expect(state.liveSlug == "day-trip")
        #expect(state.showsSlugHint)
        #expect(state.canCreate(existing: pickers.tags))
        let create = state.commit(existing: pickers.tags)
        #expect(create == .create("day-trip"))
        await pickers.createTag(slug: "day-trip", color: PickerDataModel.tagPalette[0].color)
        #expect(await service.createdTags == ["day-trip"])
        #expect(pickers.tag("day-trip") != nil)
        state.typed = ""
        state.backspace()
        #expect(state.selected.isEmpty)
        var full = TagInputState(selected: (1...PickerDataModel.maxTags).map { "t\($0)" })
        full.typed = "new"
        #expect(!full.canCreate(existing: []))
        full.add("other")
        #expect(full.selected.count == PickerDataModel.maxTags)
        #expect(PickerDataModel.tagPalette.count == 12)
    }
}

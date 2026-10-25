import Foundation
import Testing
@testable import VisionNativeCore

/// The bulk bar's calls, the payee creation and the transfer link over recorded calls.
actor FakeTransactionBulkService: TransactionBulkService {
    private(set) var updateSelectors: [BulkSelector] = []
    private(set) var updateFields: [BulkUpdateFields] = []
    private(set) var deletes: [BulkSelector] = []
    private(set) var exports: [BulkSelector] = []
    private(set) var exportFormats: [ExportFormat] = []
    /// `"ids|add|remove"` per bulk tag.
    private(set) var tagCalls: [String] = []
    private(set) var transfers: [[Int]] = []
    private(set) var createdNames: [String] = []
    private var failing = false
    private var exportedCount: Int? = 3
    private var existing: [String: Int] = [:]
    private var nextRecipient = 300

    init() {}

    func fail(_ on: Bool) { failing = on }
    func setExportedCount(_ count: Int?) { exportedCount = count }
    func setExisting(_ names: [String: Int]) { existing = names }

    private func check() throws {
        if failing { throw APIError.network("offline") }
    }

    func bulkUpdate(_ selector: BulkSelector, fields: BulkUpdateFields) async throws -> BulkUpdateResult {
        updateSelectors.append(selector)
        updateFields.append(fields)
        try check()
        return BulkUpdateResult(updated: selector.count, requested: selector.count, matched: selector.count)
    }

    func bulkDelete(_ selector: BulkSelector) async throws -> BulkDeleteResult {
        deletes.append(selector)
        try check()
        return BulkDeleteResult(deleted: selector.count, requested: selector.count, matched: selector.count)
    }

    func bulkExport(_ selector: BulkSelector, format: ExportFormat) async throws -> BulkExportFile {
        exports.append(selector)
        exportFormats.append(format)
        try check()
        return BulkExportFile(data: Data("id\n".utf8), exportedCount: exportedCount)
    }

    func bulkTag(ids: [Int], add: [String], remove: [String]) async throws -> OpenAPI.BulkTagResult {
        tagCalls.append("\(ids.map(String.init).joined(separator: ","))|\(add.joined(separator: ","))|\(remove.joined(separator: ","))")
        try check()
        return OpenAPI.BulkTagResult(added: add.count, removed: remove.count, transactionsAffected: ids.count)
    }

    func markTransfer(_ first: Int, _ second: Int) async throws {
        transfers.append([first, second])
        try check()
    }

    func createRecipient(name: String) async throws -> CreatedRecipient {
        createdNames.append(name)
        try check()
        if let id = existing[name] {
            return CreatedRecipient(id: id, name: name, isActive: true, createdAt: "2026-01-01", links: [], created: false)
        }
        nextRecipient += 1
        existing[name] = nextRecipient
        return CreatedRecipient(
            id: nextRecipient, name: name, isActive: true, createdAt: "2026-10-12", links: [], created: true)
    }
}

/// The split calls over an in-memory list of owed splits.
actor FakeSplitsService: SplitsService {
    private(set) var batches: [[SplitShare]] = []
    private(set) var bulkCalls: [String] = []
    private(set) var payments: [String] = []
    private(set) var settled: [Int] = []
    private(set) var settledAll: [Int] = []
    private(set) var deletedSplits: [Int] = []
    private(set) var summaryLoads = 0
    private(set) var detailLoads: [Int] = []
    private(set) var recentOffsets: [Int] = []
    private var existing: [Int: [OpenAPI.Split]] = [:]
    private var owedSplits: [OpenAPI.SplitOwedDetail]
    private var recentRows: [OpenAPI.Transaction]
    private var failing = false
    private var bulkResult = OpenAPI.BulkSplitResult(
        requested: 2, split: 2, skippedAlreadySplit: 0, skippedZeroAmount: 0, skippedMissing: 0, items: [])

    init(owed: [OpenAPI.SplitOwedDetail] = [], recent: [OpenAPI.Transaction] = []) {
        owedSplits = owed
        recentRows = recent
    }

    func fail(_ on: Bool) { failing = on }
    func setExisting(_ splits: [OpenAPI.Split], transactionId: Int) { existing[transactionId] = splits }
    func setBulkResult(_ result: OpenAPI.BulkSplitResult) { bulkResult = result }

    private func check() throws {
        if failing { throw APIError.network("offline") }
    }

    func splits(transactionId: Int) async throws -> [OpenAPI.Split] {
        existing[transactionId] ?? []
    }

    func createSplits(transactionId: Int, shares: [SplitShare]) async throws {
        batches.append(shares)
        try check()
    }

    func bulkSplit(transactionIds: [Int], recipientId: Int, mode: BulkSplitMode) async throws -> OpenAPI.BulkSplitResult {
        bulkCalls.append("\(transactionIds.map(String.init).joined(separator: ","))|\(recipientId)|\(mode.rawValue)")
        try check()
        return bulkResult
    }

    func owedSummary(currency: String) async throws -> [OpenAPI.SplitOwed] {
        summaryLoads += 1
        try check()
        let open = owedSplits.filter { !$0.isSettled }
        guard !open.isEmpty else { return [] }
        let total = open.reduce(Decimal(0)) { $0 + $1.amount }
        let paid = open.reduce(Decimal(0)) { $0 + $1.amountPaid }
        return [
            OpenAPI.SplitOwed(
                recipientId: 4, recipientName: "Anna", totalOwed: total, totalPaid: paid, remaining: total - paid,
                splitCount: open.count, unconvertedCount: 0, unconvertedCurrencies: [])
        ]
    }

    func owed(recipientId: Int, currency: String) async throws -> [OpenAPI.SplitOwedDetail] {
        detailLoads.append(recipientId)
        try check()
        return owedSplits.filter { !$0.isSettled }
    }

    func exportOwedCsv(recipientId: Int) async throws -> Data {
        try check()
        return Data("date,amount\n".utf8)
    }

    func recordPayment(splitId: Int, amount: Decimal) async throws {
        payments.append("\(splitId):\(amount)")
        try check()
    }

    func settle(splitId: Int) async throws {
        settled.append(splitId)
        try check()
        owedSplits.removeAll { $0.id == splitId }
    }

    func settleAll(recipientId: Int) async throws -> Int {
        settledAll.append(recipientId)
        try check()
        let count = owedSplits.count
        owedSplits = []
        return count
    }

    func deleteSplit(id: Int) async throws {
        deletedSplits.append(id)
        try check()
        owedSplits.removeAll { $0.id == id }
    }

    func recipientTransactions(groupId: Int, offset: Int, limit: Int) async throws -> TransactionPage {
        recentOffsets.append(offset)
        let end = min(recentRows.count, offset + limit)
        let items = offset < end ? Array(recentRows[offset..<end]) : []
        return TransactionPage(items: items, total: recentRows.count)
    }
}

enum SplitFixture {
    static func owed(_ id: Int, amount: Decimal, paid: Decimal = 0, memo: String? = "Dinner") -> OpenAPI.SplitOwedDetail {
        OpenAPI.SplitOwedDetail(
            id: id, transactionId: 40 + id, recipientId: 4, recipientName: "Anna", amount: amount, amountPaid: paid,
            note: id == 1 ? "Half" : nil, isSettled: false, createdAt: "2026-10-01", updatedAt: "2026-10-01",
            transactionDate: "2026-10-0\(id)", transactionMemo: memo, transactionAmount: -amount * 2,
            transactionCurrency: "EUR", transactionRecipientName: "Bistro", remaining: amount - paid)
    }

    static func split(_ id: Int, transactionId: Int, amount: Decimal, name: String?) -> OpenAPI.Split {
        OpenAPI.Split(
            id: id, transactionId: transactionId, recipientId: 4, recipientName: name, amount: amount, amountPaid: 0,
            isSettled: false, createdAt: "2026-10-01", updatedAt: "2026-10-01")
    }

    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "owesPage.fromPerson": "from {n} person", "owesPage.fromPeople": "from {n} people",
            "owesPage.split": "{n} split", "owesPage.splits": "{n} splits", "owesPage.paid": "Paid: {amount}",
            "owesPage.totalLabel": "Total: {amount}", "owesPage.transaction": "Transaction",
            "owesPage.original": "Original: {amount}", "txPage.field.uncategorized": "Uncategorized",
            "splits.bulkSkippedAlreadySplit.one": "{count} was already split.",
            "splits.bulkSkippedAlreadySplit.other": "{count} were already split.",
            "splits.bulkSkippedOther.one": "{count} could not be split.",
            "splits.bulkSkippedOther.other": "{count} could not be split.",
            "txPage.bulk.confirmDeleteTitle.one": "Delete {count} transaction?",
            "txPage.bulk.confirmDeleteTitle.other": "Delete {count} transactions?",
            "txPage.bulk.transferSelectionChanged": "The selected records changed.",
        ])

    static func decimal(_ text: String) -> Decimal { Decimal(string: text)! }
}

// MARK: - Add transaction

@MainActor
@Suite struct AddTransactionTests {
    static let anchored = OpenAPI.Account(
        id: 7, name: "BE00 1234", displayName: "Everyday", currency: "USD", type: "checking", liquidityClass: "cash",
        spendable: true, inNetWorth: true, taxWrapper: "none", owner: "self", multiCurrencyCash: false,
        hasCashSleeve: false, anchorDate: "2026-10-10", isActive: true, createdAt: "2026-01-01",
        updatedAt: "2026-01-01")

    static func pickers() -> FakePickerService {
        FakePickerService(
            recipients: [TxFixture.recipient(1, "Bakery", defaultCategory: 5), TxFixture.recipient(2, "Garage")],
            accounts: [anchored, EditingFixture.account(9, "BE99 0000", display: "Savings")],
            categories: [EditingFixture.category(5, ["Food"]), EditingFixture.category(6, ["Car"])])
    }

    @Test func theFormValidatesRevealsAndHintsLikeTheWeb() async throws {
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService(), pickers: Self.pickers())
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        #expect(form.draft.date == "2026-10-12")
        #expect(form.draft.currency == "EUR")
        #expect(!form.isDirty)
        #expect(form.hintKey == "addTxn.hint.amount")
        #expect(form.visibleErrors(format: .eu).isEmpty)
        await model.submitAdd()
        #expect(form.errorsRevealed)
        #expect(form.focusRequest == .amount)
        let errors = form.visibleErrors(format: .eu)
        #expect(errors[.amount] == "validation.required")
        #expect(errors[.recipient] == "validation.required")
        #expect(errors[.account] == "portfolio.move.selectAccount")
        #expect(errors[.toAccount] == nil)
        form.setAmount("abc")
        #expect(form.visibleErrors(format: .eu)[.amount] == "addTxn.invalidAmount")
        form.setAmount("0")
        #expect(form.visibleErrors(format: .eu)[.amount] == "addTxn.zeroAmount")
        form.setAmount("12,50")
        #expect(form.isDirty)
        #expect(form.hintKey == "addTxn.hint.recipient")
        form.setKind(.income)
        #expect(!form.errorsRevealed)
        #expect(form.hintKey == "addTxn.hint.recipientIncome")
        #expect(form.recipientLabelKey == "addTxn.recipientIncome")
        form.setKind(.transfer)
        #expect(form.hintKey == "addTxn.hint.account")
        form.pickAccount(name: "BE00 1234", id: 7)
        #expect(form.draft.currency == "USD")
        #expect(form.hintKey == "addTxn.hint.toAccount")
        form.pickToAccount(name: "BE00 1234", id: 7)
        #expect(form.errors(format: .eu)[.toAccount] == "addTxn.transferSameAccount")
        form.pickToAccount(name: "BE99 0000", id: 9)
        #expect(form.errors(format: .eu).isEmpty)
        #expect(form.hintKey == "addTxn.hint.ready")
        // Currency is upper-cased and at most 10 characters; memo and comment are capped.
        form.setCurrency("usdollarsxyz")
        #expect(form.draft.currency == "USDOLLARSX")
        form.setMemo(String(repeating: "m", count: 600))
        #expect(form.draft.memo.count == 500)
        form.setComment(String(repeating: "c", count: 1200))
        #expect(form.draft.comment.count == 1000)
    }

    @Test func theKindSignsTheAmountAndTheDateControlsMoveTheDay() async throws {
        #expect(TransactionKind.expense.signed(SplitFixture.decimal("-12.5")) == SplitFixture.decimal("-12.5"))
        #expect(TransactionKind.income.signed(SplitFixture.decimal("-12.5")) == SplitFixture.decimal("12.5"))
        #expect(TransactionKind.transfer.signed(SplitFixture.decimal("3")) == SplitFixture.decimal("-3"))
        #expect(TransactionKind.income.submitKey == "addTxn.addIncome")
        #expect(TransactionKind.expense.signGlyph == "−")
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService(), pickers: Self.pickers())
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        #expect(form.dateChoice == .today)
        form.setDateChoice(.yesterday)
        #expect(form.draft.date == "2026-10-11")
        #expect(form.dateChoice == .yesterday)
        form.setDateChoice(.other)
        #expect(form.dateChoice == .other)
        form.setCustomDay(PlannedDay(year: 2026, month: 10, day: 3))
        #expect(form.draft.date == "2026-10-03")
        // On or before the account's statement anchor, the backdated note shows.
        #expect(form.backdatedAnchorDate == nil)
        form.pickAccount(name: "BE00 1234", id: 7)
        #expect(form.backdatedAnchorDate == "2026-10-10")
        form.setDateChoice(.today)
        #expect(form.backdatedAnchorDate == nil)
        form.setCustomDay(nil)
        #expect(form.errors(format: .eu)[.date] == "validation.required")
    }

    @Test func aPayeesUsualCategoryFillsUntilTheUserChooses() async throws {
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService(), pickers: Self.pickers())
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        await form.selectRecipient(1)
        #expect(form.draft.categoryId == 5)
        #expect(form.categoryAuto)
        #expect(form.usualCategorySource?.name == "Bakery")
        // Another payee clears the filled category; this one has none.
        await form.selectRecipient(2)
        #expect(form.draft.categoryId == nil)
        #expect(!form.categoryAuto)
        // A chosen category stays.
        form.selectCategory(6)
        await form.selectRecipient(1)
        #expect(form.draft.categoryId == 6)
        #expect(!form.categoryAuto)
    }

    @Test func anExpenseIsCreatedSignedAndTheNewRowIsSelected() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(2))
        let (model, shell) = try await TxFixture.opened(service, pickers: Self.pickers())
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        form.setAmount("12,50")
        await form.selectRecipient(2)
        form.pickAccount(name: "BE00 1234", id: 7)
        form.setMemo("  Lunch  ")
        form.setComment("   ")
        #expect(model.hasUnsavedChanges)
        await model.submitAdd()
        let body = try #require(await service.created.last)
        #expect(body.amount == SplitFixture.decimal("-12.5"))
        #expect(body.recipientId == 2)
        #expect(body.accountId == 7)
        #expect(body.currency == "USD")
        #expect(body.memo == "Lunch")
        #expect(body.comment == nil)
        #expect(body.allowDuplicate == nil)
        #expect(!model.isAddPresented)
        #expect(model.addForm == nil)
        #expect(!model.hasUnsavedChanges)
        #expect(shell.nativeNavigationLocation.raw == "/transactions?id=1001")
        // The route selects the new row: the first page reloads and the row opens.
        await model.sync()
        #expect(model.selectedId == 1001)
        #expect(model.rows?.first?.id == 1001)
    }

    @Test func aConflictAsksAndAddAnywayResubmits() async throws {
        let service = FakeTransactionsService()
        await service.conflictCreates(true)
        let (model, shell) = try await TxFixture.opened(service, pickers: Self.pickers())
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        form.setKind(.income)
        form.setAmount("100")
        await form.selectRecipient(2)
        form.pickAccount(name: "BE99 0000", id: 9)
        await model.submitAdd()
        #expect(form.duplicateDetected)
        #expect(model.notice?.key == "addTxn.duplicateError")
        #expect(model.isAddPresented)
        // Any change hides the prompt; Add anyway needs it.
        form.setMemo("x")
        #expect(!form.duplicateDetected)
        await model.submitAdd(allowDuplicate: true)
        #expect(await service.created.count == 1)
        await model.submitAdd()
        #expect(form.duplicateDetected)
        await model.submitAdd(allowDuplicate: true)
        let last = try #require(await service.created.last)
        #expect(last.allowDuplicate == true)
        #expect(last.amount == SplitFixture.decimal("100"))
        #expect(!model.isAddPresented)
    }

    @Test func aTransferRecordsBothLegsAndLinksThem() async throws {
        let service = FakeTransactionsService()
        let bulk = FakeTransactionBulkService()
        await bulk.setExisting(["BE00 1234": 77])
        let (model, shell) = try await TxFixture.opened(service, pickers: Self.pickers(), bulk: bulk)
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        form.setKind(.transfer)
        form.setAmount("-250")
        form.pickAccount(name: "BE00 1234", id: 7)
        form.pickToAccount(name: "BE99 0000", id: 9)
        form.setMemo("Savings")
        await model.submitAdd()
        #expect(Set(await bulk.createdNames) == ["BE00 1234", "BE99 0000"])
        let legs = await service.created
        #expect(legs.count == 2)
        #expect(legs.first?.amount == SplitFixture.decimal("-250"))
        #expect(legs.first?.accountId == 7)
        #expect(legs.first?.recipientId == 301)
        #expect(legs.last?.amount == SplitFixture.decimal("250"))
        #expect(legs.last?.accountId == 9)
        #expect(legs.last?.recipientId == 77)
        #expect(legs.last?.memo == "Savings")
        #expect(await bulk.transfers == [[1001, 1002]])
        #expect(!model.isAddPresented)
    }

    @Test func aFailedTransferToastsAndKeepsTheSheet() async throws {
        let bulk = FakeTransactionBulkService()
        await bulk.fail(true)
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService(), pickers: Self.pickers(), bulk: bulk)
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        model.requestAdd()
        let form = try #require(model.addForm)
        form.setKind(.transfer)
        form.setAmount("5")
        form.pickAccount(name: "BE00 1234", id: 7)
        form.pickToAccount(name: "BE99 0000", id: 9)
        await model.submitAdd()
        #expect(model.notice?.key == "transactions.createFailedTitle")
        #expect(model.isAddPresented)
        #expect(!form.isPending)
    }

    @Test func thePayeeCreateRowCreatesSelectsAndToasts() async throws {
        let bulk = FakeTransactionBulkService()
        await bulk.setExisting(["Garage": 2])
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService(), pickers: Self.pickers(), bulk: bulk)
        defer { withExtendedLifetime(shell) {} }
        await model.pickers.load()
        let listed = model.pickers.recipients(matching: "")
        #expect(PickerDataModel.creatableName("  New shop ", listed: listed) == "New shop")
        #expect(PickerDataModel.creatableName("bakery", listed: listed) == nil)
        #expect(PickerDataModel.creatableName("   ", listed: listed) == nil)
        model.requestAdd()
        await model.createRecipientForAdd(named: "New shop")
        #expect(model.notice?.key == "recipients.created")
        #expect(model.addForm?.draft.recipientId == 301)
        #expect(model.pickers.recipientName(301) == "New shop")
        _ = await model.createRecipient(named: "Garage")
        #expect(model.notice?.key == "recipients.exists")
        #expect(model.notice?.kind == .info)
        await bulk.fail(true)
        let failed = await model.createRecipient(named: "Other")
        #expect(failed == nil)
        #expect(model.notice?.key == "recipients.createFailedTitle")
    }

    @Test func theSheetKeepsItsFormAndGuardsNavigation() async throws {
        let (model, shell) = try await TxFixture.opened(FakeTransactionsService())
        defer { withExtendedLifetime(shell) {} }
        shell.setLeaveGuard(model.leaveGuard)
        model.requestAdd()
        model.addForm?.setAmount("5")
        shell.navigate(to: "/planned")
        #expect(shell.leaveConfirmation?.path == "/planned")
        shell.stayOnPage()
        // Cancel keeps the form for next time.
        model.dismissAdd()
        #expect(!model.hasUnsavedChanges)
        model.requestAdd()
        #expect(model.addForm?.draft.amount == "5")
        shell.navigate(to: "/planned")
        shell.leavePage()
        #expect(model.addForm == nil)
        #expect(!model.isAddPresented)
        #expect(shell.route.path == "/planned")
    }
}


@MainActor
@Suite struct OwesTests {
    static func shell(_ splits: FakeSplitsService) -> (OwesModel, NativeShellModel) {
        let model = TxFixture.model(FakeTransactionsService(), splits: splits)
        let shell = TxFixture.shell(model)
        shell.strings = SplitFixture.strings
        return (model.owes, shell)
    }

    @Test func theSummaryLoadsOnceAndTotalsTheRemainingAmounts() async throws {
        let splits = FakeSplitsService(owed: [SplitFixture.owed(1, amount: 20, paid: 5), SplitFixture.owed(2, amount: 10)])
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.isLoadingSummary)
        async let first: Void = model.appear()
        async let second: Void = model.loadSummary()
        _ = await (first, second)
        #expect(await splits.summaryLoads == 1)
        #expect(model.totalOutstanding == 25)
        #expect(model.peopleLabel() == "from 1 person")
        let item = try #require(model.summary?.first)
        #expect(model.personSubtitle(item) == "2 splits · Paid: \(model.money(5, currency: "EUR")) · Total: \(model.money(30, currency: "EUR"))")
        #expect(OwesModel.progress(paid: 5, of: 30) > 0.16)
        #expect(OwesModel.progress(paid: 5, of: 0) == 0)
        await model.loadSummary(force: true)
        #expect(await splits.summaryLoads == 2)
    }

    @Test func aFailedSummaryRetries() async throws {
        let splits = FakeSplitsService(owed: [SplitFixture.owed(1, amount: 20)])
        await splits.fail(true)
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        await model.appear()
        #expect(model.summaryError != nil)
        await splits.fail(false)
        await model.loadSummary(force: true)
        #expect(model.summaryError == nil)
        #expect(model.summary?.count == 1)
    }

    @Test func thePersonDetailRecordsSettlesAndDeletes() async throws {
        let splits = FakeSplitsService(
            owed: [SplitFixture.owed(1, amount: 20, paid: 5), SplitFixture.owed(2, amount: 10, memo: nil)])
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        await model.appear()
        let item = try #require(model.summary?.first)
        await model.open(item)
        #expect(model.person == OwesPerson(id: 4, name: "Anna"))
        let rows = try #require(model.splits)
        #expect(rows.count == 2)
        #expect(model.title(rows[0]) == "Bistro - Dinner")
        #expect(model.title(rows[1]) == "Bistro")
        #expect(model.originalText(rows[0]) == "Original: \(model.money(40, currency: "EUR")) · Half")
        #expect(OwesModel.transactionLink(41, label: "Bistro - Dinner") == "/transactions?transaction_id=41&filter_label=Bistro%20-%20Dinner")
        // Record payment: prefilled with the remaining amount, more than zero.
        model.openPayment(rows[0])
        #expect(model.payment?.amountText == "15")
        model.setPaymentAmount("0")
        await model.submitPayment()
        #expect(model.payment?.invalid == true)
        model.setPaymentAmount("7,5")
        #expect(model.payment?.invalid == false)
        await model.submitPayment()
        #expect(await splits.payments == ["1:7.5"])
        #expect(model.payment == nil)
        #expect(model.notice?.key == "splits.paymentRecorded")
        // Mark as settled, then Delete split behind its alert.
        await model.settle(2)
        #expect(model.notice?.key == "splits.settled")
        #expect(model.splits?.count == 1)
        model.requestDeleteSplit(1)
        #expect(model.confirmation == .deleteSplit(1))
        model.cancelConfirmation()
        #expect(await splits.deletedSplits.isEmpty)
        model.requestDeleteSplit(1)
        await model.confirm()
        #expect(await splits.deletedSplits == [1])
        #expect(model.notice?.key == "splits.removed")
        #expect(model.splits?.isEmpty == true)
        model.back()
        #expect(model.person == nil)
    }

    @Test func settleAllAsksWithTheCountAndAmount() async throws {
        let splits = FakeSplitsService(owed: [SplitFixture.owed(1, amount: 20), SplitFixture.owed(2, amount: 10)])
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        await model.appear()
        await model.open(try #require(model.summary?.first))
        model.requestSettleAll()
        #expect(model.confirmation == .settleAll(count: 2, amount: 30))
        await model.confirm()
        #expect(await splits.settledAll == [4])
        #expect(model.notice?.key == "splits.allSettled")
        #expect(model.notice?.variables["n"] == "2")
        #expect(model.summary?.isEmpty == true)
        await splits.fail(true)
        model.requestSettleAll()
        #expect(model.confirmation == nil)
    }

    @Test func exportUsesTheSafeNameAndTheSavePanel() async throws {
        #expect(OwesModel.exportFileName("Anna & Bob  (Team)", today: EditingFixture.today) == "owed_anna_bob_team_2026-10-12.csv")
        #expect(OwesModel.exportFileName(String(repeating: "a", count: 80), today: EditingFixture.today).count == 64 + 20)
        let splits = FakeSplitsService(owed: [SplitFixture.owed(1, amount: 20)])
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        var saved: [String] = []
        model.save = { _, name in
            saved.append(name)
            return true
        }
        await model.appear()
        await model.open(try #require(model.summary?.first))
        await model.exportCsv()
        #expect(saved == ["owed_anna_2026-10-12.csv"])
        #expect(model.notice?.key == "owesPage.export.success")
        await splits.fail(true)
        await model.exportCsv()
        #expect(model.notice?.key == "owesPage.export.failed")
    }

    @Test func recentTransactionsPageByTenAndFilterLocally() async throws {
        let recent = (1...23).map { index in
            TxFixture.wire(
                id: index, categoryId: index == 1 ? nil : 5, category: index == 1 ? nil : "Food",
                bank: index == 2 ? nil : "BE00 1234", memo: index == 3 ? nil : "Lunch \(index)")
        }
        let splits = FakeSplitsService(owed: [SplitFixture.owed(1, amount: 20)], recent: recent)
        let (model, shell) = Self.shell(splits)
        defer { withExtendedLifetime(shell) {} }
        await model.appear()
        await model.open(try #require(model.summary?.first))
        async let first: Void = model.loadRecent()
        async let second: Void = model.loadRecent()
        _ = await (first, second)
        #expect(await splits.recentOffsets == [0])
        #expect(model.recent.count == 10)
        #expect(model.recentHasMore)
        let rows = model.recentAllRows
        #expect(rows[0].category == "Uncategorized")
        #expect(rows[1].bankAccount == "—")
        #expect(rows[2].description == "Transaction")
        await model.recentRowAppeared(10)
        #expect(model.recent.count == 20)
        await model.loadMoreRecent()
        #expect(model.recent.count == 23)
        #expect(!model.recentHasMore)
        model.recentQuery.search = "lunch 2"
        #expect(model.recentRows.map { row in row.id } == [2, 20, 21, 22, 23])
        model.recentQuery.toggleSort("amount")
        #expect(model.recentRows.count == 5)
        #expect(model.recentFilterValues("category") == ["Food", "Uncategorized"])
        model.disappear()
        #expect(model.recent.isEmpty)
        #expect(model.person == nil)
    }
}

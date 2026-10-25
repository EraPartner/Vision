import Foundation
import Testing
@testable import VisionNativeCore

/// A transactions service over an in-memory list that pages, filters a little, applies
/// PATCHes and records every call.
actor FakeTransactionsService: TransactionsService, TransactionAttachmentsService {
    private(set) var rows: [OpenAPI.Transaction]
    private(set) var queries: [TransactionListQuery] = []
    private(set) var offsets: [Int] = []
    private(set) var patches: [TransactionPatch] = []
    private(set) var created: [OpenAPI.TransactionCreate] = []
    private(set) var deleted: [Int] = []
    /// `"recipient:category:expected"` per Use for all.
    private(set) var bulkUpdates: [String] = []
    /// `"recipient:category"` per Always use.
    private(set) var defaults: [String] = []
    private(set) var savedSettings: [JSONValue] = []
    private(set) var baselines: [JSONValue] = []
    private(set) var exports: [TransactionExportQuery] = []
    private(set) var uploads: [String] = []
    private(set) var attachmentDeletes: [Int] = []
    private var attachmentList: [OpenAPI.Attachment] = []
    private var recipients: [Int: OpenAPI.Recipient] = [:]
    private var categoryNames: [Int: String] = [:]
    private var pageFailures: Set<Int> = []
    private var updateFails = false
    private var deleteFails = false
    private var deleteAttachmentFails = false
    private var stored: OpenAPI.Setting?
    private var updateGate: CallGate?
    private var nextId = 1000
    private var createConflicts = false
    private var createFails = false

    init(rows: [OpenAPI.Transaction] = []) {
        self.rows = rows
    }

    func failPages(atOffsets offsets: Set<Int>) { pageFailures = offsets }
    func failUpdates(_ fail: Bool) { updateFails = fail }
    func failDeletes(_ fail: Bool) { deleteFails = fail }
    func failAttachmentDeletes(_ fail: Bool) { deleteAttachmentFails = fail }
    func holdUpdates(_ gate: CallGate?) { updateGate = gate }
    /// A create without `allow_duplicate` answers 409.
    func conflictCreates(_ conflict: Bool) { createConflicts = conflict }
    func failCreates(_ fail: Bool) { createFails = fail }
    func setRecipients(_ list: [OpenAPI.Recipient]) {
        recipients = Dictionary(uniqueKeysWithValues: list.map { recipient in (recipient.id, recipient) })
    }
    func setCategoryNames(_ names: [Int: String]) { categoryNames = names }
    func setStoredSetting(_ setting: OpenAPI.Setting?) { stored = setting }
    func setAttachments(_ list: [OpenAPI.Attachment]) { attachmentList = list }

    private func matching(_ query: TransactionListQuery) -> [OpenAPI.Transaction] {
        rows.filter { row in
            if !query.includeExcluded && row.isActive == false { return false }
            if let id = query.filters.recipientId, row.recipientId != id { return false }
            if query.filters.uncategorised && row.categoryId != nil { return false }
            if !query.search.isEmpty {
                let haystack = "\(row.recipientName ?? "") \(row.memo ?? "")".lowercased()
                if !haystack.contains(query.search.lowercased()) { return false }
            }
            return true
        }
    }

    func transactionPage(_ query: TransactionListQuery, offset: Int) async throws -> TransactionPage {
        queries.append(query)
        offsets.append(offset)
        if pageFailures.contains(offset) { throw APIError.network("offline") }
        let all = matching(query)
        let end = min(all.count, offset + query.pageSize)
        let items = offset < end ? Array(all[offset..<end]) : []
        return TransactionPage(items: items, total: all.count)
    }

    func uncategorisedCount(recipientId: Int?) async throws -> Int {
        rows.filter { row in
            row.categoryId == nil && row.isActive != false && (recipientId == nil || row.recipientId == recipientId)
        }.count
    }

    func updateTransaction(id: Int, patch: TransactionPatch) async throws -> OpenAPI.Transaction {
        patches.append(patch)
        if let updateGate { await updateGate.wait() }
        if updateFails { throw APIError.network("offline") }
        guard let index = rows.firstIndex(where: { row in row.id == id }) else { throw APIError.network("missing") }
        let row = rows[index]
        var categoryId = row.categoryId
        if let change = patch.categoryId { categoryId = change }
        var recipientId = row.recipientId
        if let change = patch.recipientId { recipientId = change }
        var memo = row.memo
        if let change = patch.memo { memo = change }
        var comment = row.comment
        if let change = patch.comment { comment = change }
        let updated = TxFixture.wire(
            id: id, date: patch.transactionDate ?? row.transactionDate, recipientId: recipientId,
            recipient: recipientId.flatMap { recipients[$0]?.name } ?? (recipientId == row.recipientId ? row.recipientName : nil),
            categoryId: categoryId, category: categoryId.flatMap { categoryNames[$0] }, accountId: row.accountId,
            bank: row.bankAccount, amount: patch.amount ?? row.amount, currency: patch.currency ?? row.currency,
            memo: memo, comment: comment, isActive: patch.isActive ?? row.isActive ?? true,
            tags: patch.tags.map { slugs in slugs.enumerated().map { TxFixture.tag($0.offset + 1, $0.element) } } ?? row.tags ?? [])
        rows[index] = updated
        return updated
    }

    func createTransaction(_ body: OpenAPI.TransactionCreate) async throws -> OpenAPI.Transaction {
        created.append(body)
        if createFails { throw APIError.network("offline") }
        if createConflicts && body.allowDuplicate != true {
            throw APIError.client(APIClientError(status: 409, code: .conflict, message: "Duplicate"))
        }
        nextId += 1
        let row = TxFixture.wire(
            id: nextId, date: body.transactionDate, recipientId: body.recipientId,
            recipient: recipients[body.recipientId]?.name, categoryId: body.categoryId, accountId: body.accountId,
            amount: body.amount, currency: body.currency, memo: body.memo, comment: body.comment)
        rows.insert(row, at: 0)
        return row
    }

    func deleteTransaction(id: Int) async throws {
        deleted.append(id)
        if deleteFails { throw APIError.network("offline") }
        rows.removeAll { row in row.id == id }
    }

    func categorizeUncategorised(recipientId: Int, categoryId: Int, expectedCount: Int) async throws -> BulkUpdateResult {
        bulkUpdates.append("\(recipientId):\(categoryId):\(expectedCount)")
        var updated = 0
        for (index, row) in rows.enumerated()
        where row.recipientId == recipientId && row.categoryId == nil && row.isActive != false {
            rows[index] = TxFixture.wire(
                id: row.id, date: row.transactionDate, recipientId: row.recipientId, recipient: row.recipientName,
                categoryId: categoryId, category: categoryNames[categoryId], accountId: row.accountId,
                bank: row.bankAccount, amount: row.amount, currency: row.currency, memo: row.memo)
            updated += 1
        }
        return BulkUpdateResult(updated: updated, requested: expectedCount, matched: updated)
    }

    func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws {
        defaults.append("\(recipientId):\(categoryId)")
        if let recipient = recipients[recipientId] {
            recipients[recipientId] = TxFixture.recipient(recipient.id, recipient.name, defaultCategory: categoryId)
        }
    }

    func recipient(id: Int) async throws -> OpenAPI.Recipient {
        guard let found = recipients[id] else {
            throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Recipient not found"))
        }
        return found
    }

    func allAccounts() async throws -> [OpenAPI.Account] {
        [EditingFixture.account(7, "BE00 1234", display: "Everyday"), TxFixture.archivedAccount]
    }

    func exportFilteredTransactions(_ format: ExportFormat, query: TransactionExportQuery) async throws -> Data {
        exports.append(query)
        return Data("id,amount\n".utf8)
    }

    func setting(key: String) async throws -> OpenAPI.Setting {
        guard let stored else {
            throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Setting not found"))
        }
        return stored
    }

    func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        savedSettings.append(value)
        baselines.append(expected)
        let saved = OpenAPI.Setting(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
        stored = saved
        return saved
    }

    func attachments(transactionId: Int) async throws -> [OpenAPI.Attachment] {
        attachmentList.filter { item in item.transactionId == transactionId }
    }

    func uploadAttachment(transactionId: Int, file: AttachmentUpload) async throws -> OpenAPI.Attachment {
        uploads.append(file.name)
        let item = TxFixture.attachment(String(500 + uploads.count), transactionId: transactionId, name: file.name)
        attachmentList.append(item)
        return item
    }

    func downloadAttachment(id: Int) async throws -> Data {
        Data("%PDF-1.7".utf8)
    }

    func deleteAttachment(id: Int) async throws {
        attachmentDeletes.append(id)
        if deleteAttachmentFails { throw APIError.network("offline") }
        attachmentList.removeAll { item in item.id == String(id) }
    }
}

enum TxFixture {
    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "txPage.field.uncategorized": "Uncategorized", "txPage.field.unknown": "Unknown",
            "txPage.tableSubtitle": "{n} transactions", "txPage.countInAccounts": "{n} transactions in {m} accounts",
            "table.loadedOf": "{loaded} of {total} loaded", "table.scrollForMore": "Scroll for more",
            "table.shownOfFiltered": "{shown} of {total} shown (filtered)", "filter.type.expense": "Expenses",
            "filter.recipientId": "Payee #{id}", "filter.transactionId": "Transaction {id}",
        ])

    static let archivedAccount = OpenAPI.Account(
        id: 8, name: "Old savings", currency: "EUR", type: "savings", liquidityClass: "cash", spendable: false,
        inNetWorth: true, taxWrapper: "none", owner: "self", multiCurrencyCash: false, hasCashSleeve: false,
        isActive: false, createdAt: "2026-01-01", updatedAt: "2026-01-01")

    static func wire(
        id: Int, date: String = "2026-10-01", recipientId: Int? = 1, recipient: String? = "Bakery",
        categoryId: Int? = nil, category: String? = nil, accountId: Int? = 7, bank: String? = "BE00 1234",
        amount: Decimal = Decimal(string: "-4.5")!, currency: String? = "EUR", memo: String? = nil,
        comment: String? = nil, isActive: Bool = true, tags: [OpenAPI.TransactionTagRef] = []
    ) -> OpenAPI.Transaction {
        OpenAPI.Transaction(
            id: id, transactionDate: date, accountId: accountId, bankAccount: bank, recipientId: recipientId,
            recipientName: recipient, memo: memo, amount: amount, currency: currency, categoryId: categoryId,
            categoryName: category, comment: comment, isActive: isActive, tags: tags, links: [])
    }

    static func tag(_ id: Int, _ slug: String) -> OpenAPI.TransactionTagRef {
        OpenAPI.TransactionTagRef(id: id, slug: slug, isActive: true)
    }

    static func recipient(_ id: Int, _ name: String, defaultCategory: Int? = nil) -> OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: name, defaultCategoryId: defaultCategory, isActive: true, createdAt: "2026-01-01", links: [])
    }

    static func attachment(_ id: String, transactionId: Int, name: String, mime: String = "application/pdf")
        -> OpenAPI.Attachment
    {
        OpenAPI.Attachment(
            id: id, transactionId: transactionId, filename: name, storedPath: "a/\(name)", mimeType: mime,
            sizeBytes: 2048, createdAt: "2026-10-01T10:00:00Z")
    }

    /// `count` rows from Bakery (1) and Garage (2), newest id first, every third uncategorised.
    static func rows(_ count: Int) -> [OpenAPI.Transaction] {
        (1...max(1, count)).prefix(count).map { index in
            wire(
                id: index, recipientId: index % 2 == 0 ? 2 : 1, recipient: index % 2 == 0 ? "Garage" : "Bakery",
                categoryId: index % 3 == 0 ? nil : 5, category: index % 3 == 0 ? nil : "Food")
        }
    }

    @MainActor
    static func model(
        _ service: FakeTransactionsService, pickers: FakePickerService = FakePickerService(),
        bulk: FakeTransactionBulkService = FakeTransactionBulkService(), splits: FakeSplitsService = FakeSplitsService()
    ) -> TransactionsModel {
        TransactionsModel(
            service: service, attachments: service, pickers: pickers, bulk: bulk, splits: splits,
            calendar: PlannedFixture.calendar, now: { PlannedFixture.today })
    }

    @MainActor
    static func shell(
        _ model: TransactionsModel, settings: NativeAppSettings = NativeAppSettings()
    ) -> NativeShellModel {
        NativeShellModel(
            strings: strings, theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(), transactions: model,
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { settings })
    }

    /// A shell on `route` with its settings read and the list synced.
    @MainActor
    static func opened(
        _ service: FakeTransactionsService, route: String = "/transactions",
        settings: NativeAppSettings = NativeAppSettings(), pickers: FakePickerService = FakePickerService(),
        bulk: FakeTransactionBulkService = FakeTransactionBulkService(), splits: FakeSplitsService = FakeSplitsService()
    ) async throws -> (TransactionsModel, NativeShellModel) {
        let model = model(service, pickers: pickers, bulk: bulk, splits: splits)
        let shell = shell(model, settings: settings)
        shell.show(try #require(NativeRoute(route)))
        await shell.settingsSettled()
        await model.sync()
        return (model, shell)
    }
}

enum TransactionsFixture {
    @MainActor
    static func idleModel() -> TransactionsModel {
        TxFixture.model(FakeTransactionsService())
    }
}

// MARK: - Routes and values

@Suite struct TransactionsRouteTests {
    @Test func theFiltersReadLikeThePage() throws {
        let route = try #require(
            NativeRoute(
                "/transactions?transaction_id=12&recipient_id=abc&category_ids=3,x,4&uncategorised=true"
                    + "&amount_min=-10.5&amount_signed=true&tags=a,,b&transaction_type=bogus&filter_label="))
        let filters = TransactionFilters(route: route)
        #expect(filters.transactionId == 12)
        #expect(filters.recipientId == nil)
        #expect(filters.categoryIds == [3, 4])
        #expect(filters.uncategorised)
        #expect(filters.amountMin == Decimal(string: "-10.5"))
        #expect(filters.amountSigned)
        #expect(filters.tags == ["a", "b"])
        #expect(filters.transactionType == nil)
        #expect(filters.filterLabel == nil)
        #expect(filters.hasMainFilter)
        #expect(TransactionFilters.parseId("0") == nil)
        #expect(TransactionFilters.parseId("7") == 7)
        #expect(TransactionFilters(route: NativeRoute(path: "/transactions")).showsBanner == false)
    }

    @Test func theSortNeedsBothParametersAndCyclesThroughNone() throws {
        let half = try #require(NativeRoute("/transactions?sort_key=amount"))
        #expect(TransactionsRoutes.sort(in: half) == nil)
        let both = try #require(NativeRoute("/transactions?sort_key=amount&sort_dir=desc"))
        #expect(TransactionsRoutes.sort(in: both) == LocalTableSort(key: "amount", ascending: false))
        let first = LocalTableSort.cycled(nil, key: "date")
        #expect(first == LocalTableSort(key: "date", ascending: true))
        #expect(LocalTableSort.cycled(first, key: "date") == LocalTableSort(key: "date", ascending: false))
        #expect(LocalTableSort.cycled(LocalTableSort(key: "date", ascending: false), key: "date") == nil)
        #expect(LocalTableSort.cycled(first, key: "amount") == LocalTableSort(key: "amount", ascending: true))
        let written = TransactionsRoutes.route(NativeRoute(path: "/transactions"), sortedBy: first)
        #expect(written.string == "/transactions?sort_key=date&sort_dir=asc")
        #expect(TransactionsRoutes.route(written, sortedBy: nil).string == "/transactions")
    }

    @Test func clearingKeepsOnlyTheSortAndQuickFiltersMerge() throws {
        let route = try #require(
            NativeRoute("/transactions?recipient_id=4&sort_key=amount&sort_dir=asc&tags=x&search=bread"))
        #expect(TransactionsRoutes.clearingFilters(route).string == "/transactions?sort_key=amount&sort_dir=asc")
        let unsorted = try #require(NativeRoute("/transactions?recipient_id=4&sort_key=amount"))
        #expect(TransactionsRoutes.clearingFilters(unsorted).string == "/transactions")
        #expect(
            TransactionsRoutes.showingAll(from: 4, name: "Bakery & Co").string
                == "/transactions?recipient_id=4&filter_label=Bakery%20%26%20Co")
        let merged = TransactionsRoutes.route(
            route,
            applying: [QuickFilterParameter("transaction_type", "expense"), QuickFilterParameter("recipient_id", nil)])
        #expect(merged.value("transaction_type") == "expense")
        #expect(merged.value("recipient_id") == nil)
        #expect(merged.value("search") == "bread")
        #expect(TransactionsRoutes.route(route, needsCategory: true).value("uncategorised") == "true")
        let category = TransactionsRoutes.route(route.setting("category_ids", to: "1,2"), category: (id: 9, label: "Food"))
        #expect(category.value("category_ids") == nil)
        #expect(category.value("category_id") == "9")
        #expect(category.value("filter_label") == "Food")
    }

    @Test func theDatePresetsAreLocalCalendarRanges() {
        let calendar = PlannedFixture.calendar
        let today = PlannedDay(year: 2026, month: 1, day: 15)
        #expect(TransactionDatePreset.thisMonth.range(today: today, calendar: calendar)?.start == "2026-01-01")
        #expect(TransactionDatePreset.thisMonth.range(today: today, calendar: calendar)?.end == "2026-01-31")
        #expect(TransactionDatePreset.lastMonth.range(today: today, calendar: calendar)?.start == "2025-12-01")
        #expect(TransactionDatePreset.lastMonth.range(today: today, calendar: calendar)?.end == "2025-12-31")
        #expect(TransactionDatePreset.thisYear.range(today: today, calendar: calendar)?.end == "2026-12-31")
        #expect(TransactionDatePreset.any.range(today: today, calendar: calendar) == nil)
        #expect(
            TransactionDatePreset.matching(start: "2025-12-01", end: "2025-12-31", today: today, calendar: calendar)
                == .lastMonth)
        #expect(TransactionDatePreset.matching(start: "2025-12-02", end: nil, today: today, calendar: calendar) == nil)
        #expect(TransactionDatePreset.matching(start: nil, end: nil, today: today, calendar: calendar) == .any)
    }

    @Test func aListPageAsksForTheFiltersTheSortAndTheBalance() throws {
        let route = try #require(NativeRoute("/transactions?recipient_id=4&tags=a,b&uncategorised=true"))
        let query = TransactionListQuery(
            filters: TransactionFilters(route: route), search: "bread", sort: LocalTableSort(key: "amount", ascending: false),
            includeExcluded: true, pageSize: 25)
        let items = query.operation(offset: 50).queryItems.map { "\($0.name)=\($0.value ?? "")" }
        for expected in [
            "limit=25", "offset=50", "recipient_id=4", "search=bread", "sort_by=amount", "sort_dir=desc", "tags=a,b",
            "active=false", "include_balance=true", "uncategorised=true",
        ] {
            #expect(items.contains(expected))
        }
        #expect(TransactionListQuery().operation(offset: 0).queryItems.contains { $0.name == "active" && $0.value == "true" })
    }

    @Test func theExportNamesTheFileAndLeavesTagsOut() throws {
        let route = try #require(NativeRoute("/transactions?filter_label=Caf%C3%A9%20%26%20Co!!&tags=x&recipient_id=3"))
        let query = TransactionExportQuery(filters: TransactionFilters(route: route), search: "coffee")
        let today = PlannedDay(year: 2026, month: 10, day: 12)
        #expect(query.fileName(.csv, today: today) == "transactions_caf-co_2026-10-12.csv")
        let unlabelled = TransactionExportQuery(filters: TransactionFilters(), search: "")
        #expect(unlabelled.fileName(.json, today: today) == "transactions_filtered_2026-10-12.ndjson")
        let items = query.csv.queryItems.map(\.name)
        #expect(items.contains("recipient_id"))
        #expect(items.contains("search"))
        #expect(!items.contains("tags"))
        #expect(TransactionExportQuery.slugify(String(repeating: "ab ", count: 40)).count == 60)
    }

    @Test func theBannerNamesTheLabelTypeAndAmount() throws {
        let route = try #require(
            NativeRoute("/transactions?recipient_id=4&filter_label=Bakery&transaction_type=expense&amount_min=10&amount_max=10"))
        let filters = TransactionFilters(route: route)
        let text = TransactionFilterDescriptor.label(
            filters, recipient: .found("Bakery"), settings: NativeAppSettings(), strings: TxFixture.strings)
        #expect(text == "Bakery · Expenses · = 10 EUR")
        let unlabelled = TransactionFilters(route: try #require(NativeRoute("/transactions?recipient_id=4&transaction_id=9")))
        #expect(
            TransactionFilterDescriptor.label(
                unlabelled, recipient: .loading, settings: NativeAppSettings(), strings: TxFixture.strings)
                == "Transaction 9 · Payee #4")
        var signed = TransactionFilters()
        signed.amountMin = 5
        signed.amountSigned = true
        #expect(TransactionFilterDescriptor.amountLabel(signed, settings: NativeAppSettings()) == "≥ +5 EUR")
    }

    @Test func theSuggestionsBuildTheWebsParameters() {
        var form = TransactionSearchSuggestions(thisYear: 2026)
        #expect(form.yearInput == "2026")
        form.mode = .amountExact
        form.amountA = "-12,50"
        #expect(
            form.amountParameters(format: .eu) == [
                QuickFilterParameter("amount_min", "-12.5"), QuickFilterParameter("amount_max", "-12.5"),
                QuickFilterParameter("amount_signed", "true"),
            ])
        form.mode = .amountRange
        form.amountA = "50"
        form.amountB = "10"
        #expect(
            form.amountParameters(format: .eu) == [
                QuickFilterParameter("amount_min", "10"), QuickFilterParameter("amount_max", "50"),
                QuickFilterParameter("amount_signed", nil),
            ])
        form.amountB = "abc"
        #expect(form.amountInvalid(format: .eu))
        #expect(form.amountParameters(format: .eu) == nil)
        form.yearInput = "1899"
        #expect(form.yearValue == nil)
        form.yearInput = " 2025 "
        #expect(form.yearValue == 2025)
        #expect(
            TransactionSearchSuggestions.yearRange(2025) == [
                QuickFilterParameter("start_date", "2025-01-01"), QuickFilterParameter("end_date", "2025-12-31"),
            ])
        form.dateStart = PlannedDay(year: 2026, month: 3, day: 2)
        form.dateEnd = PlannedDay(year: 2026, month: 3, day: 1)
        #expect(form.datesReversed)
        #expect(form.dateParameters == nil)
        form.dateEnd = nil
        #expect(
            form.dateParameters == [
                QuickFilterParameter("start_date", "2026-03-02"), QuickFilterParameter("end_date", nil),
            ])
    }

    @Test func rowsMapTheWireAndTheColumns() {
        let labels = TransactionLabels(strings: TxFixture.strings)
        let wire = TxFixture.wire(
            id: 3, date: "2026-10-01T00:00:00Z", recipient: nil, categoryId: nil, currency: nil, memo: "Bread",
            tags: [TxFixture.tag(1, "food")])
        let row = TransactionRow(wire)
        #expect(row.day == "2026-10-01")
        #expect(row.displayCurrency == "EUR")
        #expect(row.recipient(labels) == "Unknown")
        #expect(row.isUncategorised(labels))
        #expect(row.rawValue("tags", labels: labels) == .text("food"))
        #expect(row.rawValue("amount", labels: labels) == .number(Decimal(string: "-4.5")!))
        #expect(row.deleteDescription(labels) == "Bread")
        #expect(row.duplicateBody?.allowDuplicate == true)
        #expect(row.duplicateBody?.balance == nil)
        #expect(row.restoreBody?.tags == ["food"])
        let orphan = TransactionRow(TxFixture.wire(id: 4, accountId: nil))
        #expect(orphan.restoreBody == nil)
        #expect(CategoryColor.index("Food: Groceries") == CategoryColor.index("food"))
        #expect(CategoryColor.index("  ") == nil)
        #expect(TransactionColumn.shown(TransactionColumnVisibility()) == [.date, .recipient, .category, .bank, .amount])
        let setting = JSONValue.object(["other": .object(["a": .bool(true)])])
        let visibility = TransactionColumnVisibility(stored: ["tags": true])
        let written = visibility.written(into: setting)
        #expect(written.objectValue?["other"] != nil)
        #expect(TransactionColumnVisibility.read(written).isVisible(.tags))
        #expect(TransactionColumnVisibility().written(into: written).objectValue?["transactionsColumns"] == nil)
    }

    @Test func aPatchSendsExplicitNulls() throws {
        var patch = TransactionPatch()
        patch.categoryId = .some(nil)
        patch.amount = Decimal(string: "12.5")
        let data = try #require(try patch.encodedBodyForTests())
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["category_id"] is NSNull)
        #expect(object["memo"] == nil)
        #expect(object["amount"] != nil)
        let request = TransactionBulkCategoryRequest(recipientId: 4, categoryId: 9, expectedCount: 3)
        let body = try #require(try request.encodedBody())
        let bulk = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(bulk["expected_count"] as? Int == 3)
        #expect((bulk["filter"] as? [String: Any])?["uncategorised"] as? Bool == true)
        #expect(TransactionPatchRequest(id: 5, patch: patch).path == "/api/transactions/5")
    }

    @Test func thePagingThresholdClampsAndTheSelectionExtends() {
        #expect(ServerTablePaging.loadMoreThreshold(pageSize: 50) == 15)
        #expect(ServerTablePaging.loadMoreThreshold(pageSize: 200) == 40)
        #expect(ServerTablePaging.loadMoreThreshold(pageSize: 1000) == 50)
        #expect(!ServerTablePaging.shouldLoadMore(rowIndex: 10, shownCount: 50, threshold: 15, hasMore: true))
        #expect(ServerTablePaging.shouldLoadMore(rowIndex: 35, shownCount: 50, threshold: 15, hasMore: true))
        #expect(!ServerTablePaging.shouldLoadMore(rowIndex: 49, shownCount: 50, threshold: 15, hasMore: false))
        var selection = ServerTableSelection()
        selection.toggle(2)
        selection.extend(to: 5, in: [1, 2, 3, 4, 5, 6])
        #expect(selection.ids == [2, 3, 4, 5])
        #expect(selection.someSelected([1, 2, 3, 4, 5, 6]))
        selection.toggleAll([1, 2, 3, 4, 5, 6])
        #expect(selection.allSelected([1, 2, 3, 4, 5, 6]))
        selection.keep(only: [1, 2])
        #expect(selection.ids == [1, 2])
        var filters = ServerColumnFilters()
        filters.set("recipient", to: "bak")
        #expect(filters.apply(["Bakery", "Garage"]) { name, _ in .text(name) } == ["Bakery"])
        filters.set("recipient", to: "")
        #expect(filters.isEmpty)
    }
}

extension TransactionPatch {
    /// The JSON the PATCH sends.
    func encodedBodyForTests() throws -> Data? {
        try TransactionPatchRequest(id: 1, patch: self).encodedBody()
    }
}

// MARK: - The screen's model

@MainActor
@Suite struct TransactionsModelTests {
    @Test func syncLoadsTheFirstPageAndReusesAFreshAnswer() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(5))
        let (model, shell) = try await TxFixture.opened(service, route: "/transactions?recipient_id=1")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.rows?.map(\.id) == [1, 3, 5])
        #expect(model.total == 3)
        #expect(!model.hasMore)
        #expect(model.query?.filters.recipientId == 1)
        await model.sync()
        #expect(await service.queries.count == 1)
        await model.reload()
        #expect(await service.queries.count == 2)
        #expect(model.subtitle() == "3 transactions")
        #expect(model.footer() == "3 of 3 loaded")
    }

    @Test func scrollingLoadsTheNextPageAndAFailureOffersRetry() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(120))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.rows?.count == 50)
        #expect(model.hasMore)
        #expect(model.footer() == "50 of 120 loaded · Scroll for more")
        // Far from the end nothing loads; within the threshold the next page does.
        await model.rowAppeared(10)
        #expect(await service.offsets == [0])
        await service.failPages(atOffsets: [50])
        await model.rowAppeared(40)
        #expect(await service.offsets == [0, 50])
        #expect(model.notice?.key == "txPage.loadMoreFailed")
        #expect(model.pendingAction?.action == .retryLoadMore)
        #expect(model.notice.flatMap { model.actionTitle(for: $0) } == "common.retry")
        #expect(!model.actionIsUndo)
        await service.failPages(atOffsets: [])
        await model.performPendingAction()
        #expect(model.rows?.count == 100)
        #expect(model.notice == nil)
        #expect(!model.isFetchingMore)
    }

    @Test func theSearchSettlesIntoTheURLWithReplace() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(6))
        let (model, shell) = try await TxFixture.opened(service)
        model.searchText = "garage"
        await model.commitSearch()
        #expect(model.search == "garage")
        #expect(shell.route.value("search") == "garage")
        #expect(shell.nativeNavigationLocation.raw == "/transactions?search=garage")
        #expect(model.rows?.map(\.id) == [2, 4, 6])
        // A search the route brings (the palette) lands in the field.
        shell.show(try #require(NativeRoute("/transactions?search=bakery")))
        await model.sync()
        #expect(model.searchText == "bakery")
        #expect(model.rows?.map(\.id) == [1, 3, 5])
        await model.clearSearch()
        #expect(shell.route.value("search") == nil)
        #expect(model.emptyState == .noTransactions)
    }

    @Test func theSortIsWrittenWithReplaceAndFiltersArePushed() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(3))
        let (model, shell) = try await TxFixture.opened(service)
        await model.toggleSort(.amount)
        #expect(shell.nativeNavigationLocation.raw == "/transactions?sort_key=amount&sort_dir=asc")
        let entries = shell.nativeNavigation.count
        #expect(model.sort == LocalTableSort(key: "amount", ascending: true))
        #expect(model.query?.sort == LocalTableSort(key: "amount", ascending: true))
        await model.toggleSort(.tags)
        #expect(model.sort?.key == "amount")
        model.setNeedsCategory(true)
        #expect(shell.nativeNavigationLocation.raw == "/transactions?sort_key=amount&sort_dir=asc&uncategorised=true")
        #expect(shell.nativeNavigation.count == entries + 1)
        model.setAccountFilter(EditingFixture.account(7, "BE00 1234", display: "Everyday"))
        #expect(
            shell.nativeNavigationLocation.raw
                == "/transactions?sort_key=amount&sort_dir=asc&uncategorised=true&account_id=7&filter_label=Everyday")
        model.searchText = "a"
        await model.commitSearch()
        let row = try #require(model.rows?.first)
        model.showAllFrom(row)
        #expect(model.searchText.isEmpty)
        #expect(shell.nativeNavigationLocation.raw == "/transactions?recipient_id=1&filter_label=Bakery")
        await model.clearAll()
        #expect(shell.route.value("sort_key") == nil)
        #expect(model.sort == nil)
    }

    @Test func aCategoryChangeShowsAtOnceAndRollsBackOnFailure() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(3))
        await service.setCategoryNames([9: "Transport"])
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let row = try #require(model.row(3))
        let gate = CallGate()
        await service.holdUpdates(gate)
        let change = Task { await model.selectCategory(row, categoryId: 9) }
        while await service.patches.isEmpty { await Task.yield() }
        #expect(model.row(3)?.categoryId == 9)
        #expect(model.updatesInFlight == 1)
        gate.open()
        await change.value
        #expect(model.row(3)?.categoryName == "Transport")
        #expect(model.notice?.key == "transactions.updated")
        // A failure puts the old category back.
        await service.holdUpdates(nil)
        await service.failUpdates(true)
        let updated = try #require(model.row(3))
        await model.selectCategory(updated, categoryId: nil)
        #expect(model.row(3)?.categoryId == 9)
        #expect(model.notice?.key == "transactions.updateFailedTitle")
        #expect(model.updatesInFlight == 0)
    }

    @Test func excludingARowDropsItUnlessExcludedRowsShow() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(3))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await model.toggleActive(try #require(model.row(2)))
        #expect(model.row(2) == nil)
        #expect(model.total == 2)
        #expect(await service.patches.last?.isActive == false)
        await model.setShowAll(true)
        #expect(model.row(2)?.isActive == false)
        await model.toggleActive(try #require(model.row(2)))
        #expect(model.row(2)?.isActive == true)
    }

    @Test func deleteOffersAnUndoThatRecreatesTheRow() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(3))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.select(2)
        #expect(model.inspector?.id == 2)
        model.requestDelete(try #require(model.row(2)))
        await model.confirmDelete()
        #expect(model.row(2) == nil)
        #expect(model.selectedId == nil)
        #expect(model.notice?.key == "transactions.deleted")
        #expect(model.actionIsUndo)
        let notice = try #require(model.notice)
        #expect(model.duration(of: notice) == TransactionsModel.undoDuration)
        await model.performPendingAction()
        #expect(await service.created.count == 1)
        #expect(await service.created.first?.recipientId == 2)
        #expect(model.notice?.key == "transactions.restored")
        #expect(model.rows?.count == 3)
        // A failed delete puts the row back where it was.
        await service.failDeletes(true)
        let second = try #require(model.rows?[1])
        model.requestDelete(second)
        await model.confirmDelete()
        #expect(model.rows?[1].id == second.id)
        #expect(model.notice?.key == "transactions.deleteFailedTitle")
    }

    @Test func aRowWithoutAnAccountIsDeletedWithoutUndo() async throws {
        let service = FakeTransactionsService(rows: [TxFixture.wire(id: 1, accountId: nil)])
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.requestDelete(try #require(model.row(1)))
        await model.confirmDelete()
        #expect(model.notice?.key == "transactions.deleted")
        #expect(model.pendingAction == nil)
        #expect(model.emptyState == .noTransactions)
    }

    @Test func theInspectorFollowsTheSelectionAndFocusReturns() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(4))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.rowFocused(3)
        #expect(model.selectedId == 3)
        #expect(model.handleRowKey(.down, from: 3) == 4)
        #expect(model.handleRowKey(.up, from: 1) == nil)
        _ = model.handleRowKey(.quickLook, from: 3)
        #expect(model.quickLookRow?.id == 3)
        _ = model.handleRowKey(.quickLook, from: 3)
        #expect(model.quickLookId == nil)
        #expect(model.focusRequest == 3)
        model.focusRestored()
        _ = model.handleRowKey(.close, from: 3)
        #expect(model.selectedId == nil)
        #expect(model.focusRequest == 3)
        // Focus coming back does not open the inspector again.
        model.rowFocused(3)
        #expect(model.selectedId == nil)
        #expect(model.focusRequest == nil)
        // A row that leaves the list closes the inspector.
        model.select(4)
        await model.setShowAll(false)
        await model.toggleActive(try #require(model.row(4)))
        #expect(model.selectedId == nil)
        #expect(model.inspector == nil)
    }

    @Test func theInspectorTipsOfferUseForAllAndAlwaysUse() async throws {
        let rows = [
            TxFixture.wire(id: 1, recipientId: 4, recipient: "Garage", categoryId: 9, category: "Transport"),
            TxFixture.wire(id: 2, recipientId: 4, recipient: "Garage"),
            TxFixture.wire(id: 3, recipientId: 4, recipient: "Garage"),
        ]
        let service = FakeTransactionsService(rows: rows)
        await service.setRecipients([TxFixture.recipient(4, "Garage")])
        await service.setCategoryNames([9: "Transport"])
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.select(1)
        let inspector = try #require(model.inspector)
        await inspector.load(recipientId: 4)
        let row = try #require(model.row(1))
        let tips = try #require(inspector.tips(for: row, labels: model.labels))
        #expect(tips.othersNeedingCategory == 2)
        #expect(tips.showsUseForAll)
        #expect(tips.canSetUsual)
        #expect(!tips.ruleApplies)
        await model.useForAll()
        #expect(await service.bulkUpdates == ["4:9:2"])
        #expect(model.notice?.key == "txPage.bulk.updated.other")
        #expect(model.notice?.variables["n"] == "2")
        #expect(model.row(2)?.categoryId == 9)
        await model.alwaysUse()
        #expect(await service.defaults == ["4:9"])
        #expect(model.notice?.key == "recipients.updated")
        let firstRow = try #require(model.row(1))
        let ruled = try #require(inspector.tips(for: firstRow, labels: model.labels))
        #expect(ruled.ruleApplies)
        #expect(!ruled.canSetUsual)
    }

    @Test func detailEditsAndTagsPatchTheRow() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(2))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.select(1)
        let inspector = try #require(model.inspector)
        let row = try #require(model.row(1))
        inspector.startEdit(.amount, row: row, format: .eu)
        #expect(inspector.editingValue == "-4,5")
        inspector.editingValue = "abc"
        await model.saveDetail()
        #expect(inspector.amountError)
        #expect(await service.patches.isEmpty)
        inspector.editingValue = "-7,25"
        await model.saveDetail()
        #expect(model.row(1)?.amount == Decimal(string: "-7.25"))
        #expect(inspector.editingField == nil)
        inspector.startEdit(.memo, row: try #require(model.row(1)), format: .eu)
        inspector.editingValue = "  "
        await model.saveDetail()
        let memo = try #require(await service.patches.last?.memo)
        #expect(memo == nil)
        await model.setTags(["fixed-costs"])
        #expect(model.row(1)?.tags.map(\.slug) == ["fixed-costs"])
        await service.failUpdates(true)
        await model.setTags(["other"])
        #expect(inspector.tagSlugs == ["fixed-costs"])
    }

    @Test func theInlineEditorSavesDateAndAmount() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(2))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.startEditing(try #require(model.row(2)))
        model.rowEditor?.amountText = "12,x"
        #expect(model.rowEditor?.amountInvalid(format: .eu) == true)
        await model.saveEditing()
        #expect(await service.patches.isEmpty)
        model.rowEditor?.amountText = ""
        model.rowEditor?.day = PlannedDay(year: 2026, month: 9, day: 30)
        await model.saveEditing()
        let patch = try #require(await service.patches.last)
        #expect(patch.transactionDate == "2026-09-30")
        #expect(patch.amount == Decimal(string: "-4.5"))
        #expect(model.rowEditor == nil)
        #expect(model.focusRequest == 2)
    }

    @Test func columnChoicesSaveAgainstTheBaseline() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(1))
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await model.loadColumnVisibility()
        model.setColumn(.tags, visible: true)
        await model.settleColumns()
        #expect(model.columns.contains(.tags))
        #expect(await service.baselines.first == .object(["exists": .bool(false)]))
        #expect(
            await service.savedSettings.first
                == .object(["transactionsColumns": .object(["tags": .bool(true)])]))
        model.resetColumns()
        await model.settleColumns()
        #expect(!model.columns.contains(.tags))
        #expect(await service.baselines.last?.objectValue?["exists"] == .bool(true))
        #expect(await service.savedSettings.last == .object([:]))
    }

    @Test func deepLinksOpenAddAndSelectThenLeaveTheURL() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(3))
        let (model, shell) = try await TxFixture.opened(service, route: "/transactions?new=1&id=2")
        #expect(model.isAddPresented)
        #expect(model.selectedId == 2)
        #expect(model.inspector?.id == 2)
        #expect(shell.route.string == "/transactions")
        #expect(shell.nativeNavigationLocation.raw == "/transactions")
        model.dismissAdd()
        #expect(shell.detail == .native(.transactions))
        // The mounted screen acknowledges it (ShellRootView's `.task(id: screen)`), so the sheet
        // opens in place.
        shell.nativeIntentConsumerDidBecomeReady(for: .transactions)
        #expect(shell.newTransaction())
        #expect(model.isAddPresented)
        model.disappear()
        #expect(!model.isAddPresented)
        #expect(model.selectedId == nil)
    }

    @Test func theNewTransactionShortcutGoesToTheNativeScreen() async throws {
        let model = TransactionsFixture.idleModel()
        let shell = TxFixture.shell(model)
        // Before the shell is ready the shortcut waits.
        #expect(shell.newTransaction())
        #expect(shell.route == .home)
        shell.show(try #require(NativeRoute("/planned")))
        await shell.settingsSettled()
        // The shell moves to `/transactions`; the native sheet opens once the screen is ready there.
        shell.nativeIntentReadinessDidChange()
        #expect(shell.route.path == "/transactions")
        #expect(!model.isAddPresented)
        shell.nativeIntentConsumerDidBecomeReady(for: .transactions)
        await model.sync()
        #expect(model.isAddPresented)
        model.dismissAdd()
        await model.sync()
        #expect(!model.isAddPresented)
        // The `N` shortcut asks again; the screen is already there.
        #expect(shell.handleKey("n"))
        #expect(shell.route.path == "/transactions")
        #expect(model.isAddPresented)
    }

    @Test func theBannerExportsUnderItsFileName() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(2))
        let (model, shell) = try await TxFixture.opened(
            service, route: "/transactions?recipient_id=1&filter_label=Bakery&tags=x")
        defer { withExtendedLifetime(shell) {} }
        var saved: [String] = []
        model.save = { _, name in
            saved.append(name)
            return true
        }
        await model.export(.json)
        #expect(saved == ["transactions_bakery_2026-10-12.ndjson"])
        #expect(await service.exports.first?.filters.tags == ["x"])
        #expect(model.notice?.key == "txPage.toast.exportSuccess")
        #expect(model.exportingFormat == nil)
        #expect(model.bannerRecipient == .failed)
    }

    @Test func attachmentsUploadPreviewAndDelete() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(1))
        await service.setAttachments([TxFixture.attachment("41", transactionId: 1, name: "receipt.pdf")])
        let (model, shell) = try await TxFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.select(1)
        let attachments = try #require(model.inspector?.attachments)
        #expect(attachments.isLoading)
        await attachments.load()
        #expect(attachments.items?.map(\.id) == ["41"])
        await attachments.upload(AttachmentUpload(name: "photo.png", contentType: "image/png", data: Data([1])))
        #expect(await service.uploads == ["photo.png"])
        #expect(attachments.items?.count == 2)
        let receipt = try #require(attachments.items?.first)
        await attachments.preview(receipt)
        let url = try #require(attachments.previewURL)
        #expect(url.lastPathComponent == "receipt.pdf")
        #expect(FileManager.default.fileExists(atPath: url.path))
        attachments.closePreview()
        await service.failAttachmentDeletes(true)
        attachments.requestDelete(receipt)
        await attachments.confirmDelete()
        model.reportAttachmentDeleteFailure()
        #expect(model.notice?.key == "txPage.deleteAttachmentError")
        #expect(attachments.deleteError == nil)
        await service.failAttachmentDeletes(false)
        attachments.requestDelete(receipt)
        await attachments.confirmDelete()
        #expect(await service.attachmentDeletes == [41, 41])
        #expect(attachments.items?.map(\.filename) == ["photo.png"])
        #expect(TransactionAttachmentsModel.size(2048) == "2.0 KB")
        #expect(TransactionAttachmentsModel.safeName("a/b:c") == "a_b_c")
    }

    @Test func theBulkToastPicksThePluralKey() {
        let one = TransactionsModel.bulkUpdatedToast(BulkUpdateResult(updated: 1, requested: 1, matched: 1), language: .en)
        #expect(one.key == "txPage.bulk.updated.one")
        #expect(one.variables["n"] == "1")
        let partial = TransactionsModel.bulkUpdatedToast(
            BulkUpdateResult(updated: 2, requested: 3, matched: 3), language: .nl)
        #expect(partial.key == "txPage.bulk.updatedOf.other")
        #expect(partial.variables["skipped"] == "1")
        let changed = TransactionsModel.bulkUpdatedToast(
            BulkUpdateResult(updated: 2, requested: 3, matched: 2), language: .en)
        #expect(changed.key == "txPage.bulk.updatedSelectionChanged.other")
    }

    @Test func theCheckboxesSelectLoadedRowsAndAFilterChangeClearsThem() async throws {
        let service = FakeTransactionsService(rows: TxFixture.rows(4))
        let (model, shell) = try await TxFixture.opened(service)
        model.toggleSelection(1)
        model.extendSelection(to: 3)
        #expect(model.selection.ids == [1, 2, 3])
        #expect(model.someSelected)
        model.toggleSelectAll()
        #expect(model.allSelected)
        await model.toggleSort(.date)
        #expect(model.selection.ids.count == 4)
        shell.show(try #require(NativeRoute("/transactions?recipient_id=2&sort_key=date&sort_dir=asc")))
        await model.sync()
        #expect(model.selection.isEmpty)
        model.columnFilters.set(TransactionColumn.recipient.rawValue, to: "zzz")
        #expect(model.visibleRows.isEmpty)
        #expect(model.emptyState == .noFilterResults)
        #expect(model.footer() == "0 of 2 shown (filtered)")
    }
}

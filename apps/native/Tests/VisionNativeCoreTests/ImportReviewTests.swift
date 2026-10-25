import Foundation
import Testing
@testable import VisionNativeCore

/// The export and Setup and reference calls over fixed answers, recording every call.
actor FakeImportExportService: ImportExportService {
    private(set) var exports: [(format: ExportFormat, filters: ExportFilters)] = []
    private(set) var bankLoads = 0
    private(set) var recipientImports: [String] = []
    private(set) var categoryImports: [String] = []
    private var labels: [String]
    private var exportFails = false
    private var importFails = false

    init(labels: [String] = ["BE12 3456", "BE98 7654", "Savings"]) {
        self.labels = labels
    }

    func failExports(_ fail: Bool) { exportFails = fail }
    func failImports(_ fail: Bool) { importFails = fail }

    func exportTransactions(_ format: ExportFormat, filters: ExportFilters) async throws -> Data {
        exports.append((format, filters))
        if exportFails { throw APIError.client(APIClientError(status: 429, code: .rateLimited, message: "Slow down")) }
        return Data("Date,Amount\n".utf8)
    }

    func bankAccountLabels() async throws -> [String] {
        bankLoads += 1
        return labels
    }

    func importRecipientsCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult {
        recipientImports.append("\(file.name)|\(separator)|\(encoding)")
        if importFails { throw APIError.client(APIClientError(status: 400, code: .validationError, message: "Bad CSV")) }
        return SimpleImportResult(totalProcessed: 6, imported: 4, skipped: 1, errors: 1)
    }

    func importCategoriesCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult {
        categoryImports.append("\(file.name)|\(separator)|\(encoding)")
        if importFails { throw APIError.network("offline") }
        return SimpleImportResult(totalProcessed: 9, imported: 7, skipped: 2, errors: 0)
    }
}

/// The review calls over one scripted preview, recording every call.
actor FakeImportReviewService: ImportReviewService {
    private(set) var previewLoads: [Int] = []
    /// `"rowId:recipientId"` (`nil` written as `null`).
    private(set) var recipientOverrides: [String] = []
    private(set) var categoryOverrides: [String] = []
    private(set) var defaults: [String] = []
    private(set) var commits: [Int] = []
    private(set) var discards: [Int] = []
    private var preview: ImportPreview
    private var accounts: [OpenAPI.Account]
    private var previewFails = false
    private var overrideFailsFor: String?
    private var categoryFails = false
    private var defaultFails = false
    private var commitFails = false
    private var discardFails = false
    private var result = ImportCommitResult(imported: 3, duplicates: 1, errors: 0, autoLinkedCount: 0)
    private var previewGate: CallGate?

    init(preview: ImportPreview = ReviewFixture.preview, accounts: [OpenAPI.Account] = ReviewFixture.accounts) {
        self.preview = preview
        self.accounts = accounts
    }

    func failPreview(_ fail: Bool) { previewFails = fail }
    func failOverride(row: String?) { overrideFailsFor = row }
    func failCategories(_ fail: Bool) { categoryFails = fail }
    func failDefaults(_ fail: Bool) { defaultFails = fail }
    func failCommit(_ fail: Bool) { commitFails = fail }
    func failDiscard(_ fail: Bool) { discardFails = fail }
    func setResult(_ next: ImportCommitResult) { result = next }
    func setPreview(_ next: ImportPreview) { preview = next }
    /// Holds the next preview request, which answers with the preview it started with.
    func holdNextPreview(_ gate: CallGate) { previewGate = gate }

    func importPreview(batchId: Int) async throws -> ImportPreview {
        previewLoads.append(batchId)
        if previewFails { throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Batch not found")) }
        let answer = preview
        if let gate = previewGate {
            previewGate = nil
            await gate.wait()
        }
        return answer
    }

    func overrideImportRow(batchId: Int, rowId: String, recipientId: Int?) async throws {
        recipientOverrides.append("\(rowId):\(recipientId.map(String.init) ?? "null")")
        if overrideFailsFor == rowId { throw APIError.network("offline") }
    }

    func overrideImportRowCategory(batchId: Int, rowId: String, categoryId: Int?) async throws {
        categoryOverrides.append("\(rowId):\(categoryId.map(String.init) ?? "null")")
        if categoryFails { throw APIError.network("offline") }
    }

    func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws {
        defaults.append("\(recipientId):\(categoryId)")
        if defaultFails { throw APIError.network("offline") }
    }

    func commitImportBatch(batchId: Int) async throws -> ImportCommitResult {
        commits.append(batchId)
        if commitFails { throw APIError.client(APIClientError(status: 409, code: .conflict, message: "Batch is busy")) }
        return result
    }

    func discardImportBatch(batchId: Int) async throws {
        discards.append(batchId)
        if discardFails { throw APIError.network("offline") }
    }

    func allAccounts() async throws -> [OpenAPI.Account] { accounts }
}

enum ReviewFixture {
    static func row(
        _ id: String, payee: String, amount: String, date: String, source: String?, account: String? = "Checking",
        similarity: Double? = nil
    ) -> ImportStagingRow {
        ImportStagingRow(
            id: id, recipientRaw: payee, amount: amount, currency: "EUR", txDate: date, memo: "memo \(id)",
            bankAccount: account, matchSource: source, matchSimilarity: similarity)
    }

    static let bakery = ImportPreviewGroup(
        recipientId: 11, recipientName: "Bakery", recipientDefaultCategoryId: nil, currentCategoryId: 4,
        currentCategoryLabel: "Food", rowCount: 2,
        rows: [
            row("101", payee: "BAKERY 1", amount: "-4.50", date: "2026-10-03", source: "exact"),
            row("102", payee: "BAKERY 2", amount: "-3.20", date: "2026-10-01", source: "fuzzy", similarity: 0.87),
        ])

    static let unknown = ImportPreviewGroup(
        recipientName: nil, matchedPatternText: "SALARY*", rowCount: 1,
        rows: [row("201", payee: "EMPLOYER", amount: "2500.00", date: "2026-10-09", source: nil, account: " new wallet ")])

    static let landlord = ImportPreviewGroup(
        recipientId: 12, recipientName: "Landlord", recipientDefaultCategoryId: 9, rowCount: 1,
        rows: [row("301", payee: "RENT", amount: "-900", date: "2026-10-02", source: "new", account: nil)])

    static let preview = ImportPreview(
        batchId: 42, groups: [bakery, unknown, landlord],
        totals: ["exact": 1, "fuzzy": 1, "pattern": 0, "new": 1, "unresolved": 1])

    static let accounts = [EditingFixture.account(1, "checking ")]

    @MainActor
    static func model(
        _ review: FakeImportReviewService = FakeImportReviewService(), clock: ImportClock = ImportClock()
    ) -> ImportsModel {
        ImportFixture.model(clock: clock, review: review)
    }
}

// MARK: - Export

@MainActor
@Suite struct ImportExportCardTests {
    static let tree = [
        OpenAPI.CategoryNode(
            id: 1, name: "Home", pathIds: [1], path: ["Home"], categoryName: "Home", depth: 0, isActive: true,
            hierarchyOnly: false, legacyCompatible: true),
        OpenAPI.CategoryNode(
            id: 5, name: "Rent", parentId: 1, pathIds: [1, 5], path: ["Home", "Rent"], categoryName: "Rent", depth: 1,
            isActive: true, hierarchyOnly: false, legacyCompatible: true),
        OpenAPI.CategoryNode(
            id: 3, name: "Old", parentId: 1, pathIds: [1, 3], path: ["Home", "Old"], categoryName: "Old", depth: 1,
            isActive: false, hierarchyOnly: false, legacyCompatible: true),
        EditingFixture.category(8, ["Food"]),
    ]

    func makeModel(_ exports: FakeImportExportService = FakeImportExportService()) -> ImportsModel {
        ImportFixture.model(exports: exports, pickers: FakePickerService(categories: Self.tree))
    }

    @Test func showingTheFiltersLoadsTheAccountsAndCategoriesOnce() async {
        let exports = FakeImportExportService()
        let model = makeModel(exports).export
        #expect(!model.showsFilters)
        await model.toggleFilters()
        #expect(model.showsFilters)
        #expect(model.bankAccounts.count == 3)
        #expect(model.activeCategories.map { $0.id } == [1, 5, 8])
        await model.toggleFilters()
        #expect(!model.showsFilters)
        await model.toggleFilters()
        #expect(await exports.bankLoads == 1)
    }

    @Test func theFacesSayAllOrHowManyArePicked() async {
        let strings = DictionaryStrings(
            language: .en,
            table: [
                "combobox.bankAccount.allSelected": "All accounts", "combobox.bankAccount.nSelected": "{n} selected",
                "combobox.categoryMulti.allSelected": "All categories", "combobox.categoryMulti.nSelected": "{n} selected",
            ])
        let model = makeModel().export
        await model.loadLists()
        #expect(model.bankAccountsLabel(strings) == "All accounts")
        #expect(model.categoriesLabel(strings) == "All categories")
        model.toggleBankAccount("Savings")
        model.toggleBankAccount("BE12 3456")
        #expect(model.filters.bankAccounts == ["Savings", "BE12 3456"])
        #expect(model.bankAccountsLabel(strings) == "2 selected")
        model.toggleBankAccount("Savings")
        #expect(model.filters.bankAccounts == ["BE12 3456"])
        // A parent brings its descendants, inactive ones included, in ascending order.
        model.toggleCategory(8)
        model.toggleCategory(1)
        #expect(model.filters.categoryIds == [1, 3, 5, 8])
        #expect(model.categoriesLabel(strings) == "4 selected")
        // A child of a picked parent cannot leave alone.
        model.toggleCategory(5)
        #expect(model.filters.categoryIds == [1, 3, 5, 8])
        model.toggleCategory(1)
        #expect(model.filters.categoryIds == [3, 5, 8])
    }

    @Test func theListsShowPickedItemsFirstAndFilterBySearch() {
        let ordered = MultiSelection.ordered(
            ["Alpha", "Beta", "Gamma"], selection: ["Gamma"], value: { $0 }, searchText: { $0 }, search: "")
        #expect(ordered == ["Gamma", "Alpha", "Beta"])
        let searched = MultiSelection.ordered(
            ["Alpha", "Beta", "Gamma"], selection: ["Gamma"], value: { $0 }, searchText: { $0 }, search: " ET ")
        #expect(searched == ["Beta"])
        #expect(MultiSelection.toggle(2, in: [1, 2, 3]) == [1, 3])
        #expect(MultiSelection.toggle(4, in: [1]) == [1, 4])
    }

    @Test func theFiltersBuildTheWebQuery() {
        var filters = ExportFilters()
        #expect(filters.queryItems.isEmpty)
        #expect(filters.bankAccountsParameter == nil)
        filters.startDate = PlannedDay(year: 2026, month: 1, day: 5)
        filters.endDate = PlannedDay(year: 2026, month: 3, day: 31)
        filters.bankAccounts = ["BE12", "BE34"]
        filters.categoryIds = [2, 7]
        let query = filters.queryItems.map { "\($0.name)=\($0.value ?? "")" }
        #expect(query == ["start_date=2026-01-05", "end_date=2026-03-31", "bank_accounts=BE12,BE34", "category_ids=2,7"])
        #expect(ExportFormat.csv.fileName(today: PlannedDay(year: 2026, month: 10, day: 3)) == "transactions_2026-10-03.csv")
        #expect(ExportFormat.json.fileName(today: PlannedDay(year: 2026, month: 10, day: 3)) == "transactions_2026-10-03.ndjson")
        #expect(ExportFormat.json.labelKey == "importPage.exportJsonBtn")
    }

    @Test func exportingSavesTheFileUnderTheWebNameAndToasts() async {
        let exports = FakeImportExportService()
        let page = makeModel(exports)
        let model = page.export
        var saved: [String] = []
        model.save = { data, name in
            saved.append("\(name):\(data.count)")
            return true
        }
        model.filters.categoryIds = [5]
        await model.export(.csv, strings: ImportFixture.strings)
        #expect(saved == ["transactions_2026-10-03.csv:12"])
        #expect(page.notice?.key == "importPage.toast.exportSuccess")
        #expect(!model.isExporting)
        let recorded = await exports.exports
        #expect(recorded.count == 1)
        #expect(recorded.first?.format == .csv)
        #expect(recorded.first?.filters.categoryIds == [5])
        await model.export(.json, strings: ImportFixture.strings)
        #expect(saved.last == "transactions_2026-10-03.ndjson:12")
    }

    @Test func aCancelledSavePanelSaysNothing() async {
        let page = makeModel()
        page.export.save = { _, _ in false }
        await page.export.export(.csv, strings: ImportFixture.strings)
        #expect(page.notice == nil)
    }

    @Test func aFailedExportOrWriteToastsWithTheReason() async {
        let exports = FakeImportExportService()
        await exports.failExports(true)
        let page = makeModel(exports)
        var asked = false
        page.export.save = { _, _ in
            asked = true
            return true
        }
        await page.export.export(.csv, strings: ImportFixture.strings)
        #expect(!asked)
        #expect(page.notice?.key == "importPage.toast.exportFailed")
        #expect(page.notice?.kind == .error)
        await exports.failExports(false)
        page.export.save = { _, _ in throw CocoaError(.fileWriteNoPermission) }
        await page.export.export(.json, strings: ImportFixture.strings)
        #expect(page.notice?.key == "importPage.toast.exportFailed")
        #expect(!page.export.isExporting)
    }

    @Test func leavingThePageResetsTheCard() async {
        let page = makeModel()
        await page.export.toggleFilters()
        page.export.filters.bankAccounts = ["Savings"]
        page.toggleSetupReference()
        #expect(page.isSetupReferenceExpanded)
        page.disappear()
        #expect(!page.export.showsFilters)
        #expect(page.export.filters == ExportFilters())
        #expect(!page.isSetupReferenceExpanded)
    }
}

// MARK: - Payees and Categories from CSV

@MainActor
@Suite struct SimpleCSVImportTests {
    @Test func payeesImportWithSeparatorAndEncodingThenClearTheFile() async {
        let exports = FakeImportExportService()
        let page = ImportFixture.model(exports: exports)
        let card = page.recipientsCSV
        #expect(card.kind.showsEncoding)
        #expect(!card.canImport)
        await card.startImport(strings: ImportFixture.strings)
        #expect(page.notice?.key == "importPage.toast.noFileSel")
        card.chooseFile(ImportFixture.file("payees.txt", mimeType: "text/plain"))
        #expect(card.file == nil)
        #expect(page.notice?.key == "importPage.toast.noFile")
        card.chooseFile(ImportFixture.file("payees.csv"))
        card.separator = ";"
        card.encoding = "windows-1252"
        #expect(card.canImport)
        await card.startImport(strings: ImportFixture.strings)
        #expect(await exports.recipientImports == ["payees.csv|;|windows-1252"])
        #expect(card.result == SimpleImportResult(totalProcessed: 6, imported: 4, skipped: 1, errors: 1))
        #expect(card.file == nil)
        #expect(page.notice?.key == "importPage.recipientsResult")
        #expect(page.notice?.variables == ["n": "4", "e": "1", "x": "1"])
        // A new file clears the result line; so does Remove.
        card.chooseFile(ImportFixture.file("more.csv"))
        #expect(card.result == nil)
    }

    @Test func categoriesSendUTF8AndToastTheImportSummary() async {
        let exports = FakeImportExportService()
        let page = ImportFixture.model(exports: exports)
        let card = page.categoriesCSV
        #expect(!card.kind.showsEncoding)
        card.chooseFile(ImportFixture.file("categories.csv"))
        card.separator = "|"
        card.encoding = "latin1"
        await card.startImport(strings: ImportFixture.strings)
        #expect(await exports.categoryImports == ["categories.csv|||utf-8"])
        #expect(page.notice?.key == "importPage.toast.importSuccess")
        #expect(page.notice?.variables == ["n": "7", "dups": "2", "total": "9"])
        #expect(card.result?.imported == 7)
    }

    @Test func aFailedImportKeepsTheFileAndToastsTheCardsFailure() async {
        let exports = FakeImportExportService()
        await exports.failImports(true)
        let page = ImportFixture.model(exports: exports)
        page.recipientsCSV.chooseFile(ImportFixture.file("payees.csv"))
        await page.recipientsCSV.startImport(strings: ImportFixture.strings)
        #expect(page.notice?.key == "importPage.toast.recipientsImportFailed")
        #expect(page.notice?.detail == "Bad CSV")
        #expect(page.recipientsCSV.file != nil)
        #expect(page.recipientsCSV.result == nil)
        #expect(!page.recipientsCSV.isImporting)
        page.categoriesCSV.chooseFile(ImportFixture.file("categories.csv"))
        await page.categoriesCSV.startImport(strings: ImportFixture.strings)
        #expect(page.notice?.key == "importPage.toast.categoriesImportFailed")
        page.recipientsCSV.removeFile()
        #expect(page.recipientsCSV.file == nil)
    }

    @Test func theRequestsPostTheFileThenSeparatorAndEncoding() {
        let file = ImportFile(name: "p.csv", data: Data("Name\n".utf8), mimeType: "text/csv")
        let payees = ImportRecipientsRequest(file: file, separator: ";", encoding: "latin1", boundary: "B")
        #expect(payees.path == "/api/import/recipients")
        #expect(payees.contentType == "multipart/form-data; boundary=B")
        #expect(payees.form.parts.map { $0.name } == ["file", "separator", "encoding"])
        #expect(payees.form.parts.first?.filename == "p.csv")
        let categories = ImportCategoriesRequest(file: file, separator: ",", encoding: "utf-8", boundary: "B")
        #expect(categories.path == "/api/import/categories")
        #expect(ImportCategoriesRequest.method == .post)
        let text = String(decoding: categories.form.encoded(), as: UTF8.self)
        #expect(text.contains("name=\"separator\"\r\n\r\n,\r\n"))
        #expect(text.contains("name=\"encoding\"\r\n\r\nutf-8\r\n"))
    }

    @Test func theSimpleResultDecodes() throws {
        let json = Data(#"{"total_processed":5,"imported":3,"skipped":2,"errors":0,"status":"ok"}"#.utf8)
        let result = try JSONDecoder().decode(SimpleImportResult.self, from: json)
        #expect(result == SimpleImportResult(totalProcessed: 5, imported: 3, skipped: 2, errors: 0))
    }
}

// MARK: - Review import

@MainActor
@Suite struct ImportReviewModelTests {
    @Test func appearingLoadsThePreviewAccountsAndPickers() async {
        let service = FakeImportReviewService()
        let review = ReviewFixture.model(service).review
        #expect(review.isLoading)
        await review.appear(batchId: 42)
        #expect(!review.isLoading)
        #expect(review.preview == ReviewFixture.preview)
        #expect(review.totalRows == 4)
        #expect(review.pickers.isLoaded)
        #expect(review.expandedGroups.isEmpty)
        #expect(await service.previewLoads == [42])
        // Concurrent appearances share the request.
        let first = Task { await review.load() }
        let second = Task { await review.load() }
        await first.value
        await second.value
        #expect(await service.previewLoads.count <= 3)
    }

    @Test func groupsReadTheirHeadingBadgeAndDefaults() async {
        let strings = DictionaryStrings(
            language: .en, table: ["importReview.newRecipient": "New payee", "importReview.unresolved": "Unresolved"])
        let review = ReviewFixture.model().review
        await review.appear(batchId: 42)
        let bakery = ReviewFixture.bakery
        #expect(bakery.key == "11")
        #expect(bakery.dominantKind == .fuzzy)
        #expect(review.heading(for: bakery, strings: strings) == "Bakery")
        #expect(review.state(for: bakery).persistAsDefault)
        #expect(review.state(for: bakery).categoryId == 4)
        let unknown = ReviewFixture.unknown
        #expect(unknown.key == "__unresolved__::memo 201")
        #expect(unknown.dominantKind == .unresolved)
        #expect(review.heading(for: unknown, strings: strings) == "New payee")
        #expect(!review.state(for: ReviewFixture.landlord).persistAsDefault)
        #expect(ReviewFixture.landlord.isNew)
        review.setExpanded(bakery, true)
        review.setExpanded(unknown, true)
        #expect(review.isExpanded(bakery))
        review.setExpanded(bakery, false)
        #expect(review.expandedGroups == [unknown.key])
    }

    @Test func theAccountsCardCountsLabelsAndFlagsNewOnes() async {
        let review = ReviewFixture.model().review
        await review.appear(batchId: 42)
        let entries = review.accountDisclosure
        #expect(entries.map { $0.key } == ["checking", "", "new wallet"])
        #expect(entries.map { $0.count } == [2, 1, 1])
        #expect(entries.map { $0.isNew } == [false, false, true])
        #expect(entries[1].isUnspecified)
        #expect(entries[2].label == "new wallet")
        #expect(review.newAccountCount == 1)
        // Before the accounts load nothing is badged.
        #expect(ImportAccountDisclosure.entries(rows: ReviewFixture.preview.rows, accounts: nil).allSatisfy { !$0.isNew })
    }

    @Test func aPayeeChangeOverridesEveryRowOfTheGroupThenRefetches() async {
        let service = FakeImportReviewService()
        let review = ReviewFixture.model(service).review
        await review.appear(batchId: 42)
        await review.setRecipient(77, name: "Bakery & Co", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(await service.recipientOverrides.sorted() == ["101:77", "102:77"])
        #expect(await service.previewLoads == [42, 42])
        let state = review.state(for: ReviewFixture.bakery)
        #expect(state.recipientId == 77)
        #expect(state.recipientName == "Bakery & Co")
        #expect(!state.recipientSaving)
        // No payee sends null for each row.
        await review.setRecipient(nil, name: nil, for: ReviewFixture.unknown, strings: ImportFixture.strings)
        #expect(await service.recipientOverrides.suffix(1) == ["201:null"])
    }

    @Test func aPayeeChangeRefetchesAfterAPreviewRequestAlreadyRunning() async {
        let service = FakeImportReviewService()
        let review = ReviewFixture.model(service).review
        await review.appear(batchId: 42)
        // A preview request starts before the overrides land and answers with the old groups.
        let gate = CallGate()
        await service.holdNextPreview(gate)
        let stale = Task { await review.load() }
        while await service.previewLoads.count < 2 { await Task.yield() }
        let updated = ImportPreview(
            batchId: 42, groups: [ReviewFixture.unknown, ReviewFixture.landlord],
            totals: ["exact": 0, "fuzzy": 0, "pattern": 0, "new": 1, "unresolved": 1])
        await service.setPreview(updated)
        let picking = Task {
            await review.setRecipient(77, name: "Bakery & Co", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        }
        while await service.recipientOverrides.count < 2 { await Task.yield() }
        // Let the change reach its refetch, which waits on the held request.
        for _ in 0..<50 { await Task.yield() }
        gate.open()
        await stale.value
        await picking.value
        // The change waited for the running request, then asked again.
        #expect(await service.previewLoads == [42, 42, 42])
        #expect(review.preview == updated)
    }

    @Test func aFailedPayeeChangeToastsAndRevertsTheGroup() async {
        let service = FakeImportReviewService()
        await service.failOverride(row: "102")
        let page = ReviewFixture.model(service)
        let review = page.review
        await review.appear(batchId: 42)
        await review.setRecipient(77, name: "Other", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(page.notice?.key == "importReview.toast.overrideFailed")
        #expect(review.groupStates[ReviewFixture.bakery.key] == nil)
        #expect(review.state(for: ReviewFixture.bakery).recipientId == 11)
    }

    @Test func aCategoryChangeOverridesEveryRowAndSavesThePayeeDefault() async {
        let service = FakeImportReviewService()
        let review = ReviewFixture.model(service).review
        await review.appear(batchId: 42)
        await review.setCategory(8, label: "Food", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(await service.categoryOverrides.sorted() == ["101:8", "102:8"])
        #expect(await service.defaults == ["11:8"])
        #expect(review.state(for: ReviewFixture.bakery).categoryId == 8)
        #expect(!review.state(for: ReviewFixture.bakery).categorySaving)
        // Unchecked: only the rows change. No category never touches the default.
        review.setPersistDefault(false, for: ReviewFixture.bakery)
        await review.setCategory(9, label: "Fun", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        review.setPersistDefault(true, for: ReviewFixture.bakery)
        await review.setCategory(nil, label: nil, for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(await service.defaults == ["11:8"])
        #expect(await service.categoryOverrides.suffix(2).sorted() == ["101:null", "102:null"])
        // The landlord already has a default: the box starts off.
        await review.setCategory(8, label: "Food", for: ReviewFixture.landlord, strings: ImportFixture.strings)
        #expect(await service.defaults == ["11:8"])
    }

    @Test func categoryAndDefaultFailuresToastSeparately() async {
        let service = FakeImportReviewService()
        await service.failDefaults(true)
        let page = ReviewFixture.model(service)
        let review = page.review
        await review.appear(batchId: 42)
        await review.setCategory(8, label: "Food", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(page.notice?.key == "importReview.toast.persistDefaultFailed")
        #expect(review.state(for: ReviewFixture.bakery).categoryId == 8)
        await service.failCategories(true)
        await review.setCategory(4, label: "Food", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(page.notice?.key == "importReview.toast.categoryOverrideFailed")
        #expect(!review.state(for: ReviewFixture.bakery).categorySaving)
    }

    /// useImportReviewData (main, 2026-10-18): a failed edit blocks commit until the saved
    /// edits are reviewed, which rereads the persisted preview.
    @Test func aFailedEditBlocksCommitUntilTheSavedEditsAreReviewed() async {
        let service = FakeImportReviewService()
        await service.failOverride(row: "102")
        let review = ReviewFixture.model(service).review
        await review.appear(batchId: 42)
        await review.setRecipient(77, name: "Other", for: ReviewFixture.bakery, strings: ImportFixture.strings)
        #expect(review.hasEditErrors && !review.isSavingEdits)
        await review.commit(strings: ImportFixture.strings)
        #expect(await service.commits.isEmpty)
        let loads = await service.previewLoads.count
        await review.reviewSavedEdits()
        #expect(!review.hasEditErrors && review.groupStates.isEmpty)
        #expect(await service.previewLoads.count == loads + 1)
        await service.failOverride(row: nil)
        await review.commit(strings: ImportFixture.strings)
        #expect(await service.commits == [42])
    }

    @Test func discardAsksFirstThenReturnsToImport() async {
        let service = FakeImportReviewService()
        let page = ReviewFixture.model(service)
        let review = page.review
        await review.appear(batchId: 42)
        review.requestDiscard()
        #expect(review.isDiscardConfirmationPresented)
        review.cancelDiscard()
        #expect(!review.isDiscardConfirmationPresented)
        await review.confirmDiscard(strings: ImportFixture.strings)
        #expect(await service.discards.isEmpty)
        await service.failDiscard(true)
        review.requestDiscard()
        await review.confirmDiscard(strings: ImportFixture.strings)
        #expect(page.notice?.key == "importReview.toast.discardFailed")
        #expect(review.navigationRequest == nil)
        await service.failDiscard(false)
        review.requestDiscard()
        await review.confirmDiscard(strings: ImportFixture.strings)
        #expect(await service.discards == [42, 42])
        #expect(page.notice?.key == "importReview.toast.discarded")
        #expect(review.navigationRequest == .replace("/import"))
        review.didHandleNavigation()
        #expect(review.navigationRequest == nil)
        review.goBack()
        #expect(review.navigationRequest == .push("/import"))
    }

    @Test func commitToastsAndHandsTheReceiptToImport() async {
        let service = FakeImportReviewService()
        await service.setResult(ImportCommitResult(imported: 3, duplicates: 1, errors: 0, autoLinkedCount: 2))
        let page = ReviewFixture.model(service)
        let review = page.review
        await review.appear(batchId: 42)
        await review.commit(strings: ImportFixture.strings)
        #expect(await service.commits == [42])
        let keys = page.toasts.notices.map { $0.key }
        #expect(keys == ["importReview.toast.success", "importReview.toast.autoLinked", "importReview.toast.newAccounts"])
        #expect(page.toasts.notices.first?.variables == ["imported": "3", "duplicates": "1", "errors": "0"])
        let newAccounts = page.toasts.notices.last
        #expect(newAccounts?.variables == ["n": "1"])
        let action = newAccounts.flatMap { page.toasts.action(for: $0.id) }
        #expect(action?.route == "/accounts")
        #expect(action?.titleKey == "importReview.toast.reviewAccounts")
        #expect(action?.duration == Duration.seconds(10))
        #expect(page.commitReceipt?.imported == 3)
        #expect(page.commitReceipt?.dateFrom == "2026-10-01")
        #expect(page.commitReceipt?.dateTo == "2026-10-09")
        #expect(review.navigationRequest == .replace("/import"))
        #expect(!review.isCommitting)
    }

    @Test func commitInvalidatesImportHistoryForTheNextVisit() async {
        let imports = FakeImportService(batches: ImportFixture.batches(2))
        let review = FakeImportReviewService()
        let page = ImportFixture.model(imports, review: review)
        await page.appear(strings: ImportFixture.strings)
        page.disappear()
        await page.review.appear(batchId: 42)
        await page.review.commit(strings: ImportFixture.strings)
        await page.appear(strings: ImportFixture.strings)
        #expect(await imports.historyOffsets == [0, 0])
        #expect(page.commitReceipt != nil)
    }

    @Test func aFailedCommitToastsAndStays() async {
        let service = FakeImportReviewService()
        await service.failCommit(true)
        let page = ReviewFixture.model(service)
        await page.review.appear(batchId: 42)
        await page.review.commit(strings: ImportFixture.strings)
        #expect(page.notice?.key == "importReview.toast.commitFailed")
        #expect(page.notice?.detail == "Batch is busy")
        #expect(page.review.navigationRequest == nil)
        #expect(page.commitReceipt == nil)
    }

    @Test func aFailedPreviewShowsTheErrorStateUntilRetry() async {
        let service = FakeImportReviewService()
        await service.failPreview(true)
        let review = ReviewFixture.model(service).review
        await review.appear(batchId: 42)
        #expect(review.showsError)
        #expect(!review.isLoading)
        await service.failPreview(false)
        await review.retry()
        #expect(!review.showsError)
        #expect(review.preview != nil)
    }

    @Test func anotherBatchStartsFromACleanPage() async {
        let review = ReviewFixture.model().review
        await review.appear(batchId: 42)
        review.setExpanded(ReviewFixture.bakery, true)
        review.setPersistDefault(false, for: ReviewFixture.bakery)
        await review.appear(batchId: 43)
        #expect(review.batchId == 43)
        #expect(review.expandedGroups.isEmpty)
        #expect(review.groupStates.isEmpty)
        review.setExpanded(ReviewFixture.bakery, true)
        review.disappear()
        #expect(review.expandedGroups.isEmpty)
    }
}

@Suite struct ImportReviewWireTests {
    @Test func overridesSendAnExplicitNull() throws {
        let clear = ImportRowOverrideRequest(batchId: 4, rowId: "101", recipientId: nil)
        #expect(clear.path == "/api/import/batches/4/rows/101/override")
        #expect(String(decoding: try #require(try clear.encodedBody()), as: UTF8.self) == #"{"recipient_id":null}"#)
        let set = ImportRowOverrideRequest(batchId: 4, rowId: "101", recipientId: 9)
        #expect(String(decoding: try #require(try set.encodedBody()), as: UTF8.self) == #"{"recipient_id":9}"#)
        let category = ImportRowCategoryOverrideRequest(batchId: 4, rowId: "7", categoryId: nil)
        #expect(category.path == "/api/import/batches/4/rows/7/category-override")
        #expect(String(decoding: try #require(try category.encodedBody()), as: UTF8.self) == #"{"category_id":null}"#)
        #expect(ImportCommitRequest(batchId: 4).path == "/api/import/batches/4/commit")
        #expect(ImportPreviewRequest(batchId: 4).path == "/api/import/batches/4/preview")
    }

    @Test func thePreviewAndCommitDecode() throws {
        let json = #"""
            {"batch_id":42,"groups":[{"recipient_id":null,"recipient_name":null,"recipient_default_category_id":null,
            "recipient_default_category_label":null,"override_category_id":null,"current_category_id":null,
            "current_category_label":null,"matched_pattern_id":null,"matched_pattern_text":null,"matched_pattern_kind":null,
            "row_count":1,"rows":[{"id":"9007199254740993","row_index":0,"recipient_raw":"SHOP","amount":"-12.34",
            "currency":null,"tx_date":"2026-10-01","memo":null,"match_source":"fuzzy","match_similarity":0.5,
            "matched_pattern_id":null,"user_override_recipient_id":null,"override_category_id":null}]}],
            "totals":{"exact":0,"fuzzy":1,"pattern":0,"new":0,"unresolved":0}}
            """#
        let preview = try JSONDecoder().decode(ImportPreview.self, from: Data(json.utf8))
        let row = try #require(preview.rows.first)
        #expect(row.id == "9007199254740993")
        #expect(row.amountValue == Decimal(string: "-12.34"))
        #expect(row.currencyCode == "EUR")
        #expect(row.bankAccount == nil)
        #expect(row.matchKind == .fuzzy)
        #expect(preview.totals["fuzzy"] == 1)
        #expect(preview.dateRange?.from == "2026-10-01")
        let commit = try JSONDecoder().decode(
            ImportCommitResult.self,
            from: Data(#"{"total":4,"imported":3,"duplicates":1,"errors":0,"batch_id":42,"auto_linked_count":2,"status":"ok","error_message":null,"links":[]}"#.utf8))
        #expect(commit == ImportCommitResult(imported: 3, duplicates: 1, errors: 0, autoLinkedCount: 2))
        #expect(ImportMatchKind(source: nil) == .unresolved)
        #expect(ImportMatchKind(source: "pattern").legendKey == "importReview.legend.pattern")
    }

    @Test func downloadsReturnTheRawBodyOrTheEnvelopeError() async throws {
        let transport = FakeTransport([
            .response(200, "Date,Amount\n2026-10-01,-4.50\n"),
            .response(429, #"{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many exports"}}"#),
        ])
        let client = PlumbingFixture.client(transport: transport)
        var filters = ExportFilters()
        filters.bankAccounts = ["BE12"]
        filters.categoryIds = [3, 4]
        let data = try await client.exportTransactions(.csv, filters: filters)
        #expect(String(decoding: data, as: UTF8.self) == "Date,Amount\n2026-10-01,-4.50\n")
        let request = try #require(await transport.requests.first)
        #expect(request.url.absoluteString == "http://127.0.0.1:54331/api/transactions/export/csv?bank_accounts=BE12&category_ids=3%2C4")
        #expect(request.method == .get)
        await #expect(throws: APIError.self) {
            _ = try await client.exportTransactions(.json, filters: ExportFilters())
        }
        // One attempt each: no retry on a rate limit.
        #expect(await transport.requests.count == 2)
    }
}

@MainActor
@Suite struct ImportReviewRouteTests {
    @Test func reviewPathsOpenTheNativeReviewScreen() async throws {
        #expect(ImportRoutes.reviewIsNative)
        #expect(NativeScreen.screen(forPath: "/import/42/review") == .importReview(batchId: 42))
        #expect(NativeScreen.screen(forPath: "/import/abc/review") == nil)
        #expect(NativeScreen.screen(forPath: "/import/42") == nil)
        let shell = ImportShellTests().makeShell(ReviewFixture.model())
        shell.show(try #require(NativeRoute("/import/42/review")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.importReview(batchId: 42)))
        shell.replace(with: "/import")
        #expect(shell.route.path == "/import" && shell.nativeNavigation.count == 1)
    }

    @Test func theToastCenterStacksThreeAndKeepsActions() {
        let center = ImportNoticeCenter()
        let action = ImportNoticeCenter.Action(titleKey: "a", route: "/accounts", duration: .seconds(10))
        let first = center.post(.success, "one", action: action)
        #expect(center.duration(of: first) == Duration.seconds(10))
        center.post(.success, "two")
        center.post(.success, "three")
        center.post(.error, "four")
        #expect(center.notices.map { $0.key } == ["two", "three", "four"])
        #expect(center.action(for: first.id) == nil)
        #expect(center.latest?.key == "four")
        if let last = center.latest { center.clear(last.id) }
        #expect(center.latest?.key == "three")
        #expect(center.duration(of: center.notices[0]) == ImportNoticeCenter.defaultDuration)
    }
}

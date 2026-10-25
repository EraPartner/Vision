import AppKit
import SwiftUI
import Testing
import VisionNativeCore
@testable import VisionNativeUI

/// An Import & export service with fixed answers; `hangs` keeps a bank import streaming until
/// it is cancelled.
actor StaticImportService: ImportService {
    let batches: [OpenAPI.ImportBatch]
    let failing: Bool
    let hangs: Bool

    init(batches: [OpenAPI.ImportBatch] = StaticImportService.sample, failing: Bool = false, hangs: Bool = false) {
        self.batches = batches
        self.failing = failing
        self.hangs = hangs
    }

    static let sample = [
        OpenAPI.ImportBatch(
            id: "12", adapterName: "kbc", sourceFilename: "kbc-oktober-2026-rekeningafschriften.csv", status: "complete",
            rowsTotal: 40, rowsImported: 37, rowsDuplicate: 2, rowsError: 1, errorSummary: "1 row has no amount",
            startedAt: "2026-10-12T08:30:00.000Z", transactionsRemaining: 37),
        OpenAPI.ImportBatch(
            id: "13", adapterName: "generic", status: "awaiting_review", rowsTotal: 5, rowsImported: 0,
            rowsDuplicate: 0, rowsError: 0, startedAt: "2026-10-12T09:00:00.000Z", transactionsRemaining: 0),
    ]

    static let parser = OpenAPI.CustomParserConfig(
        id: 7, name: "Spaarbank",
        config: OpenAPI.TransactionParserConfig(
            dateColumn: "Datum", recipientColumn: "Naam", amountColumn: "Bedrag", separator: ";"))

    static let csv = Data(
        "Datum;Naam;Bedrag;Omschrijving\n2026-10-01;Bakkerij;-4,50;Brood\n2026-10-02;Werkgever;2500,00;Loon\n".utf8)

    func supportedAdapters() async throws -> [ImportAdapter] {
        if failing { throw APIError.network("offline") }
        return [ImportAdapter(key: "kbc", name: "KBC"), ImportAdapter(key: "belfius", name: "Belfius")]
    }

    func customParsers() async throws -> [OpenAPI.CustomParserConfig] { [Self.parser] }

    func createCustomParser(name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig {
        OpenAPI.CustomParserConfig(id: 8, name: name, config: config.payload)
    }

    func updateCustomParser(id: Int, name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig {
        OpenAPI.CustomParserConfig(id: id, name: name, config: config.payload)
    }

    func deleteCustomParser(id: Int) async throws {}

    func importStream(
        file: ImportFile, bankName: String, onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> ImportOutcome {
        await onProgress(ImportProgress(phase: "importing", current: 12, total: 40, imported: 10, duplicates: 1, errors: 1, percent: 30))
        if hangs { try await Task.sleep(for: .seconds(60)) }
        return .completed(ImportCompletion(total: 40, imported: 37, duplicates: 2, errors: 1))
    }

    func importCustom(file: ImportFile, bankName: String, config: CSVParserConfig) async throws -> ImportOutcome {
        if failing { throw APIError.network("offline") }
        return .completed(ImportCompletion(total: 2, imported: 2, duplicates: 0, errors: 0))
    }

    func importBatches(limit: Int, offset: Int) async throws -> ImportBatchPage {
        if failing { throw APIError.network("offline") }
        return ImportBatchPage(total: batches.count + 20, limit: limit, offset: offset, items: batches)
    }

    func rollbackImportBatch(id: Int) async throws -> Int { 37 }
}

extension StaticImportService: ImportExportService {
    func exportTransactions(_ format: ExportFormat, filters: ExportFilters) async throws -> Data {
        if failing { throw APIError.network("offline") }
        return Data("Date,Amount\n".utf8)
    }

    func bankAccountLabels() async throws -> [String] { ["BE00 1234 5678 9012", "Spaarrekening"] }

    func importRecipientsCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult {
        if failing { throw APIError.network("offline") }
        return SimpleImportResult(totalProcessed: 12, imported: 10, skipped: 1, errors: 1)
    }

    func importCategoriesCSV(file: ImportFile, separator: String, encoding: String) async throws -> SimpleImportResult {
        SimpleImportResult(totalProcessed: 4, imported: 4, skipped: 0, errors: 0)
    }
}

extension StaticImportService: ImportReviewService {
    static let preview = ImportPreview(
        batchId: 13,
        groups: [
            ImportPreviewGroup(
                recipientId: 1, recipientName: "Landlord", currentCategoryId: 7, currentCategoryLabel: "Housing / Energy",
                rowCount: 2,
                rows: [
                    ImportStagingRow(
                        id: "501", recipientRaw: "HUISBAAS NV OVERSCHRIJVING HUUR OKTOBER", amount: "-950.00",
                        currency: "EUR", txDate: "2026-10-01", memo: "Huur oktober 2026 appartement", bankAccount: "BE00 1234",
                        matchSource: "exact"),
                    ImportStagingRow(
                        id: "502", recipientRaw: "HUISBAAS NV", amount: "-950.00", currency: "EUR", txDate: "2026-09-01",
                        memo: nil, bankAccount: "BE00 1234", matchSource: "fuzzy", matchSimilarity: 0.86),
                ]),
            ImportPreviewGroup(
                recipientName: nil, matchedPatternText: "WERKGEVER*", rowCount: 1,
                rows: [
                    ImportStagingRow(
                        id: "503", recipientRaw: "WERKGEVER BV", amount: "2500.00", currency: nil, txDate: "2026-10-25",
                        memo: "Loon", bankAccount: "Nieuwe rekening", matchSource: nil)
                ]),
            ImportPreviewGroup(
                recipientId: 2, recipientName: "Streaming service", rowCount: 1,
                rows: [
                    ImportStagingRow(
                        id: "504", recipientRaw: "STREAM", amount: "-12.99", txDate: "2026-10-05", matchSource: "pattern")
                ]),
        ],
        totals: ["exact": 1, "fuzzy": 1, "pattern": 1, "new": 0, "unresolved": 1])

    func importPreview(batchId: Int) async throws -> ImportPreview {
        if failing { throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Batch not found")) }
        return Self.preview
    }

    func overrideImportRow(batchId: Int, rowId: String, recipientId: Int?) async throws {}

    func overrideImportRowCategory(batchId: Int, rowId: String, categoryId: Int?) async throws {}

    func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws {}

    func commitImportBatch(batchId: Int) async throws -> ImportCommitResult {
        ImportCommitResult(imported: 4, duplicates: 0, errors: 0, autoLinkedCount: 1)
    }

    func discardImportBatch(batchId: Int) async throws {}

    func allAccounts() async throws -> [OpenAPI.Account] { [] }
}

actor StaticRatesService: ExchangeRatesService {
    let result: OpenAPI.ExchangeRates

    init(_ result: OpenAPI.ExchangeRates) {
        self.result = result
    }

    func exchangeRates() async throws -> OpenAPI.ExchangeRates { result }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage { OpenAPI.InfoMessage(message: "ok") }
}

actor StaticAdminService: AdminService {
    let failing: Bool

    init(failing: Bool = false) {
        self.failing = failing
    }

    static let provider = OpenAPI.ProviderHealth(
        provider: "ecb", kind: "fx", label: "ECB", lastSuccessAt: "2026-10-09T08:05:00.000Z",
        lastErrorAt: "2026-10-09T09:30:00.000Z", lastError: "Fetch timeout after 5000ms", consecutiveFailures: 1,
        updatedAt: nil)

    private func check() throws {
        if failing { throw APIError.client(APIClientError(status: 401, code: .unauthorized, message: "Unauthorized")) }
    }

    func databaseStats() async throws -> OpenAPI.DbStats {
        try check()
        return OpenAPI.DbStats(tables: [], dbSize: "12 MB")
    }

    func providerHealth() async throws -> [OpenAPI.ProviderHealth] {
        try check()
        return [Self.provider]
    }

    func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult {
        OpenAPI.ProbeResult(ok: true, provider: Self.provider)
    }

    func requestMetrics() async throws -> [OpenAPI.RouteMetric] {
        try check()
        return [
            OpenAPI.RouteMetric(
                route: "GET:/api/x", method: "GET", path: "/api/x", count: 10, errors: 1,
                errorRate: Decimal(string: "0.1")!, p50Ms: 12, p95Ms: nil, windowMinutes: 15)
        ]
    }

    func endpointManifest() async throws -> [OpenAPI.EndpointEntry] {
        try check()
        return [
            OpenAPI.EndpointEntry(method: "GET", path: "/api/x"),
            OpenAPI.EndpointEntry(method: "DELETE", path: "/api/x/:id"),
        ]
    }
}

/// The database pages' service: two tables, a three-column table with a primary key (or
/// without one for `readOnly`), and a dry run of one statement.
actor StaticDatabaseService: DatabaseAdminService {
    let readOnly: Bool
    let emptyStats: Bool

    init(readOnly: Bool = false, emptyStats: Bool = false) {
        self.readOnly = readOnly
        self.emptyStats = emptyStats
    }

    static let columns = [
        OpenAPI.DbEditorColumn(
            name: "id", dataType: "integer", udtName: "int4", nullable: false, hasDefault: true, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "name", dataType: "text", udtName: "text", nullable: true, hasDefault: false, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "active", dataType: "boolean", udtName: "bool", nullable: false, hasDefault: false, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "meta", dataType: "jsonb", udtName: "jsonb", nullable: true, hasDefault: false, generated: false,
            writable: true),
    ]

    func databaseStats() async throws -> OpenAPI.DbStats {
        guard !emptyStats else { return OpenAPI.DbStats(tables: [], dbSize: "8 MB") }
        return OpenAPI.DbStats(
            tables: [
                OpenAPI.DbTableStat(
                    schemaname: "public", tableName: "transactions", liveRows: "2453", deadRows: "1500",
                    lastAutovacuum: "2026-04-24 10:15:32.123456+00", lastAutoanalyze: nil, size: "3200 kB",
                    sizeBytes: "3276800"),
                OpenAPI.DbTableStat(
                    schemaname: "public", tableName: "categories", liveRows: "45", deadRows: "2", lastAutovacuum: nil,
                    lastAutoanalyze: nil, size: "64 kB", sizeBytes: "65536"),
            ],
            dbSize: "12 MB")
    }

    func vacuum(table: String?) async throws -> OpenAPI.DbVacuumResult {
        OpenAPI.DbVacuumResult(vacuumed: table ?? "all")
    }

    func tableSchema(_ table: String) async throws -> OpenAPI.DbEditorTableSchema {
        OpenAPI.DbEditorTableSchema(table: table, columns: Self.columns, primaryKey: readOnly ? [] : ["id"])
    }

    func tableRows(_ table: String, _ query: TableRowsQuery) async throws -> OpenAPI.DbEditorRows {
        OpenAPI.DbEditorRows(
            table: table, columns: Self.columns, primaryKey: readOnly ? [] : ["id"],
            rows: [
                [
                    "id": .int(1), "name": .string("Food"), "active": .bool(true), "meta": .object(["a": .int(1)]),
                    "__xmin": .string("100"),
                ],
                ["id": .int(2), "name": .null, "active": .bool(false), "meta": .null, "__xmin": .string("101")],
            ],
            limit: 100, hasMore: true, nextCursor: "c1")
    }

    func mutateTable(_ table: String, changes: [TableChange], dryRun: Bool) async throws
        -> OpenAPI.DbEditorMutationResult
    {
        OpenAPI.DbEditorMutationResult(
            dryRun: dryRun, count: changes.count,
            statements: changes.map { OpenAPI.DbEditorStatement(op: $0.op, preview: "\($0.op.uppercased()) …") },
            applied: dryRun ? nil : changes.count)
    }
}

/// A planned-payments service with fixed rows; `failing` fails the list.
actor StaticPlannedService: PlannedPaymentsService {
    let rows: [OpenAPI.PlannedTransaction]
    let failing: Bool

    init(rows: [OpenAPI.PlannedTransaction] = [], failing: Bool = false) {
        self.rows = rows
        self.failing = failing
    }

    func plannedPayments(includePaused: Bool) async throws -> [OpenAPI.PlannedTransaction] {
        if failing { throw APIError.network("The network connection was lost.") }
        return includePaused ? rows : rows.filter { row in row.isActive }
    }

    func setPlannedPaymentActive(id: Int, isActive: Bool) async throws -> OpenAPI.PlannedTransaction {
        guard let row = rows.first(where: { candidate in candidate.id == id }) else { throw APIError.network("missing") }
        return OpenAPI.PlannedTransaction(
            id: row.id, plannedDate: row.plannedDate, recipientName: row.recipientName, memo: row.memo,
            amount: row.amount, currency: row.currency, categoryName: row.categoryName, url: row.url,
            isRecurring: row.isRecurring, recurrencePattern: row.recurrencePattern, isLoan: row.isLoan,
            loanTermMonths: row.loanTermMonths, isExecuted: row.isExecuted, lastExecutedDate: row.lastExecutedDate,
            executedTransactionId: row.executedTransactionId, executionCount: row.executionCount,
            executions: row.executions, isActive: isActive, links: [])
    }

    func deletePlannedPayment(id: Int) async throws {}

    func transaction(id: Int) async throws -> OpenAPI.Transaction? {
        OpenAPI.Transaction(
            id: id, transactionDate: "2026-10-01", recipientName: "Landlord", memo: nil, amount: -950,
            currency: "EUR", categoryName: "Housing", links: [])
    }

    /// The local day `offset` days from today, as `planned_date`.
    static let today = Date(timeIntervalSince1970: 1_791_806_400)

    static func day(_ offset: Int) -> String {
        let calendar = PlannedDates.local
        let date = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: today)) ?? today
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 2026, parts.month ?? 1, parts.day ?? 1)
    }

    static var sample: [OpenAPI.PlannedTransaction] {
        [
            OpenAPI.PlannedTransaction(
                id: 1, plannedDate: day(0), recipientName: "Landlord", memo: "Rent", amount: -950, currency: "EUR",
                categoryName: "Housing", url: "https://example.com/lease", isRecurring: true,
                recurrencePattern: "monthly", isExecuted: true, executedTransactionId: 31, executionCount: 4,
                executions: [
                    OpenAPI.PlannedTransactionExecution(id: 1, executedTransactionId: 31, executionDate: day(-30))
                ],
                isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 2, plannedDate: day(3), memo: "Streaming", amount: Decimal(string: "-12.99")!, currency: "USD",
                categoryName: "Leisure", isRecurring: true, recurrencePattern: "every 14 days", isExecuted: false,
                executionCount: 0, isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 3, plannedDate: day(40), memo: "Car loan", amount: -310, currency: "EUR", isRecurring: true,
                recurrencePattern: "monthly", isLoan: true, loanTermMonths: 48, isExecuted: false, executionCount: 0,
                isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 4, plannedDate: day(-2), memo: "Old gym", amount: -40, currency: "XYZ", isRecurring: false,
                isExecuted: false, executionCount: 0, isActive: false, links: []),
        ]
    }
}

/// The planned-payment sheet, Mark as paid, suggestions and recurring detection over fixed
/// answers.
extension StaticPlannedService: PlannedEditingService {
    func createPlannedPayment(_ body: OpenAPI.PlannedTransactionCreate) async throws -> OpenAPI.PlannedTransaction {
        OpenAPI.PlannedTransaction(
            id: 50, plannedDate: body.plannedDate, memo: body.memo, amount: body.amount, currency: body.currency,
            isRecurring: body.isRecurring ?? false, isExecuted: false, executionCount: 0, isActive: true, links: [])
    }

    func trackPlannedPayment(_ body: PlannedTrackBody) async throws -> OpenAPI.PlannedTransaction {
        OpenAPI.PlannedTransaction(
            id: 51, plannedDate: body.plannedDate, memo: body.memo, amount: body.amount, currency: body.currency,
            isRecurring: true, isExecuted: false, executionCount: 0, isActive: true, links: [])
    }

    func updatePlannedPayment(id: Int, patch: PlannedPaymentPatch) async throws -> OpenAPI.PlannedTransaction {
        guard let row = rows.first(where: { candidate in candidate.id == id }) else { throw APIError.network("missing") }
        return row
    }

    func executePlannedPayment(id: Int, transactionId: Int, executionDate: String?) async throws
        -> OpenAPI.PlannedTransaction
    {
        guard let row = rows.first(where: { candidate in candidate.id == id }) else { throw APIError.network("missing") }
        return row
    }

    func matchSuggestions() async throws -> [PlannedMatchSuggestion] {
        [PlannedMatchSuggestion(planned: .init(id: 2, recipientName: "Streaming"), candidates: [])]
    }

    func recurringPatterns() async throws -> [PlannedRecurringPattern] {
        [
            PlannedRecurringPattern(
                recipientId: 11, recipientName: "Energy supplier with a long name", latestAmount: 96,
                categoryId: 7, categoryName: "Utilities", predictedNext: Self.day(20),
                amountChanges: [
                    PlannedRecurringPattern.AmountChange(
                        date: Self.day(-10), previousAmount: 84, newAmount: 96, percentChange: Decimal(string: "14.29")!,
                        direction: "increased")
                ], confidence: 92),
            PlannedRecurringPattern(
                recipientId: 12, recipientName: "Gym", direction: "expense", detectedPattern: "custom", intervalDays: 10,
                latestAmount: 25, predictedNext: "", confidence: 64),
            PlannedRecurringPattern(
                recipientId: 13, recipientName: "Salary", direction: "income", latestAmount: 3200,
                predictedNext: Self.day(18),
                amountChanges: [
                    PlannedRecurringPattern.AmountChange(
                        date: Self.day(-12), previousAmount: 3300, newAmount: 3200, percentChange: Decimal(string: "-3.03")!,
                        direction: "decreased")
                ], confidence: 45),
        ]
    }

    func linkCandidates(_ query: PlannedLinkQuery) async throws -> [OpenAPI.Transaction] {
        [
            OpenAPI.Transaction(
                id: 31, transactionDate: Self.day(-1), recipientName: "Streaming service", memo: "STREAMING 4411",
                amount: Decimal(string: "-12.99")!, currency: "USD", links: []),
            OpenAPI.Transaction(id: 32, transactionDate: Self.day(-2), amount: Decimal(string: "-13.10")!, links: []),
        ]
    }

    func setting(key: String) async throws -> OpenAPI.Setting {
        throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Setting not found"))
    }

    func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        OpenAPI.Setting(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }
}

extension StaticPlannedService: PickerDataService {
    func recipients(search: String?, limit: Int) async throws -> [OpenAPI.Recipient] {
        [
            OpenAPI.Recipient(id: 1, name: "Landlord", isActive: true, createdAt: "2026-01-01", links: []),
            OpenAPI.Recipient(id: 2, name: "Streaming service", isActive: true, createdAt: "2026-01-01", links: []),
        ]
    }

    func recipient(id: Int) async throws -> OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: "Landlord", primaryRecipientId: 1, isActive: true, createdAt: "2026-01-01", links: [])
    }

    func accounts() async throws -> [OpenAPI.Account] {
        [
            OpenAPI.Account(
                id: 7, name: "BE00 1234", displayName: "Everyday account", currency: "EUR", type: "checking",
                liquidityClass: "cash", spendable: true, inNetWorth: true, taxWrapper: "none", owner: "self",
                multiCurrencyCash: false, hasCashSleeve: false, isActive: true, createdAt: "2026-01-01",
                updatedAt: "2026-01-01")
        ]
    }

    func categories() async throws -> [OpenAPI.CategoryNode] {
        [
            OpenAPI.CategoryNode(
                id: 7, name: "Energy", pathIds: [6, 7], path: ["Housing", "Energy"], categoryName: "Energy", depth: 1,
                isActive: true, hierarchyOnly: false, legacyCompatible: true)
        ]
    }

    func tags() async throws -> [OpenAPI.Tag] {
        [OpenAPI.Tag(id: 1, slug: "fixed-costs", color: "hsl(210, 62%, 50%)", isActive: true, createdAt: "", updatedAt: "")]
    }

    func createTag(slug: String, color: String?) async throws {}
}

/// A transactions service with three fixed rows and one attachment; `failing` fails the list.
actor StaticTransactionsService: TransactionsService, TransactionAttachmentsService {
    let rows: [OpenAPI.Transaction]
    let failing: Bool

    init(rows: [OpenAPI.Transaction] = StaticTransactionsService.sample, failing: Bool = false) {
        self.rows = rows
        self.failing = failing
    }

    static let sample: [OpenAPI.Transaction] = [
        OpenAPI.Transaction(
            id: 3, transactionDate: "2026-10-09", accountId: 7, bankAccount: "BE00 1234", recipientId: 1,
            recipientName: "Landlord", memo: "Rent October", amount: Decimal(string: "-950.00")!, currency: "EUR",
            balance: Decimal(string: "1520.40")!, categoryId: 7, categoryName: "Energy", comment: "Paid on time",
            isActive: true, tags: [OpenAPI.TransactionTagRef(id: 1, slug: "fixed-costs", isActive: true)],
            links: []),
        OpenAPI.Transaction(
            id: 2, transactionDate: "2026-10-05", accountId: 7, bankAccount: "BE00 1234", recipientId: 2,
            recipientName: "Streaming service", memo: "Monthly plan", amount: Decimal(string: "-12.99")!,
            currency: "EUR", isActive: true, tags: [], links: []),
        OpenAPI.Transaction(
            id: 1, transactionDate: "2026-10-01", accountId: 7, bankAccount: "BE00 1234", recipientId: 3,
            recipientName: "Employer", memo: "Salary", amount: Decimal(string: "2480.00")!, currency: "EUR",
            isActive: false, tags: [], links: []),
    ]

    func transactionPage(_ query: TransactionListQuery, offset: Int) async throws -> TransactionPage {
        if failing { throw APIError.network("The network connection was lost.") }
        let shown = query.includeExcluded ? rows : rows.filter { row in row.isActive != false }
        return TransactionPage(items: offset == 0 ? shown : [], total: shown.count)
    }

    func uncategorisedCount(recipientId: Int?) async throws -> Int { 2 }

    func updateTransaction(id: Int, patch: TransactionPatch) async throws -> OpenAPI.Transaction {
        guard let row = rows.first(where: { candidate in candidate.id == id }) else { throw APIError.network("missing") }
        return row
    }

    func createTransaction(_ body: OpenAPI.TransactionCreate) async throws -> OpenAPI.Transaction {
        throw APIError.network("unsupported")
    }

    func deleteTransaction(id: Int) async throws {}

    func categorizeUncategorised(recipientId: Int, categoryId: Int, expectedCount: Int) async throws
        -> BulkUpdateResult
    {
        BulkUpdateResult(updated: expectedCount, requested: expectedCount, matched: expectedCount)
    }

    func setRecipientDefaultCategory(recipientId: Int, categoryId: Int) async throws {}

    func recipient(id: Int) async throws -> OpenAPI.Recipient {
        OpenAPI.Recipient(id: id, name: "Landlord", defaultCategoryId: 7, isActive: true, createdAt: "2026-01-01", links: [])
    }

    func allAccounts() async throws -> [OpenAPI.Account] {
        [
            OpenAPI.Account(
                id: 7, name: "BE00 1234", displayName: "Everyday account", currency: "EUR", type: "checking",
                liquidityClass: "cash", spendable: true, inNetWorth: true, taxWrapper: "none", owner: "self",
                multiCurrencyCash: false, hasCashSleeve: false, isActive: true, createdAt: "2026-01-01",
                updatedAt: "2026-01-01")
        ]
    }

    func exportFilteredTransactions(_ format: ExportFormat, query: TransactionExportQuery) async throws -> Data {
        Data("id,amount\n".utf8)
    }

    func setting(key: String) async throws -> OpenAPI.Setting {
        throw APIError.client(APIClientError(status: 404, code: .notFound, message: "Setting not found"))
    }

    func saveSetting(key: String, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        OpenAPI.Setting(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }

    func attachments(transactionId: Int) async throws -> [OpenAPI.Attachment] {
        [
            OpenAPI.Attachment(
                id: "41", transactionId: transactionId, filename: "invoice-october.pdf", storedPath: "a/invoice.pdf",
                mimeType: "application/pdf", sizeBytes: 48_213, createdAt: "2026-10-09T10:00:00Z")
        ]
    }

    func uploadAttachment(transactionId: Int, file: AttachmentUpload) async throws -> OpenAPI.Attachment {
        OpenAPI.Attachment(
            id: "42", transactionId: transactionId, filename: file.name, storedPath: "a/\(file.name)",
            mimeType: file.contentType, sizeBytes: file.data.count, createdAt: "2026-10-09T10:00:00Z")
    }

    func downloadAttachment(id: Int) async throws -> Data { Data("%PDF-1.7".utf8) }

    func deleteAttachment(id: Int) async throws {}
}

/// The bulk and split calls with fixed answers: two open splits owed by Anna and three
/// recent transactions; `failing` fails the summary.
actor StaticSplitsService: TransactionBulkService, SplitsService {
    let failing: Bool
    let owedSplits: [OpenAPI.SplitOwedDetail]

    init(failing: Bool = false, owed: [OpenAPI.SplitOwedDetail] = StaticSplitsService.sample) {
        self.failing = failing
        owedSplits = owed
    }

    static let sample: [OpenAPI.SplitOwedDetail] = [
        OpenAPI.SplitOwedDetail(
            id: 1, transactionId: 3, recipientId: 4, recipientName: "Anna", amount: Decimal(string: "20.00")!,
            amountPaid: Decimal(string: "5.00")!, note: "Half", isSettled: false, createdAt: "2026-10-01",
            updatedAt: "2026-10-01", transactionDate: "2026-10-09", transactionMemo: "Dinner",
            transactionAmount: Decimal(string: "-40.00")!, transactionCurrency: "EUR",
            transactionRecipientName: "Bistro", remaining: Decimal(string: "15.00")!),
        OpenAPI.SplitOwedDetail(
            id: 2, transactionId: 2, recipientId: 4, recipientName: "Anna", amount: Decimal(string: "6.50")!,
            amountPaid: 0, note: nil, isSettled: false, createdAt: "2026-10-05", updatedAt: "2026-10-05",
            transactionDate: "2026-10-05", transactionMemo: nil, transactionAmount: Decimal(string: "-12.99")!,
            transactionCurrency: "EUR", transactionRecipientName: "Streaming service",
            remaining: Decimal(string: "6.50")!),
    ]

    func bulkUpdate(_ selector: BulkSelector, fields: BulkUpdateFields) async throws -> BulkUpdateResult {
        BulkUpdateResult(updated: selector.count, requested: selector.count, matched: selector.count)
    }

    func bulkDelete(_ selector: BulkSelector) async throws -> BulkDeleteResult {
        BulkDeleteResult(deleted: selector.count, requested: selector.count, matched: selector.count)
    }

    func bulkExport(_ selector: BulkSelector, format: ExportFormat) async throws -> BulkExportFile {
        BulkExportFile(data: Data("id\n".utf8), exportedCount: selector.count)
    }

    func bulkTag(ids: [Int], add: [String], remove: [String]) async throws -> OpenAPI.BulkTagResult {
        OpenAPI.BulkTagResult(added: add.count, removed: remove.count, transactionsAffected: ids.count)
    }

    func markTransfer(_ first: Int, _ second: Int) async throws {}

    func createRecipient(name: String) async throws -> CreatedRecipient {
        CreatedRecipient(id: 9, name: name, isActive: true, createdAt: "2026-10-09", links: [], created: true)
    }

    func splits(transactionId: Int) async throws -> [OpenAPI.Split] {
        [
            OpenAPI.Split(
                id: 1, transactionId: transactionId, recipientId: 4, recipientName: "Anna",
                amount: Decimal(string: "20.00")!, amountPaid: 0, isSettled: false, createdAt: "2026-10-01",
                updatedAt: "2026-10-01")
        ]
    }

    func createSplits(transactionId: Int, shares: [SplitShare]) async throws {}

    func bulkSplit(transactionIds: [Int], recipientId: Int, mode: BulkSplitMode) async throws
        -> OpenAPI.BulkSplitResult
    {
        OpenAPI.BulkSplitResult(
            requested: transactionIds.count, split: transactionIds.count, skippedAlreadySplit: 0, skippedZeroAmount: 0,
            skippedMissing: 0, items: [])
    }

    func owedSummary(currency: String) async throws -> OwedSummaryPage {
        if failing { throw APIError.network("The network connection was lost.") }
        let totals = OpenAPI.OwedTotals(
            currency: currency, remaining: owedSplits.reduce(Decimal(0)) { sum, split in sum + split.remaining },
            unconvertedCount: 0, unconvertedCurrencies: [])
        guard !owedSplits.isEmpty else { return OwedSummaryPage(items: [], summary: totals) }
        let total = owedSplits.reduce(Decimal(0)) { sum, split in sum + split.amount }
        let paid = owedSplits.reduce(Decimal(0)) { sum, split in sum + split.amountPaid }
        return OwedSummaryPage(
            items: [
                OpenAPI.SplitOwed(
                    recipientId: 4, recipientName: "Anna", totalOwed: total, totalPaid: paid, remaining: total - paid,
                    splitCount: owedSplits.count, unconvertedCount: 0, unconvertedCurrencies: [])
            ], summary: totals)
    }

    func owed(recipientId: Int, currency: String) async throws -> OwedDetailPage {
        OwedDetailPage(
            items: owedSplits,
            summary: OpenAPI.OwedTotals(
                currency: currency, remaining: owedSplits.reduce(Decimal(0)) { sum, split in sum + split.remaining },
                unconvertedCount: 0, unconvertedCurrencies: []))
    }

    func exportOwedCsv(recipientId: Int) async throws -> Data { Data("date,amount\n".utf8) }

    func recordPayment(splitId: Int, amount: Decimal) async throws {}

    func settle(splitId: Int) async throws {}

    func settleAll(recipientId: Int) async throws -> Int { owedSplits.count }

    func deleteSplit(id: Int) async throws {}

    func recipientTransactions(groupId: Int, offset: Int, limit: Int) async throws -> TransactionPage {
        TransactionPage(items: offset == 0 ? StaticTransactionsService.sample : [], total: StaticTransactionsService.sample.count)
    }
}

/// An accounts service with fixed answers: a checking, a brokerage and an archived savings
/// account, a two-row ledger and one planned payment. `failing` fails the list.
actor StaticAccountsService: AccountsService {
    let rows: [OpenAPI.Account]
    let failing: Bool

    init(rows: [OpenAPI.Account] = StaticAccountsService.sample, failing: Bool = false) {
        self.rows = rows
        self.failing = failing
    }

    static func account(
        _ id: Int, _ name: String, type: String, balance: Decimal, isActive: Bool = true,
        statements: [OpenAPI.Account.StatementBalancesItem]? = nil, drift: Decimal? = nil
    ) -> OpenAPI.Account {
        let flags = AccountTypeFlags.of(type)
        return OpenAPI.Account(
            id: id, name: name, displayName: nil, institution: "KBC", currency: "EUR", type: type,
            liquidityClass: flags.liquidityClass, spendable: flags.spendable, inNetWorth: true,
            taxWrapper: flags.taxWrapper, owner: "me", multiCurrencyCash: false, hasCashSleeve: flags.hasCashSleeve,
            statementBalances: statements, computedBalance: balance, balanceParts: nil, balanceIncomplete: false,
            unconvertedCurrencies: nil, reconcilableBalance: balance, reconcilableCurrency: "EUR", drift: drift,
            anchorDate: nil, postAnchorCount: nil, hasTransactions: true, isActive: isActive,
            createdAt: "2026-01-01", updatedAt: "2026-01-01")
    }

    static let sample = [
        account(
            1, "Zichtrekening met een bijzonder lange naam", type: "checking", balance: Decimal(string: "1234.56")!,
            statements: [.init(currency: "EUR", balance: Decimal(string: "1244.56")!, balanceDate: "2026-10-01")],
            drift: 10),
        account(2, "Bolero", type: "brokerage", balance: 250),
        account(3, "Spaarrekening", type: "savings", balance: 0, isActive: false),
    ]

    func accounts(active: String) async throws -> [OpenAPI.Account] {
        if failing { throw APIError.network("offline") }
        return active == "true" ? rows.filter(\.isActive) : rows
    }

    func portfolioAccountRows(currency: String) async throws -> AccountPortfolioSummary {
        AccountPortfolioSummary(
            byAccount: [PortfolioAccountRow(accountId: 2, contributionKind: "position", currentValue: 4200)],
            accountTotals: [PortfolioAccountTotalsRow(accountId: 2, oversold: false, gainLoss: 310)])
    }

    func accountTotals(currency: String) async throws -> OpenAPI.AccountTotals {
        func group(_ total: Decimal) -> OpenAPI.AccountGroupTotal {
            OpenAPI.AccountGroupTotal(
                total: total, cash: total, holdings: 0, holdingsUnavailable: false, unconvertedCount: 0,
                unconvertedCurrencies: [])
        }
        return OpenAPI.AccountTotals(
            currency: currency,
            netCash: .init(total: Decimal(string: "1234.56")!, unconvertedCount: 0, unconvertedCurrencies: []),
            groups: .init(cash: group(Decimal(string: "1234.56")!), portfolio: group(4200), liabilities: group(0), archived: group(0)),
            accounts: [])
    }

    func ledger(accountId: Int, offset: Int, limit: Int) async throws -> AccountLedgerPage {
        AccountLedgerPage(
            rows: [
                AccountLedgerRow(
                    id: 11, date: "2026-10-10", recipientName: "Delhaize", memo: "Boodschappen",
                    categoryName: "Groceries", amount: -42, runningBalance: Decimal(string: "1234.56")!),
                AccountLedgerRow(
                    id: 10, date: "2026-10-01", recipientName: "Werkgever", amount: 2500,
                    runningBalance: Decimal(string: "1276.56")!),
            ],
            total: 140)
    }

    func plannedRows(accountId: Int) async throws -> AccountPlannedPage {
        AccountPlannedPage(
            rows: [AccountPlannedRow(id: 7, date: "2026-11-01", recipientName: "Huur", amount: -950, currency: "EUR")],
            total: 1)
    }

    func createAccount(_ body: OpenAPI.AccountCreate) async throws -> Int { 9 }
    func updateAccount(id: Int, patch: AccountPatch) async throws {}
    func deleteAccount(id: Int) async throws {}
    func setOpeningBalance(id: Int, balance: Decimal, date: String, currency: String) async throws -> String? { nil }
    func setStatementBalance(id: Int, currency: String, balance: Decimal, date: String) async throws {}
    func reconcile(id: Int, mode: ReconcileMode, currency: String) async throws {}

    func mergePreview(sourceId: Int, targetId: Int) async throws -> AccountMergePreview {
        AccountMergePreview(
            into: targetId, source: sourceId, transactions: 12, planned: 1, projectedBalance: 1500,
            projectedBalanceCurrency: "EUR")
    }

    func merge(targetId: Int, sourceIds: [Int]) async throws -> AccountMergeCounts {
        AccountMergeCounts(transactions: 12, planned: 1)
    }

    func closeAccount(id: Int, balanceHandling: CloseBalanceHandling) async throws {}

    func lotPreview(accountId: Int) async throws -> AccountLotPreview {
        AccountLotPreview(accountId: accountId, eligibleCount: 3, transactionIds: [21, 22, 23], limit: 500)
    }

    func retagLots(_ request: LotRetagRequest) async throws -> LotRetagReceipt {
        LotRetagReceipt(movedCount: request.transactionIds.count)
    }
}

/// The SwiftUI screens build and lay out in both languages and appearances.
@MainActor
@Suite struct NativeScreenStructureTests {
    static let rates = OpenAPI.ExchangeRates(
        totalRates: 3,
        rates: [
            OpenAPI.ExchangeRate(
                currency: "USD", rateToEur: Decimal(string: "1.0842")!, rateDate: "2026-10-09",
                fetchedAt: "2026-10-09T15:05:00.000Z")
        ],
        source: "database", isStale: false, lastFetchedAt: nil)

    func makeShell(
        language: NativeLanguage, appearance: ThemeAppearance, failing: Bool = false,
        database: StaticDatabaseService = StaticDatabaseService(),
        planned: StaticPlannedService = StaticPlannedService(), adminMode: Bool = true,
        imports: StaticImportService = StaticImportService(),
        transactions: StaticTransactionsService = StaticTransactionsService(),
        splits: StaticSplitsService = StaticSplitsService(),
        accounts: StaticAccountsService = StaticAccountsService(),
        categories: StaticCategoriesService = StaticCategoriesService(),
        recipients: StaticRecipientsService = StaticRecipientsService()
    ) -> NativeShellModel {
        let rates = ExchangeRatesModel(service: StaticRatesService(Self.rates))
        return NativeShellModel(
            strings: CatalogStrings(language: language),
            theme: ThemeSelection(appearance: appearance),
            notices: NativeNoticeCenter(now: { StaticPlannedService.today }, automaticExpiry: false),
            exchangeRates: rates,
            admin: AdminScreens.make(
                service: StaticAdminService(failing: failing), database: database),
            planned: PlannedPaymentsModel(
                service: planned, editing: planned, pickers: planned, rates: rates, dismissals: .memory(),
                now: { StaticPlannedService.today }),
            imports: ImportsModel(service: imports, exports: imports, review: imports, pickers: planned),
            transactions: TransactionsModel(
                service: transactions, attachments: transactions, pickers: planned, bulk: splits, splits: splits),
            accounts: AccountsModel(service: accounts, rates: rates),
            categories: CategoriesModel(service: categories), recipients: RecipientsModel(service: recipients),
            loadSettings: { NativeAppSettings(adminMode: adminMode) })
    }

    func layOut<Content: View>(_ view: Content) -> NSHostingView<Content> {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        host.layoutSubtreeIfNeeded()
        return host
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theExchangeRatesScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        // Loading, then loaded.
        let loading = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loading.fittingSize.width > 0)
        await shell.exchangeRates.appear()
        #expect(shell.exchangeRates.data == Self.rates)
        let loaded = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loaded.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAdminScreensLayOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let admin = shell.admin
        // Loading.
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        // Loaded, with an expanded error row and a filter.
        await admin.overview.appear()
        await admin.providers.appear()
        await admin.endpoints.appear()
        admin.providers.toggleExpanded("ecb")
        admin.endpoints.filter = "delete"
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The empty state.
        admin.endpoints.filter = "nothing matches"
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theDatabaseMaintenanceScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async
    {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.admin.database.maintenance
        // Loading, then loaded.
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        await model.appear()
        #expect(model.tableCount == 2)
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // A finished vacuum with its toast.
        await model.vacuum(table: "categories", strings: shell.strings)
        #expect(model.notice?.key == "dbMaintenance.vacuumSuccess")
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The empty state.
        let empty = makeShell(language: language, appearance: appearance, database: StaticDatabaseService(emptyStats: true))
        await empty.admin.database.maintenance.appear()
        #expect(empty.admin.database.maintenance.showsEmptyState)
        #expect(layOut(DatabaseMaintenanceView(model: empty.admin.database.maintenance, shell: empty).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theTableEditorLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = TableDataEditorModel(table: "categories", service: StaticDatabaseService())
        // Loading, then loaded.
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        await model.appear()
        #expect(model.rows.count == 2)
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // Pending: a new row, an edited and a deleted row, an open editor and a sort.
        model.addRow()
        model.setValue(.string("New"), for: TableDataEditorModel.Cell(row: "new-0", column: "name", isNew: true))
        model.setValue(.bool(false), for: TableDataEditorModel.Cell(row: "1", column: "active"))
        model.toggleDelete(model.rows[1])
        model.beginEditing(TableDataEditorModel.Cell(row: "1", column: "name"))
        #expect(model.hasPending)
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The Review pending changes sheet, with the delete warning.
        await model.preview(strings: shell.strings)
        #expect(model.isReviewPresented)
        #expect(model.previewStatements.count == 3)
        #expect(layOut(ReviewChangesSheet(model: model, strings: shell.strings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // Read-only: a table without a primary key.
        let readOnly = TableDataEditorModel(table: "audit_view", service: StaticDatabaseService(readOnly: true))
        await readOnly.appear()
        #expect(readOnly.isReadOnly)
        #expect(layOut(TableDataEditorView(model: readOnly, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    func layOutPlanned(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            PlannedPaymentsView(model: shell.planned, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func thePlannedPaymentsScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(
            language: language, appearance: appearance, planned: StaticPlannedService(rows: StaticPlannedService.sample))
        let model = shell.planned
        // The view's own load reads `show_all` from the route, so the route and the test agree.
        shell.show(try #require(NativeRoute("/planned?show_all=true")))
        // Loading.
        #expect(model.isLoading)
        #expect(layOutPlanned(shell).fittingSize.width > 0)
        // Loaded with paused rows: the strip, Estimated monthly and the table.
        await model.appear(showAll: true, defaultCurrency: "EUR")
        #expect(model.payments.count == 4)
        #expect(model.tablePayments.count == 4)
        #expect(model.strip.dueCount == 2)
        // The static service has no server totals: the figures stay skeletons.
        #expect(model.windowTotal == nil)
        #expect(model.estimatedMonthly == nil)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // Sorted and filtered, then filtered to nothing.
        model.table.toggleSort(PlannedColumn.amount.rawValue)
        model.table.setFilter(PlannedColumn.category.rawValue, to: "hous")
        #expect(model.visibleRows.count == 1)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        model.table.search = "nothing matches"
        #expect(model.emptyState == .noFilterResults)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        model.table.clearAll()
        // The Undo toast.
        await model.toggleActive(model.payments[1])
        #expect(model.undo != nil)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // The Payment history dialog, loading and loaded.
        let theme = VisionTheme(selection: shell.theme)
        #expect(layOut(PlannedHistorySheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await model.history.load(payments: model.payments)
        #expect(model.history.entries.count == 1)
        #expect(layOut(PlannedHistorySheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // No payments at all, and every payment paused.
        let empty = makeShell(language: language, appearance: appearance)
        await empty.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(empty.planned.emptyState == .noPayments)
        #expect(empty.planned.strip.dueCount == 0)
        #expect(layOutPlanned(empty).fittingSize.height > 0)
        let paused = makeShell(
            language: language, appearance: appearance,
            planned: StaticPlannedService(rows: [StaticPlannedService.sample[3]]))
        await paused.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(paused.planned.emptyState == .allPaused || paused.planned.payments.isEmpty)
        #expect(layOutPlanned(paused).fittingSize.height > 0)
        // The error state.
        let failing = makeShell(
            language: language, appearance: appearance, planned: StaticPlannedService(failing: true))
        await failing.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(failing.planned.error != nil)
        #expect(layOutPlanned(failing).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func thePlannedSheetsAndSuggestionsLayOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(
            language: language, appearance: appearance, planned: StaticPlannedService(rows: StaticPlannedService.sample))
        let model = shell.planned
        let theme = VisionTheme(selection: shell.theme)
        shell.show(try #require(NativeRoute("/planned")))
        await model.appear(showAll: false, defaultCurrency: "EUR")
        // The recurring panel before its answer: hidden until the dismissals are known, like the web.
        #expect(model.recurring.display == .hidden)
        #expect(layOut(PlannedRecurringPanel(model: model, strings: shell.strings, settings: shell.settings).environment(\.visionTheme, theme)).fittingSize.width == 0)
        await model.loadSuggestions()
        await model.recurring.load()
        await model.pickers.load()
        #expect(model.suggestions.count == 1)
        #expect(model.recurring.display == .cards)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // Both cards open, then the banner on its own.
        model.recurring.alertsExpanded = true
        model.recurring.patternsExpanded = true
        #expect(layOut(PlannedRecurringPanel(model: model, strings: shell.strings, settings: shell.settings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(PlannedMatchSuggestionsBanner(model: model, strings: shell.strings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // Review opens Mark as paid for the suggestion's payment.
        model.reviewSuggestion()
        let link = try #require(model.link)
        #expect(link.payment.id == 2)
        #expect(layOut(PlannedLinkSheet(model: model, link: link, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await link.resolveCluster()
        await link.load()
        #expect(link.candidates.count == 2)
        link.select(31)
        #expect(link.canExecute)
        #expect(layOut(PlannedLinkSheet(model: model, link: link, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        link.search = "nothing matches"
        #expect(link.visibleCandidates.isEmpty)
        #expect(layOut(PlannedLinkSheet(model: model, link: link, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.dismissLinkDialog()
        // Add payment: blank, after a blocked submit, as a loan and with a custom interval.
        model.openEditor(for: nil, settings: shell.settings)
        let form = try #require(model.editor)
        #expect(layOut(PlannedPaymentFormSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await model.saveEditor(strings: shell.strings)
        #expect(form.errorsRevealed)
        #expect(form.focusField == .name)
        #expect(layOut(PlannedPaymentFormSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        form.isLoan = true
        #expect(layOut(PlannedPaymentFormSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        form.isLoan = false
        form.isRecurring = true
        form.frequency = .custom
        form.tags = ["fixed-costs", "new-tag"]
        form.recipientId = 1
        form.categoryId = 7
        form.pickAccount(name: "BE00 1234", id: 7)
        #expect(layOut(PlannedPaymentFormSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.dismissEditor()
        // Edit payment for a row in another currency.
        model.openEditor(for: model.payments[1], settings: shell.settings)
        let edit = try #require(model.editor)
        #expect(edit.isEditing)
        #expect(layOut(PlannedPaymentFormSheet(model: model, form: edit, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.dismissEditor()
        // Every payee dismissed: all caught up.
        for pattern in model.recurring.allPatterns {
            model.recurring.dismiss(pattern.recipientId)
        }
        await model.recurring.settle()
        #expect(model.recurring.display == .caughtUp)
        #expect(layOut(PlannedRecurringPanel(model: model, strings: shell.strings, settings: shell.settings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
    }

    func layOutTransactions(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            TransactionsView(model: shell.transactions, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theTransactionsScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.transactions
        shell.show(try #require(NativeRoute("/transactions")))
        await shell.settingsSettled()
        // Loading, then loaded with the excluded row hidden.
        #expect(model.isLoading)
        #expect(layOutTransactions(shell).fittingSize.width > 0)
        await model.sync()
        #expect(model.rows?.count == 2)
        #expect(layOutTransactions(shell).fittingSize.height > 0)
        // Show excluded, a row being edited and one selected for Quick Look.
        await model.setShowAll(true)
        #expect(model.rows?.count == 3)
        let first = try #require(model.rows?.first)
        model.startEditing(first)
        model.toggleSelection(first.id)
        #expect(layOutTransactions(shell).fittingSize.height > 0)
        model.cancelEditing()
        model.toggleQuickLook(first.id)
        let quickLook = try #require(model.quickLookRow)
        #expect(layOut(TransactionQuickLookSheet(row: quickLook, model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeQuickLook()
        // The inspector with its tips, tags and attachments, docked and as a sheet.
        model.select(first.id)
        let inspector = try #require(model.inspector)
        await inspector.load(recipientId: first.recipientId)
        await inspector.attachments.load()
        #expect(inspector.attachments.items?.count == 1)
        #expect(layOut(TransactionInspectorView(model: model, inspector: inspector, row: first, shell: shell, docked: true).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(TransactionInspectorView(model: model, inspector: inspector, row: first, shell: shell, docked: false).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(TransactionAttachmentsPanel(model: model, attachments: inspector.attachments, strings: shell.strings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOutTransactions(shell).fittingSize.height > 0)
        // The Add sheet, as an expense and as a transfer with its errors revealed.
        model.requestAdd()
        let form = try #require(model.addForm)
        #expect(layOut(TransactionAddSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        form.setKind(.transfer)
        await model.submitAdd()
        #expect(form.errorsRevealed)
        #expect(layOut(TransactionAddSheet(model: model, form: form, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.dismissAdd()
        // A payee filter with its banner.
        shell.show(try #require(NativeRoute("/transactions?recipient_id=1&uncategorised=true")))
        await model.sync()
        #expect(model.bannerRecipient == .found("Landlord"))
        #expect(layOutTransactions(shell).fittingSize.height > 0)
        // The empty and error states.
        let empty = makeShell(language: language, appearance: appearance, transactions: StaticTransactionsService(rows: []))
        empty.show(try #require(NativeRoute("/transactions")))
        await empty.settingsSettled()
        await empty.transactions.sync()
        #expect(empty.transactions.emptyState == .noTransactions)
        #expect(layOutTransactions(empty).fittingSize.height > 0)
        let failing = makeShell(language: language, appearance: appearance, transactions: StaticTransactionsService(failing: true))
        failing.show(try #require(NativeRoute("/transactions")))
        await failing.settingsSettled()
        await failing.transactions.sync()
        #expect(failing.transactions.error != nil)
        #expect(layOutTransactions(failing).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theSplitSheetBulkBarAndDialogsLayOut(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.transactions
        shell.show(try #require(NativeRoute("/transactions")))
        await shell.settingsSettled()
        await model.sync()
        let rows = try #require(model.rows)
        #expect(rows.count == 2)
        // The Split dialog with the existing split loaded, then as custom amounts.
        model.requestSplit(rows[0])
        let split = try #require(model.splitForm)
        await split.load()
        #expect(split.existing.count == 1)
        #expect(layOut(TransactionSplitSheet(model: model, form: split, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        split.setSplitType(.custom)
        split.addEntry()
        #expect(split.entries.count == 2)
        #expect(layOut(TransactionSplitSheet(model: model, form: split, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.dismissSplit()
        // The bulk bar in the toolbar, and each bulk dialog.
        model.toggleSelection(rows[0].id)
        model.toggleSelection(rows[1].id)
        #expect(model.showsBulkBar)
        #expect(layOut(TransactionBulkBar(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOutTransactions(shell).fittingSize.height > 0)
        for dialog in [TransactionBulkDialog.recategorize, .recipient, .export, .tag, .split] {
            model.openBulkDialog(dialog)
            #expect(model.bulkDialog == dialog)
            #expect(layOut(TransactionBulkDialogView(model: model, dialog: dialog, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
            model.closeBulkDialog()
        }
        // The tags multi-select, empty and with a selection.
        #expect(layOut(TagMultiSelect(pickers: model.pickers, selected: [], strings: shell.strings) { _ in }.environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(TagMultiSelect(pickers: model.pickers, selected: ["fixed-costs"], strings: shell.strings) { _ in }.environment(\.visionTheme, theme)).fittingSize.width > 0)
        model.clearBulkSelection()
        #expect(!model.showsBulkBar)
    }

    func layOutOwes(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            OwesView(model: shell.owes, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theOwesScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.owes
        shell.show(try #require(NativeRoute("/owes")))
        await shell.settingsSettled()
        // Each host stays alive until the end: a released host can fire `.onDisappear`,
        // whose `model.disappear()` would drop the person detail between the awaits and the
        // assertions below.
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        // Loading, then the totals and the people list.
        #expect(model.isLoadingSummary)
        let loadingHost = layOutOwes(shell)
        hosts.append(loadingHost)
        #expect(loadingHost.fittingSize.width > 0)
        await model.appear()
        #expect(model.summary?.count == 1)
        #expect(model.totalOutstanding == Decimal(string: "21.50"))
        let listHost = layOutOwes(shell)
        hosts.append(listHost)
        #expect(listHost.fittingSize.height > 0)
        // The person detail with its splits and Recent transactions.
        let person = try #require(model.summary?.first)
        await model.open(person)
        await model.loadRecent()
        #expect(model.splits?.count == 2)
        #expect(model.recentRows.count == 3)
        let detailHost = layOutOwes(shell)
        hosts.append(detailHost)
        #expect(detailHost.fittingSize.height > 0)
        // Record payment, with the detail re-established right before it is read.
        await model.open(person)
        model.openPayment(try #require(model.splits?.first))
        #expect(model.payment != nil)
        #expect(layOut(OwesPaymentSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closePayment()
        model.back()
        model.disappear()
        // Nobody owes you, and the error card.
        let empty = makeShell(language: language, appearance: appearance, splits: StaticSplitsService(owed: []))
        empty.show(try #require(NativeRoute("/owes")))
        await empty.settingsSettled()
        await empty.owes.appear()
        #expect(empty.owes.summary?.isEmpty == true)
        #expect(layOutOwes(empty).fittingSize.height > 0)
        let failing = makeShell(language: language, appearance: appearance, splits: StaticSplitsService(failing: true))
        failing.show(try #require(NativeRoute("/owes")))
        await failing.settingsSettled()
        await failing.owes.appear()
        #expect(failing.owes.summaryError != nil)
        #expect(layOutOwes(failing).fittingSize.height > 0)
    }

    @Test func theShellShowsTheOwesScreen() async throws {
        let shell = makeShell(language: .en, appearance: .light, adminMode: false)
        let host = layOut(ShellRootView(model: shell))
        shell.show(try #require(NativeRoute("/owes")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.owes))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theShellShowsTheTransactionsScreen() async throws {
        let shell = makeShell(language: .nl, appearance: .dark, adminMode: false)
        let host = layOut(ShellRootView(model: shell))
        shell.show(try #require(NativeRoute("/transactions")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.transactions))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theShellShowsThePlannedScreenWithoutAdminMode() async throws {
        let shell = makeShell(
            language: .en, appearance: .light, planned: StaticPlannedService(rows: StaticPlannedService.sample),
            adminMode: false)
        let host = layOut(ShellRootView(model: shell))
        shell.show(try #require(NativeRoute("/planned?show_all=true")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.plannedPayments))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theShellShowsTheDatabaseScreensForTheirRoutes() async throws {
        let shell = makeShell(language: .nl, appearance: .dark)
        let host = layOut(ShellRootView(model: shell))
        shell.show(try #require(NativeRoute("/admin/db")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.databaseMaintenance))
        host.layoutSubtreeIfNeeded()
        shell.show(try #require(NativeRoute("/admin/db/categories")))
        #expect(shell.detail == .native(.tableEditor(table: "categories")))
        #expect(shell.admin.database.editor?.table == "categories")
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theAdminErrorStatesLayOut() async {
        let shell = makeShell(language: .nl, appearance: .dark, failing: true)
        let theme = VisionTheme(selection: shell.theme)
        await shell.admin.providers.appear()
        #expect(shell.admin.providers.errorState(strings: shell.strings) != nil)
        #expect(layOut(ProviderHealthView(model: shell.admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await shell.admin.overview.appear()
        #expect(layOut(AdminOverviewView(model: shell.admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test func theShellHostsTheNativeScreen() async throws {
        let shell = makeShell(language: .nl, appearance: .light)
        let host = layOut(ShellRootView(model: shell))
        #expect(host.fittingSize.width > 0)
        shell.show(try #require(NativeRoute("/admin/exchange-rates")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.exchangeRates))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test(arguments: [ThemeAppearance.light, .dark])
    func theGlassBackgroundsLayOut(_ appearance: ThemeAppearance) {
        let theme = VisionTheme(selection: ThemeSelection(appearance: appearance))
        #expect(theme.glass == ShellGlass(selection: theme.selection))
        let sidebar = layOut(SidebarGlassBackground().environment(\.visionTheme, theme))
        let detail = layOut(DetailGlassBackground().environment(\.visionTheme, theme))
        #expect(sidebar.frame.width == 1100)
        #expect(detail.frame.width == 1100)
    }

    @Test func themeColoursComeFromTheTokens() {
        let theme = VisionTheme(selection: ThemeSelection(variant: .default, appearance: .dark))
        #expect(theme.isDark && theme.colorScheme == .dark)
        #expect(theme.palette == DesignTokens.palette(.default, .dark))
        #expect(VisionTheme.fallback.colorScheme == .light)
    }

    func layOutImports(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            ImportExportView(model: shell.imports, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theImportScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.imports
        shell.show(try #require(NativeRoute("/import")))
        // Idle, before the lists answer.
        #expect(model.isHistoryLoading)
        #expect(layOutImports(shell).fittingSize.width > 0)
        // Idle with the adapters, the saved parser and a history page.
        await model.appear(strings: shell.strings)
        #expect(model.adapters?.count == 2)
        #expect(model.historyBatches.count == 2)
        #expect(model.historyTotalPages == 3)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // A file and a built-in bank: the detected columns with sample rows.
        model.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        model.selectSource(.adapter("kbc"))
        guard case .loaded(let preview, _) = model.headersPanel else {
            Issue.record("no preview")
            return
        }
        #expect(preview.headers.count == 4)
        #expect(model.canImport)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // The saved parser's summary, then its editor. Each temporary hosting view may run
        // `onDisappear` (`model.disappear()`, which resets the card) when it goes, so every
        // step sets up the file and source it needs again.
        model.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        model.selectSource(.saved(7))
        #expect(model.showsSavedSummary)
        #expect(layOutImports(shell).fittingSize.height > 0)
        model.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        model.selectSource(.saved(7))
        model.startEditing()
        #expect(model.showsEditor)
        #expect(model.mapperHeaders.count == 4)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // A new custom setup with no file: text fields instead of header selects.
        model.removeFile()
        model.selectSource(.custom)
        #expect(model.showsEditor)
        #expect(model.mapperHeaders.isEmpty)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // A custom import's complete panel, then the commit receipt.
        model.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        model.selectSource(.custom)
        model.config.dateColumn = "Datum"
        model.config.recipientColumn = "Naam"
        model.config.amountColumn = "Bedrag"
        model.config.separator = ";"
        await model.startImport(strings: shell.strings)
        #expect(model.progress?.phase == "complete")
        #expect(layOutImports(shell).fittingSize.height > 0)
        model.showCommitReceipt(try #require(ImportCommitReceipt(imported: 37, duplicates: 2, errors: 1, dateFrom: "2026-10-01", dateTo: "2026-10-09")))
        #expect(model.commitReceipt != nil)
        #expect(layOutImports(shell).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theImportScreenLaysOutWhileImportingAndOnErrors(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance, imports: StaticImportService(hangs: true))
        let model = shell.imports
        await model.appear(strings: shell.strings)
        model.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        model.selectSource(.adapter("kbc"))
        // Importing: the progress panel with its counts, and Cancel.
        let running = Task { await model.startImport(strings: shell.strings) }
        while model.progress?.phase != "importing" { await Task.yield() }
        #expect(model.isImporting)
        #expect(model.progress?.showsCounts == true)
        #expect(layOutImports(shell).fittingSize.height > 0)
        model.cancelImport()
        await running.value
        #expect(!model.isImporting)
        #expect(model.notice?.kind == .info)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // An empty history.
        let empty = makeShell(language: language, appearance: appearance, imports: StaticImportService(batches: []))
        await empty.imports.appear(strings: empty.strings)
        #expect(empty.imports.historyBatches.isEmpty)
        #expect(!empty.imports.isHistoryLoading)
        #expect(layOutImports(empty).fittingSize.height > 0)
        // Failing lists and a failed import: the error toast and panel, unreadable columns.
        let failing = makeShell(language: language, appearance: appearance, imports: StaticImportService(failing: true))
        await failing.imports.appear(strings: failing.strings)
        #expect(failing.imports.historyError != nil)
        #expect(failing.imports.adaptersFailed)
        #expect(layOutImports(failing).fittingSize.height > 0)
        failing.imports.chooseFile(ImportFile(name: "afschrift.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        failing.imports.selectSource(.custom)
        failing.imports.config.dateColumn = "Datum"
        failing.imports.config.recipientColumn = "Naam"
        failing.imports.config.amountColumn = "Bedrag"
        failing.imports.config.encoding = "utf-16"
        #expect(failing.imports.headersPanel == .unreadable)
        await failing.imports.startImport(strings: failing.strings)
        #expect(failing.imports.progress?.phase == "error")
        #expect(failing.imports.notice?.key == "importPage.toast.serverError")
        #expect(layOutImports(failing).fittingSize.height > 0)
    }


    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theImportSidebarLaysOutWithFiltersAndReferenceCards(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.imports
        shell.show(try #require(NativeRoute("/import")))
        await model.appear(strings: shell.strings)
        // The export card with its filters open and some picked, then exporting.
        await model.export.toggleFilters()
        #expect(model.export.showsFilters)
        #expect(model.export.bankAccounts.count == 2)
        model.export.filters.startDate = PlannedDay(year: 2026, month: 1, day: 1)
        model.export.toggleBankAccount("Spaarrekening")
        model.export.toggleCategory(7)
        #expect(model.export.filters.categoryIds == [7])
        #expect(layOutImports(shell).fittingSize.height > 0)
        // Setup and reference open: a payee file with its result, the category card, the banks.
        model.toggleSetupReference()
        #expect(model.isSetupReferenceExpanded)
        model.recipientsCSV.chooseFile(ImportFile(name: "begunstigden.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        #expect(layOutImports(shell).fittingSize.height > 0)
        // The hosting view's `onDisappear` may have reset the card: choose the file again.
        model.recipientsCSV.chooseFile(ImportFile(name: "begunstigden.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        await model.recipientsCSV.startImport(strings: shell.strings)
        #expect(model.recipientsCSV.result?.imported == 10)
        model.categoriesCSV.chooseFile(ImportFile(name: "categorieen.csv", data: StaticImportService.csv, mimeType: "text/csv"))
        #expect(layOutImports(shell).fittingSize.height > 0)
        // A narrow window stacks the sidebar under the main column.
        let narrow = NSHostingView(
            rootView: ImportExportView(model: model, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
        narrow.frame = NSRect(x: 0, y: 0, width: 720, height: 760)
        narrow.layoutSubtreeIfNeeded()
        #expect(narrow.fittingSize.height > 0)
        // Loading lists: the Supported banks badge says so.
        let loading = makeShell(language: language, appearance: appearance, imports: StaticImportService(hangs: true))
        loading.imports.toggleSetupReference()
        #expect(loading.imports.isLoadingAdapters)
        #expect(layOutImports(loading).fittingSize.height > 0)
    }

    func layOutReview(_ shell: NativeShellModel, batchId: Int = 13) -> NSHostingView<some View> {
        layOut(
            ImportReviewView(model: shell.imports.review, toasts: shell.imports.toasts, batchId: batchId, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theReviewScreenLaysOutLoadingLoadedOpenAndOnErrors(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let review = shell.imports.review
        shell.show(try #require(NativeRoute("/import/13/review")))
        // Loading.
        #expect(review.isLoading)
        #expect(layOutReview(shell).fittingSize.width > 0)
        // Loaded: the legend, the accounts with a new one, the collapsed groups.
        await review.appear(batchId: 13)
        #expect(review.preview?.groups.count == 3)
        #expect(review.newAccountCount == 2)
        #expect(review.totalRows == 4)
        #expect(layOutReview(shell).fittingSize.height > 0)
        // Every group open, one saving, the discard alert up.
        for group in StaticImportService.preview.groups { review.setExpanded(group, true) }
        review.setPersistDefault(false, for: StaticImportService.preview.groups[0])
        review.requestDiscard()
        #expect(review.isDiscardConfirmationPresented)
        #expect(layOutReview(shell).fittingSize.height > 0)
        review.cancelDiscard()
        // Committing hands the receipt to /import and leaves toasts with an action.
        await review.commit(strings: shell.strings)
        #expect(shell.imports.commitReceipt?.imported == 4)
        #expect(shell.imports.toasts.notices.count == 3)
        #expect(layOutImports(shell).fittingSize.height > 0)
        // The error state with Retry.
        let failing = makeShell(language: language, appearance: appearance, imports: StaticImportService(failing: true))
        await failing.imports.review.appear(batchId: 13)
        #expect(failing.imports.review.showsError)
        #expect(layOutReview(failing).fittingSize.height > 0)
    }

    func layOutAccounts(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            AccountsView(model: shell.accounts, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    func layOutAccount(_ shell: NativeShellModel, _ id: Int) -> NSHostingView<some View> {
        layOut(
            AccountDetailView(model: shell.accounts, shell: shell, accountId: id)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAccountsHubLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.accounts
        shell.show(try #require(NativeRoute("/accounts")))
        await shell.settingsSettled()
        // Each host stays alive until the end, so no `.onDisappear` resets the model early.
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        // Loading, then the groups with subtotals, Net cash and the archived disclosure open.
        #expect(model.isLoading)
        let loadingHost = layOutAccounts(shell)
        hosts.append(loadingHost)
        #expect(loadingHost.fittingSize.width > 0)
        await model.appear(.hub)
        #expect(model.accounts?.count == 3)
        #expect(model.archivedGroup?.accounts.count == 1)
        #expect(model.metrics(StaticAccountsService.sample[1])?.holdingsValue == 4200)
        model.archivedOpen = true
        let loadedHost = layOutAccounts(shell)
        hosts.append(loadedHost)
        #expect(loadedHost.fittingSize.height > 0)
        // The delete confirmation over the hub.
        await model.appear(.hub)
        model.requestDelete(StaticAccountsService.sample[0])
        #expect(model.deleteText() != nil)
        let deleteHost = layOutAccounts(shell)
        hosts.append(deleteHost)
        #expect(deleteHost.fittingSize.height > 0)
        model.cancelDelete()
        // No accounts yet, and the error card with Retry.
        let empty = makeShell(language: language, appearance: appearance, accounts: StaticAccountsService(rows: []))
        empty.show(try #require(NativeRoute("/accounts")))
        await empty.settingsSettled()
        await empty.accounts.appear(.hub)
        #expect(empty.accounts.accounts?.isEmpty == true)
        let emptyHost = layOutAccounts(empty)
        hosts.append(emptyHost)
        #expect(emptyHost.fittingSize.height > 0)
        let failing = makeShell(language: language, appearance: appearance, accounts: StaticAccountsService(failing: true))
        failing.show(try #require(NativeRoute("/accounts")))
        await failing.settingsSettled()
        await failing.accounts.appear(.hub)
        #expect(failing.accounts.accountsError != nil)
        let failingHost = layOutAccounts(failing)
        hosts.append(failingHost)
        #expect(failingHost.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAccountDetailLaysOutWithItsLedger(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.accounts
        shell.show(try #require(NativeRoute("/accounts/1?since=2026-10-01")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.accountDetail(id: 1)))
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        // Loading, then the balance card, the planned card, the ledger with its since banner.
        let loadingHost = layOutAccount(shell, 1)
        hosts.append(loadingHost)
        #expect(loadingHost.fittingSize.width > 0)
        await model.appear(.detail(1))
        #expect(model.detailState(1) == .loaded(StaticAccountsService.sample[0]))
        #expect(model.visibleLedger.count == 2)
        #expect(model.ledgerHasMore)
        #expect(model.plannedRows.count == 1)
        #expect(model.since == "2026-10-01")
        let detailHost = layOutAccount(shell, 1)
        hosts.append(detailHost)
        #expect(detailHost.fittingSize.height > 0)
        // A brokerage account, and an id that does not exist.
        shell.show(try #require(NativeRoute("/accounts/2")))
        await model.appear(.detail(2))
        #expect(model.detailState(2) == .loaded(StaticAccountsService.sample[1]))
        let brokerHost = layOutAccount(shell, 2)
        hosts.append(brokerHost)
        #expect(brokerHost.fittingSize.height > 0)
        shell.show(try #require(NativeRoute("/accounts/99")))
        await model.appear(.detail(99))
        #expect(model.detailState(99) == .notFound)
        let missingHost = layOutAccount(shell, 99)
        hosts.append(missingHost)
        #expect(missingHost.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAccountDialogsLayOut(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.accounts
        shell.show(try #require(NativeRoute("/accounts")))
        await shell.settingsSettled()
        await model.appear(.hub)
        let checking = try #require(model.account(1))
        let broker = try #require(model.account(2))
        // Add and Edit.
        model.openCreate()
        #expect(model.form != nil)
        #expect(layOut(AccountFormSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeForm()
        model.openEdit(checking)
        #expect(model.form != nil)
        #expect(layOut(AccountFormSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeForm()
        // Reconcile, and the opening balance.
        model.openReconcile(checking)
        #expect(model.reconcile != nil)
        #expect(layOut(ReconcileSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeReconcile()
        model.openOpeningBalance(checking)
        #expect(model.opening != nil)
        #expect(layOut(OpeningBalanceSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeOpeningBalance()
        // Merge, with the preview loaded and acknowledged.
        model.openMerge(checking)
        #expect(layOut(MergeAccountSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await model.selectMergeTarget(2)
        #expect(model.merge?.preview?.value?.transactions == 12)
        model.setMergeAcknowledged(true)
        #expect(layOut(MergeAccountSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeMerge()
        // Close: a plain account, then a brokerage with its lots.
        await model.openClose(checking)
        #expect(model.close?.lotPreview == nil)
        #expect(layOut(CloseAccountSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeCloseDialog()
        await model.openClose(broker)
        #expect(model.close?.lotPreview?.value?.eligibleCount == 3)
        model.setCloseLotChoice(.unassigned)
        #expect(layOut(CloseAccountSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeCloseDialog()
        // Transfer lots.
        await model.openTransfer(broker)
        #expect(model.transfer?.preview.value?.eligibleCount == 3)
        model.setTransferDestination(.unassigned)
        #expect(layOut(BrokerTransferSheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        model.closeTransfer()
    }

    @Test func theShellShowsTheAccountsScreens() async throws {
        let shell = makeShell(language: .nl, appearance: .dark, adminMode: false)
        let host = layOut(ShellRootView(model: shell))
        shell.show(try #require(NativeRoute("/accounts")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.accounts))
        host.layoutSubtreeIfNeeded()
        shell.show(try #require(NativeRoute("/accounts/1")))
        #expect(shell.detail == .native(.accountDetail(id: 1)))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }
}

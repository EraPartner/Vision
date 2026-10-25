import Foundation
import Testing
@testable import VisionNativeCore

/// An Import & export service over in-memory lists that records every call.
actor FakeImportService: ImportService {
    private(set) var adapterCalls = 0
    private(set) var parserCalls = 0
    private(set) var created: [CSVParserDraft] = []
    private(set) var updated: [Int] = []
    private(set) var deleted: [Int] = []
    private(set) var streamed: [String] = []
    private(set) var customs: [String] = []
    private(set) var customConfigs: [CSVParserConfig] = []
    private(set) var historyOffsets: [Int] = []
    private(set) var rollbacks: [Int] = []
    private var adapters: [ImportAdapter]
    private var parsers: [OpenAPI.CustomParserConfig]
    private var batches: [OpenAPI.ImportBatch]
    private var adaptersFail = false
    private var saveFails = false
    private var deleteFails = false
    private var historyFails = false
    private var rollbackFails = false
    private var streamProgress: [ImportProgress] = []
    private var streamResult: Result<ImportOutcome, any Error> = .success(.completed(ImportFixture.completion))
    private var customResult: Result<ImportOutcome, any Error> = .success(.completed(ImportFixture.completion))
    private var streamGate: CallGate?
    private var nextId = 100

    init(
        adapters: [ImportAdapter] = ImportFixture.adapters, parsers: [OpenAPI.CustomParserConfig] = [],
        batches: [OpenAPI.ImportBatch] = []
    ) {
        self.adapters = adapters
        self.parsers = parsers
        self.batches = batches
    }

    func failAdapters(_ fail: Bool) { adaptersFail = fail }
    func failSaves(_ fail: Bool) { saveFails = fail }
    func failDeletes(_ fail: Bool) { deleteFails = fail }
    func failHistory(_ fail: Bool) { historyFails = fail }
    func failRollbacks(_ fail: Bool) { rollbackFails = fail }
    func setBatches(_ list: [OpenAPI.ImportBatch]) { batches = list }
    func holdStream(_ gate: CallGate?) { streamGate = gate }

    func scriptStream(_ progress: [ImportProgress], _ result: Result<ImportOutcome, any Error>) {
        streamProgress = progress
        streamResult = result
    }

    func scriptCustom(_ result: Result<ImportOutcome, any Error>) { customResult = result }

    func supportedAdapters() async throws -> [ImportAdapter] {
        adapterCalls += 1
        if adaptersFail { throw APIError.network("offline") }
        return adapters
    }

    func customParsers() async throws -> [OpenAPI.CustomParserConfig] {
        parserCalls += 1
        return parsers
    }

    func createCustomParser(name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig {
        if saveFails { throw APIError.client(APIClientError(status: 409, code: .conflict, message: "Name taken")) }
        created.append(CSVParserDraft(name: name, config: config))
        nextId += 1
        let parser = OpenAPI.CustomParserConfig(id: nextId, name: name, config: config.payload)
        parsers.append(parser)
        return parser
    }

    func updateCustomParser(id: Int, name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig {
        if saveFails { throw APIError.network("offline") }
        updated.append(id)
        let parser = OpenAPI.CustomParserConfig(id: id, name: name, config: config.payload)
        parsers = parsers.map { existing in existing.id == id ? parser : existing }
        return parser
    }

    func deleteCustomParser(id: Int) async throws {
        if deleteFails { throw APIError.network("offline") }
        deleted.append(id)
        parsers.removeAll { parser in parser.id == id }
    }

    func importStream(
        file: ImportFile, bankName: String, onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> ImportOutcome {
        streamed.append(bankName)
        for progress in streamProgress { await onProgress(progress) }
        if let streamGate {
            await streamGate.wait()
            try Task.checkCancellation()
        }
        return try streamResult.get()
    }

    func importCustom(file: ImportFile, bankName: String, config: CSVParserConfig) async throws -> ImportOutcome {
        customs.append(bankName)
        customConfigs.append(config)
        return try customResult.get()
    }

    func importBatches(limit: Int, offset: Int) async throws -> ImportBatchPage {
        historyOffsets.append(offset)
        if historyFails { throw APIError.network("offline") }
        let page = Array(batches.dropFirst(offset).prefix(limit))
        return ImportBatchPage(total: batches.count, limit: limit, offset: offset, items: page)
    }

    func rollbackImportBatch(id: Int) async throws -> Int {
        if rollbackFails { throw APIError.network("offline") }
        rollbacks.append(id)
        return 3
    }
}

/// A clock the tests move by hand.
final class ImportClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_791_000_000)

    var now: Date { lock.withLock { current } }

    func advance(_ seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

enum ImportFixture {
    static let strings = DictionaryStrings(language: .en, table: [:])
    static let completion = ImportCompletion(total: 10, imported: 8, duplicates: 2, errors: 0, batchId: 5)
    static let adapters = [
        ImportAdapter(key: "kbc", name: "KBC", adapterClass: "KbcAdapter"),
        ImportAdapter(key: "belfius", name: "Belfius", adapterClass: "BelfiusAdapter"),
    ]
    static let csv = Data("Datum;Naam;Bedrag;Omschrijving\n2026-10-01;Bakery;-4,50;Bread\n2026-10-02;Employer;2500,00;Salary\n".utf8)

    static func file(_ name: String = "kbc.csv", mimeType: String? = "text/csv") -> ImportFile {
        ImportFile(name: name, data: csv, mimeType: mimeType)
    }

    static var mapped: CSVParserConfig {
        var config = CSVParserConfig()
        config.dateColumn = "Datum"
        config.recipientColumn = "Naam"
        config.amountColumn = "Bedrag"
        config.separator = ";"
        return config
    }

    static let savedParser = OpenAPI.CustomParserConfig(
        id: 7, name: "Savings bank",
        config: OpenAPI.TransactionParserConfig(
            dateColumn: "Datum", recipientColumn: "Naam", amountColumn: "Bedrag", separator: ";", skipRows: 1,
            numberFormat: .decimalComma))

    static func batch(
        _ id: Int, status: String = "complete", remaining: Int = 4, file: String? = nil
    ) -> OpenAPI.ImportBatch {
        OpenAPI.ImportBatch(
            id: String(id), adapterName: "kbc", sourceFilename: file, status: status, rowsTotal: 5, rowsImported: 4,
            rowsDuplicate: 1, rowsError: 0, startedAt: "2026-10-12T08:30:00.000Z", transactionsRemaining: remaining)
    }

    static func batches(_ count: Int) -> [OpenAPI.ImportBatch] {
        (1...max(1, count)).prefix(count).map { id in batch(id) }
    }

    @MainActor
    static func model(
        _ service: FakeImportService = FakeImportService(), clock: ImportClock = ImportClock(),
        exports: FakeImportExportService = FakeImportExportService(),
        review: FakeImportReviewService = FakeImportReviewService(),
        pickers: FakePickerService = FakePickerService()
    ) -> ImportsModel {
        ImportsModel(
            service: service, exports: exports, review: review, pickers: pickers, now: { clock.now },
            calendar: ImportFixture.calendar)
    }

    /// A fixed Brussels calendar, so the export's day does not depend on the runner.
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Brussels") ?? .gmt
        return calendar
    }()

    @MainActor
    static func idleModel() -> ImportsModel {
        model()
    }
}

@MainActor
@Suite struct ImportsModelTests {
    @Test func appearingLoadsTheAdaptersTheSavedParsersAndTheFirstHistoryPage() async {
        let service = FakeImportService(parsers: [ImportFixture.savedParser], batches: ImportFixture.batches(12))
        let model = ImportFixture.model(service)
        #expect(model.isLoadingAdapters)
        #expect(model.isHistoryLoading)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.adapters?.count == 2)
        #expect(model.savedParsers?.count == 1)
        #expect(model.historyBatches.count == 10)
        #expect(model.historyTotalPages == 2)
        #expect(model.historyCurrentPage == 1)
        #expect(model.canShowNextPage)
        #expect(!model.canShowPreviousPage)
        // Fresh answers are reused when the page shows again.
        model.disappear()
        await model.appear(strings: ImportFixture.strings)
        #expect(await service.adapterCalls == 1)
        #expect(await service.parserCalls == 1)
        #expect(await service.historyOffsets == [0])
    }

    @Test func staleListsLoadAgainButTheAdaptersStayLoaded() async {
        let service = FakeImportService(batches: ImportFixture.batches(3))
        let clock = ImportClock()
        let model = ImportFixture.model(service, clock: clock)
        await model.appear(strings: ImportFixture.strings)
        clock.advance(61)
        model.disappear()
        await model.appear(strings: ImportFixture.strings)
        #expect(await service.adapterCalls == 1)
        #expect(await service.parserCalls == 2)
        #expect(await service.historyOffsets == [0, 0])
    }

    @Test func aFailedAdapterLoadToastsAndTheNextAppearanceAsksAgain() async {
        let service = FakeImportService()
        await service.failAdapters(true)
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.adaptersFailed)
        #expect(!model.isLoadingAdapters)
        #expect(model.notice?.key == "importPage.toast.parsersError")
        #expect(model.notice?.kind == .error)
        await service.failAdapters(false)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.adapters?.count == 2)
        #expect(!model.adaptersFailed)
    }

    @Test func concurrentAppearancesShareTheAdapterRequest() async {
        let service = FakeImportService()
        let model = ImportFixture.model(service)
        let first = Task { await model.loadAdapters(strings: ImportFixture.strings) }
        let second = Task { await model.loadAdapters(strings: ImportFixture.strings) }
        await first.value
        await second.value
        #expect(await service.adapterCalls == 1)
    }

    @Test func onlyACSVFileIsTakenAndAChosenFileHoldsTheNavigation() {
        let model = ImportFixture.model()
        model.chooseFile(ImportFixture.file("notes.txt", mimeType: "text/plain"))
        #expect(model.file == nil)
        #expect(model.notice?.key == "importPage.toast.noFile")
        #expect(!model.hasUnsavedChanges)
        let file = ImportFixture.file("EXPORT.CSV", mimeType: nil)
        model.chooseFile(file)
        #expect(model.file == file)
        #expect(model.hasUnsavedChanges)
        #expect(model.leaveGuard.id == ImportRoutes.path)
        #expect(model.leaveGuard.hasUnsavedChanges())
        model.removeFile()
        #expect(model.file == nil)
        #expect(!model.hasUnsavedChanges)
    }

    @Test func discardingFromTheLeaveAlertResetsTheCard() {
        let model = ImportFixture.model()
        model.chooseFile(ImportFixture.file())
        model.selectSource(.custom)
        model.parserName = "Draft"
        #expect(model.isParserDirty)
        model.leaveGuard.discard()
        #expect(model.file == nil)
        #expect(model.source == nil)
        #expect(model.parserName.isEmpty)
        #expect(!model.hasUnsavedChanges)
    }

    @Test func aHandedOffFilePrefillsTheCardWithinThirtySeconds() async {
        let clock = ImportClock()
        let model = ImportFixture.model(clock: clock)
        let file = ImportFixture.file()
        model.handoff(file)
        #expect(model.file == nil)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.file == file)
        #expect(model.source == nil)
        // While the page shows, the file lands at once.
        let next = ImportFixture.file("other.csv")
        model.handoff(next)
        #expect(model.file == next)
        // An old handoff is dropped.
        model.disappear()
        model.handoff(ImportFixture.file("late.csv"))
        clock.advance(31)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.file == nil)
        // A file that is not a CSV is never handed over.
        model.handoff(ImportFixture.file("notes.txt", mimeType: nil))
        #expect(model.file == nil)
    }

    @Test func anUnreadableFileIsRefusedLikeAFileThatIsNotACSV() {
        let model = ImportFixture.model()
        model.fileUnreadable()
        #expect(model.file == nil)
        #expect(model.notice?.key == "importPage.toast.noFile")
        model.recipientsCSV.fileUnreadable()
        #expect(model.recipientsCSV.file == nil)
        #expect(model.toasts.notices.map { notice in notice.key } == ["importPage.toast.noFile", "importPage.toast.noFile"])
    }

    @Test func aSavedParserLoadsItsSetupAndCustomStartsBlank() async {
        let service = FakeImportService(parsers: [ImportFixture.savedParser])
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.selectSource(.adapter("kbc"))
        #expect(model.resolvedBank == "kbc")
        #expect(!model.isCustomLike)
        #expect(!model.showsEditor)
        model.selectSource(.saved(7))
        #expect(model.showsSavedSummary)
        #expect(!model.showsEditor)
        #expect(model.parserName == "Savings bank")
        #expect(model.config.separator == ";")
        #expect(model.config.skipRows == 1)
        #expect(model.config.numberFormat == .decimalComma)
        #expect(model.config.dateFormat == "%Y-%m-%d")
        #expect(model.resolvedBank == "Savings bank")
        #expect(!model.isParserDirty)
        let rows = model.summaryRows(ImportFixture.strings)
        #expect(rows.count == 7)
        #expect(rows[3].value == "—")
        #expect(rows[6].value == "importPage.numberFormat.decimal_comma")
        model.selectSource(.custom)
        #expect(model.showsEditor)
        #expect(model.config == CSVParserConfig())
        #expect(model.parserName.isEmpty)
        #expect(model.resolvedBank == "generic")
        model.parserName = "Mine"
        #expect(model.resolvedBank == "Mine")
    }

    @Test func savingNeedsANameAndTheThreeRequiredColumns() async {
        let service = FakeImportService()
        let model = ImportFixture.model(service)
        model.selectSource(.custom)
        #expect(!model.canSaveParser)
        await model.saveParser(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.customParser.nameRequired")
        model.parserName = "  My bank "
        await model.saveParser(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.noConfig")
        #expect(await service.created.isEmpty)
        model.config = ImportFixture.mapped
        #expect(model.canSaveParser)
        await model.saveParser(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.customParser.saved")
        #expect(model.notice?.kind == .success)
        #expect(await service.created == [CSVParserDraft(name: "My bank", config: ImportFixture.mapped)])
        #expect(model.source == .saved(101))
        #expect(model.showsSavedSummary)
        #expect(model.savedParsers?.count == 1)
        #expect(model.hintKey == "importPage.hint.file")
        // The baseline now matches what was saved, with the trimmed name.
        model.parserName = "My bank"
        #expect(!model.isParserDirty)
    }

    @Test func editingASavedParserUpdatesItOrCancelsBack() async {
        let service = FakeImportService(parsers: [ImportFixture.savedParser])
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.selectSource(.saved(7))
        model.startEditing()
        #expect(model.showsEditor)
        #expect(!model.showsSavedSummary)
        model.config.memoColumn = "Omschrijving"
        #expect(model.isParserDirty)
        #expect(model.hasUnsavedChanges)
        model.cancelEditing()
        #expect(model.config.memoColumn.isEmpty)
        #expect(!model.isParserDirty)
        #expect(model.showsSavedSummary)
        model.startEditing()
        model.parserName = "Savings bank 2"
        await model.saveParser(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.customParser.updated")
        #expect(await service.updated == [7])
        #expect(model.showsSavedSummary)
        #expect(model.selectedParser?.name == "Savings bank 2")
        #expect(!model.isParserDirty)
    }

    @Test func aFailedSaveToastsWithTheServerMessageAndKeepsTheEdits() async {
        let service = FakeImportService()
        await service.failSaves(true)
        let model = ImportFixture.model(service)
        model.selectSource(.custom)
        model.parserName = "Mine"
        model.config = ImportFixture.mapped
        await model.saveParser(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.customParser.saveFailed")
        #expect(model.notice?.detail == "Name taken")
        #expect(model.source == .custom)
        #expect(model.isParserDirty)
        #expect(!model.isSavingParser)
    }

    @Test func deletingASavedParserAsksFirst() async {
        let service = FakeImportService(parsers: [ImportFixture.savedParser])
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.selectSource(.saved(7))
        model.requestParserDelete()
        #expect(model.pendingParserDelete?.id == 7)
        model.cancelParserDelete()
        #expect(model.pendingParserDelete == nil)
        await model.confirmParserDelete(strings: ImportFixture.strings)
        #expect(await service.deleted.isEmpty)
        await service.failDeletes(true)
        model.requestParserDelete()
        await model.confirmParserDelete(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.customParser.deleteFailed")
        #expect(model.source == .saved(7))
        await service.failDeletes(false)
        model.requestParserDelete()
        await model.confirmParserDelete(strings: ImportFixture.strings)
        #expect(await service.deleted == [7])
        #expect(model.notice?.key == "importPage.customParser.deleted")
        #expect(model.source == nil)
        #expect(model.savedParsers?.isEmpty == true)
        #expect(model.config == CSVParserConfig())
    }

    @Test func theHintNamesWhatStillBlocksTheImport() async {
        let model = ImportFixture.model()
        #expect(model.hintKey == "importPage.hint.file")
        #expect(!model.canImport)
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.noFileSel")
        model.chooseFile(ImportFixture.file())
        #expect(model.hintKey == "importPage.hint.bank")
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.noBank")
        model.selectSource(.custom)
        #expect(model.hintKey == "importPage.hint.mapping")
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.noConfig")
        model.config = ImportFixture.mapped
        #expect(model.hintKey == nil)
        #expect(model.canImport)
    }

    @Test func aBankImportStreamsItsProgressThenToastsAndResets() async {
        let service = FakeImportService(batches: ImportFixture.batches(2))
        await service.scriptStream(
            [ImportProgress(phase: "parsing", percent: 5), ImportProgress(phase: "importing", current: 3, total: 10, percent: 30)],
            .success(.completed(ImportFixture.completion)))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        await model.startImport(strings: ImportFixture.strings)
        #expect(await service.streamed == ["kbc"])
        #expect(model.notice?.key == "importPage.toast.importSuccess")
        #expect(model.notice?.variables == ["n": "8", "dups": "2", "total": "10"])
        #expect(!model.isImporting)
        #expect(model.file == nil)
        #expect(model.source == nil)
        // The panel keeps the last progress the stream reported.
        #expect(model.progress?.phase == "importing")
        #expect(await service.historyOffsets == [0, 0])
    }

    @Test func aParkedImportOpensItsReviewWithoutTheLeaveAlert() async {
        let service = FakeImportService()
        await service.scriptStream([], .success(.reviewRequired(batchId: 42)))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.navigationRequest == "/import/42/review")
        #expect(!model.hasUnsavedChanges)
        model.didHandleNavigation()
        #expect(model.navigationRequest == nil)
        #expect(model.hasUnsavedChanges)
    }

    @Test func aReviewRequestThePageNeverPerformedIsDroppedWhenItGoes() async {
        let service = FakeImportService()
        await service.scriptStream([], .success(.reviewRequired(batchId: 42)))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.navigationRequest == "/import/42/review")
        // The page went before its view performed the navigation.
        model.disappear()
        #expect(model.navigationRequest == nil)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        #expect(model.hasUnsavedChanges)
    }

    @Test func aParkedImportThatEndsOffThePageToastsResumeReview() async {
        let service = FakeImportService()
        let gate = CallGate()
        await service.holdStream(gate)
        await service.scriptStream([ImportProgress(phase: "parsing", percent: 5)], .success(.reviewRequired(batchId: 42)))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        let running = Task { await model.startImport(strings: ImportFixture.strings) }
        while model.progress?.phase != "parsing" { await Task.yield() }
        // The user leaves `/import` while the import runs.
        model.disappear()
        gate.open()
        await running.value
        #expect(model.navigationRequest == nil)
        #expect(!model.isImporting)
        #expect(model.file == nil)
        let notice = model.notice
        #expect(notice?.key == "importHistory.status.awaiting_review")
        #expect(notice?.kind == .info)
        let action = notice.flatMap { shown in model.toasts.action(for: shown.id) }
        #expect(action?.route == "/import/42/review")
        #expect(action?.titleKey == "importHistory.resumeReview")
        // Back on the page the leave guard works again.
        await model.appear(strings: ImportFixture.strings)
        #expect(!model.hasUnsavedChanges)
        model.chooseFile(ImportFixture.file())
        #expect(model.hasUnsavedChanges)
    }

    @Test func aFileHandedOffDuringAnImportWaitsUntilItEnds() async {
        let service = FakeImportService()
        let gate = CallGate()
        await service.holdStream(gate)
        await service.scriptStream([ImportProgress(phase: "parsing", percent: 5)], .success(.completed(ImportFixture.completion)))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        let first = ImportFixture.file()
        model.chooseFile(first)
        model.selectSource(.adapter("kbc"))
        let running = Task { await model.startImport(strings: ImportFixture.strings) }
        while model.progress?.phase != "parsing" { await Task.yield() }
        let next = ImportFixture.file("next.csv")
        model.handoff(next)
        // The running import keeps its card.
        #expect(model.file == first)
        gate.open()
        await running.value
        #expect(model.notice?.key == "importPage.toast.importSuccess")
        #expect(model.source == nil)
        // The finished import reset the card, then the waiting file pre-filled it.
        #expect(model.file == next)
    }

    @Test func aStreamErrorToastsItsDetailAndKeepsTheFile() async {
        let service = FakeImportService()
        await service.scriptStream(
            [ImportProgress(phase: "parsing", percent: 5)], .failure(ImportStreamFailure(detail: "No rows found")))
        let model = ImportFixture.model(service)
        let file = ImportFixture.file()
        model.chooseFile(file)
        model.selectSource(.adapter("kbc"))
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.serverError")
        #expect(model.notice?.detail == "No rows found")
        #expect(model.progress?.phase == "error")
        #expect(!model.isImporting)
        #expect(model.file == file)
        #expect(model.canImport)
        // A machine sentence is not shown as is.
        await service.scriptStream([], .failure(ImportStreamFailure(detail: "Request failed")))
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.detail == "apiError.unknown")
    }

    @Test func cancelAbortsTheStreamAndSaysSoOnce() async {
        let service = FakeImportService()
        let gate = CallGate()
        await service.holdStream(gate)
        await service.scriptStream([ImportProgress(phase: "parsing", percent: 5)], .success(.completed(ImportFixture.completion)))
        let model = ImportFixture.model(service)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        let running = Task { await model.startImport(strings: ImportFixture.strings) }
        while model.progress?.phase != "parsing" { await Task.yield() }
        #expect(model.isImporting)
        #expect(!model.canImport)
        #expect(model.hasUnsavedChanges)
        model.cancelImport()
        #expect(!model.isImporting)
        #expect(model.progress == nil)
        #expect(model.notice?.key == "importPage.toast.importCancelled")
        #expect(model.notice?.kind == .info)
        gate.open()
        await running.value
        #expect(model.notice?.key == "importPage.toast.importCancelled")
        #expect(model.file != nil)
    }

    @Test func aCustomImportIsOneRequestWithTheSetup() async {
        let service = FakeImportService()
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.custom)
        model.config = ImportFixture.mapped
        // Cancel has nothing to abort on this path.
        model.cancelImport()
        #expect(model.notice == nil)
        await model.startImport(strings: ImportFixture.strings)
        #expect(await service.customs == ["generic"])
        #expect(await service.customConfigs == [ImportFixture.mapped])
        #expect(await service.streamed.isEmpty)
        #expect(model.progress == ImportProgress(
            phase: "complete", current: 10, total: 10, imported: 8, duplicates: 2, errors: 0, percent: 100))
        #expect(model.notice?.key == "importPage.toast.importSuccess")
        #expect(model.source == nil)
        await service.scriptCustom(.success(.reviewRequired(batchId: 9)))
        model.chooseFile(ImportFixture.file())
        model.selectSource(.custom)
        model.config = ImportFixture.mapped
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.navigationRequest == "/import/9/review")
        await service.scriptCustom(.failure(APIError.client(APIClientError(status: 400, code: .validationError, message: "Bad date format"))))
        model.didHandleNavigation()
        await model.startImport(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importPage.toast.serverError")
        #expect(model.notice?.detail == "Bad date format")
    }

    @Test func historyPagesForwardAndBackReusingFreshPages() async {
        let service = FakeImportService(batches: ImportFixture.batches(25))
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.historyTotalPages == 3)
        await model.showNextPage(strings: ImportFixture.strings)
        #expect(model.historyCurrentPage == 2)
        #expect(model.historyBatches.first?.id == "11")
        await model.showNextPage(strings: ImportFixture.strings)
        #expect(model.historyBatches.count == 5)
        #expect(!model.canShowNextPage)
        await model.showNextPage(strings: ImportFixture.strings)
        #expect(model.historyCurrentPage == 3)
        await model.showPreviousPage(strings: ImportFixture.strings)
        #expect(model.historyCurrentPage == 2)
        #expect(await service.historyOffsets == [0, 10, 20])
        await model.refreshHistory(strings: ImportFixture.strings)
        #expect(await service.historyOffsets == [0, 10, 20, 10])
        // Leaving returns to the first page.
        model.disappear()
        #expect(model.historyCurrentPage == 1)
    }

    @Test func aFailedHistoryLoadToastsAndShowsTheError() async {
        let service = FakeImportService()
        await service.failHistory(true)
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        #expect(model.historyError == .network("offline"))
        #expect(!model.isHistoryLoading)
        #expect(model.notice?.key == "importHistory.loadFailed")
        await service.failHistory(false)
        await service.setBatches([])
        await model.refreshHistory(strings: ImportFixture.strings)
        #expect(model.historyError == nil)
        #expect(model.historyBatches.isEmpty)
        #expect(model.historyTotalPages == 0)
    }

    @Test func rollingBackAskedFirstThenRefreshesTheHistory() async {
        let service = FakeImportService(batches: [
            ImportFixture.batch(3), ImportFixture.batch(4, status: "awaiting_review"), ImportFixture.batch(5, remaining: 0),
        ])
        let model = ImportFixture.model(service)
        await model.appear(strings: ImportFixture.strings)
        let batches = model.historyBatches
        #expect(batches[0].canRollBack)
        #expect(!batches[0].canResumeReview)
        #expect(batches[1].canResumeReview)
        #expect(!batches[1].canRollBack)
        #expect(!batches[2].canRollBack)
        model.requestRollback(batches[1])
        #expect(model.pendingRollback == nil)
        model.requestRollback(batches[0])
        #expect(model.pendingRollback?.id == "3")
        model.cancelRollback()
        #expect(model.pendingRollback == nil)
        model.requestRollback(batches[0])
        await model.confirmRollback(strings: ImportFixture.strings)
        #expect(await service.rollbacks == [3])
        #expect(model.notice?.key == "importHistory.rollbackSuccess")
        #expect(model.notice?.variables == ["n": "3"])
        #expect(model.rollingBack.isEmpty)
        #expect(await service.historyOffsets == [0, 0])
        await service.failRollbacks(true)
        model.requestRollback(batches[0])
        await model.confirmRollback(strings: ImportFixture.strings)
        #expect(model.notice?.key == "importHistory.rollbackFailed")
    }

    @Test func theColumnsPanelFollowsTheBankOrTheCustomSetup() {
        let model = ImportFixture.model()
        #expect(model.headersPanel == .hidden)
        model.chooseFile(ImportFixture.file())
        model.selectSource(.adapter("kbc"))
        guard case .loaded(let sniffed, let separator) = model.headersPanel else {
            Issue.record("no preview")
            return
        }
        #expect(separator == ";")
        #expect(sniffed.headers == ["Datum", "Naam", "Bedrag", "Omschrijving"])
        #expect(sniffed.rows.count == 2)
        #expect(model.isSampleRowsExpanded)
        #expect(model.highlightedHeaders.isEmpty)
        model.selectSource(.custom)
        #expect(!model.isSampleRowsExpanded)
        // The custom setup's comma does not split this file.
        #expect(model.mapperHeaders == ["Datum;Naam;Bedrag;Omschrijving"])
        model.config.separator = ";"
        model.config.dateColumn = "Datum"
        #expect(model.mapperHeaders.count == 4)
        #expect(model.highlightedHeaders == ["Datum"])
        model.setSampleRowsExpanded(true)
        #expect(model.isSampleRowsExpanded)
        model.config.encoding = "utf-16"
        #expect(model.headersPanel == .unreadable)
        #expect(model.mapperHeaders.isEmpty)
    }

    @Test func theCommitReceiptShowsUntilDismissedOrLeft() {
        let model = ImportFixture.model()
        let receipt = ImportCommitReceipt(imported: 3, duplicates: 1, errors: 0, dateFrom: "2026-10-01", dateTo: "2026-10-09")
        model.showCommitReceipt(receipt!)
        #expect(model.commitReceipt == receipt)
        model.dismissCommitReceipt()
        #expect(model.commitReceipt == nil)
        model.showCommitReceipt(receipt!)
        model.disappear()
        #expect(model.commitReceipt == nil)
    }
}

@Suite struct ImportValueTests {
    @Test func reviewRoutesTakeOnlyPositiveWholeBatchIds() {
        #expect(ImportRoutes.reviewPath(12) == "/import/12/review")
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/12/review") == 12)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/0/review") == nil)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/-1/review") == nil)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/1e3/review") == nil)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/12/review/x") == nil)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/review") == nil)
        #expect(ImportRoutes.reviewBatchId(forPath: "/import/١٢/review") == nil)
    }

    @Test func importAndItsReviewAreNativeScreensForEveryone() {
        #expect(NativeScreen.screen(forPath: "/import") == .importExport)
        #expect(!NativeScreen.importExport.requiresAdmin)
        #expect(NativeScreen.importExport.path == "/import")
        #expect(NativeScreen.importReview(batchId: 4).path == "/import/4/review")
        #expect(!NativeScreen.importReview(batchId: 4).requiresAdmin)
        let review: NativeScreen? = ImportRoutes.reviewIsNative ? .importReview(batchId: 4) : nil
        #expect(NativeScreen.screen(forPath: "/import/4/review") == review)
        #expect(NativeScreen.screen(forPath: "/import/x") == nil)
    }

    @Test func skipRowsReadsLikeParseInt() {
        #expect(CSVParserConfig.skipRows(from: "3") == 3)
        #expect(CSVParserConfig.skipRows(from: " 12abc") == 12)
        #expect(CSVParserConfig.skipRows(from: "-2") == 0)
        #expect(CSVParserConfig.skipRows(from: "abc") == 0)
        #expect(CSVParserConfig.skipRows(from: "") == 0)
        #expect(CSVParserConfig.skipRows(from: "+4") == 4)
    }

    @Test func aSavedSetupOverridesOnlyTheKeysItStores() {
        let config = CSVParserConfig(saved: OpenAPI.TransactionParserConfig(dateColumn: "D", encoding: "latin1"))
        #expect(config.dateColumn == "D")
        #expect(config.encoding == "latin1")
        #expect(config.separator == ",")
        #expect(config.dateFormat == "%Y-%m-%d")
        #expect(!config.hasRequiredMapping)
        #expect(config.payload.skipRows == 0)
        #expect(CSVFormatOptions.selectedEncoding("latin-1") == "latin1")
        #expect(CSVSeparator.symbol("\t") == "⇥")
        #expect(CSVSeparator.labelKey("|") == "importPage.sep.pipe")
        #expect(CSVSeparator.detect("a;b;c") == ";")
        #expect(CSVSeparator.detect("a,b;c") == ",")
        #expect(CSVSeparator.detect("a\tb\tc") == "\t")
        #expect(CSVSeparator.detect("single") == ",")
    }

    @Test func fileSizesAndTypesReadLikeTheWebCard() {
        let file = ImportFile(name: "a.CSV", data: Data(count: 1536))
        #expect(file.sizeInKilobytes == "1.5")
        #expect(file.isCSV)
        #expect(ImportFile.isCSV(name: "export", mimeType: "text/csv"))
        #expect(!ImportFile.isCSV(name: "export.xlsx", mimeType: nil))
    }

    @Test func progressPhasesLabelOnlyTheWebPhases() {
        #expect(ImportProgress(phase: "counting").labelKey == "importPage.analyzing")
        #expect(ImportProgress(phase: "parsing").labelKey == "importPage.parsingCSV")
        #expect(ImportProgress(phase: "importing").labelKey == "importPage.importingTxns")
        #expect(ImportProgress.connecting.labelKey == "importPage.connecting")
        #expect(ImportProgress(phase: "committing").labelKey == nil)
        #expect(ImportProgress(phase: "importing", total: 4).showsCounts)
        #expect(!ImportProgress(phase: "parsing", total: 4).showsCounts)
        #expect(ImportProgress(phase: "x", percent: 140).fraction == 1)
        #expect(ImportProgress(phase: "x", percent: -3).fraction == 0)
    }

    @Test func theReceiptValidatesItsCountsAndDates() {
        #expect(ImportCommitReceipt(imported: -1, duplicates: 0, errors: 0) == nil)
        let receipt = ImportCommitReceipt(imported: 2, duplicates: 0, errors: 0, dateFrom: "2026-10-01", dateTo: "10/09/2026")
        #expect(receipt?.dateTo == nil)
        #expect(receipt?.transactionsRoute(filterLabel: "Imported") == "/transactions?start_date=2026-10-01&filter_label=Imported")
        let plain = ImportCommitReceipt(imported: 2, duplicates: 0, errors: 0)
        #expect(plain?.transactionsRoute(filterLabel: "Imported") == "/transactions")
    }

    @Test func batchesReadTheirStatusTitleAndStart() throws {
        let batch = ImportFixture.batch(9)
        #expect(batch.title(DictionaryStrings(language: .en, table: ["importHistory.batchFallback": "Batch #{id}"])) == "Batch #9")
        #expect(ImportFixture.batch(9, file: "kbc.csv").title(ImportFixture.strings) == "kbc.csv")
        #expect(batch.numericId == 9)
        #expect(batch.startedText(timeZone: try #require(TimeZone(identifier: "Europe/Brussels"))) == "2026-10-12 10:30")
        #expect(ImportBatchStatus.labelKey("awaiting_review") == "importHistory.status.awaiting_review")
        #expect(ImportBatchStatus.tone("failed") == .destructive)
        #expect(ImportBatchStatus.tone("complete") == .primary)
        #expect(ImportBatchStatus.tone("aborted") == .outline)
        #expect(ImportBatchStatus.tone("awaiting_review") == .secondary)
    }
}

@Suite struct CSVPreviewTests {
    @Test func readsTheHeaderAndUpToFiveFullRows() throws {
        var text = "Date,Payee,Amount\n"
        for day in 1...7 { text += "2026-10-0\(day),Shop \(day),-\(day)\n" }
        text += "2026-10-08,Short\n"
        let preview = try #require(CSVPreview.make(Data(text.utf8), separator: ",", encoding: "utf-8", skipRows: 0))
        #expect(preview.headers == ["Date", "Payee", "Amount"])
        #expect(preview.rows.count == 5)
        #expect(preview.rows[0] == ["2026-10-01", "Shop 1", "-1"])
    }

    @Test func quotesTrimmingBlankLinesAndSkippedRowsFollowCsvParse() throws {
        let text = "\u{FEFF}Bank export\r\nAccount 1\r\n\r\n Date ; \"Payee; Inc\" ;Memo\r\n2026-10-01;\"He said \"\"hi\"\"\";a\"b\r\n\r\n"
        let preview = try #require(CSVPreview.make(Data(text.utf8), separator: ";", encoding: "utf-8", skipRows: 2))
        #expect(preview.headers == ["Date", "Payee; Inc", "Memo"])
        #expect(preview.rows == [["2026-10-01", "He said \"hi\"", "a\"b"]])
    }

    @Test func encodingsDecodeOrFallBack() throws {
        let latin = Data([0x4E, 0x61, 0x61, 0x6D, 0x0A, 0x43, 0x61, 0x66, 0xE9, 0x0A])
        let asLatin = try #require(CSVPreview.make(latin, separator: ",", encoding: "latin1", skipRows: 0))
        #expect(asLatin.rows == [["Café"]])
        // Not valid UTF-8: read as Latin-1.
        let fallback = try #require(CSVPreview.make(latin, separator: ",", encoding: "utf-8", skipRows: 0))
        #expect(fallback.rows == [["Café"]])
        #expect(CSVPreview.make(latin, separator: ",", encoding: "utf-16", skipRows: 0) == nil)
        #expect(CSVPreview.make(Data(), separator: ",", encoding: "utf-8", skipRows: 0) == nil)
        let windows = Data([0x41, 0x0A, 0x80, 0x0A])
        #expect(CSVPreview.make(windows, separator: ",", encoding: "windows-1252", skipRows: 0)?.rows == [["€"]])
    }

    @Test func aPreviewCutInsideACharacterDropsOnlyThatTail() {
        let bytes = Array("Naam\nCafé".utf8)
        let cut = Array(bytes.dropLast())
        #expect(CSVPreview.trimmingIncompleteCharacter(cut) == Array("Naam\nCaf".utf8))
        #expect(CSVPreview.trimmingIncompleteCharacter(bytes) == bytes)
        #expect(CSVPreview.decode(cut, encoding: "utf-8", partial: true) == "Naam\nCaf")
    }

    @Test func theSeparatorIsSniffedFromTheFirstNonEmptyLine() {
        #expect(CSVPreview.detectSeparator(Data("\n\na|b|c\n1|2|3".utf8)) == "|")
        #expect(CSVPreview.detectSeparator(Data("a;b\r\n".utf8)) == ";")
        #expect(CSVPreview.detectSeparator(Data()) == ",")
    }
}

@MainActor
@Suite struct ImportShellTests {
    func makeShell(_ imports: ImportsModel, recorder: ShellRecorder, adminMode: Bool = false) -> NativeShellModel {
        NativeShellModel(
            strings: ImportFixture.strings, theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: imports, transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { NativeAppSettings(adminMode: adminMode) }, onNavigate: { recorder.actions.append($0) })
    }

    @Test func importIsNativeWithoutAdminModeOnceSettingsLoad() async throws {
        let recorder = ShellRecorder()
        let shell = makeShell(ImportFixture.model(), recorder: recorder)
        shell.routeDidChange(try #require(NativeRoute("/import")))
        #expect(shell.detail == .web)
        await shell.settingsSettled()
        #expect(shell.detail == .native(.importExport))
        shell.routeDidChange(try #require(NativeRoute("/import/3/review")))
        let review: NativeShellDetail = ImportRoutes.reviewIsNative ? .native(.importReview(batchId: 3)) : .web
        #expect(shell.detail == review)
    }

    @Test func aFinderFileGoesToTheNativeCardOnceSettingsLoad() async throws {
        let recorder = ShellRecorder()
        let imports = ImportFixture.model()
        let shell = makeShell(imports, recorder: recorder)
        let file = ImportFixture.file()
        // Before `app_settings` is read the web app takes the file.
        #expect(!shell.openImportFile(file))
        shell.routeDidChange(try #require(NativeRoute("/transactions")))
        await shell.settingsSettled()
        #expect(shell.openImportFile(file))
        #expect(recorder.actions == [.navigate("/import")])
        shell.routeDidChange(try #require(NativeRoute("/import")))
        await imports.appear(strings: ImportFixture.strings)
        #expect(imports.file == file)
        // Already on the page: no navigation, the file replaces the dropzone's.
        let next = ImportFixture.file("second.csv")
        #expect(shell.openImportFile(next))
        #expect(recorder.actions == [.navigate("/import")])
        #expect(imports.file == next)
    }

    @Test func aFinderFileOpenedBeforeSettingsLoadPrefillsTheNativeCard() async throws {
        let recorder = ShellRecorder()
        let imports = ImportFixture.model()
        let shell = makeShell(imports, recorder: recorder)
        let file = ImportFixture.file()
        // Cold launch: the web app also takes the file and moves to `/import`.
        #expect(!shell.openImportFile(file))
        #expect(recorder.actions.isEmpty)
        shell.routeDidChange(try #require(NativeRoute("/import")))
        #expect(shell.detail == .web)
        // `app_settings` is read: `/import` draws natively and its card has the file.
        await shell.settingsSettled()
        #expect(shell.detail == .native(.importExport))
        await imports.appear(strings: ImportFixture.strings)
        #expect(imports.file == file)
        #expect(imports.source == nil)
        #expect(!imports.isImporting)
    }

    @Test func aChosenFileHoldsANavigationUntilStayOrLeave() async throws {
        let recorder = ShellRecorder()
        let imports = ImportFixture.model()
        let shell = makeShell(imports, recorder: recorder)
        shell.routeDidChange(try #require(NativeRoute("/import")))
        await shell.settingsSettled()
        shell.setLeaveGuard(imports.leaveGuard)
        shell.navigate(to: "/transactions")
        #expect(recorder.actions == [.navigate("/transactions")])
        recorder.actions = []
        imports.chooseFile(ImportFixture.file())
        shell.navigate(to: "/transactions")
        #expect(shell.leaveConfirmation?.path == "/transactions")
        #expect(recorder.actions.isEmpty)
        shell.stayOnPage()
        #expect(imports.file != nil)
        shell.navigate(to: "/transactions")
        shell.leavePage()
        #expect(imports.file == nil)
        #expect(recorder.actions == [.navigate("/transactions")])
    }
}

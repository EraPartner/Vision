import Foundation
import Observation

/// The state of the Import & export page (`ImportPage` with `TransactionImportCard` and
/// `ImportHistoryCard`): the commit receipt, the bank import card (file, bank source, the
/// custom CSV setup with saved parsers, the import with its progress panel), and Import
/// history with Roll back; in the sidebar the export card and the collapsible Setup and
/// reference card (Payees and Categories from CSV, Supported banks). It also owns the Review
/// import page's model, whose commit hands its receipt back here.
@MainActor
@Observable
public final class ImportsModel {
    /// The default toast duration.
    public nonisolated static let noticeDuration: Duration = .seconds(4)
    /// `PAGE_SIZE` of Import history.
    public nonisolated static let historyPageSize = 10
    /// The default `staleTime` of the web app's `QueryClient` (Import history).
    public nonisolated static let historyStaleAfter: TimeInterval = 30
    /// `QUERY_STALE_TIME_MS.STANDARD` (saved parsers).
    public nonisolated static let parsersStaleAfter: TimeInterval = 60
    /// `DEFAULT_TTL_MS` of the import handoff.
    public nonisolated static let handoffLifetime: TimeInterval = 30

    /// The Detected columns panel.
    public enum HeadersPanel: Equatable, Sendable {
        /// No file chosen.
        case hidden
        /// `csvHeaders.unreadable`.
        case unreadable
        /// The headers and sample rows; `detectedSeparator` is set when the separator was
        /// sniffed from the file (a built-in bank) rather than set in the custom setup.
        case loaded(CSVPreview, detectedSeparator: String?)
    }

    // MARK: Bank import card

    public private(set) var file: ImportFile?
    /// The Bank source select; `nil` until one is chosen.
    public private(set) var source: ImportSource?
    /// The Parser name field (`customBank`).
    public var parserName = ""
    /// The custom CSV setup (`customConfig`).
    public var config = CSVParserConfig()
    /// A saved parser is open in the editor (`editingSaved`).
    public private(set) var isEditingSaved = false
    /// The parser name and setup the dirty check compares with (`parserBaseline`).
    public private(set) var baseline = CSVParserDraft()
    /// An import is running (`loading`).
    public private(set) var isImporting = false
    /// The progress, completion or failure panel (`progress`).
    public private(set) var progress: ImportProgress?
    public private(set) var isSavingParser = false
    public private(set) var isDeletingParser = false
    /// The parser the Delete parser? alert asks about.
    public private(set) var pendingParserDelete: OpenAPI.CustomParserConfig?
    /// The built-in adapters; `nil` until the first answer.
    public private(set) var adapters: [ImportAdapter]?
    public private(set) var adaptersFailed = false
    /// The saved custom parsers; `nil` until the first answer.
    public private(set) var savedParsers: [OpenAPI.CustomParserConfig]?

    // MARK: Import history

    /// The first batch of the shown page.
    public private(set) var historyOffset = 0
    /// The page on screen; the previous one stays while the next loads (`keepPreviousData`).
    public private(set) var historyPage: ImportBatchPage?
    public private(set) var historyError: APIError?
    public private(set) var isHistoryFetching = false
    /// The batches whose Roll back is running.
    public private(set) var rollingBack: Set<String> = []
    /// The batch the Roll back import? alert asks about.
    public private(set) var pendingRollback: OpenAPI.ImportBatch?

    // MARK: Page

    /// The receipt a review commit handed over (`importCommitReceipt`).
    public private(set) var commitReceipt: ImportCommitReceipt?
    /// The Setup and reference card is open (collapsed by default).
    public private(set) var isSetupReferenceExpanded = false
    /// A navigation the page asks the shell for (the review of a parked import); the view
    /// performs it and calls `didHandleNavigation()`.
    public private(set) var navigationRequest: String?

    // MARK: Sidebar and review

    /// The toasts this page and the review page share.
    public let toasts: ImportNoticeCenter
    /// The export card.
    public let export: TransactionExportModel
    /// Payees from CSV.
    public let recipientsCSV: SimpleCSVImportModel
    /// Categories from CSV.
    public let categoriesCSV: SimpleCSVImportModel
    /// `/import/:batchId/review`.
    public let review: ImportReviewModel

    @ObservationIgnored private let service: any ImportService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var bypassNextNavigation = false
    @ObservationIgnored private var isVisible = false
    @ObservationIgnored private var pendingHandoff: (file: ImportFile, expiresAt: Date)?
    @ObservationIgnored private var sampleRowsOverride: Bool?
    @ObservationIgnored private var importGeneration = 0
    @ObservationIgnored private var streamTask: Task<ImportOutcome, any Error>?
    @ObservationIgnored private var adaptersInFlight: Task<Void, Never>?
    @ObservationIgnored private var parsersInFlight: Task<Void, Never>?
    @ObservationIgnored private var parsersFetchedAt: Date?
    @ObservationIgnored private var historyCache: [Int: (page: ImportBatchPage, fetchedAt: Date)] = [:]
    @ObservationIgnored private var historyInFlight: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private var previewCache: (key: PreviewKey, value: CSVPreview?)?
    @ObservationIgnored private var separatorCache: (file: UUID, separator: String)?

    public init(
        service: any ImportService, exports: any ImportExportService, review: any ImportReviewService,
        pickers: any PickerDataService, now: @escaping @Sendable () -> Date = { Date() }, calendar: Calendar = .current
    ) {
        let toasts = ImportNoticeCenter()
        self.service = service
        self.now = now
        self.toasts = toasts
        self.export = TransactionExportModel(
            service: exports, pickers: pickers, toasts: toasts, now: now, calendar: calendar)
        self.recipientsCSV = SimpleCSVImportModel(kind: .recipients, service: exports, toasts: toasts)
        self.categoriesCSV = SimpleCSVImportModel(kind: .categories, service: exports, toasts: toasts)
        self.review = ImportReviewModel(service: review, pickers: pickers, toasts: toasts)
        self.review.onCommitted = { [weak self] receipt in self?.showCommitReceipt(receipt) }
        self.review.onHistoryChanged = { [weak self] in self?.invalidateHistory() }
    }

    // MARK: Lifecycle

    /// The page appeared: a handed-off file pre-fills the dropzone, and the adapters, saved
    /// parsers and Import history load unless a fresh answer is cached.
    public func appear(strings: any Localizing) async {
        isVisible = true
        consumeHandoff()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadAdapters(strings: strings) }
            group.addTask { await self.loadParsers() }
            group.addTask { await self.loadHistory(strings: strings) }
        }
    }

    /// The page went away: like an unmounted page, the card, the history page, the receipt
    /// and the alerts reset. A running import finishes in the background and keeps its card.
    public func disappear() {
        isVisible = false
        pendingParserDelete = nil
        pendingRollback = nil
        commitReceipt = nil
        isSetupReferenceExpanded = false
        export.reset()
        recipientsCSV.reset()
        categoriesCSV.reset()
        historyOffset = 0
        if let cached = historyCache[0] { historyPage = cached.page }
        if !isImporting { resetCard(keepingProgress: false) }
    }

    /// `useUnsavedChanges(file !== null || parserDirty)`: a chosen file (also while it
    /// imports) or an unsaved parser edit asks before leaving `/import`.
    public var leaveGuard: NativeLeaveGuard {
        NativeLeaveGuard(
            id: ImportRoutes.path,
            hasUnsavedChanges: { [weak self] in self?.hasUnsavedChanges ?? false },
            discard: { [weak self] in self?.resetCard(keepingProgress: false) })
    }

    public var hasUnsavedChanges: Bool {
        !bypassNextNavigation && (file != nil || isParserDirty)
    }

    /// The view performed `navigationRequest`.
    public func didHandleNavigation() {
        navigationRequest = nil
        bypassNextNavigation = false
    }

    private func requestReview(_ batchId: Int) {
        // `bypassNextNavigation()`: the parked import is the outcome, not unsaved work.
        bypassNextNavigation = true
        navigationRequest = ImportRoutes.reviewPath(batchId)
    }

    // MARK: Handoff

    /// A CSV opened from Finder or the dock, or dropped on another native screen
    /// (`registerPendingImportFile`): it pre-fills the dropzone when the page shows, within
    /// 30 seconds. The import never starts by itself; the user still picks the bank.
    public func handoff(_ file: ImportFile) {
        guard file.isCSV else { return }
        pendingHandoff = (file, now().addingTimeInterval(Self.handoffLifetime))
        if isVisible { consumeHandoff() }
    }

    /// `consumePendingImportFile`.
    private func consumeHandoff() {
        guard let pending = pendingHandoff else { return }
        pendingHandoff = nil
        guard now() <= pending.expiresAt, pending.file.isCSV else { return }
        setFile(pending.file)
    }

    // MARK: File

    /// The dropzone's drop, the Open panel's choice: a file that is not a CSV is refused with
    /// `importPage.toast.noFile`.
    public func chooseFile(_ file: ImportFile) {
        guard file.isCSV else {
            post(.error, "importPage.toast.noFile")
            return
        }
        setFile(file)
    }

    /// The dropzone's Remove: the file goes without opening the picker.
    public func removeFile() {
        setFile(nil)
    }

    private func setFile(_ next: ImportFile?) {
        file = next
        sampleRowsOverride = nil
    }

    // MARK: Bank source

    public var isSaved: Bool {
        if case .saved = source { return true }
        return false
    }

    /// A custom or saved setup: the card shows the Custom CSV setup.
    public var isCustomLike: Bool { source?.isCustomLike ?? false }

    /// The saved parser the source names, once the list has it.
    public var selectedParser: OpenAPI.CustomParserConfig? {
        guard case .saved(let id) = source else { return nil }
        return savedParsers?.first { $0.id == id }
    }

    /// While the adapters load, the select shows `importPage.loading`.
    public var isLoadingAdapters: Bool { adapters == nil && !adaptersFailed }

    /// `handleBankChange`: a saved parser loads its name and setup, Custom starts blank, and
    /// any change clears the panel and leaves edit mode.
    public func selectSource(_ next: ImportSource?) {
        source = next
        progress = nil
        isEditingSaved = false
        switch next {
        case .saved(let id):
            if let parser = savedParsers?.first(where: { $0.id == id }) {
                let loaded = CSVParserConfig(saved: parser.config)
                config = loaded
                parserName = parser.name
                baseline = CSVParserDraft(name: parser.name, config: loaded)
            }
        case .custom:
            config = CSVParserConfig()
            parserName = ""
            baseline = CSVParserDraft()
        case .adapter, nil:
            break
        }
    }

    /// The bank name the import sends (`resolvedBank`).
    public var resolvedBank: String {
        switch source {
        case .saved: return selectedParser.map { $0.name.isEmpty ? "generic" : $0.name } ?? "generic"
        case .custom: return parserName.isEmpty ? "generic" : parserName
        case .adapter(let key): return key
        case nil: return ""
        }
    }

    // MARK: Custom CSV setup

    /// The editable setup shows for Custom, or for a saved parser after Edit.
    public var showsEditor: Bool {
        switch source {
        case .custom: return true
        case .saved: return isEditingSaved
        default: return false
        }
    }

    /// The read-only Saved setup of a saved parser.
    public var showsSavedSummary: Bool { isSaved && !isEditingSaved }

    /// `parserDirty`: the name or setup differs from what was loaded or saved.
    public var isParserDirty: Bool {
        isCustomLike && CSVParserDraft(name: parserName, config: config) != baseline
    }

    /// Save parser / Save changes is enabled with a name and the three required columns.
    public var canSaveParser: Bool {
        !isSavingParser && config.hasRequiredMapping && !parserName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The rows of the Saved setup (`summaryRows`).
    public func summaryRows(_ strings: any Localizing) -> [(label: String, value: String)] {
        [
            (strings.t("importPage.dateCol"), config.dateColumn),
            (strings.t("importPage.recipientCol"), config.recipientColumn),
            (strings.t("importPage.amountCol"), config.amountColumn),
            (strings.t("importPage.memoCol"), config.memoColumn.isEmpty ? "—" : config.memoColumn),
            (strings.t("importPage.separator"), config.separator),
            (strings.t("importPage.dateFormat"), config.dateFormat),
            (strings.t("importPage.numberFormat.label"), strings.t(CSVFormatOptions.numberFormatKey(config.numberFormat))),
        ]
    }

    /// Edit: the saved parser opens in the editor.
    public func startEditing() {
        guard isSaved else { return }
        isEditingSaved = true
    }

    /// The editor's Cancel: back to the saved parser's name and setup.
    public func cancelEditing() {
        isEditingSaved = false
        if let parser = selectedParser {
            config = CSVParserConfig(saved: parser.config)
            parserName = parser.name
        }
    }

    /// Save parser (new setup) or Save changes (saved parser): creates or updates it. A new
    /// parser becomes the selected source.
    public func saveParser(strings: any Localizing) async {
        let name = parserName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            post(.error, "importPage.customParser.nameRequired")
            return
        }
        guard config.hasRequiredMapping else {
            post(.error, "importPage.toast.noConfig")
            return
        }
        guard !isSavingParser else { return }
        let saved = config
        isSavingParser = true
        defer { isSavingParser = false }
        do {
            if case .saved(let id) = source, selectedParser != nil {
                let updated = try await service.updateCustomParser(id: id, name: name, config: saved)
                storeParser(updated)
                post(.success, "importPage.customParser.updated")
                isEditingSaved = false
            } else {
                let created = try await service.createCustomParser(name: name, config: saved)
                storeParser(created)
                post(.success, "importPage.customParser.saved")
                source = .saved(created.id)
            }
            baseline = CSVParserDraft(name: name, config: saved)
            await loadParsers(force: true)
        } catch {
            post(.error, "importPage.customParser.saveFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    private func storeParser(_ parser: OpenAPI.CustomParserConfig) {
        var list = savedParsers ?? []
        if let index = list.firstIndex(where: { $0.id == parser.id }) {
            list[index] = parser
        } else {
            list.append(parser)
        }
        savedParsers = list
    }

    /// Delete: asks first.
    public func requestParserDelete() {
        guard let parser = selectedParser, !isDeletingParser else { return }
        pendingParserDelete = parser
    }

    /// The alert's Cancel or Escape.
    public func cancelParserDelete() {
        pendingParserDelete = nil
    }

    /// The alert's Delete: the parser goes, and the source and setup reset.
    public func confirmParserDelete(strings: any Localizing) async {
        guard let parser = pendingParserDelete else { return }
        pendingParserDelete = nil
        isDeletingParser = true
        defer { isDeletingParser = false }
        do {
            try await service.deleteCustomParser(id: parser.id)
            savedParsers?.removeAll { $0.id == parser.id }
            post(.success, "importPage.customParser.deleted")
            source = nil
            parserName = ""
            config = CSVParserConfig()
            baseline = CSVParserDraft()
            await loadParsers(force: true)
        } catch {
            post(.error, "importPage.customParser.deleteFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    // MARK: Detected columns

    struct PreviewKey: Equatable {
        let file: UUID
        let separator: String
        let encoding: String
        let skipRows: Int
    }

    /// The Detected columns panel (`FileHeadersPanel`): the custom setup's separator, encoding
    /// and skipped rows, or for a built-in bank a sniffed separator, UTF-8 and no skipped rows.
    public var headersPanel: HeadersPanel {
        guard let file else { return .hidden }
        let separator = isCustomLike ? config.separator : detectedSeparator(file)
        let encoding = isCustomLike ? config.encoding : "utf-8"
        let skipRows = isCustomLike ? config.skipRows : 0
        guard let preview = preview(file, separator: separator, encoding: encoding, skipRows: skipRows) else {
            return .unreadable
        }
        return .loaded(preview, detectedSeparator: isCustomLike ? nil : separator)
    }

    /// The headers the column mapper offers; empty without a readable file (text fields then).
    public var mapperHeaders: [String] {
        guard let file,
            let preview = preview(file, separator: config.separator, encoding: config.encoding, skipRows: config.skipRows)
        else { return [] }
        return preview.headers
    }

    /// The mapped headers the panel highlights (custom setups only).
    public var highlightedHeaders: Set<String> {
        guard isCustomLike else { return [] }
        return Set(config.mappedColumns.filter { !$0.isEmpty })
    }

    /// Sample rows starts collapsed for a custom or saved setup and open for a built-in bank.
    public var isSampleRowsExpanded: Bool {
        sampleRowsOverride ?? !isCustomLike
    }

    public func setSampleRowsExpanded(_ expanded: Bool) {
        sampleRowsOverride = expanded
    }

    private func preview(_ file: ImportFile, separator: String, encoding: String, skipRows: Int) -> CSVPreview? {
        let key = PreviewKey(file: file.id, separator: separator, encoding: encoding, skipRows: skipRows)
        if let cached = previewCache, cached.key == key { return cached.value }
        let value = CSVPreview.make(file.data, separator: separator, encoding: encoding, skipRows: skipRows)
        previewCache = (key, value)
        return value
    }

    private func detectedSeparator(_ file: ImportFile) -> String {
        if let cached = separatorCache, cached.file == file.id { return cached.separator }
        let separator = CSVPreview.detectSeparator(file.data)
        separatorCache = (file.id, separator)
        return separator
    }

    // MARK: Import

    /// What still blocks the import, in the card's order (`hint`); `nil` when ready.
    public var hintKey: String? {
        if file == nil { return "importPage.hint.file" }
        if source == nil { return "importPage.hint.bank" }
        if isCustomLike && !config.hasRequiredMapping { return "importPage.hint.mapping" }
        return nil
    }

    public var canImport: Bool { hintKey == nil && !isImporting }

    /// Import transactions: a built-in bank streams with live progress; a custom or saved
    /// setup posts one request. A parked batch opens its review; a committed one toasts,
    /// refreshes Import history and resets the card.
    public func startImport(strings: any Localizing) async {
        guard let file else {
            post(.error, "importPage.toast.noFileSel")
            return
        }
        let bank = resolvedBank
        guard !bank.isEmpty else {
            post(.error, "importPage.toast.noBank")
            return
        }
        if isCustomLike && !config.hasRequiredMapping {
            post(.error, "importPage.toast.noConfig")
            return
        }
        guard !isImporting else { return }
        importGeneration += 1
        let generation = importGeneration
        isImporting = true
        progress = .connecting
        let service = service
        let custom = isCustomLike
        let setup = config
        do {
            let outcome: ImportOutcome
            if custom {
                outcome = try await service.importCustom(file: file, bankName: bank, config: setup)
            } else {
                let task = Task {
                    try await service.importStream(file: file, bankName: bank) { progress in
                        await self.receive(progress, generation: generation)
                    }
                }
                streamTask = task
                outcome = try await task.value
            }
            guard generation == importGeneration else { return }
            streamTask = nil
            isImporting = false
            switch outcome {
            case .reviewRequired(let batchId):
                requestReview(batchId)
            case .completed(let result):
                if custom {
                    progress = ImportProgress(
                        phase: "complete", current: result.total, total: result.total, imported: result.imported,
                        duplicates: result.duplicates, errors: result.errors, percent: 100)
                }
                post(
                    .success, "importPage.toast.importSuccess",
                    ["n": String(result.imported), "dups": String(result.duplicates), "total": String(result.total)])
                resetCard(keepingProgress: true)
                await refreshHistory(strings: strings)
            }
        } catch {
            // A cancelled stream: Cancel already reset the panel.
            guard generation == importGeneration else { return }
            streamTask = nil
            isImporting = false
            post(.error, "importPage.toast.serverError", detail: ImportErrorText.text(error, strings: strings))
            if progress != nil { progress?.phase = "error" }
        }
    }

    private func receive(_ next: ImportProgress, generation: Int) {
        guard generation == importGeneration, isImporting else { return }
        progress = next
    }

    /// Cancel (while importing): aborts the stream, clears the panel and says so. A custom
    /// import is one request with nothing to abort, as on the web.
    public func cancelImport() {
        guard let task = streamTask else { return }
        task.cancel()
        streamTask = nil
        importGeneration += 1
        isImporting = false
        progress = nil
        post(.info, "importPage.toast.importCancelled")
    }

    /// The card after an import, a discard or leaving: no file, no source, a blank setup.
    private func resetCard(keepingProgress: Bool) {
        setFile(nil)
        source = nil
        parserName = ""
        config = CSVParserConfig()
        baseline = CSVParserDraft()
        isEditingSaved = false
        if !keepingProgress { progress = nil }
    }

    // MARK: Lists

    /// `useAdapters`: loaded once (`staleTime: Infinity`); a failure toasts and the next
    /// appearance asks again.
    public func loadAdapters(strings: any Localizing) async {
        if adapters != nil { return }
        if let adaptersInFlight {
            await adaptersInFlight.value
            return
        }
        let service = service
        let task = Task {
            do {
                let list = try await service.supportedAdapters()
                self.adapters = list
                self.adaptersFailed = false
            } catch is CancellationError {
                return
            } catch {
                self.adaptersFailed = true
                self.post(.error, "importPage.toast.parsersError")
            }
        }
        adaptersInFlight = task
        await task.value
        adaptersInFlight = nil
    }

    /// `useCustomParserConfigs` (one minute stale time); `force` refetches after a save or
    /// delete. A failed load keeps the last list.
    public func loadParsers(force: Bool = false) async {
        if let parsersInFlight {
            await parsersInFlight.value
            if !force { return }
        }
        if !force, let fetched = parsersFetchedAt, now().timeIntervalSince(fetched) < Self.parsersStaleAfter { return }
        let service = service
        let task = Task {
            guard let list = try? await service.customParsers() else { return }
            self.savedParsers = list
            self.parsersFetchedAt = self.now()
        }
        parsersInFlight = task
        await task.value
        if parsersInFlight == task { parsersInFlight = nil }
    }

    // MARK: Import history

    public var historyBatches: [OpenAPI.ImportBatch] { historyPage?.items ?? [] }

    /// The section loader shows until the first answer.
    public var isHistoryLoading: Bool { historyPage == nil && historyError == nil }

    public var historyTotalPages: Int {
        let total = historyPage?.total ?? 0
        return (total + Self.historyPageSize - 1) / Self.historyPageSize
    }

    public var historyCurrentPage: Int { historyOffset / Self.historyPageSize + 1 }

    public var canShowPreviousPage: Bool { historyOffset > 0 && !isHistoryFetching }

    public var canShowNextPage: Bool {
        historyOffset + Self.historyPageSize < (historyPage?.total ?? 0) && !isHistoryFetching
    }

    /// The shown page, unless a fresh copy is cached.
    public func loadHistory(strings: any Localizing) async {
        let offset = historyOffset
        if let cached = historyCache[offset], now().timeIntervalSince(cached.fetchedAt) < Self.historyStaleAfter {
            historyPage = cached.page
            return
        }
        await fetchHistory(offset, strings: strings)
    }

    /// Refresh, an import or a roll back (`invalidateQueries(batchesAll)`): every cached page
    /// goes stale and the shown one loads again.
    public func refreshHistory(strings: any Localizing) async {
        historyCache = [:]
        await fetchHistory(historyOffset, strings: strings)
    }

    /// The review page committed or discarded a batch: the next visit loads Import history
    /// again.
    func invalidateHistory() {
        historyCache = [:]
    }

    /// Previous: back ten batches.
    public func showPreviousPage(strings: any Localizing) async {
        guard canShowPreviousPage else { return }
        historyOffset = max(0, historyOffset - Self.historyPageSize)
        await loadHistory(strings: strings)
    }

    /// Next: forward ten batches.
    public func showNextPage(strings: any Localizing) async {
        guard canShowNextPage else { return }
        historyOffset += Self.historyPageSize
        await loadHistory(strings: strings)
    }

    /// One request per page at a time. A failure toasts `importHistory.loadFailed`; the last
    /// page stays on screen.
    private func fetchHistory(_ offset: Int, strings: any Localizing) async {
        if let running = historyInFlight[offset] {
            await running.value
            return
        }
        let service = service
        let task = Task {
            self.isHistoryFetching = true
            do {
                let page = try await service.importBatches(limit: Self.historyPageSize, offset: offset)
                self.historyCache[offset] = (page, self.now())
                if offset == self.historyOffset {
                    self.historyPage = page
                    self.historyError = nil
                }
            } catch is CancellationError {
            } catch {
                if offset == self.historyOffset {
                    self.historyError = APIError.wrapping(error)
                    self.post(.error, "importHistory.loadFailed", detail: ImportErrorText.text(error, strings: strings))
                }
            }
            self.isHistoryFetching = false
        }
        historyInFlight[offset] = task
        await task.value
        historyInFlight[offset] = nil
    }

    /// Roll back: asks first.
    public func requestRollback(_ batch: OpenAPI.ImportBatch) {
        guard batch.canRollBack, !rollingBack.contains(batch.id) else { return }
        pendingRollback = batch
    }

    /// The alert's Cancel or Escape.
    public func cancelRollback() {
        pendingRollback = nil
    }

    /// The alert's Yes, roll back: the batch's transactions go, then the history refreshes.
    public func confirmRollback(strings: any Localizing) async {
        guard let batch = pendingRollback else { return }
        pendingRollback = nil
        guard let id = batch.numericId else {
            post(.error, "importHistory.rollbackFailed", detail: strings.t("apiError.unknown"))
            return
        }
        rollingBack.insert(batch.id)
        defer { rollingBack.remove(batch.id) }
        do {
            let deleted = try await service.rollbackImportBatch(id: id)
            post(.success, "importHistory.rollbackSuccess", ["n": String(deleted)])
            await refreshHistory(strings: strings)
        } catch {
            post(.error, "importHistory.rollbackFailed", detail: ImportErrorText.text(error, strings: strings))
        }
    }

    // MARK: Commit receipt

    /// The review page committed a parked import and returned here with its receipt.
    public func showCommitReceipt(_ receipt: ImportCommitReceipt) {
        commitReceipt = receipt
    }

    /// The receipt's dismiss button.
    public func dismissCommitReceipt() {
        commitReceipt = nil
    }

    // MARK: Setup and reference

    /// The chevron of Setup and reference.
    public func toggleSetupReference() {
        isSetupReferenceExpanded.toggle()
    }

    // MARK: Toasts

    /// The newest toast.
    public var notice: ScreenNotice? { toasts.latest }

    public func clearNotice(_ id: Int) {
        toasts.clear(id)
    }

    private func post(
        _ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil
    ) {
        toasts.post(kind, key, variables, detail: detail)
    }
}

/// The description line of an import toast (`apiErrorToMessage`): a stream `error` event's
/// detail passes through when it is written for people.
public enum ImportErrorText {
    public static func text(_ error: any Error, strings: any Localizing) -> String {
        if let failure = error as? ImportStreamFailure {
            return APIErrorMessage.isAuthored(failure.detail)
                ? failure.detail.trimmingCharacters(in: .whitespacesAndNewlines) : strings.t("apiError.unknown")
        }
        return APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }
}

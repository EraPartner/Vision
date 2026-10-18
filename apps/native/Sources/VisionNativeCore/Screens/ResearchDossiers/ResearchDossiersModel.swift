import Foundation
import Observation

@MainActor @Observable public final class ResearchDossiersModel {
    public var draft: ResearchDossierContent? { didSet { if draft != oldValue { draftRevision = UUID() } } }
    public private(set) var selectedId: String?
    public private(set) var items: [ResearchDossierListItem] = []
    public private(set) var total = 0
    public private(set) var listOffset = 0
    public private(set) var detail: ResearchDossier?
    public private(set) var history: [ResearchDossierVersion] = []
    public private(set) var listLoading = false
    public private(set) var detailLoading = false
    public private(set) var historyLoading = false
    public private(set) var listError: String?
    public private(set) var detailError: String?
    public private(set) var historyError: String?
    public private(set) var categories: [ResearchDossierPickerItem] = []
    public private(set) var investments: [ResearchDossierPickerItem] = []
    public private(set) var analyses: [ResearchDossierPickerItem] = []
    public private(set) var documents: [ResearchDossierDocument] = []
    public private(set) var pickerErrors: [String: String] = [:]
    public private(set) var pickersLoading = false
    public private(set) var conflict = false
    public private(set) var error: String?
    public private(set) var notice: ScreenNotice?
    public private(set) var pendingReview: ResearchDossierReview?
    public private(set) var settings = NativeAppSettings.defaults
    public private(set) var exportData: Data?
    public private(set) var exportFilename: String?
    public var readyDocuments: [ResearchDossierDocument] { documents.filter { $0.extractionStatus == "ready" } }
    public var deletedLinks: [ResearchDossierLinkDetail] { detail?.linkDetails.filter { $0.status == "deleted" } ?? [] }
    public var busy: Bool { mutations > 0 }
    public var hasUnsavedChanges: Bool { draft.map { $0.payload != baseline?.payload } ?? false }
    public var isOnline = true { didSet { if !isOnline { invalidateReads() } } }
    @ObservationIgnored public var saveExport: (@MainActor (Data, String) async throws -> Bool)?
    @ObservationIgnored public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any DossiersService
    @ObservationIgnored private var active = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var selection = UUID()
    @ObservationIgnored private var draftRevision = UUID()
    @ObservationIgnored private var listRevision = UUID()
    @ObservationIgnored private var detailRevision = UUID()
    @ObservationIgnored private var historyRevision = UUID()
    @ObservationIgnored private var pickerRevision = UUID()
    @ObservationIgnored private var hasListLoaded = false
    @ObservationIgnored private var hasLoadedPickers = false
    private var mutations = 0
    @ObservationIgnored private var noticeID = 0
    private var baseline: ResearchDossierContent?
    public init(service: any DossiersService) { self.service = service }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func configure(settings: NativeAppSettings) { self.settings = settings }
    public func didAppear(route: NativeRoute? = nil) async { await load() }
    public func load(force: Bool = false) async {
        active = true
        let visit = visit
        async let list: Void = loadList()
        async let options: Void = loadPickers(force: force)
        _ = await (list, options)
        guard active, visit == self.visit else { return }
        if let id = selectedId { await loadSelection(id: id) }
    }
    private func loadList() async {
        guard active, isOnline else { return }
        let offset = listOffset
        let token = UUID()
        listRevision = token
        listLoading = !hasListLoaded
        defer { if token == listRevision { listLoading = false } }
        do {
            let page = try await service.listDossiers(offset: offset)
            guard active, token == listRevision, offset == listOffset, !Task.isCancelled else { return }
            guard page.offset == offset, page.limit == 500, page.total >= 0 else {
                throw ResearchDecode.failure("Dossier list scope mismatch")
            }
            items = page.items
            total = page.total
            hasListLoaded = true
            listError = nil
        } catch {
            guard active, token == listRevision, !Task.isCancelled else { return }
            listError = error.localizedDescription
        }
    }
    public func retryList() async { await loadList() }
    public func previousPage() async {
        guard listOffset > 0 else { return }
        changePage(max(0, listOffset - 500))
        await loadList()
    }
    public func nextPage() async {
        guard listOffset + 500 < total else { return }
        changePage(listOffset + 500)
        await loadList()
    }
    private func changePage(_ offset: Int) {
        listOffset = offset
        hasListLoaded = false
        items = []
        total = 0
        listError = nil
    }
    private func loadPickers(force: Bool) async {
        guard active, isOnline, force || !hasLoadedPickers else { return }
        let token = UUID()
        pickerRevision = token
        pickersLoading = true
        await withTaskGroup(of: PickerRead.self) { group in
            group.addTask { [service] in
                do { return .categories(.success(try await service.dossierCategories())) } catch {
                    return .categories(.failure(error))
                }
            }
            group.addTask { [service] in
                do { return .investments(.success(try await service.dossierInvestments())) } catch {
                    return .investments(.failure(error))
                }
            }
            group.addTask { [service] in
                do { return .analyses(.success(try await service.dossierAnalyses())) } catch {
                    return .analyses(.failure(error))
                }
            }
            group.addTask { [service] in
                do { return .documents(.success(try await service.dossierDocuments())) } catch {
                    return .documents(.failure(error))
                }
            }
            for await result in group {
                guard active, token == pickerRevision, !Task.isCancelled else { continue }
                switch result {
                case .categories(let read): installPicker(read, key: "categories") { categories = $0 }
                case .investments(let read): installPicker(read, key: "investments") { investments = $0 }
                case .analyses(let read): installPicker(read, key: "analyses") { analyses = $0 }
                case .documents(let read): installPicker(read, key: "documents") { documents = $0 }
                }
            }
        }
        if token == pickerRevision {
            pickersLoading = false
            hasLoadedPickers = true
        }
    }
    private func installPicker<Value>(_ result: Result<Value, any Error>, key: String, install: (Value) -> Void) {
        switch result {
        case .success(let value):
            install(value)
            pickerErrors[key] = nil
        case .failure(let error): pickerErrors[key] = error.localizedDescription
        }
    }
    public func requestNew() {
        guard active else { return }
        if hasUnsavedChanges { pendingReview = .init(action: .discardForNew, selection: selection) } else { beginNew() }
    }
    private func beginNew() {
        changeSelection(nil)
        draft = .init()
        baseline = draft
        clearMessages()
    }
    public func select(_ id: String) async {
        guard active, id != selectedId else { return }
        if hasUnsavedChanges {
            pendingReview = .init(action: .discardForSelection(id: id), selection: selection)
            return
        }
        await choose(id)
    }
    private func choose(_ id: String) async {
        changeSelection(id)
        clearMessages()
        await loadSelection(id: id)
    }
    private func changeSelection(_ id: String?) {
        selection = UUID()
        detailRevision = UUID()
        historyRevision = UUID()
        selectedId = id
        detail = nil
        history = []
        draft = nil
        baseline = nil
        detailLoading = false
        historyLoading = false
        detailError = nil
        historyError = nil
        pendingReview = nil
    }
    private func loadSelection(id: String) async {
        async let record: Void = loadDetail(id: id)
        async let versions: Void = loadHistory(id: id)
        _ = await (record, versions)
    }
    private func loadDetail(id: String, discard: Bool = false) async {
        guard active, isOnline, selectedId == id else { return }
        let token = UUID()
        detailRevision = token
        detailLoading = detail == nil
        defer { if token == detailRevision { detailLoading = false } }
        do {
            let record = try await service.getDossier(id: id)
            guard active, token == detailRevision, selectedId == id, !Task.isCancelled else { return }
            guard record.id == id else { throw ResearchDecode.failure("Dossier detail identity mismatch") }
            detailError = nil
            // A background read never blesses unsaved content with somebody else's version.
            if !discard, let detail, detail.id == record.id, record.version < detail.version { return }
            if !discard, hasUnsavedChanges, detail?.version != record.version { return }
            let changed = detail?.version != record.version || detail?.id != record.id
            detail = record
            detailError = nil
            if discard || changed || draft == nil {
                draft = record.content
                baseline = record.content
            }
        } catch {
            guard active, token == detailRevision, selectedId == id, !Task.isCancelled else { return }
            detailError = error.localizedDescription
        }
    }
    private func loadHistory(id: String) async {
        guard active, isOnline, selectedId == id else { return }
        let token = UUID()
        historyRevision = token
        historyLoading = history.isEmpty
        defer { if token == historyRevision { historyLoading = false } }
        do {
            let rows = try await service.dossierVersions(id: id)
            guard active, token == historyRevision, selectedId == id, !Task.isCancelled else { return }
            history = rows
            historyError = nil
        } catch {
            guard active, token == historyRevision, selectedId == id, !Task.isCancelled else { return }
            historyError = error.localizedDescription
        }
    }
    public func retryDetail() async { if let id = selectedId { await loadDetail(id: id) } }
    public func requestDelete() {
        guard !busy, let id = selectedId else { return }
        pendingReview = .init(action: .delete(id: id), selection: selection)
    }
    public func requestRestore(_ version: Int) {
        guard !busy, let id = selectedId, let detail, version != detail.version else { return }
        pendingReview = .init(
            action: .restore(id: id, version: version, expectedVersion: detail.version), selection: selection)
    }
    public func requestReloadLatest() {
        guard let id = selectedId else { return }
        pendingReview = .init(action: .reload(id: id), selection: selection)
    }
    public func cancelPendingReview() { pendingReview = nil }
    public func confirmPendingReview() async {
        guard let review = pendingReview else { return }
        pendingReview = nil
        guard review.selection == selection else { return }
        switch review.action {
        case .discardForNew: beginNew()
        case .discardForSelection(let id): await choose(id)
        case .delete(let id): await remove(id: id)
        case .restore(let id, let version, let expectedVersion):
            await restore(id: id, version: version, expectedVersion: expectedVersion)
        case .reload(let id):
            draft = nil
            baseline = nil
            error = nil
            conflict = false
            await loadDetail(id: id, discard: true)
        }
    }
    public func save() async {
        guard active, isOnline, !busy, let content = draft else { return }
        clearMessages()
        guard !content.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !content.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            content.evidence.allSatisfy({
                !$0.claim.isEmpty && !$0.source.title.isEmpty && !$0.source.reference.isEmpty
            })
        else {
            error = "dossiers.required"
            return
        }
        let id = selectedId
        let context = selection
        let visit = visit
        let submittedRevision = draftRevision
        guard id == nil || detail != nil else { return }
        let expectedVersion = detail?.version
        detailRevision = UUID()
        historyRevision = UUID()
        detailLoading = false
        historyLoading = false
        mutations += 1
        defer { mutations -= 1 }
        do {
            let saved: ResearchDossier
            if let id, let expectedVersion {
                saved = try await service.updateDossier(id: id, content: content, expectedVersion: expectedVersion)
            } else {
                saved = try await service.createDossier(content)
            }
            if let id, saved.id != id { throw ResearchDecode.failure("Dossier write receipt identity mismatch") }
            if current(visit: visit, selection: context) {
                if id == nil {
                    selectedId = saved.id
                    selection = UUID()
                }
                applyReceipt(saved, submitted: content, submittedRevision: submittedRevision)
                showNotice("dossiers.saved")
            }
            await didMutate?()
            if active, visit == self.visit { await refreshAfterMutation() }
        } catch { if current(visit: visit, selection: context) { showError(error) } }
    }
    private func remove(id: String) async {
        guard active, isOnline, !busy else { return }
        let context = selection
        let visit = visit
        clearMessages()
        mutations += 1
        defer { mutations -= 1 }
        do {
            try await service.deleteDossier(id: id)
            if current(visit: visit, selection: context), selectedId == id {
                changeSelection(nil)
                showNotice("dossiers.deleted")
            }
            await didMutate?()
            if active, visit == self.visit { await refreshAfterMutation() }
        } catch { if current(visit: visit, selection: context) { showError(error) } }
    }
    private func restore(id: String, version: Int, expectedVersion: Int) async {
        guard active, isOnline, !busy else { return }
        let context = selection
        let visit = visit
        let submitted = draft
        let revision = draftRevision
        clearMessages()
        detailRevision = UUID()
        historyRevision = UUID()
        mutations += 1
        defer { mutations -= 1 }
        do {
            let restored = try await service.restoreDossier(id: id, version: version, expectedVersion: expectedVersion)
            guard restored.id == id else { throw ResearchDecode.failure("Dossier restore receipt identity mismatch") }
            if current(visit: visit, selection: context) {
                applyReceipt(restored, submitted: submitted ?? restored.content, submittedRevision: revision)
                showNotice("dossiers.restored")
            }
            await didMutate?()
            if active, visit == self.visit { await refreshAfterMutation() }
        } catch { if current(visit: visit, selection: context) { showError(error) } }
    }
    private func applyReceipt(_ saved: ResearchDossier, submitted: ResearchDossierContent, submittedRevision: UUID) {
        if let detail, detail.id == saved.id, detail.version > saved.version { return }
        detail = saved
        baseline = saved.content
        detailError = nil
        if draftRevision == submittedRevision || draft == nil {
            draft = saved.content
        } else if let current = draft {
            draft = Self.mergeEdits(current, submitted: submitted, acknowledged: saved.content)
        }
    }
    private static func mergeEdits(
        _ current: ResearchDossierContent, submitted: ResearchDossierContent, acknowledged: ResearchDossierContent
    ) -> ResearchDossierContent {
        var result = current
        for key in [\ResearchDossierContent.title, \.workspace, \.question, \.userThesis, \.conclusion] {
            if current[keyPath: key] == submitted[keyPath: key] { result[keyPath: key] = acknowledged[keyPath: key] }
        }
        if current.assumptions == submitted.assumptions { result.assumptions = acknowledged.assumptions }
        if current.openQuestions == submitted.openQuestions { result.openQuestions = acknowledged.openQuestions }
        if current.reviewDate == submitted.reviewDate { result.reviewDate = acknowledged.reviewDate }
        if current.links == submitted.links { result.links = acknowledged.links }
        if current.evidence == submitted.evidence {
            result.evidence = acknowledged.evidence
        } else {
            for index in result.evidence.indices {
                let item = result.evidence[index]
                if let original = submitted.evidence.first(where: { $0.id == item.id }), original.source == item.source,
                    let receipt = acknowledged.evidence.first(where: { $0.id == item.id })
                {
                    result.evidence[index].source = receipt.source
                }
            }
        }
        return result
    }
    private func refreshAfterMutation() async {
        let id = selectedId
        async let list: Void = loadList()
        if let id { await loadHistory(id: id) }
        await list
    }
    public func exportAll() async { await export(id: nil) }
    public func exportOne() async { if let id = selectedId { await export(id: id) } }
    private func export(id: String?) async {
        guard active, isOnline else { return }
        clearMessages()
        let visit = visit
        let context = selection
        do {
            let result = try await service.exportDossiers(id: id)
            guard active, visit == self.visit, id == nil || context == selection else { return }
            let data = try result.jsonData()
            let name = id.map { "vision-dossier-" + $0 + ".json" } ?? "vision-dossiers.json"
            if let saveExport {
                _ = try await saveExport(data, name)
            } else {
                exportData = data
                exportFilename = name
            }
        } catch { if active, visit == self.visit, id == nil || context == selection { showError(error) } }
    }
    public func addEvidence() {
        guard (draft?.evidence.count ?? 30) < 30 else { return }
        draft?.evidence.append(.init())
    }
    public func removeEvidence(_ id: String) { draft?.evidence.removeAll { $0.id == id } }
    public func updateSourceDocument(evidenceId: String, documentId: String?) {
        guard let index = draft?.evidence.firstIndex(where: { $0.id == evidenceId }),
            var source = draft?.evidence[index].source
        else { return }
        source.documentId = nil
        source.documentVersion = nil
        source.passageOrdinal = nil
        source.contentSha256 = nil
        if let document = readyDocuments.first(where: { $0.id == documentId }) {
            source.documentId = document.id
            source.documentVersion = document.version
            if source.title.isEmpty { source.title = document.title }
        }
        draft?.evidence[index].source = source
    }
    public func setLines(_ field: ResearchDossierLinesField, raw: String) {
        let lines = raw.components(separatedBy: "\n").filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        switch field {
        case .assumptions: draft?.assumptions = lines
        case .openQuestions: draft?.openQuestions = lines
        }
    }
    public func toggleLink(_ field: ResearchDossierLinkField, id: String) {
        switch field {
        case .savedAnalysisIds:
            if draft?.links.savedAnalysisIds.contains(id) == true {
                draft?.links.savedAnalysisIds.removeAll { $0 == id }
            } else {
                draft?.links.savedAnalysisIds.append(id)
            }
        case .categoryIds, .investmentIds:
            guard let numeric = Int(id), numeric > 0 else { return }
            let key = field == .categoryIds ? \ResearchDossierLinks.categoryIds : \ResearchDossierLinks.investmentIds
            guard var links = draft?.links else { return }
            if links[keyPath: key].contains(numeric) {
                links[keyPath: key].removeAll { $0 == numeric }
            } else {
                links[keyPath: key].append(numeric)
            }
            draft?.links = links
        }
    }
    public func setAccessedAt(evidenceId: String, localValue: String) {
        guard let index = draft?.evidence.firstIndex(where: { $0.id == evidenceId }) else { return }
        if localValue.isEmpty {
            draft?.evidence[index].source.accessedAt = nil
            return
        }
        guard let date = VisionFormat.parseTimestamp(localValue) else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        draft?.evidence[index].source.accessedAt = formatter.string(from: date)
    }
    private func current(visit: UUID, selection: UUID) -> Bool {
        active && visit == self.visit && selection == self.selection
    }
    private func clearMessages() {
        error = nil
        conflict = false
        notice = nil
    }
    private func showError(_ cause: any Error) {
        error = cause.localizedDescription
        if let api = cause as? APIError, case .client(let client) = api {
            conflict = client.status == 409
        } else {
            conflict = false
        }
    }
    private func showNotice(_ key: String) {
        noticeID += 1
        notice = .init(id: noticeID, kind: .success, key: key)
    }
    public func invalidate() {
        invalidateReads()
        hasLoadedPickers = false
    }
    private func invalidateReads() {
        listRevision = UUID()
        detailRevision = UUID()
        historyRevision = UUID()
        pickerRevision = UUID()
        listLoading = false
        detailLoading = false
        historyLoading = false
        pickersLoading = false
    }
    public func didDisappear() {
        active = false
        visit = UUID()
        invalidateReads()
        changeSelection(nil)
        listOffset = 0
        hasListLoaded = false
        hasLoadedPickers = false
        items = []
        total = 0
        categories = []
        investments = []
        analyses = []
        documents = []
        pickerErrors = [:]
        listError = nil
        clearMessages()
        exportData = nil
        exportFilename = nil
    }
    private enum PickerRead: Sendable {
        case categories(Result<[ResearchDossierPickerItem], any Error>)
        case investments(Result<[ResearchDossierPickerItem], any Error>)
        case analyses(Result<[ResearchDossierPickerItem], any Error>)
        case documents(Result<[ResearchDossierDocument], any Error>)
    }
}

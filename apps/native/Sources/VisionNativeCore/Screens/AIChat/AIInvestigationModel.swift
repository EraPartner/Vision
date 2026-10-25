import Foundation
import Observation

@MainActor @Observable public final class AIInvestigationModel {
    public var question = "" { didSet { if question != oldValue { clearPreview() } } }
    public var depthOverride: String? { didSet { if depthOverride != oldValue { clearPreview() } } }
    public var route = "local" { didSet { if route != oldValue { clearPreview() } } }
    public var openAiModelOverride: String? {
        didSet { if openAiModelOverride != oldValue { clearPreview() } }
    }
    public var disclosureMode = "cloud-plan-public" {
        didSet { if disclosureMode != oldValue { clearPreview() } }
    }
    public var selectedSummary = "" { didSet { if selectedSummary != oldValue { clearPreview() } } }
    public var selectedEvidence = "" { didSet { if selectedEvidence != oldValue { clearPreview() } } }
    public var researchMode = "local-only" {
        didSet { if researchMode != oldValue { clearPreview() } }
    }
    public var publicWebQuery = "" { didSet { if publicWebQuery != oldValue { clearPreview() } } }
    public var publicQuestion = "" { didSet { if publicQuestion != oldValue { clearPreview() } } }
    public var publicSymbols = "" { didSet { if publicSymbols != oldValue { clearPreview() } } }
    public var dateFrom = "" { didSet { if dateFrom != oldValue { clearPreview() } } }
    public var dateTo = "" { didSet { if dateTo != oldValue { clearPreview() } } }
    public var clarification = ""
    public private(set) var status: AIResearchStatus?
    public private(set) var job: AIInvestigation?
    public private(set) var preview: AIDisclosurePreview?
    public private(set) var grantId: String?
    public private(set) var recordCount: Int?
    public private(set) var disclosureRecords: [TaxValue] = []
    public private(set) var disclosureGrants: [TaxValue] = []
    public private(set) var documents: [AIResearchDocument] = []
    public private(set) var busy = false
    public private(set) var error: String?
    public var isOnline = true {
        didSet { if isOnline && !oldValue { refreshStatusSoon(initialMount: !pausedStatusRead) } }
    }
    public var isForeground = true {
        didSet { if isForeground && !oldValue && pausedStatusRead { refreshStatusSoon() } }
    }
    public var didReceiveResearch: (@MainActor (NativeSettingsAIReceipt<AIResearchStatus>) -> Void)?
    public var sharedResearchReceipt: NativeSettingsAIReceipt<AIResearchStatus>? {
        guard let status, let statusReadAt else { return nil }
        return .init(value: status, fetchedAt: statusReadAt)
    }
    public func seedSharedResearch(_ value: AIResearchStatus, fetchedAt: Date) {
        guard statusReadAt.map({ fetchedAt > $0 }) ?? true else { return }
        let oldModel = openAiModel
        statusRevision = UUID()
        statusTask?.cancel()
        statusTask = nil
        status = value
        statusReadAt = fetchedAt
        pausedStatusRead = false
        if oldModel != openAiModel { clearPreview() }
    }
    public func invalidateSharedResearch() {
        statusRevision = UUID()
        statusTask?.cancel()
        statusTask = nil
        statusReadAt = nil
        // Query invalidation refetches an active observer even if the Settings writer has unmounted.
        refreshStatusSoon(initialMount: true)
    }
    public var pickDocument: (@MainActor () async throws -> AIResearchDocumentFile?)?
    @ObservationIgnored private let service: any AIInvestigationService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let pollDelay: Duration
    @ObservationIgnored private var settings = NativeAppSettings.defaults
    @ObservationIgnored private var userDefaultModel: String?
    @ObservationIgnored private var active = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var previewRevision = UUID()
    @ObservationIgnored private var jobRevision = UUID()
    @ObservationIgnored private var historyRevision = UUID()
    @ObservationIgnored private var documentRevision = UUID()
    @ObservationIgnored private var busyCount = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var statusRevision = UUID()
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var statusReadAt: Date?
    @ObservationIgnored private var pausedStatusRead = false

    public init(
        service: any AIInvestigationService, pollDelay: Duration = .milliseconds(1200),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.pollDelay = pollDelay
        self.now = now
    }
    public var depth: String {
        depthOverride
            ?? (["quick", "detailed"].contains(settings.aiAnswerDepth) ? settings.aiAnswerDepth : "quick")
    }
    public var resolvedCurrency: String {
        settings.defaultCurrency.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil
            ? settings.defaultCurrency : "EUR"
    }
    public var resolvedBenchmark: String? {
        guard let raw = settings.analysisBenchmark else { return nil }
        let value = trim(raw).uppercased()
        return value.range(of: #"^[A-Z0-9][A-Z0-9._:-]{0,31}$"#, options: .regularExpression) != nil
            ? value : nil
    }
    public var language: String { settings.language == "nl" ? "nl" : "en" }
    public var openAiModels: [OpenAIResearchModel] { status?.openAiModels ?? [] }
    public var openAiEnabled: Bool { status?.openAiEnabled ?? false }
    public var openAiModel: String {
        let allowed = Set(openAiModels.map(\.id))
        return [openAiModelOverride, userDefaultModel, status?.openAiModel].compactMap { $0 }.first {
            !$0.isEmpty && allowed.contains($0)
        } ?? openAiModels.first?.id ?? ""
    }
    public var selectedOpenAiModel: OpenAIResearchModel? {
        openAiModels.first { $0.id == openAiModel }
    }
    public var runDisabled: Bool {
        busy || trim(question).isEmpty
            || (researchMode == "public-web" && trim(publicWebQuery).isEmpty)
            || (researchMode == "public-providers" && trim(publicSymbols).isEmpty)
            || (route == "openai-api" && (!openAiEnabled || openAiModel.isEmpty))
            || (route == "openai-api" && disclosureMode == "cloud-plan-public"
                && trim(publicQuestion).isEmpty)
            || (route == "openai-api" && disclosureMode == "selected-summary"
                && trim(selectedSummary).isEmpty)
            || (route == "openai-api" && disclosureMode == "cloud-synthesis-selected"
                && trim(selectedEvidence).isEmpty)
    }
    public var canClarify: Bool { !trim(clarification).isEmpty }
    public var canCancel: Bool {
        job.map { !["completed", "failed", "cancelled", "partial"].contains($0.state) } ?? false
    }
    public var canResume: Bool { job.map { ["partial", "failed"].contains($0.state) } ?? false }
    public var settingsSummary: [String] {
        [
            route == "local" ? "aiResearch.localModel" : "aiResearch.openAi",
            depth == "quick" ? "aiResearch.quick" : "aiResearch.detailed",
            researchMode == "local-only"
                ? "aiResearch.localOnly"
                : researchMode == "public-web" ? "aiResearch.publicWeb" : "aiResearch.publicProviders",
        ]
    }
    public func configure(settings: NativeAppSettings, openAiDefaultModel: String? = nil) {
        let oldContext = input()
        self.settings = settings
        userDefaultModel = openAiDefaultModel ?? settings.openAiDefaultModel
        if oldContext != input() { clearPreview() }
    }
    public func load(force: Bool = false) async {
        if active {
            if let loadTask {
                await loadTask.value
                return
            }
            if force { await refreshStatusIfStale() }
            return
        }
        active = true
        visit = UUID()
        let scope = visit
        let documentsScope = documentRevision
        let task = Task { [weak self] in
            guard let self, active, visit == scope, !Task.isCancelled else { return }
            async let documentRead = readDocuments(visit: scope)
            await refreshStatusIfStale(initialMount: true)
            let newDocuments = await documentRead
            guard active, visit == scope else { return }
            if let newDocuments, documentRevision == documentsScope { documents = newDocuments }
        }
        loadTask = task
        await task.value
        if active, visit == scope { loadTask = nil }
    }
    /// Only status uses the source TanStack focus/reconnect policy. The job poll is a manual interval.
    public func refreshStatusIfStale(initialMount: Bool = false) async {
        guard active else { return }
        if let statusTask {
            await statusTask.value
            return
        }
        guard statusReadAt.map({ now().timeIntervalSince($0) >= 60 }) ?? true else { return }
        guard isOnline else {
            pausedStatusRead = true
            return
        }
        guard initialMount || isForeground else { return }
        pausedStatusRead = false
        let scope = visit
        let revision = UUID()
        statusRevision = revision
        let task = Task { [weak self] in
            guard let self, active, visit == scope, statusRevision == revision, !Task.isCancelled else { return }
            do {
                let response = try await service.investigationStatus()
                guard active, visit == scope, statusRevision == revision, !Task.isCancelled else { return }
                let oldModel = openAiModel
                status = response
                statusReadAt = now()
                if let receipt = sharedResearchReceipt { didReceiveResearch?(receipt) }
                if oldModel != openAiModel { clearPreview() }
            } catch {
                // useAiResearchStatus has retry: 0 and no source error banner.
            }
        }
        statusTask = task
        await task.value
        if active, visit == scope, statusRevision == revision { statusTask = nil }
    }
    private func readDocuments(visit scope: UUID) async -> [AIResearchDocument]? {
        guard active, visit == scope, !Task.isCancelled else { return nil }
        return try? await service.investigationDocuments()
    }
    private func refreshStatusSoon(initialMount: Bool = false) {
        guard active else { return }
        let scope = visit
        Task { [weak self] in
            guard let self, active, visit == scope, !Task.isCancelled else { return }
            await refreshStatusIfStale(initialMount: initialMount)
        }
    }
    public func didDisappear() {
        active = false
        visit = UUID()
        jobRevision = UUID()
        historyRevision = UUID()
        documentRevision = UUID()
        pollTask?.cancel()
        pollTask = nil
        loadTask?.cancel()
        loadTask = nil
        statusRevision = UUID()
        statusTask?.cancel()
        statusTask = nil
        pausedStatusRead = false
        question = ""
        depthOverride = nil
        route = "local"
        openAiModelOverride = nil
        disclosureMode = "cloud-plan-public"
        selectedSummary = ""
        selectedEvidence = ""
        researchMode = "local-only"
        publicWebQuery = ""
        publicQuestion = ""
        publicSymbols = ""
        dateFrom = ""
        dateTo = ""
        clarification = ""
        job = nil
        preview = nil
        grantId = nil
        recordCount = nil
        disclosureRecords = []
        disclosureGrants = []
        documents = []
        busyCount = 0
        busy = false
        error = nil
        clearPreview()
    }
    /// Identical source scope and disclosure fields. Evidence is an inspected string, not reinterpreted JSON.
    public func input() -> TaxValue {
        .object([
            "question": .string(trim(question)), "route": .string(route),
            "researchMode": .string(researchMode),
            "publicQuestion": optional(
                route == "openai-api" && disclosureMode == "cloud-plan-public" ? trim(publicQuestion) : nil),
            "publicWebQuery": optional(researchMode == "public-web" ? trim(publicWebQuery) : nil),
            "publicSymbols": .array(
                researchMode == "public-providers"
                    ? publicSymbols.split(separator: ",", omittingEmptySubsequences: false).map {
                        trim(String($0)).uppercased()
                    }.filter { !$0.isEmpty }.prefix(3).map { .string($0) } : []),
            "publicMacroQueries": .array([]), "clarification": .null,
            "model": optional(route == "openai-api" && !openAiModel.isEmpty ? openAiModel : nil),
            "depth": .string(depth), "language": .string(language), "scope": scope(), "grantId": .null,
            "selectedSummary": optional(
                route == "openai-api" && disclosureMode == "selected-summary" ? trim(selectedSummary) : nil),
            "selectedEvidence": optional(
                route == "openai-api" && disclosureMode == "cloud-synthesis-selected"
                    ? trim(selectedEvidence) : nil),
            "referenceScopeId": .null, "savedAnalysisId": .null,
        ])
    }
    public func scope() -> TaxValue {
        .object([
            "workspaces": .array([.string("cross-workspace")]), "accountIds": .array([]),
            "investmentIds": .array([]),
            "dateFrom": optional(dateFrom.isEmpty ? nil : dateFrom),
            "dateTo": optional(dateTo.isEmpty ? nil : dateTo),
            "currency": .string(resolvedCurrency),
            "constraints": .array(resolvedBenchmark.map { [.string("benchmark:" + $0)] } ?? []),
        ])
    }
    public func run() async {
        guard active, !runDisabled else { return }
        let scope = visit
        let previewScope = previewRevision
        let request = input()
        let capturedPreview = preview
        let capturedMode = disclosureMode
        let capturedDepth = depth
        beginBusy()
        error = nil
        defer { endBusy(visit: scope) }
        do {
            var outgoing = request
            if route == "openai-api" {
                guard let capturedPreview else {
                    let response = try await service.investigationPreview(request)
                    if active, visit == scope, previewRevision == previewScope { preview = response }
                    return
                }
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let grant = try await service.investigationGrant(
                    .object([
                        "route": .string("openai-api"), "mode": .string(capturedMode),
                        "purpose": .string(
                            capturedMode == "cloud-synthesis-selected"
                                ? "Synthesize an answer from this inspected selected evidence"
                                : "Plan this inspected investigation question"),
                        "previewHash": .string(capturedPreview.payloadSha256),
                        "allowedFields": .array(capturedPreview.fieldManifest.map { .string($0) }),
                        "maxRequests": .number(3),
                        "maxInputCharacters": .number(Decimal(max(100, capturedPreview.payloadBytes * 2))),
                        "maxOutputTokens": .number(capturedDepth == "detailed" ? 7200 : 2700),
                        "maxCostMicros": .number(2_000_000),
                        "maxDisclosureUnits": .number(Decimal(capturedPreview.disclosureUnits.count)),
                        "expiresAt": .string(formatter.string(from: now().addingTimeInterval(15 * 60))),
                        "retainExactPayload": .bool(false),
                    ]))
                if active, visit == scope { grantId = grant }
                guard var frozen = capturedPreview.outboundRequest.objectValue else {
                    throw ResearchDecode.failure("Invalid frozen disclosure request")
                }
                frozen["grantId"] = .string(grant)
                outgoing = .object(frozen)
            }
            let result = try await service.investigationCreate(outgoing)
            guard active, visit == scope else { return }
            setJob(result)
        } catch { if active, visit == scope { self.error = error.localizedDescription } }
    }
    public func uploadPickedDocument() async {
        guard active, !busy else { return }
        let scope = visit
        do {
            guard let pickDocument, let file = try await pickDocument(), active, visit == scope else {
                return
            }
            await uploadDocument(file)
        } catch { if active, visit == scope { self.error = error.localizedDescription } }
    }
    public func uploadDocument(_ file: AIResearchDocumentFile) async {
        guard active, !busy else { return }
        let scope = visit
        beginBusy()
        documentRevision = UUID()
        defer { endBusy(visit: scope) }
        do {
            let document = try await service.investigationUpload(file)
            guard active, visit == scope else { return }
            documents.insert(document, at: 0)
        } catch { if active, visit == scope { self.error = error.localizedDescription } }
    }
    public func deleteDocumentConfirmed(_ id: String) async {
        guard active else { return }
        let scope = visit
        documentRevision = UUID()
        do {
            try await service.investigationDeleteDocument(id: id)
            if active, visit == scope { documents.removeAll { $0.id == id } }
        } catch { if active, visit == scope { self.error = error.localizedDescription } }
    }
    /// Source Cancel ignores the returned job and lets the existing poll observe cancellation.
    public func cancel() async {
        guard active, let job, canCancel else { return }
        let scope = visit
        do { _ = try await service.investigationCancel(id: job.id) } catch {
            if active, visit == scope { self.error = error.localizedDescription }
        }
    }
    public func resume(clarification supplied: String? = nil) async {
        guard active, let job else { return }
        let text = supplied ?? (job.state == "waiting" ? trim(clarification) : "Refresh local evidence")
        guard !text.isEmpty else { return }
        let scope = visit
        let id = job.id
        let revision = UUID()
        jobRevision = revision
        pollTask?.cancel()
        pollTask = nil
        do {
            let response = try await service.investigationResume(
                id: id, clarification: text, scope: self.scope())
            guard active, visit == scope, jobRevision == revision, self.job?.id == id else { return }
            setJob(response)
        } catch {
            if active, visit == scope, jobRevision == revision, self.job?.id == id {
                self.error = error.localizedDescription
                startPolling()
            }
        }
    }
    public func deleteJob() async {
        guard active, let job else { return }
        let scope = visit
        let revision = UUID()
        jobRevision = revision
        pollTask?.cancel()
        pollTask = nil
        beginBusy()
        error = nil
        defer { endBusy(visit: scope) }
        do {
            try await service.investigationDelete(id: job.id)
            if active, visit == scope, jobRevision == revision, self.job?.id == job.id { self.job = nil }
        } catch {
            if active, visit == scope, jobRevision == revision, self.job?.id == job.id {
                self.error = error.localizedDescription
                startPolling()
            }
        }
    }
    public func loadHistory() async {
        guard active else { return }
        let scope = visit
        let revision = UUID()
        historyRevision = revision
        do {
            async let records = service.investigationRecords()
            async let grants = service.investigationGrants()
            let (r, g) = try await (records, grants)
            guard active, visit == scope, historyRevision == revision else { return }
            recordCount = try ResearchDecode.count(r["total"])
            disclosureRecords = try AIInvestigationDecode.array(r["items"])
            disclosureGrants = try AIInvestigationDecode.array(g["items"])
        } catch {
            if active, visit == scope, historyRevision == revision {
                self.error = error.localizedDescription
            }
        }
    }
    public func deleteHistory() async {
        guard active else { return }
        let scope = visit
        historyRevision = UUID()
        do {
            try await service.investigationDeleteHistory()
            guard active, visit == scope else { return }
            historyRevision = UUID()
            recordCount = 0
            disclosureRecords = []
            disclosureGrants = []
            grantId = nil
        } catch {
            if active, visit == scope {
                historyRevision = UUID()
                self.error = error.localizedDescription
            }
        }
    }
    public func revokeActiveGrant() async {
        guard let grantId else { return }
        await revoke(grantId, updateHistory: false, clearActive: true)
    }
    public func revokeGrant(_ id: String) async {
        await revoke(id, updateHistory: true, clearActive: false)
    }
    private func revoke(_ id: String, updateHistory: Bool, clearActive: Bool) async {
        guard active else { return }
        let scope = visit
        historyRevision = UUID()
        do {
            try await service.investigationRevoke(id: id)
            guard active, visit == scope else { return }
            historyRevision = UUID()
            if clearActive, grantId == id { grantId = nil }
            if updateHistory {
                let formatter = ISO8601DateFormatter()
                disclosureGrants = disclosureGrants.map { item in
                    guard item["id"] == .string(id), var fields = item.objectValue else { return item }
                    fields["revoked_at"] = .string(formatter.string(from: now()))
                    return .object(fields)
                }
            }
        } catch {
            if active, visit == scope {
                historyRevision = UUID()
                self.error = error.localizedDescription
            }
        }
    }
    private func setJob(_ value: AIInvestigation) {
        jobRevision = UUID()
        job = value
        startPolling()
    }
    private func startPolling() {
        pollTask?.cancel()
        pollTask = nil
        guard active, let job,
            !["completed", "failed", "cancelled", "partial", "waiting"].contains(job.state)
        else { return }
        let scope = visit
        let revision = jobRevision
        let id = job.id
        pollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: pollDelay) } catch { return }
                guard active, visit == scope, jobRevision == revision, self.job?.id == id else { return }
                Task { [weak self] in await self?.pollJob(visit: scope, revision: revision, id: id) }
            }
        }
    }
    private func pollJob(visit scope: UUID, revision: UUID, id: String) async {
        guard active, visit == scope, jobRevision == revision, job?.id == id, !Task.isCancelled else { return }
        do {
            let value = try await service.investigationGet(id: id)
            guard active, visit == scope, jobRevision == revision, job?.id == id, !Task.isCancelled else { return }
            // React's job dependency restarts its interval on each published snapshot.
            // Prior interval reads lose authority; a slow read does not postpone the next tick.
            setJob(value)
        } catch {
            // Source polling failures are silent; independent interval ticks continue.
        }
    }
    private func clearPreview() {
        preview = nil
        previewRevision = UUID()
    }
    private func beginBusy() {
        busyCount += 1
        busy = true
    }
    private func endBusy(visit scope: UUID) {
        guard visit == scope else { return }
        busyCount = max(0, busyCount - 1)
        busy = busyCount > 0
    }
    private func trim(_ value: String) -> String {
        value.trimmingCharacters(
            in: CharacterSet(
                charactersIn:
                    "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
            ))
    }
    private func optional(_ value: String?) -> TaxValue { value.map { .string($0) } ?? .null }
}

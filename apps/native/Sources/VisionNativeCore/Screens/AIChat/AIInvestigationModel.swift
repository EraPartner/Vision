import Foundation
import Observation

/// Local-only investigations (ADR-229): the route is fixed to the configured Ollama endpoint, so there is
/// no cloud model, disclosure preview, grant or record state.
@MainActor @Observable public final class AIInvestigationModel {
    public var question = ""
    public var depthOverride: String?
    public var researchMode = "local-only"
    public var publicWebQuery = ""
    public var publicSymbols = ""
    public var dateFrom = ""
    public var dateTo = ""
    public var clarification = ""
    public private(set) var job: AIInvestigation?
    public private(set) var documents: [AIResearchDocument] = []
    public private(set) var busy = false
    public private(set) var error: String?
    public var pickDocument: (@MainActor () async throws -> AIResearchDocumentFile?)?
    @ObservationIgnored private let service: any AIInvestigationService
    @ObservationIgnored private let pollDelay: Duration
    @ObservationIgnored private var settings = NativeAppSettings.defaults
    @ObservationIgnored private var active = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var jobRevision = UUID()
    @ObservationIgnored private var documentRevision = UUID()
    @ObservationIgnored private var busyCount = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    public init(service: any AIInvestigationService, pollDelay: Duration = .milliseconds(1200)) {
        self.service = service
        self.pollDelay = pollDelay
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
    public var runDisabled: Bool {
        busy || trim(question).isEmpty
            || (researchMode == "public-web" && trim(publicWebQuery).isEmpty)
            || (researchMode == "public-providers" && trim(publicSymbols).isEmpty)
    }
    public var canClarify: Bool { !trim(clarification).isEmpty }
    public var canCancel: Bool {
        job.map { !["completed", "failed", "cancelled", "partial"].contains($0.state) } ?? false
    }
    public var canResume: Bool { job.map { ["partial", "failed"].contains($0.state) } ?? false }
    public var settingsSummary: [String] {
        [
            "aiResearch.localModel",
            depth == "quick" ? "aiResearch.quick" : "aiResearch.detailed",
            researchMode == "local-only"
                ? "aiResearch.localOnly"
                : researchMode == "public-web" ? "aiResearch.publicWeb" : "aiResearch.publicProviders",
        ]
    }
    public func configure(settings: NativeAppSettings) {
        self.settings = settings
    }
    public func load() async {
        if active {
            if let loadTask { await loadTask.value }
            return
        }
        active = true
        visit = UUID()
        let scope = visit
        let documentsScope = documentRevision
        let task = Task { [weak self] in
            guard let self, active, visit == scope, !Task.isCancelled else { return }
            let newDocuments = await readDocuments(visit: scope)
            guard active, visit == scope else { return }
            if let newDocuments, documentRevision == documentsScope { documents = newDocuments }
        }
        loadTask = task
        await task.value
        if active, visit == scope { loadTask = nil }
    }
    private func readDocuments(visit scope: UUID) async -> [AIResearchDocument]? {
        guard active, visit == scope, !Task.isCancelled else { return nil }
        return try? await service.investigationDocuments()
    }
    public func didDisappear() {
        active = false
        visit = UUID()
        jobRevision = UUID()
        documentRevision = UUID()
        pollTask?.cancel()
        pollTask = nil
        loadTask?.cancel()
        loadTask = nil
        question = ""
        depthOverride = nil
        researchMode = "local-only"
        publicWebQuery = ""
        publicSymbols = ""
        dateFrom = ""
        dateTo = ""
        clarification = ""
        job = nil
        documents = []
        busyCount = 0
        busy = false
        error = nil
    }
    /// Identical source scope fields; the route is always the local Ollama endpoint.
    public func input() -> TaxValue {
        .object([
            "question": .string(trim(question)), "route": .string("local"),
            "researchMode": .string(researchMode),
            "publicWebQuery": optional(researchMode == "public-web" ? trim(publicWebQuery) : nil),
            "publicSymbols": .array(
                researchMode == "public-providers"
                    ? publicSymbols.split(separator: ",", omittingEmptySubsequences: false).map {
                        trim(String($0)).uppercased()
                    }.filter { !$0.isEmpty }.prefix(3).map { .string($0) } : []),
            "publicMacroQueries": .array([]), "clarification": .null, "model": .null,
            "depth": .string(depth), "language": .string(language), "scope": scope(),
            "savedAnalysisId": .null,
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
        let request = input()
        beginBusy()
        error = nil
        defer { endBusy(visit: scope) }
        do {
            let result = try await service.investigationCreate(request)
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

import Foundation
import Observation

public struct AnalysisPreferences: Equatable, Sendable {
    public let currency: String
    public let benchmark: String?
    public let answerDepth: String
    public let language: String
}
@MainActor public protocol AnalysisSQLHistoryStore {
    func read() async -> [String]
    func write(_ entries: [String]) async
}
@MainActor public final class AnalysisMemorySQLHistoryStore: AnalysisSQLHistoryStore {
    public var entries: [String] = []
    public init() {}
    public func read() async -> [String] { entries }
    public func write(_ entries: [String]) async { self.entries = entries }
}
@MainActor public final class AnalysisClosureSQLHistoryStore: AnalysisSQLHistoryStore {
    private let reader: @MainActor () async -> Data?
    private let writer: @MainActor (Data) async -> Void
    public init(read: @escaping @MainActor () async -> Data?, write: @escaping @MainActor (Data) async -> Void) {
        reader = read
        writer = write
    }
    public func read() async -> [String] {
        guard let data = await reader(), let values = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return Array(values.prefix(10))
    }
    public func write(_ entries: [String]) async {
        if let data = try? APIBody.encode(Array(entries.prefix(10))) { await writer(data) }
    }
}

@MainActor @Observable
public final class AnalysisModel {
    public static let sqlHistoryKey = "vision.analysis.sqlHistory"
    public var workspace: AnalysisWorkspace = .budgeting {
        didSet {
            if workspace != oldValue {
                changed()
                queueLibrary()
            }
        }
    }
    public var mode: AnalysisMode = .visual { didSet { if mode != oldValue { changed(query: true) } } }
    public var plan: AnalysisPlan = .example { didSet { if plan != oldValue { changed(query: true) } } }
    public var sql = "" { didSet { if sql != oldValue { changed(query: true) } } }
    public var sqlValues = "[]" { didSet { if sqlValues != oldValue { changed(query: true) } } }
    public var sqlDatasets = ["cash-flows"] { didSet { if sqlDatasets != oldValue { changed(query: true) } } }
    public var name = "" { didSet { if name != oldValue { changed() } } }
    public var sourceReferences = "" { didSet { if sourceReferences != oldValue { changed() } } }
    public var formulasJson = "[]" { didSet { if formulasJson != oldValue { changed() } } }
    public var assumptionsJson = "[]" { didSet { if assumptionsJson != oldValue { changed() } } }
    public var assumptionValuesJson = "{}" { didSet { if assumptionValuesJson != oldValue { changed() } } }
    public var workbench: TaxValue = .object([:]) { didSet { if workbench != oldValue { changed() } } }
    public var scenarioModel: TaxValue = .object(["attachments": .array([]), "joins": .array([])]) {
        didSet { if scenarioModel != oldValue { changed() } }
    }
    public var chartSpec: TaxValue = .object(["kind": .string("bar"), "x": .string(""), "y": .array([])]) {
        didSet { if chartSpec != oldValue { changed() } }
    }
    public var pivotConfig = AnalysisPivotConfig() {
        didSet {
            if pivotConfig != oldValue {
                invalidateQueryReads()
                changed()
            }
        }
    }
    public var runCurrency = "" { didSet { if runCurrency != oldValue { changed() } } }
    public var runBenchmark = "" { didSet { if runBenchmark != oldValue { changed() } } }
    public var runWithoutBenchmark = false { didSet { if runWithoutBenchmark != oldValue { changed() } } }
    public var runAnswerDepth = "" { didSet { if runAnswerDepth != oldValue { changed() } } }
    public var runLanguage = "" { didSet { if runLanguage != oldValue { changed() } } }
    public var proposalJson = "" {
        didSet {
            if proposalJson != oldValue {
                proposalRevision = UUID()
                isProposalLoading = false
                proposalPreview = nil
            }
        }
    }
    public private(set) var catalog: AnalysisCatalog?
    public private(set) var saved: [AnalysisSaved] = []
    public private(set) var selectedSaved: AnalysisSaved?
    public private(set) var versions: [AnalysisSavedVersion]?
    public private(set) var versionsLoading = false
    public private(set) var proposalPreview: AnalysisProposalPreview?
    public private(set) var isProposalLoading = false
    public private(set) var result: AnalysisResult?
    public private(set) var lastUsableResult: AnalysisResult?
    public private(set) var drillResult: AnalysisResult?
    public private(set) var pivotResult: AnalysisPivotResult?
    public private(set) var isPivotLoading = false
    public private(set) var pivotError: String?
    public private(set) var isDrillLoading = false
    public private(set) var activeRequest: String? {
        didSet { if activeRequest != oldValue && !batching { didChange?() } }
    }
    public private(set) var error: String?
    public private(set) var catalogError: String?
    public private(set) var savedError: String?
    public private(set) var savedFeedback: AnalysisFeedback?
    public private(set) var isCatalogLoading = false
    public private(set) var isSavedLoading = false
    public private(set) var savedAction = false
    public private(set) var isSaving = false
    public private(set) var offset = 0
    public private(set) var sqlHistory: [String] = []
    public private(set) var resultDatasetId: String?
    public private(set) var exportInputsKnown = false
    public private(set) var resultInputs = AnalysisResultInputs(
        formulasJson: "[]", assumptionsJson: "[]", assumptionValuesJson: "{}", workbench: .object([:]),
        scenarioModel: .object(["attachments": .array([]), "joins": .array([])]))
    public private(set) var exportContext: AnalysisExportContext?
    public private(set) var draftRevision = 0
    public private(set) var resultRevision = 0
    public private(set) var isInterchangeBusy = false
    public private(set) var interchangeError: String?
    public var saveExport: (@MainActor (Data, String) async throws -> Bool)?
    public var didChange: (@MainActor () -> Void)?
    public var didMutate: (@MainActor () async -> Void)?
    public var datasets: [AnalysisDataset] { catalog?.datasets ?? [] }
    public var dataset: AnalysisDataset? { datasets.first { $0.id == plan.datasetId } }
    public var displayedResult: AnalysisResult? { result ?? lastUsableResult }
    public var queryOutdated: Bool { resultQuery.map { $0 != querySignature } ?? false }
    public var transformationsOutdated: Bool { resultInputs != currentInputs }
    public var canSave: Bool {
        displayedResult != nil && !savedAction && !isSaving
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    public var canExport: Bool {
        displayedResult != nil && exportInputsKnown && !queryOutdated && !transformationsOutdated && !isInterchangeBusy
    }
    public var workbenchSourceStale: Bool {
        queryOutdated || activeRequest != nil || resultInputs.scenarioModel != scenarioModel
    }
    public var workbenchContext: String { querySignature + "|" + selectedEpoch.uuidString }
    public var effectivePreferences: AnalysisPreferences {
        let saved = selectedSaved?.parameters
        func currency(_ value: String?) -> String? {
            value?.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil ? value : nil
        }
        func benchmark(_ value: TaxValue?) -> String? {
            let text = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            return text?.range(of: "^[A-Z0-9][A-Z0-9._:-]{0,31}$", options: .regularExpression) != nil ? text : nil
        }
        let chosenBenchmark: String?
        if runWithoutBenchmark {
            chosenBenchmark = nil
        } else if let run = benchmark(.string(runBenchmark)) {
            chosenBenchmark = run
        } else if saved?["benchmark"] == .null {
            chosenBenchmark = nil
        } else {
            chosenBenchmark = benchmark(saved?["benchmark"]) ?? benchmark(applicationPreferences["benchmark"])
        }
        let depth =
            [
                runAnswerDepth, saved?["answerDepth"]?.stringValue ?? "",
                applicationPreferences["answerDepth"]?.stringValue ?? "",
            ].first { ["quick", "detailed"].contains($0) } ?? "quick"
        let language =
            [runLanguage, saved?["language"]?.stringValue ?? "", applicationPreferences["language"]?.stringValue ?? ""]
            .first { ["en", "nl"].contains($0) } ?? "en"
        return .init(
            currency: currency(runCurrency) ?? currency(saved?["currency"]?.stringValue) ?? currency(
                settings.defaultCurrency) ?? "EUR", benchmark: chosenBenchmark, answerDepth: depth, language: language)
    }
    @ObservationIgnored private let service: any AnalysisService
    @ObservationIgnored private let historyStore: any AnalysisSQLHistoryStore
    @ObservationIgnored private var historyLoaded = false
    @ObservationIgnored private var historyLoading = false
    @ObservationIgnored private var historyWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var historyTask: Task<Void, Never>?
    private var settings = NativeAppSettings.defaults
    private var applicationPreferences: TaxValue = .object([:])
    @ObservationIgnored private var timezone = TimeZone.current.identifier
    @ObservationIgnored private var batching = false
    @ObservationIgnored private var runRevision = UUID()
    @ObservationIgnored private var libraryRevision = UUID()
    @ObservationIgnored private var catalogRevision = UUID()
    @ObservationIgnored private var proposalRevision = UUID()
    @ObservationIgnored private var drillRevision = UUID()
    @ObservationIgnored private var pivotRevision = UUID()
    @ObservationIgnored private var selectedEpoch = UUID()
    @ObservationIgnored private var resultQuery: String?
    @ObservationIgnored private var visualOrigin: AnalysisPlan?
    @ObservationIgnored private var requestedSavedId: String?
    public init(
        service: any AnalysisService, historyStore: any AnalysisSQLHistoryStore = AnalysisMemorySQLHistoryStore()
    ) {
        self.service = service
        self.historyStore = historyStore
    }
    public func configure(
        settings: NativeAppSettings, timezone: String = TimeZone.current.identifier,
        applicationPreferences: TaxValue? = nil
    ) {
        self.settings = settings
        self.timezone = timezone
        self.applicationPreferences =
            applicationPreferences
            ?? .object([
                "benchmark": settings.analysisBenchmark.map(TaxValue.string) ?? .null,
                "answerDepth": .string(settings.aiAnswerDepth), "language": .string(settings.language),
            ])
    }
    private var currentInputs: AnalysisResultInputs {
        .init(
            formulasJson: formulasJson, assumptionsJson: assumptionsJson, assumptionValuesJson: assumptionValuesJson,
            workbench: workbench, scenarioModel: scenarioModel)
    }
    private var querySignature: String {
        signature(
            mode == .visual
                ? .object(["mode": .string(mode.rawValue), "plan": (try? TaxValue(encoding: plan)) ?? .null])
                : .object([
                    "mode": .string(mode.rawValue), "sql": .string(sql), "values": .string(sqlValues),
                    "datasets": .array(sqlDatasets.map(TaxValue.string)),
                ]))
    }
    private var executionSignature: String {
        signature(
            .object([
                "query": .string(querySignature), "formulas": .string(formulasJson),
                "assumptions": .string(assumptionsJson), "values": .string(assumptionValuesJson),
                "workbench": workbench, "scenarioModel": scenarioModel,
            ]))
    }
    private var draftSignature: String {
        executionSignature
            + signature(
                .object([
                    "name": .string(name), "workspace": .string(workspace.rawValue), "chart": chartSpec,
                    "pivot": (try? TaxValue(encoding: pivotConfig)) ?? .null, "references": .string(sourceReferences),
                    "runCurrency": .string(runCurrency), "runBenchmark": .string(runBenchmark),
                    "runWithoutBenchmark": .bool(runWithoutBenchmark), "runAnswerDepth": .string(runAnswerDepth),
                    "runLanguage": .string(runLanguage), "applicationPreferences": applicationPreferences,
                    "defaultCurrency": .string(settings.defaultCurrency),
                ]))
    }
    private func signature(_ value: TaxValue) -> String {
        (try? String(decoding: APIBody.encode(value), as: UTF8.self)) ?? "invalid"
    }
    private func invalidateQueryReads() {
        drillRevision = UUID()
        drillResult = nil
        isDrillLoading = false
        pivotRevision = UUID()
        pivotResult = nil
        isPivotLoading = false
    }
    private func changed(query: Bool = false) {
        guard !batching else { return }
        draftRevision += 1
        proposalPreview = nil
        proposalRevision = UUID()
        isProposalLoading = false
        if query { invalidateQueryReads() }
        didChange?()
    }
    public func load(force: Bool = false, route: NativeRoute? = nil) async {
        if let route { requestedSavedId = route.value("savedAnalysis") }
        let epoch = selectedEpoch
        await restoreHistory()
        guard epoch == selectedEpoch else { return }
        async let catalog: Void = loadCatalog(force: force)
        async let saved: Void = loadSavedList()
        _ = await (catalog, saved)
        guard epoch == selectedEpoch else { return }
        if let id = requestedSavedId, selectedSaved?.id != id, let saved = self.saved.first(where: { $0.id == id }) {
            selectSaved(saved)
        }
    }
    public func loadCatalog(force: Bool = false) async {
        guard force || catalog == nil else { return }
        let generation = UUID()
        catalogRevision = generation
        isCatalogLoading = true
        catalogError = nil
        defer { if generation == catalogRevision { isCatalogLoading = false } }
        do {
            let value = try await service.analysisCatalog()
            guard generation == catalogRevision else { return }
            catalog = value
            prunePlan()
        } catch { if generation == catalogRevision { catalogError = error.localizedDescription } }
    }
    public func loadSavedList() async {
        let generation = UUID()
        libraryRevision = generation
        let workspace = workspace
        isSavedLoading = true
        savedError = nil
        defer { if generation == libraryRevision { isSavedLoading = false } }
        do {
            let value = try await service.analysisSaved(workspace: workspace)
            guard generation == libraryRevision, workspace == self.workspace else { return }
            saved = value
        } catch { if generation == libraryRevision { savedError = error.localizedDescription } }
    }
    private func queueLibrary() {
        guard !batching else { return }
        Task { [weak self] in await self?.loadSavedList() }
    }
    public func invalidate() {
        catalogRevision = UUID()
        libraryRevision = UUID()
        runRevision = UUID()
        proposalRevision = UUID()
        isProposalLoading = false
        invalidateQueryReads()
        activeRequest = nil
        proposalPreview = nil
        Task { [weak self] in await self?.load(force: true) }
    }
    public func resetForVisit() {
        let request = activeRequest
        batching = true
        resetSource()
        workspace = .budgeting
        mode = .visual
        plan = .example
        sql = ""
        sqlValues = "[]"
        sqlDatasets = ["cash-flows"]
        name = ""
        sourceReferences = ""
        formulasJson = "[]"
        assumptionsJson = "[]"
        assumptionValuesJson = "{}"
        workbench = .object([:])
        scenarioModel = .object(["attachments": .array([]), "joins": .array([])])
        chartSpec = .object(["kind": .string("bar"), "x": .string(""), "y": .array([])])
        pivotConfig = AnalysisPivotConfig()
        runCurrency = ""
        runBenchmark = ""
        runWithoutBenchmark = false
        runAnswerDepth = ""
        runLanguage = ""
        proposalJson = ""
        drillResult = nil
        pivotResult = nil
        resultDatasetId = nil
        offset = 0
        requestedSavedId = nil
        interchangeError = nil
        catalogRevision = UUID()
        libraryRevision = UUID()
        proposalRevision = UUID()
        drillRevision = UUID()
        pivotRevision = UUID()
        isCatalogLoading = false
        isSavedLoading = false
        isProposalLoading = false
        isDrillLoading = false
        isPivotLoading = false
        catalogError = nil
        savedError = nil
        resultInputs = currentInputs
        batching = false
        changed(query: true)
        if let request {
            let service = service
            Task { _ = try? await service.analysisCancel(requestId: request) }
        }
    }
    public func refreshHistoryForVisit() async {
        await flushHistory()
        await restoreHistory()
        historyLoaded = false
        await restoreHistory()
    }
    public func setMode(_ mode: AnalysisMode) {
        if mode == .sql {
            if sql.isEmpty { sql = displayedResult?.generatedSql ?? "" }
            visualOrigin = plan
            sqlDatasets = [plan.datasetId] + (plan.joins.isEmpty ? [] : ["accounts"])
        }
        self.mode = mode
    }
    public func selectDataset(_ id: String) {
        var next = AnalysisPlan.example
        next.datasetId = id
        plan = next
        prunePlan()
    }
    private func prunePlan() {
        guard let dataset else { return }
        let fields = Set(dataset.fields.map(\.id))
        var next = plan
        next.fields.removeAll { !fields.contains($0) }
        next.groups.removeAll { !fields.contains($0) }
        next.filters.removeAll { !fields.contains($0.fieldId) }
        next.measures.removeAll { id in !dataset.measures.contains { $0.id == id } }
        next.joins.removeAll { id in !dataset.joins.contains { $0.id == id } }
        plan = next
    }
    private func toggle(_ values: [String], _ id: String, _ selected: Bool) -> [String] {
        selected ? (values.contains(id) ? values : values + [id]) : values.filter { $0 != id }
    }
    public func toggleField(_ id: String, _ selected: Bool) {
        plan.fields = toggle(plan.fields, id, selected)
        if !selected { plan.groups.removeAll { $0 == id } }
    }
    public func toggleMeasure(_ id: String, _ selected: Bool) { plan.measures = toggle(plan.measures, id, selected) }
    public func toggleGroup(_ id: String, _ selected: Bool) {
        guard plan.fields.contains(id) else { return }
        plan.groups = toggle(plan.groups, id, selected)
    }
    public func toggleJoin(_ id: String, _ selected: Bool) { plan.joins = selected ? [id] : [] }
    public func addFilter() { if let id = dataset?.fields.first?.id { plan.filters.append(.init(fieldId: id)) } }
    public func removeFilter(index: Int) {
        guard plan.filters.indices.contains(index) else { return }
        plan.filters.remove(at: index)
    }
    public func setFilterValue(index: Int, text: String) {
        guard plan.filters.indices.contains(index) else { return }
        let field = dataset?.fields.first { $0.id == plan.filters[index].fieldId }
        if field?.type == "boolean" {
            plan.filters[index].value = .bool(text == "true")
        } else if field?.type == "integer" {
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            plan.filters[index].value =
                clean.isEmpty
                ? .number(0)
                : clean.range(
                    of: "^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$", options: .regularExpression
                ).flatMap { _ in Decimal(string: clean, locale: Locale(identifier: "en_US_POSIX")) }.map(
                    TaxValue.number) ?? .null
        } else {
            plan.filters[index].value = .string(text)
        }
    }
    public func applyTemplate(_ template: AnalysisTemplate, name: String? = nil) {
        resetSource()
        batching = true
        workspace = template.workspace
        mode = .visual
        plan = template.plan
        self.name = name ?? template.titleKey
        batching = false
        changed(query: true)
        queueLibrary()
    }
    public func startBlank() {
        resetSource()
        batching = true
        mode = .visual
        plan = .init(datasetId: datasets.first?.id ?? "cash-flows")
        name = ""
        batching = false
        changed(query: true)
    }
    private func resetSource() {
        selectedEpoch = UUID()
        runRevision = UUID()
        activeRequest = nil
        selectedSaved = nil
        result = nil
        lastUsableResult = nil
        exportContext = nil
        exportInputsKnown = false
        resultQuery = nil
        error = nil
        savedFeedback = nil
        versions = nil
        proposalPreview = nil
    }
    private func parse(_ text: String, shape: String) throws -> TaxValue {
        let value = try JSONDecoder().decode(
            TaxValue.self, from: Data((text.isEmpty ? shape == "array" ? "[]" : "{}" : text).utf8))
        guard shape == "array" ? value.arrayValue != nil : value.objectValue != nil else {
            throw APIError.invalidRequest("Invalid analysis input JSON")
        }
        return value
    }
    private func sqlParameterValues() throws -> TaxValue {
        let value = try parse(sqlValues, shape: "array")
        guard
            value.arrayValue!.allSatisfy({
                switch $0 {
                case .array, .object: false
                default: true
                }
            })
        else { throw APIError.invalidRequest("analysis.sqlParametersInvalid") }
        return value
    }
    public func executionInput(requestId: String, offset: Int = 0) throws -> TaxValue {
        var input: TaxValue = .object([
            "requestId": .string(requestId), "mode": .string(mode.rawValue), "limit": .number(Decimal(plan.limit)),
            "offset": .number(Decimal(offset)), "workbench": workbench, "scenarioModel": scenarioModel,
            "formulaModel": .object([
                "formulas": try parse(formulasJson, shape: "array"),
                "assumptions": try parse(assumptionsJson, shape: "array"),
                "assumptionValues": try parse(assumptionValuesJson, shape: "object"),
            ]),
        ])
        if mode == .visual {
            input["plan"] = try TaxValue(encoding: plan)
        } else {
            input["sql"] = .string(sql)
            input["values"] = try sqlParameterValues()
            input["datasetIds"] = .array(sqlDatasets.map(TaxValue.string))
            if let result = displayedResult {
                input["columns"] = .array(
                    result.effectiveColumns.map {
                        .object(["id": .string($0.id), "label": .string($0.label ?? $0.id), "type": .string($0.type)])
                    })
            }
        }
        return input
    }
    @discardableResult public func run(offset: Int = 0) async -> Bool {
        guard offset >= 0 else { return false }
        let id = "analysis-" + UUID().uuidString.lowercased()
        let generation = UUID()
        runRevision = generation
        activeRequest = id
        error = nil
        let stamp = executionSignature
        let query = querySignature
        let inputs = currentInputs
        let plan = plan
        let mode = mode
        let context = captureExportContext()
        defer { if generation == runRevision { activeRequest = nil } }
        do {
            let input = try executionInput(requestId: id, offset: offset)
            await restoreHistory()
            guard generation == runRevision, stamp == executionSignature else { return false }
            let next = try await service.analysisExecute(input)
            guard generation == runRevision, stamp == executionSignature else { return false }
            result = next
            lastUsableResult = next
            resultQuery = query
            resultInputs = inputs
            exportContext = context
            exportInputsKnown = true
            resultDatasetId = mode == .visual ? plan.datasetId : nil
            self.offset = offset
            if mode == .visual {
                batching = true
                sql = next.generatedSql
                batching = false
            } else {
                sqlHistory = Array(([sql] + sqlHistory.filter { $0 != sql }).prefix(10))
                queueHistoryWrite()
            }
            bindChart(to: next)
            resultRevision += 1
            didChange?()
            return true
        } catch {
            if generation == runRevision, stamp == executionSignature { self.error = error.localizedDescription }
            return false
        }
    }
    @discardableResult public func execute(offset: Int = 0) async -> Bool { await run(offset: offset) }
    public func cancel() async {
        guard let request = activeRequest else { return }
        do { _ = try await service.analysisCancel(requestId: request) } catch {
            if activeRequest == request { self.error = error.localizedDescription }
        }
    }
    private func queueHistoryWrite() {
        let previous = historyTask
        let values = sqlHistory
        historyTask = Task {
            await restoreHistory()
            await previous?.value
            await historyStore.write(values)
        }
    }
    private func restoreHistory() async {
        if historyLoaded {
            if historyLoading { await withCheckedContinuation { historyWaiters.append($0) } }
            return
        }
        historyLoaded = true
        historyLoading = true
        let stamp = sqlHistory
        let values = await historyStore.read()
        if sqlHistory == stamp { sqlHistory = Array(values.prefix(10)) }
        historyLoading = false
        for waiter in historyWaiters { waiter.resume() }
        historyWaiters = []
    }
    public func flushHistory() async { await historyTask?.value }
    private func bindChart(to result: AnalysisResult) {
        let columns = result.effectiveColumns
        let ids = columns.map(\.id)
        let numeric = columns.filter { AnalysisPresentation.isNumeric($0.type) }.map(\.id)
        let currentX = chartSpec["x"]?.stringValue ?? ""
        let selected = (chartSpec["y"]?.arrayValue ?? []).compactMap(\.stringValue).filter { numeric.contains($0) }
        batching = true
        chartSpec["x"] = .string(ids.contains(currentX) ? currentX : ids.first ?? "")
        chartSpec["y"] = .array((selected.isEmpty ? Array(numeric.prefix(1)) : selected).map(TaxValue.string))
        batching = false
    }
    public func sortResult(column: String) async {
        guard mode == .visual else { return }
        let next = plan.orderBy.first?.id == column && plan.orderBy.first?.direction == "asc" ? "desc" : "asc"
        plan.orderBy = [.init(id: column, direction: next)]
        _ = await run()
    }
    public func sort(by column: String) async { await sortResult(column: column) }
    public func drill(row: AnalysisRow, groups: [String]? = nil) async {
        guard mode == .visual else { return }
        if groups == nil {
            guard !queryOutdated else { return }
        } else {
            guard pivotResult != nil, !isPivotLoading else { return }
        }
        let generation = UUID()
        drillRevision = generation
        let stamp = querySignature
        var plan = plan
        if let groups {
            plan.groups = groups
            plan.filters += pivotConfig.filters
        }
        isDrillLoading = true
        defer { if generation == drillRevision { isDrillLoading = false } }
        do {
            let value = try await service.analysisDrill(
                plan: plan, row: row, requestId: "analysis-" + UUID().uuidString.lowercased())
            guard generation == drillRevision, stamp == querySignature else { return }
            drillResult = value
        } catch { if generation == drillRevision { self.error = error.localizedDescription } }
    }
    public func runPivot() async {
        guard mode == .visual, !pivotConfig.values.isEmpty, !isPivotLoading else { return }
        let generation = UUID()
        pivotRevision = generation
        let stamp = signature((try? TaxValue(encoding: pivotConfig)) ?? .null) + querySignature
        isPivotLoading = true
        pivotError = nil
        defer { if generation == pivotRevision { isPivotLoading = false } }
        do {
            let value = try await service.analysisPivot(
                plan: plan, config: pivotConfig, requestId: "analysis-" + UUID().uuidString.lowercased())
            guard generation == pivotRevision,
                stamp == signature((try? TaxValue(encoding: pivotConfig)) ?? .null) + querySignature
            else { return }
            pivotResult = value
        } catch { if generation == pivotRevision { pivotError = error.localizedDescription } }
    }
    private func captureExportContext() -> AnalysisExportContext {
        .init(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "analysis" : name.trimmingCharacters(in: .whitespacesAndNewlines), timezone: timezone,
            workspace: workspace, datasetIds: mode == .visual ? [plan.datasetId] : sqlDatasets,
            sourceReferences: references())
    }
    private func references() -> [String] {
        sourceReferences.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter {
            !$0.isEmpty
        }
    }
    public func selectSaved(_ saved: AnalysisSaved) {
        do {
            let source = try AnalysisSavedSource(saved: saved)
            selectedEpoch = UUID()
            runRevision = UUID()
            activeRequest = nil
            savedFeedback = nil
            batching = true
            selectedSaved = saved
            name = saved.name
            workspace = saved.workspace
            mode = source.mode
            if var plan = source.plan {
                let financial = saved.parameters["financialPlan"]
                plan.reportingCurrency = financial?["reportingCurrency"]?.stringValue
                plan.from = financial?["from"]?.stringValue
                plan.to = financial?["to"]?.stringValue
                plan.symbol = financial?["symbol"]?.stringValue
                plan.range = financial?["range"]?.stringValue
                plan.costBasisMethod = financial?["costBasisMethod"]?.stringValue
                self.plan = plan
            }
            if let sql = source.sql { self.sql = sql }
            if !source.datasetIds.isEmpty { sqlDatasets = source.datasetIds }
            visualOrigin = source.visualOrigin
            sqlValues = json(saved.parameters["sqlValues"] ?? .array([]))
            scenarioModel =
                saved.parameters["scenarioModel"] ?? .object(["attachments": .array([]), "joins": .array([])])
            workbench = saved.parameters["workbench"] ?? .object([:])
            pivotConfig =
                (try? saved.parameters["pivotConfig"]?.decode(AnalysisPivotConfig.self))
                ?? .init(
                    rows: Array((source.plan?.groups ?? []).prefix(1)),
                    columns: Array((source.plan?.groups ?? []).dropFirst().prefix(1)),
                    values: source.plan?.measures ?? [])
            let formulas = saved.parameters["formulaModel"]
            formulasJson = json(formulas?["formulas"] ?? .array([]))
            assumptionsJson = json(formulas?["assumptions"] ?? .array([]))
            assumptionValuesJson = json(formulas?["assumptionValues"] ?? .object([:]))
            runCurrency = ""
            runBenchmark = ""
            runWithoutBenchmark = false
            runAnswerDepth = ""
            runLanguage = ""
            chartSpec = saved.charts.first ?? .object(["kind": .string("bar"), "x": .string(""), "y": .array([])])
            if let result = saved.lastResult { bindChart(to: result) }
            result = saved.lastResult
            lastUsableResult = saved.lastResult
            offset = 0
            resultDatasetId = source.mode == .visual ? source.plan?.datasetId : nil
            resultInputs = currentInputs
            resultQuery = querySignature
            exportInputsKnown = false
            sourceReferences = saved.sourceReferences.map { AnalysisPresentation.rawText($0) }.joined(separator: "\n")
            let datasets = (saved.definition["datasets"]?.arrayValue ?? []).compactMap {
                $0["id"]?.stringValue ?? $0["datasetId"]?.stringValue
            }
            exportContext = saved.lastResult.map { _ in
                .init(
                    name: saved.name, timezone: saved.parameters["timezone"]?.stringValue ?? timezone,
                    workspace: saved.workspace, definitionId: saved.definitionId, definitionVersion: saved.version,
                    datasetIds: datasets, sourceReferences: references())
            }
            proposalPreview = nil
            versions = nil
            versionsLoading = false
            error = saved.lastError?["message"]?.stringValue
            batching = false
            changed(query: true)
            resultRevision += 1
            queueLibrary()
        } catch {
            batching = false
            self.error = error.localizedDescription
        }
    }
    private func json(_ value: TaxValue) -> String {
        (try? String(decoding: APIBody.encode(value), as: UTF8.self)) ?? "null"
    }
    public func saveInput() throws -> TaxValue {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.invalidRequest("analysis.nameRequired")
        }
        let query: TaxValue
        if mode == .visual {
            query = .object(["mode": .string("visual"), "plan": try TaxValue(encoding: plan)])
        } else {
            var raw: TaxValue = .object([
                "mode": .string("sql"), "sql": .string(sql), "datasetIds": .array(sqlDatasets.map(TaxValue.string)),
                "columns": .array(
                    (displayedResult?.effectiveColumns ?? []).map { column in
                        var raw = column.raw
                        raw["label"] = .string(column.id)
                        raw["nullable"] = .bool(true)
                        return raw
                    }),
            ])
            if let visualOrigin, let result = displayedResult {
                let ids = Set(visualOrigin.fields + visualOrigin.measures)
                if ids.count == result.effectiveColumns.count,
                    result.effectiveColumns.allSatisfy({ ids.contains($0.id) })
                {
                    raw["visualOrigin"] = try TaxValue(encoding: visualOrigin)
                }
            }
            query = raw
        }
        let preferences = effectivePreferences
        var parameters = selectedSaved?.parameters ?? .object([:])
        parameters["currency"] = .string(preferences.currency)
        parameters["benchmark"] = preferences.benchmark.map(TaxValue.string) ?? .null
        parameters["answerDepth"] = .string(preferences.answerDepth)
        parameters["language"] = .string(preferences.language)
        parameters["timezone"] = .string(timezone)
        parameters["sqlValues"] = try sqlParameterValues()
        parameters["scenarioModel"] = scenarioModel
        parameters["workbench"] = workbench
        parameters["pivotConfig"] = try TaxValue(encoding: pivotConfig)
        var financial: TaxValue = .object([:])
        for (key, value) in [
            ("reportingCurrency", plan.reportingCurrency), ("from", plan.from), ("to", plan.to),
            ("symbol", plan.symbol), ("range", plan.range), ("costBasisMethod", plan.costBasisMethod),
        ] { if let value { financial[key] = .string(value) } }
        parameters["financialPlan"] = financial
        var input: TaxValue = .object([
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "workspace": .string(workspace.rawValue), "querySpec": query, "refreshMode": .string("live"),
            "parameters": parameters, "charts": .array([chartSpec]),
            "sourceReferences": .array(references().map(TaxValue.string)),
            "formulas": try parse(formulasJson, shape: "array"),
            "assumptions": try parse(assumptionsJson, shape: "array"),
            "assumptionValues": try parse(assumptionValuesJson, shape: "object"),
        ])
        if let selectedSaved { input["expectedVersion"] = .number(Decimal(selectedSaved.version)) }
        return input
    }
    public func save() async {
        guard canSave else { return }
        isSaving = true
        savedFeedback = nil
        let epoch = selectedEpoch
        let stamp = draftSignature
        let selected = selectedSaved
        defer { isSaving = false }
        do {
            let value = try await service.analysisSave(id: selected?.id, input: saveInput())
            guard selected == nil || value.id == selected?.id else {
                throw AnalysisDecode.failure("Saved acknowledgement names a different analysis")
            }
            if selectedEpoch == epoch, draftSignature == stamp {
                selectedSaved = value
                savedFeedback = .init(error: false, message: "analysis.savedActionComplete")
            }
            await loadSavedList()
            await didMutate?()
        } catch {
            if selectedEpoch == epoch, draftSignature == stamp {
                savedFeedback = .init(error: true, message: error.localizedDescription)
            }
            await loadSavedList()
            await didMutate?()
        }
    }
    private func savedOperation(_ operation: () async throws -> AnalysisSaved?) async {
        guard !savedAction, !isSaving else { return }
        savedAction = true
        savedFeedback = nil
        let epoch = selectedEpoch
        let stamp = draftSignature
        defer { savedAction = false }
        do {
            let value = try await operation()
            let canApply = selectedEpoch == epoch && draftSignature == stamp
            if canApply, let value { selectSaved(value) }
            if canApply {
                savedFeedback = .init(error: false, message: "analysis.savedActionComplete")
            }
            await loadSavedList()
            await didMutate?()
        } catch {
            if selectedEpoch == epoch, draftSignature == stamp {
                savedFeedback = .init(error: true, message: error.localizedDescription)
            }
            await loadSavedList()
            await didMutate?()
        }
    }
    public func runSaved(id: String) async { await savedOperation { try await service.analysisRunSaved(id: id) } }
    public func deleteSaved(id: String) async {
        guard !savedAction, !isSaving else { return }
        savedAction = true
        savedFeedback = nil
        let epoch = selectedEpoch
        defer { savedAction = false }
        do {
            try await service.analysisDeleteSaved(id: id)
            if selectedSaved?.id == id {
                selectedSaved = nil
                selectedEpoch = UUID()
            }
            if epoch == selectedEpoch { savedFeedback = .init(error: false, message: "analysis.savedActionComplete") }
            await loadSavedList()
            await didMutate?()
        } catch {
            if epoch == selectedEpoch { savedFeedback = .init(error: true, message: error.localizedDescription) }
            await loadSavedList()
            await didMutate?()
        }
    }
    public func loadVersions() async {
        guard let selected = selectedSaved, !versionsLoading else { return }
        versionsLoading = true
        let epoch = selectedEpoch
        let version = selected.version
        defer { if epoch == selectedEpoch { versionsLoading = false } }
        do {
            let value = try await service.analysisVersions(id: selected.id)
            guard epoch == selectedEpoch, selectedSaved?.version == version else { return }
            versions = value
        } catch { if epoch == selectedEpoch { self.error = error.localizedDescription } }
    }
    public func restoreVersion(_ version: Int) async {
        guard let selected = selectedSaved else { return }
        await savedOperation {
            try await service.analysisRestore(id: selected.id, version: version, expectedVersion: selected.version)
        }
    }
    public func previewProposal() async {
        guard !isProposalLoading, let selected = selectedSaved else { return }
        let generation = UUID()
        proposalRevision = generation
        let epoch = selectedEpoch
        let text = proposalJson
        isProposalLoading = true
        proposalPreview = nil
        defer { if generation == proposalRevision { isProposalLoading = false } }
        do {
            let proposal = try JSONDecoder().decode(AnalysisEditProposal.self, from: Data(text.utf8))
            guard proposal.savedAnalysisId == selected.id, proposal.baseVersion == selected.version else {
                throw APIError.invalidRequest("analysis.proposalInvalid")
            }
            let value = try await service.analysisPreviewProposal(proposal)
            guard generation == proposalRevision, epoch == selectedEpoch, text == proposalJson else { return }
            guard value.baseVersion == selected.version, value.proposal == proposal else {
                throw AnalysisDecode.failure("Proposal preview does not match the selected version")
            }
            proposalPreview = value
        } catch { if generation == proposalRevision { self.error = error.localizedDescription } }
    }
    public func generateProposal(instruction: String? = nil, model: String? = nil) async {
        guard !isProposalLoading, let selected = selectedSaved else { return }
        let text = instruction ?? proposalJson
        let generation = UUID()
        proposalRevision = generation
        let epoch = selectedEpoch
        isProposalLoading = true
        proposalPreview = nil
        defer { if generation == proposalRevision { isProposalLoading = false } }
        do {
            let value = try await service.analysisGenerateProposal(id: selected.id, instruction: text, model: model)
            guard generation == proposalRevision, epoch == selectedEpoch else { return }
            guard value.proposal.savedAnalysisId == selected.id, value.baseVersion == selected.version,
                value.proposal.baseVersion == selected.version
            else { throw AnalysisDecode.failure("Generated proposal belongs to another definition version") }
            proposalJson = json(try TaxValue(encoding: value.proposal))
            proposalRevision = generation
            proposalPreview = value
        } catch { if generation == proposalRevision { self.error = error.localizedDescription } }
    }
    public func applyProposal() async {
        guard let preview = proposalPreview, let selected = selectedSaved, preview.baseVersion == selected.version,
            preview.proposal.savedAnalysisId == selected.id
        else { return }
        await savedOperation { try await service.analysisApplyProposal(preview.proposal) }
    }
    public func applyExtension(_ output: AnalysisExtensionOutput) {
        guard !workbenchSourceStale, let displayed = displayedResult, let rows = output.rows,
            let columns = output.columns
        else { return }
        let base = displayed.sourceResultData ?? displayed
        var raw = base.raw
        raw["rows"] = .array(rows.map(TaxValue.object))
        raw["columns"] = .array(columns.map(\.raw))
        raw["declaredColumns"] = .array(
            columns.map { column in
                var raw = column.raw
                raw["label"] = .string(column.label ?? column.id)
                raw["nullable"] = .bool(true)
                return raw
            })
        let complete =
            base.isComplete && output.complete != false && output.coverage?["complete"] != .bool(false)
            && output.coverage?["status"] != .string("partial")
            && !(output.raw["transformationCoverage"]?.arrayValue ?? []).contains { $0["complete"] == .bool(false) }
            && (output.raw["transformationErrors"]?.arrayValue ?? []).isEmpty
        raw["complete"] = .bool(complete)
        var coverage = base.coverage ?? .object([:])
        for (key, value) in output.coverage?.objectValue ?? [:] { coverage[key] = value }
        coverage["complete"] = .bool(complete)
        coverage["status"] = .string(complete ? "complete" : "partial")
        raw["coverage"] = coverage
        for key in ["transformationCoverage", "transformationErrors"] {
            if let value = output.raw[key] { raw[key] = value }
        }
        if let lineage = output.raw["preparationLineage"] ?? output.raw["lineage"] {
            raw["preparationLineage"] = lineage
        }
        var window = output.raw["window"] ?? base.window.raw
        if output.raw["window"] == nil { window["returnedRows"] = .number(Decimal(rows.count)) }
        raw["window"] = window
        raw["formulaErrors"] = output.raw["errors"]?.arrayValue.map {
            .array(
                $0.filter { $0["formulaId"] != nil }.map { error in
                    var error = error
                    error["code"] = .string("FORMULA_ERROR")
                    error["message"] = error["message"] ?? .string("")
                    return error
                })
        }
        raw["formulaSummaries"] = output.raw["summaries"]
        raw["sourceResult"] = displayed.sourceResult ?? displayed.raw
        do {
            let updated = try raw.decode(AnalysisResult.self)
            result = updated
            lastUsableResult = updated
            resultInputs = currentInputs
            resultRevision += 1
            didChange?()
        } catch { self.error = error.localizedDescription }
    }
    public func updateWorkbenchDraft(_ draft: AnalysisWorkbenchDraft) {
        batching = true
        formulasJson = json(.array(draft.formulas))
        assumptionsJson = json(.array(draft.assumptions))
        assumptionValuesJson = json(.object(draft.assumptionValues))
        workbench = draft.config
        batching = false
        changed()
    }
    public func importAttachment(file: AnalysisInterchangeFile, format: String) async {
        guard !isInterchangeBusy else { return }
        guard (scenarioModel["attachments"]?.arrayValue?.count ?? 0) < 5 else {
            interchangeError = "analysis.ext.workbook.limit"
            return
        }
        isInterchangeBusy = true
        interchangeError = nil
        let epoch = selectedEpoch
        defer { isInterchangeBusy = false }
        do {
            let attachment = try await service.analysisImport(file: file, format: format)
            guard epoch == selectedEpoch else { return }
            var attachments = scenarioModel["attachments"]?.arrayValue ?? []
            guard attachments.count < 5 else { return }
            if format == "csv" { attachments.removeAll { $0["id"]?.stringValue == attachment.id } }
            attachments.append(attachment.raw)
            scenarioModel["attachments"] = .array(attachments)
        } catch { if epoch == selectedEpoch { interchangeError = error.localizedDescription } }
    }
    public func removeAttachment(id: String) {
        scenarioModel["attachments"] = .array(
            (scenarioModel["attachments"]?.arrayValue ?? []).filter { $0["id"]?.stringValue != id })
        scenarioModel["joins"] = .array(
            (scenarioModel["joins"]?.arrayValue ?? []).filter { $0["inputId"]?.stringValue != id })
    }
    public func export(format: String) async {
        guard canExport, let result = displayedResult, let context = exportContext else { return }
        isInterchangeBusy = true
        interchangeError = nil
        defer { isInterchangeBusy = false }
        do {
            var raw = try TaxValue(encoding: context)
            raw["assumptions"] = .object([
                "definitions": try parse(resultInputs.assumptionsJson, shape: "array"),
                "values": try parse(resultInputs.assumptionValuesJson, shape: "object"),
            ])
            raw["formulas"] = try parse(resultInputs.formulasJson, shape: "array")
            let file = try await service.analysisExport(result: result, context: raw, format: format)
            guard let saveExport else { throw APIError.invalidRequest("Analysis export destination unavailable") }
            _ = try await saveExport(file.data, file.filename)
        } catch { interchangeError = error.localizedDescription }
    }
}
public typealias AnalysisWorkspaceModel = AnalysisModel

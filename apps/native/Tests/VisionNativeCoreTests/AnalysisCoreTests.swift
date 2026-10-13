import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native analysis requests, drafts and snapshots")
struct AnalysisCoreTests {
    @Test func dynamicDecimalCellsIdentifiersNullsUnitsAndCoverageRemainExact() throws {
        var raw = analysisResultWire()
        raw["rows"] = .array([
            .object([
                "money": .number(Decimal(string: "123456789012345.123456789012345")!),
                "raw_money": .string("999999999999999999999999999999999999999999.0001"),
                "id": .string("9007199254740993"), "missing": .null,
                "json": .object(["nested": .number(Decimal(string: "0.1234567890123456789")!)]),
            ])
        ])
        raw["sourceResult"] = .object(["legacy": .string("retain")])
        raw["coverage"] = .object(["complete": .bool(false), "unavailableRows": .number(3)])
        raw["future"] = .array([.bool(true)])
        let result = try raw.decode(AnalysisResult.self)
        #expect(result.rows[0]["money"]?.decimalValue == Decimal(string: "123456789012345.123456789012345"))
        #expect(result.rows[0]["raw_money"] == raw["rows"]?.arrayValue?[0]["raw_money"])
        #expect(result.rows[0]["id"] == .string("9007199254740993"))
        #expect(result.rows[0]["missing"] == .null)
        #expect(result.columns[1].unit?.currencyColumn == "currency")
        #expect(result.columns[1].unit?.instrumentColumn == "investment_id")
        #expect(result.columns[1].unit?.percentageBasis == "ratio")
        #expect(result.sourceResult == raw["sourceResult"])
        #expect(!result.isComplete)
        #expect(try TaxValue(encoding: result) == raw)
    }
    @Test func actualExecuteAPIPreservesNumbersStringsNullsAndRejectsWrongRequestOrPage() async throws {
        let transport = AnalysisRequestTransport()
        let client = analysisClient(transport)
        let input: TaxValue = .object([
            "requestId": .string("analysis-synthetic"), "mode": .string("sql"), "sql": .string("SELECT synthetic"),
            "values": .array([.number(Decimal(string: "123.456789012345678901")!), .string("00123"), .null]),
            "datasetIds": .array([.string("cash-flows")]), "limit": .number(500), "offset": .number(500),
        ])
        let result = try await client.analysisExecute(input)
        #expect(result.window.offset == 500)
        #expect(result.window.hasMore == false)
        let sent = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.last?.body))
        #expect(sent == input)
        await transport.wrongEcho()
        await #expect(throws: APIError.self) { try await client.analysisExecute(input) }
        await transport.wrongPage()
        await #expect(throws: APIError.self) { try await client.analysisExecute(input) }
    }
    @Test func builderHelpersMatchEditableTemplatesAndTypedFilters() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        await model.load()
        model.applyTemplate(AnalysisTemplate.all[0], name: "Synthetic category")
        #expect(model.plan == AnalysisPlan.example)
        model.toggleField("month", false)
        #expect(!model.plan.groups.contains("month"))
        model.toggleJoin("first", true)
        model.toggleJoin("second", true)
        #expect(model.plan.joins == ["second"])
        model.plan.filters = [.init(fieldId: "integer_id"), .init(fieldId: "is_active")]
        model.setFilterValue(index: 0, text: "9007199254740993")
        model.setFilterValue(index: 1, text: "false")
        #expect(model.plan.filters[0].value == .number(Decimal(string: "9007199254740993")!))
        #expect(model.plan.filters[1].value == .bool(false))
        model.setFilterValue(index: 0, text: "")
        #expect(model.plan.filters[0].value == .number(0))
    }
    @Test func changedQueryRejectsDelayedRunAndKeepsLastUsableResultWithOutdatedScope() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        #expect(await model.run())
        let original = model.displayedResult
        await service.pause("execute")
        let pending = Task { await model.run() }
        await service.waitForPause()
        model.plan.datasetId = "holdings"
        await service.release()
        #expect(await pending.value == false)
        #expect(model.displayedResult == original)
        #expect(model.queryOutdated)
        #expect(!model.canExport)
        #expect(model.activeRequest == nil)
    }
    @Test func failedRerunPreservesUsableResultAndExplicitError() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        #expect(await model.run())
        let result = model.displayedResult
        await service.failExecute()
        #expect(await model.run() == false)
        #expect(model.displayedResult == result)
        #expect(model.error != nil)
    }
    @Test func sqlHistoryKeepsTenUniqueRecentStringsAndRejectsStructuredParameters() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisMemorySQLHistoryStore()
        store.entries = ["old-query"]
        let model = AnalysisModel(service: service, historyStore: store)
        model.setMode(.sql)
        for index in 0..<12 {
            model.sql = "SELECT synthetic_\(index)"
            #expect(await model.run())
        }
        model.sql = "SELECT synthetic_11"
        #expect(await model.run())
        await model.flushHistory()
        #expect(store.entries.count == 10)
        #expect(store.entries.first == "SELECT synthetic_11")
        #expect(store.entries.filter { $0 == "SELECT synthetic_11" }.count == 1)
        model.sqlValues = "[{\"nested\":1}]"
        #expect(throws: APIError.self) { try model.executionInput(requestId: "analysis-test") }
    }
    @Test func preferenceLayersValidateUppercaseCurrencyAndExplicitNullBenchmark() throws {
        let model = AnalysisModel(service: AnalysisFixtureService())
        model.configure(
            settings: .init(
                defaultCurrency: "usd", analysisBenchmark: "sp500", aiAnswerDepth: "detailed", language: "nl"))
        #expect(model.effectivePreferences.currency == "EUR")
        #expect(model.effectivePreferences.benchmark == "SP500")
        #expect(model.effectivePreferences.answerDepth == "detailed")
        #expect(model.effectivePreferences.language == "nl")
        model.runCurrency = "GBP"
        model.runWithoutBenchmark = true
        model.runLanguage = "en"
        #expect(model.effectivePreferences.currency == "GBP")
        #expect(model.effectivePreferences.benchmark == nil)
        #expect(model.effectivePreferences.language == "en")
    }
    @Test func delayedSavedRunCannotResetNewPreferenceEditsAndStillRefreshesLibrary() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        model.selectSaved(try analysisSavedWire().decode(AnalysisSaved.self))
        await service.pause("saved-run")
        let operation = Task { await model.runSaved(id: "saved-A") }
        await service.waitForPause()
        model.runCurrency = "GBP"
        await service.release()
        await operation.value
        #expect(model.runCurrency == "GBP")
        #expect(model.savedFeedback == nil)
        #expect(await service.savedReads >= 1)
    }
    @Test func savePinsExpectedVersionPreservesUnknownParametersAndDoesNotRebaseNewDraft() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        model.selectSaved(try analysisSavedWire().decode(AnalysisSaved.self))
        let input = try model.saveInput()
        #expect(input["expectedVersion"] == .number(2))
        #expect(input["parameters"]?["future"] == .string("retain"))
        await service.pause("save")
        let save = Task { await model.save() }
        await service.waitForPause()
        model.name = "Newer draft"
        await service.release()
        await save.value
        #expect(model.name == "Newer draft")
        #expect(model.selectedSaved?.version == 2)
        #expect(model.savedFeedback == nil)
    }
    @Test func unknownSavedWriteAcknowledgementReloadsLibraryAndInvalidatesConsumers() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        model.selectSaved(try analysisSavedWire().decode(AnalysisSaved.self))
        var changed = 0
        model.didMutate = { changed += 1 }
        await service.failSavedWrite()
        await model.save()
        #expect(model.savedFeedback?.error == true)
        #expect(await service.readsAfterSaveFailure == 1)
        #expect(changed == 1)
    }
    @Test func lateVersionAndProposalReadsCannotAttachToAnotherSavedSelection() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        model.selectSaved(try analysisSavedWire().decode(AnalysisSaved.self))
        await service.pause("versions")
        let versions = Task { await model.loadVersions() }
        await service.waitForPause()
        model.selectSaved(try analysisSavedWire(id: "saved-B").decode(AnalysisSaved.self))
        await service.release()
        await versions.value
        #expect(model.versions == nil)
        #expect(!model.versionsLoading)
        model.proposalJson = String(decoding: try APIBody.encode(analysisProposalWire(id: "saved-B")), as: UTF8.self)
        await service.pause("proposal")
        let proposal = Task { await model.previewProposal() }
        await service.waitForPause()
        model.proposalJson = "fresh instruction"
        await service.release()
        await proposal.value
        #expect(model.proposalPreview == nil)
        #expect(!model.isProposalLoading)
    }
    @Test func csvReplacementRemovalAndLateImportsRetainCorrectAttachmentSource() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        let file = AnalysisInterchangeFile(name: "synthetic.csv", data: Data())
        await model.importAttachment(file: file, format: "csv")
        await model.importAttachment(file: file, format: "csv")
        #expect(model.scenarioModel["attachments"]?.arrayValue?.count == 1)
        model.scenarioModel["joins"] = .array([
            .object(["inputId": .string("scenario-synthetic"), "resultColumn": .string("month")])
        ])
        model.removeAttachment(id: "scenario-synthetic")
        #expect(model.scenarioModel["joins"] == .array([]))
        await service.pause("import")
        let upload = Task { await model.importAttachment(file: file, format: "csv") }
        await service.waitForPause()
        model.startBlank()
        await service.release()
        await upload.value
        #expect(model.scenarioModel["attachments"] == .array([]))
    }
    @Test func capturedPartialSnapshotExportsExactlyAndDraftChangesDisableIt() async throws {
        let service = AnalysisFixtureService()
        await service.returnPartial()
        let model = AnalysisModel(service: service)
        var exported: Data?
        model.saveExport = { data, _ in
            exported = data
            return true
        }
        #expect(await model.run())
        #expect(!model.displayedResult!.isComplete)
        #expect(model.canExport)
        await model.export(format: "csv")
        #expect(exported == Data("synthetic export".utf8))
        let captured = try #require(await service.lastExport)
        #expect(captured["result"]?["coverage"]?["complete"] == .bool(false))
        #expect(captured["result"]?["window"]?["hasMore"] == .bool(true))
        model.formulasJson = "[{\"id\":\"new\"}]"
        #expect(!model.canExport)
    }
    @Test func currentPivotCanDrillWhileMainTableIsStaleAndMetadataEditsRetainResults() async throws {
        let service = AnalysisFixtureService()
        let model = AnalysisModel(service: service)
        #expect(await model.run())
        model.plan.filters.append(.init(fieldId: "category", value: .string("synthetic")))
        #expect(model.queryOutdated)
        await model.drill(row: ["category": .string("synthetic")])
        #expect(await service.drillReads == 0)
        await model.runPivot()
        #expect(model.pivotResult != nil)
        model.name = "New presentation name"
        model.sourceReferences = "Reference"
        model.formulasJson = "[{\"id\":\"future\"}]"
        #expect(model.pivotResult != nil)
        await model.drill(row: ["category": .string("synthetic")], groups: ["category"])
        #expect(await service.drillReads == 1)
        #expect(model.drillResult != nil)
        model.chartSpec["kind"] = .string("line")
        #expect(model.drillResult != nil)
        model.pivotConfig.rows = ["month"]
        #expect(model.pivotResult == nil)
        #expect(model.drillResult == nil)
    }
    @Test func leavingDuringHistoryRestoreCannotStartLateCatalogOrSavedReads() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisDelayedHistoryStore()
        let screens = AnalysisScreens(service: service, historyStore: store)
        let mounting = Task { await screens.didAppear() }
        await store.waitForRead()
        screens.didDisappear()
        store.release()
        await mounting.value
        #expect(await service.savedReads == 0)
        #expect(screens.workspace.catalog == nil)
        #expect(screens.workspace.displayedResult == nil)
    }
    @Test func leaveClearsUnsavedStateAndRejectsLateQueryButKeepsSQLHistory() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisMemorySQLHistoryStore()
        store.entries = ["SELECT retained"]
        let screens = AnalysisScreens(service: service, historyStore: store)
        await screens.didAppear()
        screens.workspace.name = "Unsaved"
        screens.workspace.scenarioModel["attachments"] = .array([.object(["id": .string("unsaved")])])
        await service.pause("execute")
        let run = Task { await screens.workspace.run() }
        await service.waitForPause()
        screens.didDisappear()
        await service.release()
        #expect(await run.value == false)
        #expect(screens.workspace.name.isEmpty)
        #expect(screens.workspace.displayedResult == nil)
        #expect(screens.workspace.scenarioModel["attachments"] == .array([]))
        await screens.didAppear()
        #expect(screens.workspace.sqlHistory == ["SELECT retained"])
    }
    @Test func reloadDrainWaitsForAcceptedRunAndItsFutureSQLHistoryWrite() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisReloadTailHistoryStore()
        let model = AnalysisModel(service: service, historyStore: store)
        model.setMode(.sql)
        model.sql = "SELECT synthetic_reload"
        await service.pause("execute")
        let run = Task { await model.run() }
        await service.waitForPause()
        var drained = false
        let drain = Task {
            await model.flushAcceptedRuns()
            drained = true
        }
        #expect(await analysisReloadEventually { model.pendingAcceptedRunDrainCount == 1 })
        #expect(!drained && store.writes.isEmpty)
        await service.release()
        #expect(await run.value)
        await store.waitForWrite()
        #expect(!drained && store.writes.isEmpty)
        store.releaseWrite()
        await drain.value
        #expect(drained)
        #expect(store.writes == [["SELECT synthetic_reload", "SELECT retained"]])
    }
    @Test func failedAcceptedRunCannotLeaveTheReloadDrainWaitingOrAddHistory() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisReloadTailHistoryStore()
        let model = AnalysisModel(service: service, historyStore: store)
        model.setMode(.sql)
        model.sql = "SELECT synthetic_failure"
        await service.failExecute()
        await service.pause("execute")
        let run = Task { await model.run() }
        await service.waitForPause()
        let drain = Task { await model.flushAcceptedRuns() }
        #expect(await analysisReloadEventually { model.pendingAcceptedRunDrainCount == 1 })
        await service.release()
        #expect(await run.value == false)
        await drain.value
        #expect(model.pendingAcceptedRunDrainCount == 0)
        #expect(store.writes.isEmpty && model.sqlHistory == ["SELECT retained"])
    }
    @Test func reloadDrainPreservesTheExistingLateQueryExitPolicy() async throws {
        let service = AnalysisFixtureService()
        let store = AnalysisReloadTailHistoryStore()
        let model = AnalysisModel(service: service, historyStore: store)
        model.setMode(.sql)
        model.sql = "SELECT synthetic_retired_visit"
        await service.pause("execute")
        let run = Task { await model.run() }
        await service.waitForPause()
        let drain = Task { await model.flushAcceptedRuns() }
        #expect(await analysisReloadEventually { model.pendingAcceptedRunDrainCount == 1 })
        model.resetForVisit()
        await service.release()
        #expect(await run.value == false)
        await drain.value
        #expect(store.writes.isEmpty)
        #expect(model.displayedResult == nil)
        #expect(model.pendingAcceptedRunDrainCount == 0)
    }
}

@MainActor private func analysisReloadEventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<10_000 {
        if condition() { return true }
        await Task.yield()
    }
    return false
}
@MainActor private final class AnalysisReloadTailHistoryStore: AnalysisSQLHistoryStore {
    private(set) var writes: [[String]] = []
    private var started = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var completion: CheckedContinuation<Void, Never>?
    func read() async -> [String] { ["SELECT retained"] }
    func write(_ entries: [String]) async {
        await withCheckedContinuation { continuation in
            completion = continuation
            started = true
            waiter?.resume()
            waiter = nil
        }
        writes.append(entries)
    }
    func waitForWrite() async {
        if !started { await withCheckedContinuation { waiter = $0 } }
    }
    func releaseWrite() {
        completion?.resume()
        completion = nil
    }
}

private func analysisResultWire(id: String? = nil, offset: Int = 0, partial: Bool = false) -> TaxValue {
    var result: TaxValue = .object([
        "startedAt": .string("2026-01-01T00:00:00Z"), "completedAt": .string("2026-01-01T00:00:01Z"),
        "executor": .string("synthetic"),
        "rows": .array([
            .object([
                "month": .string("2026-01"), "sum_spending": .string("123.456789012345678901"),
                "currency": .string("EUR"),
            ])
        ]),
        "columns": .array([
            .object(["id": .string("month"), "type": .string("string")]),
            .object([
                "id": .string("sum_spending"), "type": .string("decimal"),
                "unit": .object([
                    "kind": .string("money"), "currencyColumn": .string("currency"),
                    "instrumentColumn": .string("investment_id"), "percentageBasis": .string("ratio"),
                    "futureUnit": .string("retain"),
                ]),
            ]),
        ]),
        "window": .object([
            "kind": .string("page"), "offset": .number(Decimal(offset)), "limit": .number(500),
            "returnedRows": .number(1), "hasMore": .bool(partial),
        ]), "byteLength": .number(100), "generatedSql": .string("SELECT synthetic"),
        "coverage": .object(["complete": .bool(!partial), "status": .string(partial ? "partial" : "complete")]),
    ])
    if let id { result["requestId"] = .string(id) }
    return result
}
private func analysisSavedWire(id: String = "saved-A", version: Int = 2) -> TaxValue {
    .object([
        "id": .string(id), "definitionId": .string("definition-A"), "name": .string("Synthetic saved"),
        "workspace": .string("budgeting"), "version": .number(Decimal(version)), "refreshMode": .string("live"),
        "parameters": .object(["future": .string("retain"), "currency": .string("USD"), "benchmark": .null]),
        "charts": .array([]), "sourceReferences": .array([]), "refreshStatus": .string("succeeded"),
        "lastSuccessfulRunId": .string("run-A"), "lastError": .null, "lastResult": analysisResultWire(),
        "createdAt": .string("2026-01-01"), "updatedAt": .string("2026-01-01"),
        "definition": .object([
            "source": .object([
                "kind": .string("visual-plan"), "datasetId": .string("cash-flows"),
                "select": .array([
                    .object(["id": .string("month"), "source": .object(["kind": .string("field")])]),
                    .object(["id": .string("sum_spending"), "source": .object(["kind": .string("metric")])]),
                ]), "filters": .array([]), "groupBy": .array([.string("month")]), "joins": .array([]),
                "orderBy": .array([]), "limit": .number(500),
            ])
        ]),
    ])
}
private func analysisProposalWire(id: String = "saved-A") -> TaxValue {
    .object([
        "schemaVersion": .number(1), "savedAnalysisId": .string(id), "baseVersion": .number(2),
        "rationale": .string("Synthetic edit"),
        "operations": .array([
            .object(["op": .string("replace"), "path": .string("/name"), "value": .string("Synthetic name")])
        ]),
    ])
}
private actor AnalysisFixtureService: AnalysisService {
    var savedReads = 0
    var drillReads = 0
    var readsAfterSaveFailure = 0
    private var hadSaveFailure = false
    var lastExport: TaxValue?
    private var pauseName: String?
    private var began = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var executeFails = false
    private var saveFails = false
    private var partial = false
    func pause(_ name: String) {
        pauseName = name
        began = false
    }
    func waitForPause() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    private func wait(_ name: String) async {
        if pauseName == name {
            pauseName = nil
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
    }
    func failExecute() { executeFails = true }
    func failSavedWrite() { saveFails = true }
    func returnPartial() { partial = true }
    func analysisCatalog() async throws -> AnalysisCatalog {
        try TaxValue.object([
            "version": .number(1),
            "datasets": .array([
                .object([
                    "id": .string("cash-flows"), "label": .string("Cash flows"),
                    "relation": .string("analysis.cash_flows"),
                    "fields": .array([
                        .object(["id": .string("month"), "label": .string("Month"), "type": .string("string")]),
                        .object(["id": .string("integer_id"), "label": .string("ID"), "type": .string("integer")]),
                        .object(["id": .string("is_active"), "label": .string("Active"), "type": .string("boolean")]),
                    ]),
                    "measures": .array([
                        .object([
                            "id": .string("sum_spending"), "label": .string("Spending"), "type": .string("decimal"),
                        ])
                    ]), "joins": .array([]),
                ])
            ]),
        ]).decode(AnalysisCatalog.self)
    }
    func analysisExecute(_ input: TaxValue) async throws -> AnalysisResult {
        await wait("execute")
        if executeFails { throw APIError.network("Synthetic execution failure") }
        return try analysisResultWire(
            id: input["requestId"]?.stringValue,
            offset: Int(NSDecimalNumber(decimal: input["offset"]?.decimalValue ?? 0).intValue), partial: partial
        ).decode(AnalysisResult.self)
    }
    func analysisCancel(requestId: String) async throws -> TaxValue { .object(["cancelled": .bool(true)]) }
    func analysisDrill(plan: AnalysisPlan, row: AnalysisRow, requestId: String) async throws -> AnalysisResult {
        drillReads += 1
        return try analysisResultWire(id: requestId).decode(AnalysisResult.self)
    }
    func analysisPivot(plan: AnalysisPlan, config: AnalysisPivotConfig, requestId: String) async throws
        -> AnalysisPivotResult
    {
        try TaxValue.object([
            "levels": .array([]), "partitions": .array([]),
            "config": try TaxValue(encoding: config),
            "coverage": .object(["complete": .bool(true), "rows": .number(0)]),
        ]).decode(AnalysisPivotResult.self)
    }
    func evaluateExtension(_ input: TaxValue) async throws -> AnalysisExtensionOutput {
        try TaxValue.object(["rows": .array([]), "columns": .array([])]).decode(AnalysisExtensionOutput.self)
    }
    func analysisSaved(workspace: AnalysisWorkspace?) async throws -> [AnalysisSaved] {
        savedReads += 1
        if hadSaveFailure { readsAfterSaveFailure += 1 }
        return [try analysisSavedWire().decode(AnalysisSaved.self)]
    }
    func analysisSave(id: String?, input: TaxValue) async throws -> AnalysisSaved {
        await wait("save")
        if saveFails {
            hadSaveFailure = true
            throw APIError.network("Synthetic lost saved acknowledgement")
        }
        return try analysisSavedWire(id: id ?? "saved-A", version: 3).decode(AnalysisSaved.self)
    }
    func analysisRunSaved(id: String) async throws -> AnalysisSaved {
        await wait("saved-run")
        return try analysisSavedWire(id: id, version: 3).decode(AnalysisSaved.self)
    }
    func analysisDeleteSaved(id: String) async throws {}
    func analysisVersions(id: String) async throws -> [AnalysisSavedVersion] {
        await wait("versions")
        return []
    }
    func analysisRestore(id: String, version: Int, expectedVersion: Int) async throws -> AnalysisSaved {
        try analysisSavedWire(id: id, version: expectedVersion + 1).decode(AnalysisSaved.self)
    }
    func analysisPreviewProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisProposalPreview {
        await wait("proposal")
        return try TaxValue.object([
            "proposal": try TaxValue(encoding: proposal), "before": .object([:]), "after": .object([:]),
            "baseVersion": .number(Decimal(proposal.baseVersion)),
        ]).decode(AnalysisProposalPreview.self)
    }
    func analysisApplyProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisSaved {
        try analysisSavedWire(id: proposal.savedAnalysisId, version: 3).decode(AnalysisSaved.self)
    }
    func analysisGenerateProposal(id: String, instruction: String, model: String?) async throws
        -> AnalysisProposalPreview
    { try await analysisPreviewProposal(analysisProposalWire(id: id).decode(AnalysisEditProposal.self)) }
    func analysisImport(file: AnalysisInterchangeFile, format: String) async throws -> AnalysisAttachment {
        await wait("import")
        return try AnalysisAttachment(
            raw: .object([
                "id": .string("scenario-synthetic"), "fileName": .string(file.name),
                "importedAt": .string("2026-01-01"), "sha256": .string(String(repeating: "a", count: 64)),
                "columns": .array([
                    .object(["id": .string("month"), "label": .string("Month"), "type": .string("string")])
                ]), "rows": .array([]),
            ]))
    }
    func analysisExport(result: AnalysisResult, context: TaxValue, format: String) async throws -> AnalysisExportFile {
        lastExport = .object(["result": result.raw, "context": context])
        return .init(filename: "synthetic.csv", data: Data("synthetic export".utf8), contentType: "text/csv")
    }
}
private func analysisClient(_ transport: AnalysisRequestTransport) -> APIClient {
    .init(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
}
private actor AnalysisRequestTransport: APITransport {
    var requests: [APIRequest] = []
    private var badEcho = false
    private var badPage = false
    func wrongEcho() { badEcho = true }
    func wrongPage() {
        badEcho = false
        badPage = true
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let input = try JSONDecoder().decode(TaxValue.self, from: request.body!)
        let raw = analysisResultWire(
            id: badEcho ? "analysis-wrong" : input["requestId"]?.stringValue,
            offset: badPage ? 0 : NSDecimalNumber(decimal: input["offset"]?.decimalValue ?? 0).intValue)
        return APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": raw])))
    }
}

@MainActor private final class AnalysisDelayedHistoryStore: AnalysisSQLHistoryStore {
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var began = false
    func waitForRead() async {
        if !began { await withCheckedContinuation { waiter = $0 } }
    }
    func release() {
        gate?.resume()
        gate = nil
    }
    func read() async -> [String] {
        if !began {
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
        return ["SELECT restored"]
    }
    func write(_ entries: [String]) async {}
}

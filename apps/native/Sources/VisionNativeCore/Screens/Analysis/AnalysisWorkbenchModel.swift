import Foundation
import Observation

@MainActor @Observable
public final class AnalysisWorkbenchModel {
    public var draft = AnalysisWorkbenchDraft() {
        didSet {
            guard draft != oldValue, !configuring else { return }
            inputsChanged()
            didChangeDraft?(draft)
        }
    }
    public var step = AnalysisPreparationStepDraft()
    public private(set) var result: AnalysisResult?
    public private(set) var attachments: [TaxValue] = []
    public private(set) var sourceStale = false
    public private(set) var output: AnalysisExtensionOutput?
    public private(set) var preview: AnalysisExtensionOutput?
    public private(set) var error: String?
    public private(set) var previewError: String?
    public private(set) var isBusy = false
    public private(set) var previewBusy = false
    public var didChangeDraft: (@MainActor (AnalysisWorkbenchDraft) -> Void)?
    public var didApply: (@MainActor (AnalysisExtensionOutput) -> Void)?
    public var scenarioTask = "compare"
    public var scenarioName = ""
    public var outcomeId = ""
    public var variableId = ""
    public var variable2Id = ""
    public var grid = "0, 0.05, 0.1"
    public var grid2 = "0, 1"
    public var target = "0"
    public var lower = "0"
    public var upper = "1"
    @ObservationIgnored private let service: any AnalysisService
    @ObservationIgnored private let previewDelay: Duration
    @ObservationIgnored private var context = ""
    @ObservationIgnored private var configuring = false
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var runRevision = 0

    public init(service: any AnalysisService, previewDelay: Duration = .milliseconds(400)) {
        self.service = service
        self.previewDelay = previewDelay
    }
    public var columns: [AnalysisColumn] {
        guard let result else { return [] }
        if let declared = result.declaredColumns, !declared.isEmpty { return declared }
        return result.columns
    }
    public var columnIds: [String] { columns.map(\.id) }
    public var complete: Bool { result?.isComplete ?? false }
    public var canApply: Bool { !isBusy && !sourceStale && result != nil }
    public var canApplySteps: Bool { canApply && !draft.steps.isEmpty }
    public var canApplyFormulas: Bool { canApply && !draft.formulas.isEmpty }
    public var time: TaxValue {
        draft.time(defaultDateColumn: columns.first { $0.type == "date" }?.id ?? "")
    }
    public var canApplyTime: Bool {
        canApply && complete && !(time["dateColumn"]?.stringValue ?? "").isEmpty
            && !(time["valueColumns"]?.arrayValue ?? []).isEmpty
    }
    public var canCompare: Bool {
        canApply && complete && !draft.scenarios.isEmpty && !draft.assumptions.isEmpty
            && !draft.summaryFormulas.isEmpty
    }
    public var canExplore: Bool {
        canApply && complete && draft.summaryFormulas.contains { $0["id"]?.stringValue == outcomeId }
            && draft.assumptions.contains { $0["id"]?.stringValue == variableId }
    }
    public var starterField: AnalysisColumn? {
        columns.first { ["decimal", "integer", "number", "numeric", "float", "double"].contains($0.type) }
    }

    public func configure(
        result: AnalysisResult?, workbench: TaxValue, formulasJson: String, assumptionsJson: String,
        assumptionValuesJson: String, sourceStale: Bool = false, attachments: [TaxValue] = [], context: String = ""
    ) {
        let next = AnalysisWorkbenchDraft(
            formulasJson: formulasJson, assumptionsJson: assumptionsJson,
            assumptionValuesJson: assumptionValuesJson, config: workbench)
        let changed =
            self.result?.raw != result?.raw || draft != next || self.sourceStale != sourceStale
            || self.attachments != attachments || self.context != context
        configuring = true
        draft = next
        self.result = result
        self.sourceStale = sourceStale
        self.attachments = attachments
        self.context = context
        configuring = false
        if changed { inputsChanged() }
    }
    private func inputsChanged() {
        revision += 1
        output = nil
        error = nil
        preview = nil
        previewError = nil
        previewTask?.cancel()
        runTask?.cancel()
        runRevision += 1
        isBusy = false
        schedulePreview()
    }
    public func cancel() {
        previewTask?.cancel()
        runTask?.cancel()
        revision += 1
        runRevision += 1
        isBusy = false
        previewBusy = false
    }
    public func retryPreview() { schedulePreview() }
    private func schedulePreview() {
        previewTask?.cancel()
        preview = nil
        previewError = nil
        guard result != nil, !sourceStale, !draft.formulas.isEmpty else {
            previewBusy = false
            return
        }
        let current = revision
        let request = request(operation: "formulas")
        previewBusy = true
        previewTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: previewDelay)
                let response = try await service.evaluateExtension(request)
                guard current == revision, !Task.isCancelled else { return }
                preview = response
            } catch {
                guard current == revision, !Task.isCancelled else { return }
                if !(error is CancellationError) { previewError = error.localizedDescription }
            }
            guard current == revision, !Task.isCancelled else { return }
            previewBusy = false
        }
    }
    public func request(operation: String, fields: [String: TaxValue] = [:]) -> TaxValue {
        var body: [String: TaxValue] = [
            "operation": .string(operation), "rows": result?.raw["rows"] ?? .array([]),
            "columns": columnsPayload, "complete": .bool(complete), "inputComplete": .bool(complete),
            "formulas": .array(draft.formulas), "workbench": draft.config,
            "assumptions": .object(draft.resolvedAssumptions), "assumptionUnits": draft.assumptionUnits,
        ]
        body["window"] = result?.raw["window"]
        body["coverage"] = result?.raw["coverage"]
        body.merge(fields) { _, newer in newer }
        return .object(body)
    }
    private var columnsPayload: TaxValue {
        guard let result else { return .array([]) }
        if let declared = result.raw["declaredColumns"]?.arrayValue, !declared.isEmpty { return .array(declared) }
        return result.raw["columns"] ?? .array([])
    }
    public func run(operation: String = "formulas", fields: [String: TaxValue] = [:], apply: Bool = false) async {
        guard canApply else { return }
        let current = revision
        runRevision += 1
        let requestId = runRevision
        let body = request(operation: apply ? "formulas" : operation, fields: apply ? [:] : fields)
        isBusy = true
        error = nil
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await service.evaluateExtension(body)
                guard revision == current, runRevision == requestId, !Task.isCancelled else { return }
                output = response
                if apply { didApply?(response) }
            } catch {
                guard revision == current, runRevision == requestId, !Task.isCancelled else { return }
                if !(error is CancellationError) { self.error = error.localizedDescription }
            }
            if runRevision == requestId { isBusy = false }
        }
        runTask = task
        await task.value
        if runRevision == requestId { runTask = nil }
    }
    public func addStep() -> Bool {
        guard step.isValid(columnIds: columnIds) else { return false }
        let source = attachments.first { $0["id"]?.stringValue == step.inputId }
        let input = source.map {
            TaxValue.object(["rows": $0["rows"] ?? .array([]), "columns": $0["columns"] ?? .array([])])
        }
        draft.steps.append(step.payload(input: input, assumptions: draft.resolvedAssumptions))
        return true
    }
    public func updateTime(_ key: String, value: TaxValue) {
        var next = time
        next[key] = value
        draft.config["time"] = next
    }
    public func compare() async {
        guard canCompare else { return }
        await run(operation: "scenarios", fields: ["scenarios": .array(draft.scenarios)])
    }
    public func explore() async {
        guard canExplore else { return }
        var variables: [TaxValue] = [
            .object(["id": .string(variableId), "values": AnalysisWorkbenchDraft.valuesList(grid)])
        ]
        if !variable2Id.isEmpty {
            variables.append(.object(["id": .string(variable2Id), "values": AnalysisWorkbenchDraft.valuesList(grid2)]))
        }
        await run(operation: "sensitivity", fields: ["outcomeId": .string(outcomeId), "variables": .array(variables)])
    }
    public func seek() async {
        guard canExplore else { return }
        await run(
            operation: "goal",
            fields: [
                "outcomeId": .string(outcomeId), "variableId": .string(variableId),
                "target": .string(target), "lower": .string(lower), "upper": .string(upper),
            ])
    }
}

import Foundation
import Observation

@MainActor @Observable public final class ResearchLifeScenarioModel {
    public var draft = ResearchLifeScenarioDraft() {
        didSet {
            if draft != oldValue {
                output = nil
                error = nil
            }
        }
    }
    public private(set) var scenarios: [ResearchLifeScenario] = []
    public private(set) var loadingSaved = false
    public private(set) var savedError: String?
    public private(set) var saving = false
    public private(set) var running = false
    public private(set) var error: String?
    public private(set) var undoNotice: ScreenNotice?
    public private(set) var settings = NativeAppSettings.defaults
    public private(set) var forecastInput: TaxValue = .object([
        "horizonMonths": .number(60), "currency": .string("EUR"),
    ])
    public var currency: String { settings.defaultCurrency.isEmpty ? "EUR" : settings.defaultCurrency }
    public var comparison: ResearchLifeScenarioComparison? { output?.signature == signature ? output : nil }
    public var isOnline = true
    public var canSave: Bool { !saving && !loadingSaved && savedError == nil && baseline != nil }
    @ObservationIgnored private let service: any ForecastService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let newID: @Sendable () -> String
    @ObservationIgnored private let timeZone: TimeZone
    @ObservationIgnored private var active = true
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var readRevision = UUID()
    @ObservationIgnored private var runRevision = UUID()
    @ObservationIgnored private var baseline: TaxValue?
    @ObservationIgnored private var writeFailure: String?
    @ObservationIgnored private var writeTail: Task<Bool, Never>?
    @ObservationIgnored private var pendingWrites = 0
    @ObservationIgnored private var noticeID = 0
    @ObservationIgnored private var undoState:
        (previous: TaxValue, removed: ResearchLifeScenario?, expires: Date, notice: Int)?
    private var output: ResearchLifeScenarioComparison?
    private var signature: TaxValue {
        .object(["draft": draft.signature, "forecastInput": forecastInput, "currency": .string(currency)])
    }
    public init(
        service: any ForecastService, now: @escaping @Sendable () -> Date = { Date() },
        newID: @escaping @Sendable () -> String = { UUID().uuidString }, timeZone: TimeZone = .current
    ) {
        self.service = service
        self.now = now
        self.newID = newID
        self.timeZone = timeZone
    }
    public func configure(settings: NativeAppSettings, forecastInput: TaxValue) {
        self.settings = settings
        self.forecastInput = forecastInput
    }
    public func beginVisit() { active = true }
    public func loadSaved(force: Bool = false) async {
        guard active, !saving, isOnline else { return }
        if loadingSaved && !force { return }
        let token = UUID()
        readRevision = token
        loadingSaved = true
        defer { if token == readRevision { loadingSaved = false } }
        do {
            let record = try await service.readLifeScenarios()
            guard active, token == readRevision, !Task.isCancelled else { return }
            let items = try Self.decodeScenarios(record.value)
            scenarios = items
            // A retry/background read cannot rebase a stale local settings write.
            if baseline == nil { baseline = record.expected }
            savedError = nil
        } catch {
            guard active, token == readRevision, !Task.isCancelled else { return }
            savedError = error.localizedDescription
        }
    }
    public func reset() {
        guard !saving else { return }
        draft = .init()
        output = nil
        error = nil
    }
    public func selectSaved(_ id: String) {
        guard !saving else { return }
        draft =
            scenarios.first { $0.id == id }.map { .init(scenario: $0, numberFormat: settings.numberFormat) } ?? .init()
        output = nil
        error = nil
    }
    private func parsedDraft() -> (scenario: ResearchLifeScenario, goalMonth: Int?)? {
        let horizon = forecastInput["horizonMonths"]?.decimalValue.map { NSDecimalNumber(decimal: $0).intValue } ?? 60
        do {
            return try draft.read(
                numberFormat: settings.numberFormat, horizonMonths: horizon, now: now(), timeZone: timeZone,
                newID: newID)
        } catch {
            self.error = "research.lifeScenario.invalid"
            return nil
        }
    }
    public func saveDraft() async {
        guard canSave, let parsed = parsedDraft() else { return }
        let id = draft.id
        let next = id == nil ? scenarios + [parsed.scenario] : scenarios.map { $0.id == id ? parsed.scenario : $0 }
        let token = visit
        if await persist(.array(next.map(\.raw))), active, token == visit {
            scenarios = next
            draft = .init(scenario: parsed.scenario, numberFormat: settings.numberFormat)
            error = nil
        }
    }
    public func deleteDraft() async {
        guard !saving, baseline != nil, let id = draft.id else { return }
        let previous = TaxValue.array(scenarios.map(\.raw))
        let removed = scenarios.first { $0.id == id }
        let next = scenarios.filter { $0.id != id }
        let token = visit
        if await persist(.array(next.map(\.raw))), active, token == visit {
            scenarios = next
            draft = .init()
            output = nil
            error = nil
            noticeID += 1
            undoState = (previous, removed, now().addingTimeInterval(8), noticeID)
            undoNotice = .init(id: noticeID, kind: .info, key: "research.lifeScenario.deleted")
        }
    }
    public func undo() async {
        guard let state = undoState, now() < state.expires else {
            if let notice = undoNotice { clearUndoNotice(notice.id) }
            return
        }
        let token = visit
        // Reserve the single undo action before awaiting the serialized setting queue.
        undoState = nil
        undoNotice = nil
        if await persist(state.previous), active, token == visit {
            scenarios = (try? Self.decodeScenarios(state.previous)) ?? scenarios
            if let removed = state.removed { draft = .init(scenario: removed, numberFormat: settings.numberFormat) }
            error = nil
        }
    }
    public func clearUndoNotice(_ id: Int) {
        guard undoNotice?.id == id else { return }
        undoNotice = nil
        undoState = nil
    }
    /// Writes serialize against the original baseline; advance only on acknowledged receipts.
    private func persist(_ value: TaxValue) async -> Bool {
        guard isOnline else { return false }
        readRevision = UUID()
        loadingSaved = false
        let previous = writeTail
        let token = visit
        pendingWrites += 1
        saving = true
        let task = Task { [weak self] in
            guard let self else { return false }
            _ = await previous?.value
            defer {
                pendingWrites -= 1
                saving = pendingWrites > 0
                if active, token != visit, !saving {
                    Task { [weak self] in await self?.loadSaved(force: true) }
                }
            }
            if let failure = writeFailure {
                if active, token == visit { error = failure }
                return false
            }
            guard let baseline else { return false }
            do {
                let record = try await service.saveLifeScenarios(value: value, expected: baseline)
                _ = try Self.decodeScenarios(record.value)
                guard record.value == value else {
                    throw ResearchDecode.failure("Life scenario save receipt differs from request")
                }
                self.baseline = .object(["exists": .bool(true), "value": record.value])
                return true
            } catch {
                writeFailure = error.localizedDescription
                if active, token == visit { self.error = error.localizedDescription }
                return false
            }
        }
        writeTail = task
        return await task.value
    }
    public func run() async {
        guard !running, !saving, isOnline, let parsed = parsedDraft() else { return }
        let inputSignature = signature
        let token = UUID()
        runRevision = token
        running = true
        error = nil
        output = nil
        defer { if token == runRevision { running = false } }
        do {
            var preparation: [String: TaxValue] = [
                "kind": .string("lifeScenarioPrepare"), "scenario": parsed.scenario.raw, "forecastInput": forecastInput,
            ]
            if let month = parsed.goalMonth { preparation["goalMonth"] = .number(Decimal(month)) }
            let plan = try await service.researchPresentation(.object(preparation))
            guard active, token == runRevision, inputSignature == signature else { return }
            guard plan["kind"] == .string("lifeScenarioPrepare") else {
                throw ResearchDecode.failure("Invalid Life preparation kind")
            }
            let prepared = try ResearchDecode.object(plan["result"])
            let baselineInput = try ResearchDecode.object(prepared["baselineInput"])
            let interruptedInput = try ResearchDecode.object(prepared["interruptedInput"])
            let reduced = try ResearchDecode.decimal(prepared["reducedContribution"])
            let deficit = try ResearchDecode.decimal(prepared["monthlyDeficit"])
            let goalMonth = try prepared["goalMonth"].map { try ResearchDecode.count($0) }
            async let baseline = service.researchPortfolioForecast(baselineInput)
            async let interrupted = service.researchPortfolioForecast(interruptedInput)
            let pair = try await (baseline, interrupted)
            guard active, token == runRevision, inputSignature == signature else { return }
            let comparison = try await service.researchPresentation(
                .object([
                    "kind": .string("lifeScenarioCompare"), "baseline": pair.0.data.raw, "interrupted": pair.1.data.raw,
                ]))
            guard active, token == runRevision, inputSignature == signature else { return }
            guard comparison["kind"] == .string("lifeScenarioCompare") else {
                throw ResearchDecode.failure("Invalid Life comparison kind")
            }
            let compared = try ResearchDecode.object(comparison["result"])
            guard try ResearchDecode.bool(compared["comparable"]) else {
                error = try ResearchDecode.optionalString(compared["errorKey"]) ?? "research.lifeScenario.inputsChanged"
                return
            }
            output = .init(
                baseline: pair.0.data, interrupted: pair.1.data, baselineMeta: pair.0.meta,
                interruptedMeta: pair.1.meta,
                goalMonth: goalMonth, reducedContribution: reduced, monthlyDeficit: deficit,
                medianGap: try ResearchDecode.optionalDecimal(compared["medianGap"]),
                available: try ResearchDecode.bool(compared["available"]),
                rawPreparation: plan, rawComparison: comparison, signature: inputSignature)
        } catch {
            guard active, token == runRevision, inputSignature == signature, !(error is CancellationError) else {
                return
            }
            self.error = error.localizedDescription
        }
    }
    public func didDisappear() {
        active = false
        visit = UUID()
        readRevision = UUID()
        runRevision = UUID()
        loadingSaved = false
        running = false
        draft = .init()
        output = nil
        error = nil
        if let notice = undoNotice { clearUndoNotice(notice.id) }
    }
    static func decodeScenarios(_ value: TaxValue) throws -> [ResearchLifeScenario] {
        // Existing non-array storage is treated as empty by the browser panel.
        guard let array = value.arrayValue else { return [] }
        guard array.count <= 50 else { throw ResearchDecode.failure("Too many life scenarios") }
        return try array.map { try .init(raw: $0) }
    }
}

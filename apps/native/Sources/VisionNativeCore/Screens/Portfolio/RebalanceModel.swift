import Foundation
import Observation

@MainActor
@Observable
public final class RebalanceModel {
    public private(set) var draft = RebalanceURLDraft.defaults
    public private(set) var route = NativeRoute(path: "/portfolio/rebalance")
    public private(set) var reserveFloor = "0"
    public private(set) var inputs: RebalanceResult?
    public private(set) var result: RebalanceResult?
    public private(set) var projection: RebalanceCashProjection?
    public private(set) var plans: [RebalancePlan] = []
    public private(set) var isLoadingInputs = false
    public private(set) var isLoadingPlans = false
    public private(set) var isComputing = false
    public private(set) var isSaving = false
    public private(set) var inputsError: String?
    public private(set) var plansError: String?
    public private(set) var computeError: String?
    public private(set) var actionError: String?
    public private(set) var errorKey: String?
    public private(set) var noticeKey: String?
    public private(set) var noticeRevision = 0
    public var deletingPlan: RebalancePlan?
    public private(set) var currency = "EUR"
    public private(set) var numberFormat: NumberFormat = .eu
    public var availableCash: Decimal { inputs?.availableCash ?? 0 }
    public var showEditor: Bool { draft.preset == nil }
    public var hasValidRows: Bool { !RebalanceForm.weights(draft.rows, format: numberFormat).isEmpty }
    public var weightTotal: Decimal {
        draft.rows.reduce(0) { $0 + LocaleNumber.parseOrZero($1.pct, format: numberFormat) }
    }
    public var canCompute: Bool { !isComputing && (!showEditor || hasValidRows) }
    public var canSave: Bool { !isSaving && setting != nil && hasValidRows }

    @ObservationIgnored private let service: any RebalanceService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var setting: OpenAPI.Setting?
    @ObservationIgnored private var inputsTime: Date?
    @ObservationIgnored private var plansTime: Date?
    @ObservationIgnored private var inputsTask: Task<Void, Never>?
    @ObservationIgnored private var plansTask: Task<Void, Never>?
    @ObservationIgnored private var inputsRevision = UUID()
    @ObservationIgnored private var plansRevision = UUID()
    @ObservationIgnored private var computeRevision = UUID()
    @ObservationIgnored private var computeTask: Task<Void, Never>?

    public init(service: any RebalanceService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public func invalidate() {
        inputsRevision = UUID()
        inputsTask?.cancel()
        inputsTask = nil
        inputsTime = nil
        isLoadingInputs = false
        plansTime = nil
        cancelPlansRead()
        resetComputation()
    }
    public func load(route: NativeRoute, settings: NativeAppSettings, force: Bool = false) async {
        let currency = settings.defaultCurrency.isEmpty ? "EUR" : settings.defaultCurrency.uppercased()
        let before = signature
        if currency != self.currency {
            invalidate()
            inputs = nil
            inputsError = nil
            self.currency = currency
        }
        self.numberFormat = settings.numberFormat
        self.route = route
        draft = RebalanceURLState.parse(route)
        if signature != before { resetComputation() }
        async let inputs: Void = loadInputs(force: force)
        async let plans: Void = loadPlans(force: force)
        _ = await (inputs, plans)
        hydratePlan()
    }
    public func setReserveFloor(_ value: String) {
        guard reserveFloor != value else { return }
        reserveFloor = value
        resetComputation()
    }
    public func updateDraft(_ change: (inout RebalanceURLDraft) -> Void) {
        let before = signature
        var next = draft
        change(&next)
        route = RebalanceURLState.write(next, preserving: route)
        draft = RebalanceURLState.parse(route)
        if before != signature { resetComputation() }
        errorKey = nil
        actionError = nil
        noticeKey = nil
    }
    public func selectSource(_ source: String) {
        if source.hasPrefix("model:"), let model = RebalancePreset(rawValue: String(source.dropFirst(6))) {
            updateDraft {
                $0 = RebalanceURLDraft(
                    source: source, rows: RebalanceForm.rows(model.weights, format: numberFormat), name: "",
                    capEnabled: false, cap: "")
            }
        } else if source == "custom" {
            updateDraft {
                $0 = RebalanceURLDraft(
                    source: "custom", rows: RebalanceForm.currentMix(inputs?.actualValues ?? [:], format: numberFormat),
                    name: "", capEnabled: false, cap: "")
            }
        } else if let plan = plans.first(where: { "plan:\($0.id)" == source }) {
            apply(plan)
        }
    }
    public func updateRow(_ index: Int, sleeve: String? = nil, pct: String? = nil) {
        updateDraft {
            guard $0.rows.indices.contains(index) else { return }
            if let sleeve { $0.rows[index].sleeve = sleeve }
            if let pct { $0.rows[index].pct = pct }
        }
    }
    public func addRow() {
        guard draft.rows.count < 8 else { return }
        let used = Set(draft.rows.map(\.sleeve))
        updateDraft {
            $0.rows.append(.init(sleeve: RebalanceURLDraft.sleeves.first { !used.contains($0) } ?? "", pct: ""))
        }
    }
    public func removeRow(_ index: Int) {
        updateDraft { if $0.rows.indices.contains(index) { $0.rows.remove(at: index) } }
    }
    public func loadCurrentMix() {
        updateDraft { $0.rows = RebalanceForm.currentMix(inputs?.actualValues ?? [:], format: numberFormat) }
    }
    public func loadPreset(_ preset: RebalancePreset) {
        updateDraft { $0.rows = RebalanceForm.rows(preset.weights, format: numberFormat) }
    }
    public func compute() async {
        guard canCompute else { return }
        guard let floor = LocaleNumber.parse(reserveFloor, format: numberFormat), floor >= 0 else {
            computeError = nil
            errorKey = "rebalance.commitment.invalidFloor"
            return
        }
        let token = UUID()
        computeRevision = token
        let requestSignature = signature
        let requestCurrency = currency
        let custom =
            draft.capEnabled ? RebalanceForm.cap(draft.cap, available: availableCash, format: numberFormat) : nil
        let model = draft.preset
        let weights = RebalanceForm.weights(draft.rows, format: numberFormat)
        isComputing = true
        computeError = nil
        errorKey = nil
        result = nil
        projection = nil
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let cash = try await service.rebalanceCash(currency: requestCurrency, reserveFloor: floor)
                guard token == computeRevision, requestSignature == signature, !Task.isCancelled else { return }
                let cap = min(cash.candidateCashCap, custom ?? cash.candidateCashCap)
                let value = try await service.rebalance(
                    .init(
                        currency: requestCurrency, model: model,
                        targetWeights: model == nil ? weights : nil, availableCash: cap))
                guard token == computeRevision, requestSignature == signature, !Task.isCancelled else { return }
                result = value
                projection = cash
            } catch {
                guard token == computeRevision, requestSignature == signature, !Task.isCancelled else { return }
                computeError = error.localizedDescription
            }
        }
        computeTask = task
        await task.value
        guard token == computeRevision else { return }
        computeTask = nil
        isComputing = false
    }
    public func savePlan() async {
        guard canSave, let setting else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            errorKey = "rebalance.plan.nameRequired"
            noticeRevision += 1
            return
        }
        let weights = RebalanceForm.weights(draft.rows, format: numberFormat)
        guard !weights.isEmpty else {
            errorKey = "rebalance.editor.needSleeve"
            noticeRevision += 1
            return
        }
        let previous = plans.first { $0.id == draft.planId }
        let id = draft.planId ?? UUID().uuidString.lowercased()
        let cap = draft.capEnabled ? RebalanceForm.cap(draft.cap, available: availableCash, format: numberFormat) : nil
        let plan = RebalancePlan(
            id: id, name: name, targetWeights: weights, cashCap: cap, preserving: previous?.storedValue)
        let next = previous == nil ? plans + [plan] : plans.map { $0.id == id ? plan : $0 }
        cancelPlansRead()
        isSaving = true
        actionError = nil
        errorKey = nil
        noticeKey = nil
        do {
            let saved = try await service.saveRebalancePlans(next, expected: setting.expected)
            self.setting = saved
            plans = try decodePlans(saved.value)
            plansTime = now()
            updateDraft { $0.source = "plan:\(id)" }
            noticeKey = previous == nil ? "rebalance.plan.saved" : "rebalance.plan.updated"
        } catch {
            actionError = error.localizedDescription
            errorKey = "rebalance.plan.saveFailed"
        }
        noticeRevision += 1
        isSaving = false
    }
    public func requestDelete() {
        guard let id = draft.planId, let plan = plans.first(where: { $0.id == id }) else { return }
        deletingPlan = plan
    }
    public func deletePlan() async {
        guard !isSaving, let plan = deletingPlan, let setting else { return }
        isSaving = true
        actionError = nil
        errorKey = nil
        noticeKey = nil
        cancelPlansRead()
        do {
            let saved = try await service.saveRebalancePlans(
                plans.filter { $0.id != plan.id }, expected: setting.expected)
            self.setting = saved
            plans = try decodePlans(saved.value)
            plansTime = now()
            deletingPlan = nil
            selectSource("model:sixty_forty")
            noticeKey = "rebalance.plan.deleted"
        } catch {
            actionError = error.localizedDescription
            errorKey = "rebalance.plan.saveFailed"
        }
        noticeRevision += 1
        isSaving = false
    }
    private var signature: ComputeSignature {
        ComputeSignature(
            currency: currency, source: draft.source, rows: draft.rows, capEnabled: draft.capEnabled,
            cap: draft.cap, floor: reserveFloor, available: availableCash, format: numberFormat)
    }
    private struct ComputeSignature: Equatable {
        let currency: String
        let source: String
        let rows: [RebalanceDraftRow]
        let capEnabled: Bool
        let cap: String
        let floor: String
        let available: Decimal
        let format: NumberFormat
    }
    private func resetComputation() {
        computeRevision = UUID()
        computeTask?.cancel()
        computeTask = nil
        result = nil
        projection = nil
        computeError = nil
        isComputing = false
        if errorKey == "rebalance.commitment.invalidFloor" { errorKey = nil }
    }
    private func loadInputs(force: Bool) async {
        if !force, let inputsTime, now().timeIntervalSince(inputsTime) < 30 { return }
        if let inputsTask {
            await inputsTask.value
            return
        }
        let token = UUID()
        inputsRevision = token
        let currency = currency
        isLoadingInputs = true
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await service.rebalance(.init(currency: currency, model: .sixtyForty))
                guard token == inputsRevision, !Task.isCancelled else { return }
                let old = availableCash
                inputs = value
                inputsError = nil
                inputsTime = now()
                if old != availableCash { resetComputation() }
            } catch {
                guard token == inputsRevision, !Task.isCancelled else { return }
                inputsError = error.localizedDescription
            }
        }
        inputsTask = task
        await task.value
        guard token == inputsRevision else { return }
        inputsTask = nil
        isLoadingInputs = false
    }
    private func loadPlans(force: Bool) async {
        guard !isSaving else { return }
        if !force, let plansTime, now().timeIntervalSince(plansTime) < 30 { return }
        if let plansTask {
            await plansTask.value
            return
        }
        isLoadingPlans = true
        let token = UUID()
        plansRevision = token
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await service.rebalancePlans()
                guard token == plansRevision, !Task.isCancelled else { return }
                plans = try decodePlans(value.value)
                setting = value
                plansError = nil
                plansTime = now()
            } catch {
                guard token == plansRevision, !Task.isCancelled else { return }
                plansError = error.localizedDescription
            }
        }
        plansTask = task
        await task.value
        guard token == plansRevision else { return }
        plansTask = nil
        isLoadingPlans = false
    }
    private func cancelPlansRead() {
        plansRevision = UUID()
        plansTask?.cancel()
        plansTask = nil
        isLoadingPlans = false
    }
    private func hydratePlan() {
        guard plansError == nil, let id = draft.planId else { return }
        guard let plan = plans.first(where: { $0.id == id }) else {
            updateDraft { $0.source = "custom" }
            return
        }
        if !route.query.contains(where: { $0.name == "target" }) { apply(plan) }
    }
    private func apply(_ plan: RebalancePlan) {
        updateDraft {
            $0 = RebalanceURLDraft(
                source: "plan:\(plan.id)",
                rows: RebalanceForm.rows(
                    plan.targetWeights.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }, format: numberFormat),
                name: plan.name, capEnabled: plan.cashCap != nil,
                cap: LocaleNumber.editable(plan.cashCap, format: numberFormat))
        }
    }
    private func decodePlans(_ value: JSONValue) throws -> [RebalancePlan] {
        guard value.arrayValue != nil else { return [] }
        do { return try JSONDecoder().decode([RebalancePlan].self, from: APIBody.encode(value)) } catch {
            throw APIError.contract(
                APIContractError(endpoint: "/api/settings/rebalance_plans", issues: ["value: invalid saved plan array"])
            )
        }
    }
}

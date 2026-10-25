import Foundation
import Observation

@MainActor @Observable
public final class AnalysisMonitorsModel {
    public private(set) var rules: AnalysisMonitorPage<AnalysisMonitorRule>?
    public private(set) var analyses: [AnalysisSaved] = []
    public private(set) var dossiers: AnalysisMonitorPage<AnalysisMonitorDossier>?
    public private(set) var observations: AnalysisMonitorPage<AnalysisMonitorObservation>?
    public private(set) var notifications: AnalysisMonitorPage<AnalysisMonitorNotification>?
    public private(set) var rulesLoading = false
    public private(set) var analysesLoading = false
    public private(set) var dossiersLoading = false
    public private(set) var observationsLoading = false
    public private(set) var notificationsLoading = false
    public private(set) var rulesError: String?
    public private(set) var analysesError: String?
    public private(set) var dossiersError: String?
    public private(set) var observationsError: String?
    public private(set) var notificationsError: String?
    public private(set) var actionError: String?
    public private(set) var validation: AnalysisMonitorInput?
    public private(set) var validationIsEdit = false
    public private(set) var validationRevision = 0
    public private(set) var notice: ScreenNotice?
    public private(set) var isBusy = false
    public private(set) var rulesOffset = 0
    public private(set) var dossierOffset = 0
    public private(set) var observationOffset = 0
    public private(set) var notificationOffset = 0
    public private(set) var selectedId: AnalysisMonitorID?
    public private(set) var newDraft = AnalysisMonitorDraft()
    public private(set) var editDraft: AnalysisMonitorDraft?
    public var deletingRule: AnalysisMonitorRule?
    public var eligibleAnalyses: [AnalysisSaved] { analyses.filter(AnalysisMonitorTargets.eligible) }
    public var selectedRule: AnalysisMonitorRule? { rules?.items.first { $0.id == selectedId } }
    public var newColumns: [String] {
        eligibleAnalyses.first { $0.id == newDraft.savedAnalysisId }.map(AnalysisMonitorTargets.numericColumns) ?? []
    }
    public var editColumns: [String] {
        var fields =
            analyses.first { $0.id == selectedRule?.savedAnalysisId }.map(AnalysisMonitorTargets.numericColumns) ?? []
        if let stored = editDraft?.fieldId, !stored.isEmpty, !fields.contains(stored) { fields.append(stored) }
        return fields
    }
    public var hasNewTarget: Bool {
        newDraft.kind == .threshold
            ? eligibleAnalyses.contains { $0.id == newDraft.savedAnalysisId } : newDraft.dossierId != nil
    }
    public var unreadCount: Int? { notifications?.unreadCount }
    @ObservationIgnored public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored public var unreadDidChange: (@MainActor (Int) -> Void)?
    @ObservationIgnored private let service: any AnalysisMonitorsService
    @ObservationIgnored private var revisions: [Lane: UUID] = [:]
    @ObservationIgnored private var loaded: Set<Lane> = []
    @ObservationIgnored private var editRevision: String?
    @ObservationIgnored private var editDirty = false
    @ObservationIgnored private var noticeID = 0
    private enum Lane: Hashable { case rules, analyses, dossiers, observations, notifications }

    public init(service: any AnalysisMonitorsService) { self.service = service }
    public func invalidate() {
        for lane in [Lane.rules, .analyses, .dossiers, .observations, .notifications] { revisions[lane] = UUID() }
        loaded = []
        rulesLoading = false
        analysesLoading = false
        dossiersLoading = false
        observationsLoading = false
        notificationsLoading = false
    }
    public func load(force: Bool = false) async {
        async let r: Void = loadRules(force: force)
        async let a: Void = loadAnalyses(force: force)
        async let d: Void = loadDossiers(force: force)
        async let n: Void = loadNotifications(force: force)
        _ = await (r, a, d, n)
        if selectedId != nil { await loadObservations(force: force) }
    }
    /// The web polls only rules and inbox every minute; target and history reads stay explicit.
    public func poll() async {
        guard !isBusy else { return }
        async let r: Void = loadRules(force: true)
        async let n: Void = loadNotifications(force: true)
        _ = await (r, n)
    }
    public func loadRules(force: Bool = true) async {
        guard !rulesLoading, force || !loaded.contains(.rules) else { return }
        let offset = rulesOffset
        let token = begin(.rules)
        rulesLoading = true
        defer { if owns(.rules, token) { rulesLoading = false } }
        do {
            let page = try await service.monitorRules(offset: offset)
            guard current(.rules, token) else { return }
            try page.validate(offset: offset, limit: 200)
            rules = page
            rulesError = nil
            loaded.insert(.rules)
            synchronizeEdit()
        } catch { if current(.rules, token) { rulesError = error.localizedDescription } }
    }
    public func loadAnalyses(force: Bool = true) async {
        guard !analysesLoading, force || !loaded.contains(.analyses) else { return }
        let token = begin(.analyses)
        analysesLoading = true
        defer { if owns(.analyses, token) { analysesLoading = false } }
        do {
            let values = try await service.monitorAnalyses()
            guard current(.analyses, token) else { return }
            guard Set(values.map(\.id)).count == values.count else { throw MonitorWire.invalid("analysis ids") }
            analyses = values
            analysesError = nil
            loaded.insert(.analyses)
        } catch { if current(.analyses, token) { analysesError = error.localizedDescription } }
    }
    public func loadDossiers(force: Bool = true) async {
        guard !dossiersLoading, force || !loaded.contains(.dossiers) else { return }
        let offset = dossierOffset
        let token = begin(.dossiers)
        dossiersLoading = true
        defer { if owns(.dossiers, token) { dossiersLoading = false } }
        do {
            let page = try await service.monitorDossiers(offset: offset)
            guard current(.dossiers, token) else { return }
            try page.validate(offset: offset, limit: 500)
            dossiers = page
            dossiersError = nil
            loaded.insert(.dossiers)
        } catch { if current(.dossiers, token) { dossiersError = error.localizedDescription } }
    }
    public func loadObservations(force: Bool = true) async {
        guard let id = selectedId, !observationsLoading, force || !loaded.contains(.observations) else { return }
        let offset = observationOffset
        let token = begin(.observations)
        observationsLoading = true
        defer { if owns(.observations, token) { observationsLoading = false } }
        do {
            let page = try await service.monitorObservations(id: id, offset: offset)
            guard current(.observations, token), selectedId == id else { return }
            try page.validate(offset: offset, limit: 200)
            guard page.items.allSatisfy({ $0.monitorId == id }) else { throw MonitorWire.invalid("monitorId") }
            observations = page
            observationsError = nil
            loaded.insert(.observations)
        } catch {
            if current(.observations, token), selectedId == id { observationsError = error.localizedDescription }
        }
    }
    public func loadNotifications(force: Bool = true) async {
        guard !notificationsLoading, force || !loaded.contains(.notifications) else { return }
        let offset = notificationOffset
        let token = begin(.notifications)
        notificationsLoading = true
        defer { if owns(.notifications, token) { notificationsLoading = false } }
        do {
            let page = try await service.monitorNotifications(offset: offset)
            guard current(.notifications, token) else { return }
            try page.validate(offset: offset, limit: 200, notifications: true)
            notifications = page
            notificationsError = nil
            loaded.insert(.notifications)
            if let count = page.unreadCount { unreadDidChange?(count) }
        } catch { if current(.notifications, token) { notificationsError = error.localizedDescription } }
    }
    public func select(_ id: AnalysisMonitorID) async {
        guard selectedId != id else { return }
        selectedId = id
        observationOffset = 0
        observations = nil
        observationsError = nil
        reset(.observations)
        editRevision = nil
        editDirty = false
        synchronizeEdit()
        await loadObservations()
    }
    public func changeRulesPage(_ offset: Int) async {
        guard offset != rulesOffset else { return }
        rulesOffset = max(0, min(1_000_000, offset))
        rules = nil
        rulesError = nil
        reset(.rules)
        editDraft = nil
        editRevision = nil
        editDirty = false
        await loadRules()
    }
    public func changeDossierPage(_ offset: Int) async {
        guard offset != dossierOffset else { return }
        dossierOffset = max(0, min(1_000_000, offset))
        dossiers = nil
        dossiersError = nil
        newDraft.dossierId = nil
        reset(.dossiers)
        await loadDossiers()
    }
    public func changeObservationPage(_ offset: Int) async {
        guard offset != observationOffset else { return }
        observationOffset = max(0, min(1_000_000, offset))
        observations = nil
        observationsError = nil
        reset(.observations)
        await loadObservations()
    }
    public func changeNotificationPage(_ offset: Int) async {
        guard offset != notificationOffset else { return }
        notificationOffset = max(0, min(1_000_000, offset))
        notifications = nil
        notificationsError = nil
        reset(.notifications)
        await loadNotifications()
    }
    public func updateNew(_ update: (inout AnalysisMonitorDraft) -> Void) {
        guard !isBusy else { return }
        update(&newDraft)
        validation = nil
    }
    public func chooseKind(_ kind: AnalysisMonitorKind) {
        guard !isBusy else { return }
        newDraft = AnalysisMonitorDraft()
        newDraft.kind = kind
        validation = nil
    }
    public func chooseAnalysis(_ id: SavedAnalysisID?) {
        updateNew {
            $0.savedAnalysisId = id
            $0.fieldId = ""
        }
    }
    public func updateEdit(_ update: (inout AnalysisMonitorDraft) -> Void) {
        guard !isBusy, var draft = editDraft else { return }
        let previous = draft
        update(&draft)
        editDraft = draft
        var dataOnly = draft
        dataOnly.scheduleExpanded = previous.scheduleExpanded
        if dataOnly != previous { editDirty = true }
        validation = nil
    }
    public func create() async {
        guard !isBusy else { return }
        clearAction()
        guard validateDraft(edit: false) else { return }
        let input: TaxValue
        do { input = try newDraft.createPayload() } catch {
            actionError = error.localizedDescription
            return
        }
        await perform {
            let created = try await service.monitorCreate(input)
            newDraft = AnalysisMonitorDraft()
            rulesOffset = 0
            selectedId = created.id
            observationOffset = 0
            observations = nil
            observationsError = nil
            editDirty = false
            editDraft = AnalysisMonitorDraft(rule: created)
            editRevision = created.id.rawValue + ":" + created.updatedAt
            publish("monitors.created")
        }
    }
    public func save() async {
        guard !isBusy, let rule = selectedRule, let draft = editDraft else { return }
        clearAction()
        guard validateDraft(edit: true) else { return }
        let payload: TaxValue
        do { payload = try draft.editPayload() } catch {
            actionError = error.localizedDescription
            return
        }
        await perform {
            let saved = try await service.monitorUpdate(id: rule.id, patch: payload)
            if selectedId == rule.id {
                editDirty = false
                editDraft = AnalysisMonitorDraft(rule: saved)
                editRevision = saved.id.rawValue + ":" + saved.updatedAt
            }
            publish("monitors.saved")
        }
    }
    public func toggle(_ rule: AnalysisMonitorRule) async {
        guard !isBusy else { return }
        clearAction()
        await perform {
            let updated = try await service.monitorUpdate(
                id: rule.id, patch: .object(["enabled": .bool(!rule.enabled)]))
            if selectedId == rule.id {
                if editDirty {
                    editDraft?.enabled = updated.enabled
                } else {
                    editDraft = AnalysisMonitorDraft(rule: updated)
                }
                editRevision = updated.id.rawValue + ":" + updated.updatedAt
            }
            publish("monitors.saved")
        }
    }
    public func check(_ rule: AnalysisMonitorRule) async {
        guard !isBusy else { return }
        clearAction()
        await perform {
            let result = try await service.monitorCheck(id: rule.id)
            guard result.monitorId == rule.id else { throw MonitorWire.invalid("monitorId") }
            observationOffset = 0
            reset(.observations)
            publish("monitors.checkResult", variables: ["statusKey": "monitors.status." + result.status.rawValue])
        }
    }
    public func deleteConfirmed() async {
        guard !isBusy, let rule = deletingRule else { return }
        deletingRule = nil
        clearAction()
        await perform {
            try await service.monitorDelete(id: rule.id)
            if selectedId == rule.id {
                selectedId = nil
                editDraft = nil
                editRevision = nil
                editDirty = false
                observations = nil
                observationsError = nil
                observationOffset = 0
                reset(.observations)
            }
            publish("monitors.deleted")
        }
    }
    public func markRead(_ notification: AnalysisMonitorNotification) async {
        guard !isBusy, notification.readAt == nil else { return }
        clearAction()
        await perform {
            let result = try await service.monitorReadNotification(id: notification.id)
            guard result.id == notification.id, result.readAt != nil else { throw MonitorWire.invalid("readAt") }
            publish("monitors.markedRead")
        }
    }
    private func perform(_ action: () async throws -> Void) async {
        isBusy = true
        // Every older read loses its ownership before a write starts, including a minute poll.
        for lane in [Lane.rules, .observations, .notifications] { reset(lane) }
        do { try await action() } catch { actionError = error.localizedDescription }
        // An acknowledgement can be lost after a commit. Refresh authority on either outcome,
        // keeping the failed editor draft and never treating an unavailable inbox as zero unread.
        await didMutate?()
        // Selection, paging and Retry can start reads while a mutation is pending.
        // Those pre-commit reads cannot own the post-commit cache or block its refresh.
        for lane in [Lane.rules, .observations, .notifications] { reset(lane) }
        async let r: Void = loadRules()
        async let n: Void = loadNotifications()
        async let o: Void = loadObservations()
        _ = await (r, n, o)
        isBusy = false
    }
    private func validateDraft(edit: Bool) -> Bool {
        var draft = edit ? editDraft ?? AnalysisMonitorDraft() : newDraft
        let schedule = draft.invalidSchedule
        if schedule != nil { draft.scheduleExpanded = true }
        let invalid: AnalysisMonitorInput?
        if draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            invalid = .title
        } else if draft.kind == .threshold
            && (!AnalysisMonitorDraft.exactDecimal(draft.threshold) || (!edit && !newColumns.contains(draft.fieldId)))
        {
            invalid = .threshold
        } else if draft.kind == .evidence && !edit && draft.dossierId == nil {
            invalid = .target
        } else {
            invalid = schedule
        }
        if edit { editDraft = draft } else { newDraft = draft }
        validation = invalid
        validationIsEdit = edit
        validationRevision &+= 1
        return invalid == nil
    }
    private func synchronizeEdit() {
        guard let rule = selectedRule else {
            editDraft = nil
            editRevision = nil
            editDirty = false
            return
        }
        let revision = rule.id.rawValue + ":" + rule.updatedAt
        guard revision != editRevision, !editDirty else { return }
        editDraft = AnalysisMonitorDraft(rule: rule)
        editRevision = revision
    }
    private func clearAction() {
        actionError = nil
        notice = nil
        validation = nil
    }
    private func publish(_ key: String, variables: [String: String] = [:]) {
        noticeID &+= 1
        notice = ScreenNotice(id: noticeID, kind: .success, key: key, variables: variables)
    }
    private func begin(_ lane: Lane) -> UUID {
        let value = UUID()
        revisions[lane] = value
        return value
    }
    private func owns(_ lane: Lane, _ token: UUID) -> Bool { revisions[lane] == token }
    private func current(_ lane: Lane, _ token: UUID) -> Bool { owns(lane, token) && !Task.isCancelled }
    private func reset(_ lane: Lane) {
        revisions[lane] = UUID()
        loaded.remove(lane)
        switch lane {
        case .rules: rulesLoading = false
        case .analyses: analysesLoading = false
        case .dossiers: dossiersLoading = false
        case .observations: observationsLoading = false
        case .notifications: notificationsLoading = false
        }
    }
}

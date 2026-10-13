import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Analysis monitor wire and exact conditions")
struct AnalysisMonitorsDataTests {
    @Test func thresholdsAndProvenanceRetainExactWireValuesAndDeletedTargets() throws {
        var raw = monitorRuleValue(id: monitorFirstID)
        raw["threshold"] = .string("12345678901234567890123456789012345678901234567890.123456789")
        raw["savedAnalysisId"] = .null
        raw["targetAvailable"] = .bool(false)
        raw["lastObservation"] = monitorObservationValue(monitorID: monitorFirstID, status: .partial)
        let rule = try raw.decode(AnalysisMonitorRule.self)
        #expect(rule.threshold == raw["threshold"]?.stringValue && rule.savedAnalysisId == nil)
        #expect(rule.historicalTargetId == monitorTargetID && !rule.targetAvailable)
        #expect(rule.lastObservation?.status == .partial)
        #expect(
            rule.lastObservation?.analysisWindow?["futureAmount"] == .number(Decimal(string: "0.1234567890123456789")!))
        #expect(rule.lastObservation?.previousValue == "0.1234567890123456789")
        #expect(try TaxValue(encoding: rule) == raw)
    }
    @Test func missingRequiredNullsAndWrongNumericTypesAreRejected() throws {
        var raw = monitorObservationValue(monitorID: monitorFirstID)
        raw["currentValue"] = nil
        #expect(throws: DecodingError.self) { try raw.decode(AnalysisMonitorObservation.self) }
        raw["currentValue"] = .number(1)
        #expect(throws: DecodingError.self) { try raw.decode(AnalysisMonitorObservation.self) }
        var rule = monitorRuleValue(id: monitorFirstID)
        rule["threshold"] = .number(25)
        #expect(throws: DecodingError.self) { try rule.decode(AnalysisMonitorRule.self) }
        rule = monitorRuleValue(id: monitorFirstID)
        rule["cooldownMinutes"] = .number(Decimal(string: "1.5")!)
        #expect(throws: DecodingError.self) { try rule.decode(AnalysisMonitorRule.self) }
    }
    @Test func numericTargetsMatchRawSingleRowResultsAndPreserveLegacyMetadata() throws {
        let live = try monitorAnalysisValue().decode(AnalysisSaved.self)
        #expect(live.lastResult == nil)
        #expect(AnalysisMonitorTargets.numericColumns(live) == ["amount", "exact"])
        #expect(AnalysisMonitorTargets.eligible(live))
        var frozen = live.raw
        frozen["refreshMode"] = .string("frozen")
        #expect(!AnalysisMonitorTargets.eligible(try frozen.decode(AnalysisSaved.self)))
        var many = live.raw
        var result = many["lastResult"]!
        result["rows"] = .array([.object(["amount": .number(1)]), .object(["amount": .number(2)])])
        many["lastResult"] = result
        #expect(AnalysisMonitorTargets.numericColumns(try many.decode(AnalysisSaved.self)).isEmpty)
    }
    @Test func exactDecimalInputDoesNotUseLocaleOrFloatingPoint() throws {
        for value in ["0", "-0", "-12.500", String(repeating: "9", count: 100)] {
            #expect(AnalysisMonitorDraft.exactDecimal(value))
        }
        for value in ["+1", "01", "1,5", ".5", "1.", "1e3", "NaN", " 2", String(repeating: "9", count: 101)] {
            #expect(!AnalysisMonitorDraft.exactDecimal(value))
        }
        var draft = AnalysisMonitorDraft()
        draft.title = "  Rule  "
        draft.savedAnalysisId = monitorTargetID
        draft.fieldId = "amount"
        draft.threshold = "-12.500"
        let create = try draft.createPayload()
        #expect(create["title"] == .string("Rule") && create["threshold"] == .string("-12.500"))
        #expect(create["dossierId"] == nil && create["expected"] == nil)
        let edit = try draft.editPayload()
        #expect(edit["savedAnalysisId"] == nil && edit["dossierId"] == nil && edit["kind"] == nil)
        draft.kind = .evidence
        draft.dossierId = monitorTargetID
        #expect(try draft.createPayload()["threshold"] == nil)
        #expect(try draft.editPayload()["fieldId"] == nil)
    }
    @Test func realOperationsUnwrapExactlyOneEnvelopeAndKeepStrictPartialBodies() async throws {
        let transport = MonitorTestTransport()
        let client = monitorClient(transport)
        let rules = try await client.monitorRules(offset: 0)
        #expect(rules.items.first?.id == monitorFirstID)
        let analyses = try await client.monitorAnalyses()
        #expect(analyses.first?.name == "Synthetic saved analysis")
        _ = try await client.monitorDossiers(offset: 500)
        _ = try await client.monitorObservations(id: monitorFirstID, offset: 0)
        let inbox = try await client.monitorNotifications(offset: 0)
        #expect(inbox.unreadCount == 17)
        _ = try await client.monitorUpdate(id: monitorFirstID, patch: .object(["enabled": .bool(false)]))
        _ = try await client.monitorCheck(id: monitorFirstID)
        _ = try await client.monitorReadNotification(id: monitorNotificationID)
        try await client.monitorDelete(id: monitorFirstID)
        let requests = await transport.requests
        #expect(requests.count == 9)
        #expect(requests[0].url.query?.contains("limit=200") == true)
        #expect(requests[2].url.query?.contains("limit=500") == true)
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(requests[5].body))
        #expect(body == .object(["enabled": .bool(false)]))
        #expect(requests[5].method == .patch && requests[6].method == .post && requests[8].method == .delete)
    }
    @Test func postCreateIsNotAutomaticallyRetriedAfterALostAcknowledgement() async throws {
        let transport = MonitorTestTransport(loseCreate: true)
        let client = monitorClient(transport, retries: 3)
        var draft = AnalysisMonitorDraft()
        draft.title = "Rule"
        draft.savedAnalysisId = monitorTargetID
        draft.fieldId = "amount"
        draft.threshold = "1.000"
        await #expect(throws: APIError.self) { try await client.monitorCreate(draft.createPayload()) }
        #expect(await transport.requests.count == 1)
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(await transport.requests.first?.body))
        #expect(body["threshold"] == .string("1.000"))
        #expect(body["expected"] == nil && body["idempotencyKey"] == nil)
    }
    @Test func wrongObservationIdentityAndMissingInboxCountFailVisibly() async {
        let transport = MonitorTestTransport(invalid: true)
        let client = monitorClient(transport)
        await #expect(throws: Error.self) { try await client.monitorObservations(id: monitorFirstID, offset: 0) }
        await #expect(throws: Error.self) { try await client.monitorNotifications(offset: 0) }
    }
}

@MainActor @Suite("Analysis monitor request and mutation ownership")
struct AnalysisMonitorsModelTests {
    @Test func createResetsTheFormAndSelectsTheAcknowledgedRule() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        model.updateNew {
            $0.title = "Created"
            $0.savedAnalysisId = monitorTargetID
            $0.fieldId = "amount"
            $0.threshold = "-12.500"
        }
        await model.create()
        #expect(model.newDraft.title.isEmpty && model.selectedId == monitorCreatedID)
        #expect(model.notice?.key == "monitors.created" && model.actionError == nil)
        let payload = try #require(await service.creates.first)
        #expect(payload["threshold"] == .string("-12.500") && payload["dossierId"] == nil)
        #expect(model.observations?.items.first?.monitorId == monitorCreatedID)
    }
    @Test func invalidSchedulesOpenTheDisclosureAndRepeatedSubmitsRequestFocusAgain() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        model.updateNew {
            $0.title = "Rule"
            $0.savedAnalysisId = monitorTargetID
            $0.fieldId = "amount"
            $0.threshold = "1"
            $0.intervalMinutes = "14"
        }
        await model.create()
        let revision = model.validationRevision
        #expect(model.newDraft.scheduleExpanded && model.validation == .interval)
        await model.create()
        #expect(model.validationRevision == revision + 1)
        #expect(await service.creates.isEmpty)
        model.updateNew {
            $0.intervalMinutes = "15"
            $0.cooldownMinutes = "0"
        }
        await model.create()
        #expect(await service.creates.count == 1)
    }
    @Test func changingKindsResetsAllInputsAndDossierPagingClearsOnlyTheTarget() async throws {
        let model = AnalysisMonitorsModel(service: try MonitorTestService())
        await model.load()
        model.updateNew {
            $0.title = "Draft"
            $0.threshold = "2"
            $0.intervalMinutes = "60"
        }
        model.chooseKind(.evidence)
        #expect(
            model.newDraft.kind == .evidence && model.newDraft.title.isEmpty && model.newDraft.intervalMinutes == "1440"
        )
        model.updateNew {
            $0.title = "Evidence"
            $0.dossierId = monitorTargetID
            $0.cooldownMinutes = "120"
        }
        await model.changeDossierPage(500)
        #expect(
            model.newDraft.dossierId.isEmpty && model.newDraft.title == "Evidence"
                && model.newDraft.cooldownMinutes == "120")
    }
    @Test func selectingAnotherRuleRejectsTheOldHistoryResponse() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        await service.pause("observations")
        let old = Task { await model.select(monitorFirstID) }
        await service.waitForPause()
        await model.select(monitorSecondID)
        await service.release()
        await old.value
        #expect(model.selectedId == monitorSecondID)
        #expect(model.observations?.items.allSatisfy { $0.monitorId == monitorSecondID } == true)
        #expect(model.editDraft?.title == "Rule 2" && !model.observationsLoading)
    }
    @Test func oldNotificationReadCannotUndoReadStateOrTheServerCount() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        let notification = try #require(model.notifications?.items.first)
        await service.pause("notifications")
        let old = Task { await model.loadNotifications() }
        await service.waitForPause()
        await model.markRead(notification)
        #expect(model.unreadCount == 16 && model.notifications?.items.first?.readAt != nil)
        await service.release()
        await old.value
        #expect(model.unreadCount == 16 && model.notifications?.items.first?.readAt != nil)
    }
    @Test func failedRefetchRetainsCachedListsAndDoesNotEraseUnreadCountOrDirtyEdits() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        await model.select(monitorFirstID)
        model.updateEdit { $0.title = "Unsaved title" }
        await service.setReadFailure(true)
        await model.poll()
        await model.loadObservations()
        #expect(model.rulesError != nil && model.notificationsError != nil && model.observationsError != nil)
        #expect(model.rules?.items.count == 2 && model.unreadCount == 17 && model.observations?.items.count == 1)
        #expect(model.editDraft?.title == "Unsaved title")
        await service.setReadFailure(false)
        await model.poll()
        #expect(model.rulesError == nil && model.notificationsError == nil && model.editDraft?.title == "Unsaved title")
    }
    @Test func failedDomainCheckIsAnObservationAndDisabledRulesDoNotSendRequests() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        await model.select(monitorFirstID)
        let rule = try #require(model.selectedRule)
        await model.check(rule)
        #expect(model.actionError == nil && model.notice?.key == "monitors.checkResult")
        #expect(model.notice?.variables["statusKey"] == "monitors.status.failed")
        #expect(model.observationOffset == 0 && model.observations?.items.first?.status == .failed)
        var raw = monitorRuleValue(id: monitorSecondID)
        raw["enabled"] = .bool(false)
        await model.check(try raw.decode(AnalysisMonitorRule.self))
        #expect(await service.checks == 1)
    }
    @Test func deleteRequiresConfirmationAndClearsOnlyTheDeletedSelection() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        await model.select(monitorFirstID)
        model.deletingRule = model.selectedRule
        model.deletingRule = nil
        await model.deleteConfirmed()
        #expect(await service.deletes.isEmpty)
        model.deletingRule = model.rules?.items.first { $0.id == monitorSecondID }
        await model.deleteConfirmed()
        #expect(model.selectedId == monitorFirstID)
        model.deletingRule = model.selectedRule
        await model.deleteConfirmed()
        #expect(model.selectedId == nil && model.editDraft == nil && model.observations == nil)
        #expect(model.notice?.key == "monitors.deleted")
    }
    @Test func lostUpdateAcknowledgementKeepsTheFormAndRefreshesAuthority() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        var notifications = 0
        model.didMutate = { notifications += 1 }
        await model.load()
        await model.select(monitorFirstID)
        model.updateEdit {
            $0.title = "Committed draft"
            $0.threshold = "2.000"
        }
        await service.loseNextUpdate()
        await model.save()
        #expect(model.actionError != nil && model.notice == nil && notifications == 1)
        #expect(model.selectedRule?.title == "Committed draft" && model.editDraft?.title == "Committed draft")
        #expect(await service.patches.last?["threshold"] == .string("2.000"))
        #expect(await service.patches.last?["savedAnalysisId"] == nil)
    }
    @Test func cancelingAReadClearsLoadingAndAllowsASecondVisit() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await service.pause("rules")
        let read = Task { await model.loadRules() }
        await service.waitForPause()
        read.cancel()
        await service.release()
        await read.value
        #expect(!model.rulesLoading && model.rules == nil)
        await model.loadRules()
        #expect(model.rules?.items.count == 2 && model.rulesError == nil)
    }
    @Test func aReadStartedDuringTheUpdateCannotReplacePostCommitAuthority() async throws {
        let service = try MonitorTestService()
        let model = AnalysisMonitorsModel(service: service)
        await model.load()
        await model.select(monitorFirstID)
        model.updateEdit { $0.title = "Saved title" }
        await service.pause("update")
        let write = Task { await model.save() }
        await service.waitForPause("update")
        await service.pause("rules")
        let oldRead = Task { await model.loadRules() }
        await service.waitForPause("rules")
        await service.release("update")
        await write.value
        #expect(model.selectedRule?.title == "Saved title" && !model.isBusy)
        await service.release("rules")
        await oldRead.value
        #expect(model.selectedRule?.title == "Saved title" && model.editDraft?.title == "Saved title")
    }
    @Test func rowEnableActionUpdatesTheEditorWithoutDiscardingItsOtherDraftFields() async throws {
        let model = AnalysisMonitorsModel(service: try MonitorTestService())
        await model.load()
        await model.select(monitorFirstID)
        model.updateEdit {
            $0.title = "Unsaved title"
            $0.scheduleExpanded = true
        }
        let rule = try #require(model.selectedRule)
        await model.toggle(rule)
        #expect(model.selectedRule?.enabled == false && model.editDraft?.enabled == false)
        #expect(model.editDraft?.title == "Unsaved title" && model.editDraft?.scheduleExpanded == true)
    }
}

private let monitorFirstID = "11111111-1111-4111-8111-111111111111"
private let monitorSecondID = "22222222-2222-4222-8222-222222222222"
private let monitorCreatedID = "33333333-3333-4333-8333-333333333333"
private let monitorTargetID = "44444444-4444-4444-8444-444444444444"
private let monitorObservationID = "55555555-5555-4555-8555-555555555555"
private let monitorNotificationID = "66666666-6666-4666-8666-666666666666"
private let monitorTimestamp = "2026-10-13T12:00:00.000Z"
private func monitorRuleValue(id: String, title: String = "Rule 1") -> TaxValue {
    .object([
        "id": .string(id), "kind": .string("analysis-threshold"), "title": .string(title), "enabled": .bool(true),
        "savedAnalysisId": .string(monitorTargetID), "dossierId": .null, "historicalTargetId": .string(monitorTargetID),
        "targetLabel": .string("Synthetic saved analysis"), "targetAvailable": .bool(true),
        "fieldId": .string("amount"),
        "operator": .string("above"), "threshold": .string("1.00"), "intervalMinutes": .number(1440),
        "cooldownMinutes": .number(1440),
        "nextDueAt": .string(monitorTimestamp), "lastCheckedAt": .null, "lastStatus": .null, "lastObservation": .null,
        "createdAt": .string(monitorTimestamp), "updatedAt": .string(monitorTimestamp),
    ])
}
private func monitorObservationValue(monitorID: String, status: AnalysisMonitorStatus = .baseline) -> TaxValue {
    .object([
        "id": .string(monitorObservationID), "monitorId": .string(monitorID), "status": .string(status.rawValue),
        "previousValue": .string("0.1234567890123456789"), "currentValue": .null,
        "previousEvidenceVersion": .null, "currentEvidenceVersion": .null, "analysisDefinitionVersion": .number(1),
        "analysisRunId": .string(monitorTargetID), "historicalAnalysisRunId": .string(monitorTargetID),
        "analysisRunStatus": .string("completed"),
        "analysisWindow": .object([
            "kind": .string("page"), "futureAmount": .number(Decimal(string: "0.1234567890123456789")!),
        ]),
        "coverage": .object(["status": .string("unknown"), "reason": .string("Synthetic unverified coverage")]),
        "reasonCode": .string(status == .failed ? "analysis-execution-failed" : "baseline"),
        "reason": .string("Synthetic reason"),
        "checkedAt": .string(monitorTimestamp),
    ])
}
private func monitorNotificationValue(read: Bool = false) -> TaxValue {
    .object([
        "id": .string(monitorNotificationID), "monitorId": .string(monitorFirstID),
        "observationId": .string(monitorObservationID),
        "kind": .string("analysis-threshold"), "title": .string("Synthetic alert"),
        "reasonCode": .string("threshold-crossed"),
        "reason": .string("Synthetic reason"), "previousValue": .string("1.000"), "currentValue": .string("2.000"),
        "createdAt": .string(monitorTimestamp), "readAt": read ? .string(monitorTimestamp) : .null,
    ])
}
private func monitorAnalysisValue() -> TaxValue {
    .object([
        "id": .string(monitorTargetID), "definitionId": .string(monitorTargetID),
        "name": .string("Synthetic saved analysis"),
        "workspace": .string("portfolio"), "version": .number(1), "refreshMode": .string("live"),
        "parameters": .object([:]),
        "charts": .array([]), "sourceReferences": .array([]), "refreshStatus": .string("succeeded"),
        "lastSuccessfulRunId": .null,
        "lastError": .null, "definition": .object([:]), "createdAt": .string(monitorTimestamp),
        "updatedAt": .string(monitorTimestamp),
        "lastResult": .object([
            "rows": .array([
                .object([
                    "amount": .number(Decimal(string: "0.1234567890123456789")!),
                    "exact": .string("12.500"), "scientific": .string("1e3"), "missing": .null, "text": .string("12"),
                ])
            ]),
            "columns": .array(
                ["amount", "exact", "scientific", "missing", "text"].map { id in
                    .object(["id": .string(id), "type": .string(id == "text" ? "text" : "currency")])
                }),
        ]),
    ])
}
private func monitorClient(_ transport: MonitorTestTransport, retries: Int = 0) -> APIClient {
    APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: retries)
}
private func monitorPage(_ items: [TaxValue], offset: Int = 0, limit: Int = 200, unread: Int? = nil) -> TaxValue {
    var value: TaxValue = .object([
        "items": .array(items), "total": .number(Decimal(offset + items.count)), "limit": .number(Decimal(limit)),
        "offset": .number(Decimal(offset)),
    ])
    if let unread { value["unreadCount"] = .number(Decimal(unread)) }
    return value
}
private actor MonitorTestTransport: APITransport {
    var requests: [APIRequest] = []
    let invalid: Bool
    let loseCreate: Bool
    init(invalid: Bool = false, loseCreate: Bool = false) {
        self.invalid = invalid
        self.loseCreate = loseCreate
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        if request.method == .delete { return .init(status: 204, body: Data()) }
        let data: TaxValue
        if request.url.path == "/api/analysis/saved" {
            data = .object(["items": .array([monitorAnalysisValue()])])
        } else if request.url.path == "/api/research-dossiers" {
            data = monitorPage(
                [.object(["id": .string(monitorTargetID), "title": .string("Synthetic dossier")])], offset: 500,
                limit: 500)
        } else if request.url.path.hasSuffix("/observations") {
            data = monitorPage([monitorObservationValue(monitorID: invalid ? monitorSecondID : monitorFirstID)])
        } else if request.url.path.hasSuffix("/notifications") {
            data = monitorPage([monitorNotificationValue()], unread: invalid ? nil : 17)
        } else if request.url.path.hasSuffix("/read") {
            data = monitorNotificationValue(read: true)
        } else if request.url.path.hasSuffix("/check") {
            data = monitorObservationValue(monitorID: monitorFirstID)
        } else if request.method == .post {
            if loseCreate { throw APIError.network("Synthetic lost create acknowledgement") }
            data = monitorRuleValue(id: monitorCreatedID)
        } else if request.method == .patch {
            data = monitorRuleValue(id: monitorFirstID)
        } else {
            data = monitorPage([monitorRuleValue(id: monitorFirstID)])
        }
        return .init(
            status: request.method == .post && request.url.path == "/api/analysis/monitors" ? 201 : 200,
            body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
}
private actor MonitorTestService: AnalysisMonitorsService {
    var ruleValues = [monitorRuleValue(id: monitorFirstID), monitorRuleValue(id: monitorSecondID, title: "Rule 2")]
    var creates: [TaxValue] = []
    var patches: [TaxValue] = []
    var deletes: [String] = []
    var checks = 0
    var read = false
    var readFailure = false
    var lostUpdate = false
    private var paused: Set<String> = []
    private var lastPaused = ""
    private var held: [String: CheckedContinuation<Void, Never>] = [:]
    private var entered: [String: CheckedContinuation<Void, Never>] = [:]
    init() throws {}
    func pause(_ operation: String) {
        paused.insert(operation)
        lastPaused = operation
    }
    func waitForPause(_ operation: String? = nil) async {
        let key = operation ?? lastPaused
        if held[key] == nil { await withCheckedContinuation { entered[key] = $0 } }
    }
    func release(_ operation: String? = nil) { held.removeValue(forKey: operation ?? lastPaused)?.resume() }
    func setReadFailure(_ fail: Bool) { readFailure = fail }
    func loseNextUpdate() { lostUpdate = true }
    private func wait(_ operation: String) async {
        guard paused.remove(operation) != nil else { return }
        await withCheckedContinuation {
            held[operation] = $0
            entered.removeValue(forKey: operation)?.resume()
        }
    }
    func monitorRules(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorRule> {
        let values = try ruleValues.map { try $0.decode(AnalysisMonitorRule.self) }
        await wait("rules")
        if readFailure { throw APIError.network("Synthetic rules failure") }
        return .init(items: offset == 0 ? values : [], total: values.count, limit: 200, offset: offset)
    }
    func monitorAnalyses() async throws -> [AnalysisSaved] { [try monitorAnalysisValue().decode(AnalysisSaved.self)] }
    func monitorDossiers(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorDossier> {
        .init(items: [.init(id: monitorTargetID, title: "Synthetic dossier")], total: 501, limit: 500, offset: offset)
    }
    func monitorObservations(id: String, offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorObservation> {
        let value = try monitorObservationValue(monitorID: id, status: checks > 0 ? .failed : .baseline).decode(
            AnalysisMonitorObservation.self)
        await wait("observations")
        if readFailure { throw APIError.network("Synthetic observations failure") }
        return .init(items: [value], total: 1, limit: 200, offset: offset)
    }
    func monitorNotifications(offset: Int) async throws -> AnalysisMonitorPage<AnalysisMonitorNotification> {
        let value = try monitorNotificationValue(read: read).decode(AnalysisMonitorNotification.self)
        let unread = read ? 16 : 17
        await wait("notifications")
        if readFailure { throw APIError.network("Synthetic inbox failure") }
        return .init(items: [value], total: 17, limit: 200, offset: offset, unreadCount: unread)
    }
    func monitorCreate(_ input: TaxValue) async throws -> AnalysisMonitorRule {
        creates.append(input)
        var value = monitorRuleValue(id: monitorCreatedID, title: input["title"]!.stringValue!)
        for key in ["threshold", "operator", "fieldId", "intervalMinutes", "cooldownMinutes"] {
            value[key] = input[key]
        }
        ruleValues.insert(value, at: 0)
        return try value.decode(AnalysisMonitorRule.self)
    }
    func monitorUpdate(id: String, patch: TaxValue) async throws -> AnalysisMonitorRule {
        patches.append(patch)
        await wait("update")
        let index = ruleValues.firstIndex { $0["id"] == .string(id) }!
        for (key, value) in patch.objectValue! { ruleValues[index][key] = value }
        ruleValues[index]["updatedAt"] = .string("2026-10-13T12:01:00.000Z")
        if lostUpdate {
            lostUpdate = false
            throw APIError.network("Synthetic lost update acknowledgement")
        }
        return try ruleValues[index].decode(AnalysisMonitorRule.self)
    }
    func monitorDelete(id: String) async throws {
        deletes.append(id)
        ruleValues.removeAll { $0["id"] == .string(id) }
    }
    func monitorCheck(id: String) async throws -> AnalysisMonitorObservation {
        checks += 1
        return try monitorObservationValue(monitorID: id, status: .failed).decode(AnalysisMonitorObservation.self)
    }
    func monitorReadNotification(id: String) async throws -> AnalysisMonitorNotification {
        read = true
        return try monitorNotificationValue(read: true).decode(AnalysisMonitorNotification.self)
    }
}

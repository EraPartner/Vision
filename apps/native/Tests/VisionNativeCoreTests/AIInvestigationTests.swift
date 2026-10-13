import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Investigation source inputs, inspected grants and visit authority")
struct AIInvestigationTests {
    @Test func rawDecimalsEvidenceAndUnknownFieldsRemainLossless() throws {
        var raw = investigationAnswerFixture()
        raw["unknown"] = .number(Decimal(string: "123456789.1234567890123456789")!)
        let answer = try AIAnswer(raw: raw)
        #expect(answer.evidence[0].locator == "account:1")
        #expect(answer.facts[0].evidenceIds == ["e1"])
        #expect(try TaxValue(encoding: answer) == raw)
        let document = try AIResearchDocument(raw: investigationDocumentFixture())
        #expect(document.extractionError == nil && document.version == 1)
        #expect(throws: APIError.self) { try AIDisclosurePreview(raw: .object([:])) }
    }
    @Test func preferencesModelFallbackAndEcmaTrimMatchTheSource() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        var settings = NativeAppSettings(
            defaultCurrency: "usd", analysisBenchmark: " \u{FEFF}acwi\u{FEFF} ", aiAnswerDepth: "invalid",
            language: "nl")
        settings.openAiDefaultModel = "second"
        model.configure(settings: settings)
        await model.load()
        #expect(model.resolvedCurrency == "EUR" && model.resolvedBenchmark == "ACWI")
        #expect(model.depth == "quick" && model.language == "nl" && model.openAiModel == "second")
        model.openAiModelOverride = "invalid"
        #expect(model.openAiModel == "second")
        model.openAiModelOverride = "first"
        #expect(model.openAiModel == "first")
        model.question = " \u{FEFF}question\u{FEFF} "
        #expect(model.input()["question"] == .string("question"))
        model.clarification = "\u{FEFF}"
        #expect(!model.canClarify)
        model.clarification = "\u{0085}"
        #expect(model.canClarify)
        model.didDisappear()
    }
    @Test func localRunUsesExactScopeAndThreePublicSymbolsWithoutDisclosureCalls() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .seconds(60))
        model.configure(
            settings: .init(
                defaultCurrency: "USD", analysisBenchmark: "ACWI", aiAnswerDepth: "detailed", language: "nl"))
        await model.load()
        model.question = " Question "
        model.researchMode = "public-providers"
        model.publicSymbols = " aapl, ,msft,aapl,extra "
        model.dateFrom = "2026-01-01"
        await model.run()
        let input = try #require(await service.creates.first)
        #expect(input["publicSymbols"] == .array([.string("AAPL"), .string("MSFT"), .string("AAPL")]))
        #expect(input["scope"]?["currency"] == .string("USD"))
        #expect(input["scope"]?["constraints"] == .array([.string("benchmark:ACWI")]))
        #expect(input["scope"]?["accountIds"] == .array([]) && input["scope"]?["dateTo"] == .null)
        #expect(input["grantId"] == .null && input["selectedEvidence"] == .null)
        #expect(await service.grants.isEmpty)
        #expect(await service.previews.isEmpty)
        #expect(model.job?.id == "job1")
        model.didDisappear()
    }
    @Test func inspectedPreviewBindsGrantAndFrozenOutboundEvenWhenFormChangesDuringGrant() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(
            service: service, pollDelay: .seconds(60), now: { Date(timeIntervalSince1970: 0) })
        await model.load()
        model.route = "openai-api"
        model.question = "private"
        model.publicQuestion = "public"
        model.depthOverride = "detailed"
        await model.run()
        #expect(model.preview?.payloadSha256 == "hash")
        #expect(await service.creates.isEmpty)
        await service.pause("grant")
        let pending = Task { await model.run() }
        await service.waitForPause()
        model.question = "changed"
        model.selectedEvidence = "new"
        await service.release()
        await pending.value
        let grant = try #require(await service.grants.first)
        let create = try #require(await service.creates.first)
        #expect(
            grant["previewHash"] == .string("hash") && grant["allowedFields"] == .array([.string("publicQuestion")]))
        #expect(grant["maxInputCharacters"] == .number(120) && grant["maxOutputTokens"] == .number(7200))
        #expect(grant["maxDisclosureUnits"] == .number(1) && grant["retainExactPayload"] == .bool(false))
        #expect(grant["expiresAt"] == .string("1970-01-01T00:15:00.000Z"))
        #expect(create["question"] == .string("frozen") && create["grantId"] == .string("grant1"))
        #expect(create["unknown"] == .string("retain") && model.preview == nil)
        model.didDisappear()
    }
    @Test func stalePreviewAndChangedResolvedSettingsCannotRestoreConsent() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        model.route = "openai-api"
        model.question = "private"
        model.publicQuestion = "public"
        await service.pause("preview")
        let pending = Task { await model.run() }
        await service.waitForPause()
        model.dateTo = "2026-10-13"
        await service.release()
        await pending.value
        #expect(model.preview == nil && !model.busy)
        await model.run()
        #expect(model.preview != nil)
        model.configure(settings: .init(defaultCurrency: "USD"))
        #expect(model.preview == nil)
        model.didDisappear()
    }
    @Test func disclosureModeFieldsAndRunDisabledMatchSourceIncludingCloudAccessControls() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        model.question = "q"
        model.route = "openai-api"
        #expect(model.runDisabled)
        model.disclosureMode = "selected-summary"
        model.selectedSummary = " inspected "
        #expect(!model.runDisabled && model.input()["selectedSummary"] == .string("inspected"))
        model.disclosureMode = "cloud-synthesis-selected"
        model.selectedEvidence = " {raw} "
        model.researchMode = "public-web"
        #expect(model.runDisabled)
        model.publicWebQuery = " allowed "
        #expect(!model.runDisabled && model.input()["selectedEvidence"] == .string("{raw}"))
        #expect(model.input()["publicWebQuery"] == .string("allowed") && model.input()["publicQuestion"] == .null)
        model.didDisappear()
    }
    @Test func pollWaitsForSourceIntervalAndStopsAtWaitingWithoutReplacingCancelResponse() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(10))
        await model.load()
        model.question = "q"
        await service.pause("get")
        await model.run()
        await service.waitForPause()
        await model.cancel()
        #expect(model.job?.state == "running")
        await service.release()
        try await waitForPublishedState(model, "waiting")
        #expect(await service.getReads >= 1)
        model.clarification = " clarify "
        await model.resume()
        #expect(await service.resumes.first?["clarification"] == .string("clarify"))
        model.didDisappear()
    }
    @Test func deleteRetiresInFlightPollAndCannotRestoreDeletedJob() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(1))
        await model.load()
        model.question = "q"
        await service.pause("get")
        await model.run()
        await service.waitForPause()
        await model.deleteJob()
        #expect(model.job == nil)
        await service.release()
        try await Task.sleep(for: .milliseconds(10))
        #expect(model.job == nil && !model.busy)
        model.didDisappear()
    }
    @Test func failedNonIdempotentCreateIsNotReplayedAndBusyClears() async throws {
        let service = InvestigationFixtureService()
        await service.failCreates()
        let model = AIInvestigationModel(service: service)
        await model.load()
        model.question = "q"
        await model.run()
        #expect(await service.creates.count == 1)
        #expect(model.error != nil && model.job == nil && !model.busy)
        model.didDisappear()
    }
    @Test func historyWritesRetireReadsStartedBeforeAndDuringTheWrite() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        await model.loadHistory()
        #expect(model.recordCount == 1 && model.disclosureGrants.count == 1)
        await service.pause("history")
        let pending = Task { await model.loadHistory() }
        await service.waitForPause()
        await model.deleteHistory()
        await service.release()
        await pending.value
        #expect(model.recordCount == 0 && model.disclosureRecords.isEmpty && model.disclosureGrants.isEmpty)
        await model.loadHistory()
        await model.revokeGrant("grant1")
        #expect(model.disclosureGrants.first?["revoked_at"]?.stringValue != nil)
        model.didDisappear()
    }
    @Test func uploadAndConfirmedDeleteRemainScopedAndNoConfirmationIsInventedForJobHistory() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        let file = AIResearchDocumentFile(name: "note.md", contentType: "text/markdown", data: Data("raw <text>".utf8))
        await model.uploadDocument(file)
        #expect(await service.uploads == [file] && model.documents.first?.id == "doc1")
        await model.deleteDocumentConfirmed("doc1")
        #expect(model.documents.isEmpty)
        #expect(await service.deletedDocuments == ["doc1"])
        model.didDisappear()
    }
    @Test func realRouteExitResetsDraftAndBlocksLateJobAcknowledgement() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        model.question = "q"
        await service.pause("create")
        let pending = Task { await model.run() }
        await service.waitForPause()
        model.didDisappear()
        await model.load()
        model.question = "new visit"
        await service.release()
        await pending.value
        #expect(model.job == nil && model.question == "new visit" && !model.busy)
        model.didDisappear()
    }
    @Test func offlineBackgroundStatusPausesButDocumentsAndManualJobPollKeepSourcePolicy() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(10))
        model.isOnline = false
        model.isForeground = false
        await model.load()
        #expect(await service.statusReads == 0)
        #expect(await service.documentReads == 1)
        model.question = "q"
        await model.run()
        try await waitForPublishedState(model, "waiting")
        #expect(await service.getReads >= 1)
        model.isOnline = true
        await model.refreshStatusIfStale()
        #expect(await service.statusReads == 0)
        model.isForeground = true
        await model.refreshStatusIfStale()
        #expect(await service.statusReads == 1)
        #expect(await service.documentReads == 1)
        model.didDisappear()
    }
    @Test func failedStatusRecoversOnReconnectWithoutRetryingFailedDocumentMountRead() async throws {
        let service = InvestigationFixtureService()
        await service.failStatusOnce()
        await service.failDocumentOnce()
        let model = AIInvestigationModel(service: service)
        await model.load()
        #expect(model.status == nil && !model.openAiEnabled && model.error == nil)
        model.isForeground = false
        model.isForeground = true
        await Task.yield()
        #expect(await service.statusReads == 1)
        model.isOnline = false
        model.isOnline = true
        await model.refreshStatusIfStale()
        #expect(model.openAiEnabled && model.openAiModel == "first")
        #expect(await service.statusReads == 2)
        #expect(await service.documentReads == 1)
        model.didDisappear()
    }
    @Test func freshStatusFocusUsesSixtySecondCacheAndStaleReturnRefreshesOnlyStatus() async throws {
        let service = InvestigationFixtureService()
        let clock = InvestigationFixtureClock()
        let model = AIInvestigationModel(service: service, now: { clock.read() })
        await model.load()
        model.isForeground = false
        model.isForeground = true
        await model.refreshStatusIfStale()
        #expect(await service.statusReads == 1)
        clock.advance(61)
        model.isForeground = false
        model.isForeground = true
        await Task.yield()
        #expect(await service.statusReads == 1)
        model.isOnline = false
        model.isOnline = true
        await model.refreshStatusIfStale()
        #expect(await service.statusReads == 2)
        #expect(await service.documentReads == 1)
        model.didDisappear()
    }
    @Test func modeAndConversationRefreshesDoNotIndependentlyRefetchExpiredStatus() async throws {
        let service = InvestigationFixtureService()
        let clock = InvestigationFixtureClock()
        let model = AIInvestigationModel(service: service, now: { clock.read() })
        await model.load()
        clock.advance(61)
        await model.load()
        #expect(await service.statusReads == 1)
        #expect(await service.documentReads == 1)
        await model.load(force: true)
        #expect(await service.statusReads == 2)
        model.didDisappear()
    }
    @Test func footerAndHistoryRevokeKeepTheirDistinctSourceControlState() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .seconds(60))
        await model.load()
        model.route = "openai-api"
        model.question = "private"
        model.publicQuestion = "public"
        await model.run()
        await model.run()
        await model.loadHistory()
        await model.revokeActiveGrant()
        #expect(model.grantId == nil && model.disclosureGrants.first?["revoked_at"] == .null)
        await model.run()
        #expect(model.grantId == "grant1")
        await model.revokeGrant("grant1")
        #expect(model.grantId == "grant1" && model.disclosureGrants.first?["revoked_at"]?.stringValue != nil)
        model.didDisappear()
    }
    @Test func retiredQueuedFocusCannotStartAHiddenStatusRead() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        model.isOnline = false
        await model.load()
        model.isOnline = true
        model.didDisappear()
        await Task.yield()
        await Task.yield()
        #expect(await service.statusReads == 0)
        #expect(await service.documentReads == 1)
    }
    @Test func onlineInitialMountFetchesStatusEvenWhenBackgrounded() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        model.isForeground = false
        await model.load()
        #expect(await service.statusReads == 1)
        #expect(await service.documentReads == 1)
        #expect(model.openAiEnabled)
        model.didDisappear()
    }
    @Test func slowJobReadsOverlapAtSourceIntervalWithoutRestoringADeletedJob() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(10))
        await model.load()
        model.question = "q"
        await service.pause("get")
        await model.run()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while await service.getReads < 2, clock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(await service.getReads >= 2)
        await model.deleteJob()
        await service.release()
        await Task.yield()
        await Task.yield()
        #expect(model.job == nil)
        model.didDisappear()
    }
    @Test func staleBackgroundReconnectStartsANewOnlineQueryWithoutFocusRefetch() async throws {
        let service = InvestigationFixtureService()
        let clock = InvestigationFixtureClock()
        let model = AIInvestigationModel(service: service, now: { clock.read() })
        await model.load()
        clock.advance(61)
        model.isForeground = false
        model.isOnline = false
        model.isOnline = true
        await model.refreshStatusIfStale(initialMount: true)
        #expect(await service.statusReads == 2)
        #expect(await service.documentReads == 1)
        model.didDisappear()
    }
    private func waitForPublishedState(_ model: AIInvestigationModel, _ state: String) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while model.job?.state != state, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        try #require(model.job?.state == state, "Expected the acknowledged poll snapshot to publish")
    }
    @Test func actualAPIAdapterUsesExistingOperationsAndOriginalMultipartBytes() async throws {
        let transport = InvestigationHTTPFixture()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        _ = try await client.investigationStatus()
        _ = try await client.investigationCreate(.object(["question": .string("q")]))
        _ = try await client.investigationGet(id: "job1")
        _ = try await client.investigationResume(
            id: "job1", clarification: "text", scope: .object(["currency": .string("EUR")]))
        let file = AIResearchDocumentFile(
            name: "note.md", contentType: "text/markdown", data: Data("unchanged \u{FEFF} text".utf8))
        _ = try await client.investigationUpload(file)
        try await client.investigationDeleteDocument(id: "doc1")
        try await client.investigationDelete(id: "job1")
        let requests = await transport.requests
        #expect(
            requests.map { $0.url.path } == [
                "/api/ai-research/status", "/api/ai-research/investigations", "/api/ai-research/investigations/job1",
                "/api/ai-research/investigations/job1/resume", "/api/ai-research/documents",
                "/api/ai-research/documents/doc1", "/api/ai-research/investigations/job1",
            ])
        let body = try #require(requests[4].body)
        #expect(String(decoding: body, as: UTF8.self).contains("name=\"file\"; filename=\"note.md\""))
        #expect(body.range(of: file.data) != nil)
        #expect(requests[4].headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    }
}

private func investigationStatusFixture() -> TaxValue {
    .object([
        "openai": .object([
            "enabled": .bool(true), "model": .string("first"),
            "models": .array(
                ["first", "second"].map {
                    .object([
                        "id": .string($0), "label": .string($0), "inputMicrosPerMillion": .number(100),
                        "outputMicrosPerMillion": .number(200), "isDefault": .bool($0 == "first"),
                    ])
                }),
        ])
    ])
}
private func investigationJobFixture(state: String = "running") -> TaxValue {
    .object([
        "id": .string("job1"), "question": .string("q"), "route": .string("local"), "depth": .string("quick"),
        "language": .string("en"), "state": .string(state), "plan": .null, "result": .null, "error": .null,
    ])
}
private func investigationPreviewFixture() -> TaxValue {
    .object([
        "payload": .object(["publicQuestion": .string("public")]), "payloadSha256": .string("hash"),
        "payloadBytes": .number(60), "fieldManifest": .array([.string("publicQuestion")]),
        "disclosureUnits": .array([.string("u1")]), "referenceScope": .null,
        "outboundRequest": .object(["question": .string("frozen"), "unknown": .string("retain")]),
        "agentCloakPreflight": .object(["enabled": .bool(false)]),
    ])
}
private func investigationDocumentFixture() -> TaxValue {
    .object([
        "id": .string("doc1"), "title": .string("Note"), "sourceName": .string("note.md"),
        "mediaType": .string("text/markdown"), "version": .number(1), "extractionStatus": .string("ready"),
        "extractionError": .null, "createdAt": .string("2026-10-13T00:00:00Z"),
    ])
}
private func investigationAnswerFixture() -> TaxValue {
    .object([
        "status": .string("qualified"), "depth": .string("quick"), "language": .string("en"),
        "summary": .string("Evidence"),
        "facts": .array([.object(["text": .string("fact"), "evidenceIds": .array([.string("e1")])])]),
        "calculations": .array([]), "interpretations": .array([]), "assumptions": .array([]),
        "missingInformation": .array([]), "analysisReference": .null,
        "evidence": .array([
            .object([
                "id": .string("e1"), "kind": .string("local"), "label": .string("account"), "sourceDate": .null,
                "locator": .string("account:1"), "excerpt": .null, "available": .bool(true),
            ])
        ]),
    ])
}
private actor InvestigationFixtureService: AIInvestigationService {
    var creates: [TaxValue] = []
    var grants: [TaxValue] = []
    var previews: [TaxValue] = []
    var resumes: [TaxValue] = []
    var uploads: [AIResearchDocumentFile] = []
    var deletedDocuments: [String] = []
    var getReads = 0
    var statusReads = 0
    var documentReads = 0
    private var failingStatus = false
    private var failingDocument = false
    private var pauseKind: String?
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var paused = false
    private var failCreate = false
    func pause(_ kind: String) { pauseKind = kind }
    func waitForPause() async { while !paused { await Task.yield() } }
    func release() {
        pauseKind = nil
        paused = false
        let pending = continuations
        continuations = []
        for continuation in pending { continuation.resume() }
    }
    func failCreates() { failCreate = true }
    func failStatusOnce() { failingStatus = true }
    func failDocumentOnce() { failingDocument = true }
    private func gate(_ kind: String) async {
        guard pauseKind == kind else { return }
        paused = true
        await withCheckedContinuation { continuations.append($0) }
    }
    func investigationStatus() throws -> AIResearchStatus {
        statusReads += 1
        if failingStatus {
            failingStatus = false
            throw APIError.network("synthetic unavailable")
        }
        return try .init(raw: investigationStatusFixture())
    }
    func investigationDocuments() throws -> [AIResearchDocument] {
        documentReads += 1
        if failingDocument {
            failingDocument = false
            throw APIError.network("synthetic documents unavailable")
        }
        return []
    }
    func investigationCreate(_ input: TaxValue) async throws -> AIInvestigation {
        creates.append(input)
        await gate("create")
        if failCreate { throw APIError.network("lost receipt") }
        return try .init(raw: investigationJobFixture())
    }
    func investigationGet(id: String) async throws -> AIInvestigation {
        getReads += 1
        await gate("get")
        return try .init(raw: investigationJobFixture(state: "waiting"))
    }
    func investigationDelete(id: String) {}
    func investigationCancel(id: String) throws -> AIInvestigation {
        try .init(raw: investigationJobFixture(state: "cancelled"))
    }
    func investigationResume(id: String, clarification: String, scope: TaxValue) throws -> AIInvestigation {
        resumes.append(.object(["clarification": .string(clarification), "scope": scope]))
        return try .init(raw: investigationJobFixture(state: "completed"))
    }
    func investigationPreview(_ input: TaxValue) async throws -> AIDisclosurePreview {
        previews.append(input)
        await gate("preview")
        return try .init(raw: investigationPreviewFixture())
    }
    func investigationGrant(_ input: TaxValue) async -> String {
        grants.append(input)
        await gate("grant")
        return "grant1"
    }
    func investigationRecords() async -> TaxValue {
        await gate("history")
        return .object(["items": .array([.object(["id": .string("record1")])]), "total": .number(1)])
    }
    func investigationGrants() -> TaxValue {
        .object([
            "items": .array([
                .object(["id": .string("grant1"), "mode": .string("selected-summary"), "revoked_at": .null])
            ]), "total": .number(1),
        ])
    }
    func investigationRevoke(id: String) {}
    func investigationDeleteHistory() {}
    func investigationUpload(_ file: AIResearchDocumentFile) throws -> AIResearchDocument {
        uploads.append(file)
        return try .init(raw: investigationDocumentFixture())
    }
    func investigationDeleteDocument(id: String) { deletedDocuments.append(id) }
}
private actor InvestigationHTTPFixture: APITransport {
    var requests: [APIRequest] = []
    func send(_ request: APIRequest) throws -> APIResponse {
        requests.append(request)
        if request.method == .delete { return .init(status: 204, body: Data()) }
        let result: TaxValue
        if request.url.path.hasSuffix("/status") {
            result = investigationStatusFixture()
        } else if request.url.path == "/api/ai-research/documents" {
            result = investigationDocumentFixture()
        } else {
            result = investigationJobFixture()
        }
        return .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": result])))
    }
}

private final class InvestigationFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 0)
    func read() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return date
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        date = date.addingTimeInterval(seconds)
    }
}

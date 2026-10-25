import Foundation
import Observation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Local investigation source inputs and visit authority")
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
    }
    @Test func preferencesModelFallbackAndEcmaTrimMatchTheSource() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        let settings = NativeAppSettings(
            defaultCurrency: "USD", analysisBenchmark: " \u{FEFF}acwi\u{FEFF} ", aiAnswerDepth: "invalid",
            language: "nl")
        model.configure(settings: settings)
        await model.load()
        #expect(model.resolvedCurrency == CurrencyCode(rawValue: "USD") && model.resolvedBenchmark == "ACWI")
        #expect(model.depth == .quick && model.language == .nl)
        model.question = " \u{FEFF}question\u{FEFF} "
        #expect(model.input()["question"] == .string("question"))
        model.clarification = "\u{FEFF}"
        #expect(!model.canClarify)
        model.clarification = "\u{0085}"
        #expect(model.canClarify)
        model.didDisappear()
    }
    @Test func localRunUsesExactScopeAndThreePublicSymbolsAndOnlyTheLocalRoute() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .seconds(60))
        model.configure(
            settings: .init(
                defaultCurrency: "USD", analysisBenchmark: "ACWI", aiAnswerDepth: "detailed", language: "nl"))
        await model.load()
        model.question = " Question "
        model.researchMode = .publicProviders
        model.publicSymbols = " aapl, ,msft,aapl,extra "
        model.dateFrom = "2026-01-01"
        await model.run()
        let input = try #require(await service.creates.first)
        #expect(input["publicSymbols"] == .array([.string("AAPL"), .string("MSFT"), .string("AAPL")]))
        #expect(input["scope"]?["currency"] == .string("USD"))
        #expect(input["scope"]?["constraints"] == .array([.string("benchmark:ACWI")]))
        #expect(input["scope"]?["accountIds"] == .array([]) && input["scope"]?["dateTo"] == .null)
        #expect(input["route"] == .string("local") && input["model"] == .null)
        for retired in ["grantId", "selectedSummary", "selectedEvidence", "publicQuestion", "referenceScopeId"] {
            #expect(input[retired] == nil)
        }
        #expect(model.job?.id == "job1")
        model.didDisappear()
    }
    @Test(.timeLimit(.minutes(2)))
    func pollWaitsForSourceIntervalAndStopsAtWaitingWithoutReplacingCancelResponse() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(10))
        defer { model.didDisappear() }
        await model.load()
        model.question = "q"
        await service.pause("get")
        await model.run()
        await service.waitForPause()
        await model.cancel()
        #expect(model.job?.state == .running)
        await service.release()
        try await waitForPublishedState(model, .waiting)
        #expect(await service.getReads >= 1)
        model.clarification = " clarify "
        await model.resume()
        #expect(await service.resumes.first?["clarification"] == .string("clarify"))
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
    @Test(.timeLimit(.minutes(1)))
    func slowJobReadsOverlapAtSourceIntervalWithoutRestoringADeletedJob() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service, pollDelay: .milliseconds(10))
        defer {
            model.didDisappear()
            Task { await service.release() }
        }
        await model.load()
        model.question = "q"
        await service.pause("get")
        await model.run()
        // Both reads must be outstanding before the delete, regardless of executor scheduling.
        try await service.waitForPausedGets(2)
        #expect(await service.getReads >= 2)
        await model.deleteJob()
        await service.release()
        await Task.yield()
        await Task.yield()
        #expect(model.job == nil)
    }
    @Test func runDisabledRequiresAQuestionAndTheInputOfTheSelectedResearchMode() async throws {
        let service = InvestigationFixtureService()
        let model = AIInvestigationModel(service: service)
        await model.load()
        #expect(model.runDisabled)
        model.question = "q"
        #expect(!model.runDisabled)
        model.researchMode = .publicWeb
        #expect(model.runDisabled)
        model.publicWebQuery = " allowed "
        #expect(!model.runDisabled && model.input()["publicWebQuery"] == .string("allowed"))
        model.researchMode = .publicProviders
        #expect(model.runDisabled && model.input()["publicWebQuery"] == .null)
        model.publicSymbols = "aapl"
        #expect(!model.runDisabled && model.input()["publicSymbols"] == .array([.string("AAPL")]))
        model.didDisappear()
    }
    @Test func mountReadsDocumentsOnceAndARepeatedLoadDoesNotRefetchThem() async throws {
        let service = InvestigationFixtureService()
        await service.failDocumentOnce()
        let model = AIInvestigationModel(service: service)
        await model.load()
        await model.load()
        #expect(model.documents.isEmpty && model.error == nil)
        #expect(await service.documentReads == 1)
        model.didDisappear()
        await model.load()
        #expect(await service.documentReads == 2)
        model.didDisappear()
    }
    private func waitForPublishedState(_ model: AIInvestigationModel, _ state: AIInvestigationState) async throws {
        guard model.job?.state != state else { return }
        let publication = AsyncStream<Void>.makeStream()
        defer { publication.continuation.finish() }
        withObservationTracking { _ = model.job } onChange: { publication.continuation.yield(()) }
        var updates = publication.stream.makeAsyncIterator()
        _ = await updates.next()
        try Task.checkCancellation()
        try #require(model.job?.state == state, "Expected the acknowledged poll snapshot to publish")
    }
    @Test func actualAPIAdapterUsesExistingOperationsAndOriginalMultipartBytes() async throws {
        let transport = InvestigationHTTPFixture()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
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
                "/api/ai-research/investigations", "/api/ai-research/investigations/job1",
                "/api/ai-research/investigations/job1/resume", "/api/ai-research/documents",
                "/api/ai-research/documents/doc1", "/api/ai-research/investigations/job1",
            ])
        let body = try #require(requests[3].body)
        #expect(String(decoding: body, as: UTF8.self).contains("name=\"file\"; filename=\"note.md\""))
        #expect(body.range(of: file.data) != nil)
        #expect(requests[3].headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    }
}

private func investigationJobFixture(state: String = "running") -> TaxValue {
    .object([
        "id": .string("job1"), "question": .string("q"), "route": .string("local"), "depth": .string("quick"),
        "language": .string("en"), "state": .string(state), "plan": .null, "result": .null, "error": .null,
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
    var resumes: [TaxValue] = []
    var uploads: [AIResearchDocumentFile] = []
    var deletedDocuments: [ResearchDocumentID] = []
    var getReads = 0
    var documentReads = 0
    private var failingDocument = false
    private var pauseKind: String?
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var pausedGets = 0
    private var getWaiters: [UUID: (count: Int, continuation: CheckedContinuation<Void, Error>)] = [:]
    private var paused = false
    private var failCreate = false
    func pause(_ kind: String) { pauseKind = kind }
    func waitForPause() async { while !paused { await Task.yield() } }
    func waitForPausedGets(_ count: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                if pausedGets >= count {
                    continuation.resume()
                } else {
                    getWaiters[id] = (count, continuation)
                }
            }
        } onCancel: {
            Task { await self.cancelGetWaiter(id) }
        }
    }
    private func cancelGetWaiter(_ id: UUID) {
        getWaiters.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
    }
    func release() {
        pauseKind = nil
        paused = false
        let pending = continuations
        continuations = []
        for continuation in pending { continuation.resume() }
    }
    func failCreates() { failCreate = true }
    func failDocumentOnce() { failingDocument = true }
    private func gate(_ kind: String) async {
        guard pauseKind == kind else { return }
        paused = true
        await withCheckedContinuation {
            continuations.append($0)
            if kind == "get" {
                pausedGets += 1
                let ready = getWaiters.filter { $0.value.count <= pausedGets }
                for (id, waiter) in ready {
                    getWaiters[id] = nil
                    waiter.continuation.resume()
                }
            }
        }
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
    func investigationGet(id: AiInvestigationID) async throws -> AIInvestigation {
        getReads += 1
        await gate("get")
        return try .init(raw: investigationJobFixture(state: "waiting"))
    }
    func investigationDelete(id: AiInvestigationID) {}
    func investigationCancel(id: AiInvestigationID) throws -> AIInvestigation {
        try .init(raw: investigationJobFixture(state: "cancelled"))
    }
    func investigationResume(id: AiInvestigationID, clarification: String, scope: TaxValue) throws -> AIInvestigation {
        resumes.append(.object(["clarification": .string(clarification), "scope": scope]))
        return try .init(raw: investigationJobFixture(state: "completed"))
    }
    func investigationUpload(_ file: AIResearchDocumentFile) throws -> AIResearchDocument {
        uploads.append(file)
        return try .init(raw: investigationDocumentFixture())
    }
    func investigationDeleteDocument(id: ResearchDocumentID) { deletedDocuments.append(id) }
}
private actor InvestigationHTTPFixture: APITransport {
    var requests: [APIRequest] = []
    func send(_ request: APIRequest) throws -> APIResponse {
        requests.append(request)
        if request.method == .delete { return .init(status: 204, body: Data()) }
        let result: TaxValue
        if request.url.path == "/api/ai-research/documents" {
            result = investigationDocumentFixture()
        } else {
            result = investigationJobFixture()
        }
        return .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": result])))
    }
}

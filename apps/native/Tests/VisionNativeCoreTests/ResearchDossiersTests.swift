import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Research Dossiers version authority, drafts and captures")
struct ResearchDossiersTests {
    @Test func rawExportsAndEvidenceMetadataRoundTripWithoutDroppingUnknowns() throws {
        var raw = dossierFixture(id: dossierA)
        var content = try ResearchDossierContent(raw: raw)
        var evidence = ResearchDossierEvidence(id: evidenceA)
        evidence.claim = "Claim"
        evidence.source.title = "Source"
        evidence.source.reference = "Local note"
        var source = evidence.source.payload
        source["documentId"] = .string(documentA)
        source["documentVersion"] = .number(3)
        source["passageOrdinal"] = .number(0)
        source["contentSha256"] = .string(String(repeating: "a", count: 64))
        source["future"] = .number(Decimal(string: "123456789.1234567890123456789")!)
        evidence.source = try .init(raw: source)
        content.evidence = [evidence]
        raw["evidence"] = .array([evidence.payload])
        raw["future"] = .string("preserve")
        let record = try ResearchDossier(raw: raw)
        #expect(try TaxValue(encoding: record) == raw)
        #expect(record.content.evidence[0].source.payload["future"] == source["future"])
        #expect(record.content.payload["id"] == nil && record.content.payload["future"] == nil)
        let envelope = exportFixture([raw])
        let exported = try envelope.decode(ResearchDossierExport.self)
        #expect(try JSONDecoder().decode(TaxValue.self, from: exported.jsonData()) == envelope)
        var missing = source
        missing["sourceDate"] = nil
        #expect(throws: APIError.self) { try ResearchDossierSource(raw: missing) }
        #expect(throws: APIError.self) {
            try TaxValue.object(["version": .number(0), "snapshot": content.payload, "createdAt": .string("now")])
                .decode(ResearchDossierVersion.self)
        }
    }
    @Test func initialReadsUseBoundedSourceQueriesAndRetainAllDocumentStatuses() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        #expect(model.items.count == 2 && model.total == 2 && model.selectedId == nil)
        #expect(model.categories.first?.label == "Expenses / Research")
        #expect(model.documents.count == 2 && model.readyDocuments.count == 1)
        let requests = await transport.requests
        #expect(requests.count == 5)
        #expect(
            requests.first { $0.path == "/api/research-dossiers" }?.query.first { $0.name == "limit" }?.value == "500")
        #expect(requests.first { $0.path == "/api/investments" }?.query == [.init(name: "limit", value: "1000")])
        #expect(!requests.contains { $0.path.contains("versions") })
    }
    @Test func newIsLocalUntilSaveAndRequiredEvidenceNeverPostsBlankCitations() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        model.requestNew()
        #expect(model.draft != nil && !model.hasUnsavedChanges)
        await model.save()
        #expect(model.error == "dossiers.required")
        #expect(await transport.writes.isEmpty)
        model.draft?.title = "New"
        model.draft?.question = "Question"
        model.addEvidence()
        await model.save()
        #expect(await transport.writes.isEmpty)
        model.draft?.evidence[0].claim = "Claim"
        model.draft?.evidence[0].source.title = "Source"
        model.draft?.evidence[0].source.reference = "Reference"
        await model.save()
        #expect(await transport.writes.count == 1)
        #expect(
            model.selectedId == dossierCreated && model.detail?.version == 1 && model.notice?.key == "dossiers.saved")
    }
    @Test func reselectionAndCancelledDiscardPreserveDraftAndConfirmedNewDoesNotWrite() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        model.draft?.title = "Unsaved edit"
        await model.select(dossierA)
        #expect(model.pendingReview == nil && model.draft?.title == "Unsaved edit")
        await model.select(dossierB)
        #expect(model.pendingReview?.action == .discardForSelection(id: dossierB))
        model.cancelPendingReview()
        #expect(model.selectedId == dossierA && model.draft?.title == "Unsaved edit")
        model.requestNew()
        await model.confirmPendingReview()
        #expect(model.selectedId == nil && model.draft?.title == "" && !model.hasUnsavedChanges)
        #expect(await transport.writes.isEmpty)
    }
    @Test func lateOldSelectionDetailAndHistoryCannotReplaceNewEditor() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await transport.pause(path: "/api/research-dossiers/" + dossierA)
        let old = Task { await model.select(dossierA) }
        await transport.waitForPause()
        await model.select(dossierB)
        await transport.release()
        await old.value
        #expect(model.selectedId == dossierB && model.detail?.id == dossierB && model.draft?.title == "Beta")
    }
    @Test func backgroundNewVersionDoesNotRebaseAnUnsavedEditorAndReloadRequiresConfirmation() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        model.draft?.title = "Local edit"
        await transport.externalVersion(id: dossierA, title: "External edit", version: 2)
        await model.load(force: true)
        #expect(model.detail?.version == 1 && model.draft?.title == "Local edit")
        await model.save()
        #expect(model.conflict && model.error != nil && model.draft?.title == "Local edit")
        #expect(await transport.writes.last?["expectedVersion"] == .number(1))
        model.requestReloadLatest()
        model.cancelPendingReview()
        #expect(model.draft?.title == "Local edit")
        model.requestReloadLatest()
        await model.confirmPendingReview()
        #expect(model.detail?.version == 2 && model.draft?.title == "External edit" && !model.conflict)
    }
    @Test func editsDuringSaveRemainDirtyAndUseAcknowledgedNextVersionWithoutDroppingPins() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        model.addEvidence()
        let id = try #require(model.draft?.evidence.first?.id)
        model.draft?.evidence[0].claim = "Submitted claim"
        model.draft?.evidence[0].source.reference = "Local reference"
        model.updateSourceDocument(evidenceId: id, documentId: documentA)
        await transport.pause(path: "/api/research-dossiers/" + dossierA, method: .put)
        let save = Task { await model.save() }
        await transport.waitForPause()
        model.draft?.question = "Typed during save"
        await transport.release()
        await save.value
        #expect(model.detail?.version == 2 && model.draft?.question == "Typed during save" && model.hasUnsavedChanges)
        #expect(model.draft?.evidence[0].source.contentSha256 == String(repeating: "a", count: 64))
        await model.save()
        #expect(await transport.writes.last?["expectedVersion"] == .number(2))
        #expect(model.detail?.version == 3 && !model.hasUnsavedChanges && !model.busy)
    }
    @Test func lateWriteReceiptDoesNotRetargetAChosenDossierOrClearNewDraft() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        model.draft?.title = "Submitted"
        await transport.pause(path: "/api/research-dossiers/" + dossierA, method: .put)
        let save = Task { await model.save() }
        await transport.waitForPause()
        await model.select(dossierB)
        await model.confirmPendingReview()
        model.draft?.title = "Beta unsaved"
        await transport.release()
        await save.value
        #expect(model.selectedId == dossierB && model.draft?.title == "Beta unsaved" && model.detail?.version == 1)
        #expect(model.notice == nil && !model.busy)
    }
    @Test func deleteIsConfirmedAndDoesNotClearAnEditorSelectedDuringTheRequest() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        model.requestDelete()
        model.cancelPendingReview()
        #expect(await transport.deletions.isEmpty)
        await transport.pause(path: "/api/research-dossiers/" + dossierA, method: .delete)
        model.requestDelete()
        let remove = Task { await model.confirmPendingReview() }
        await transport.waitForPause()
        await model.select(dossierB)
        await transport.release()
        await remove.value
        #expect(await transport.deletions == [dossierA])
        #expect(model.selectedId == dossierB && model.draft?.title == "Beta")
    }
    @Test func restoreUsesCapturedVersionCASAndServerReturnedContent() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await transport.externalVersion(id: dossierA, title: "Current", version: 3)
        await model.load()
        await model.select(dossierA)
        model.requestRestore(1)
        #expect(model.pendingReview?.action == .restore(id: dossierA, version: 1, expectedVersion: 3))
        await model.confirmPendingReview()
        #expect(await transport.restores.first == .object(["version": .number(1), "expectedVersion": .number(3)]))
        #expect(
            model.detail?.version == 4 && model.draft?.title == "Restored by server"
                && model.notice?.key == "dossiers.restored")
        model.requestRestore(4)
        #expect(model.pendingReview == nil)
    }
    @Test func oldWriteReceiptCannotDowngradeAnAcceptedNewerServerVersion() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        await transport.pause(path: "/api/research-dossiers/" + dossierA, method: .put)
        let save = Task { await model.save() }
        await transport.waitForPause()
        await transport.externalVersion(id: dossierA, title: "Newer acknowledged source", version: 3)
        await model.load(force: true)
        #expect(model.detail?.version == 3 && model.draft?.title == "Newer acknowledged source")
        await transport.release()
        await save.value
        #expect(
            model.detail?.version == 3 && model.draft?.title == "Newer acknowledged source" && !model.hasUnsavedChanges)
        await model.save()
        #expect(await transport.writes.last?["expectedVersion"] == .number(3))
    }
    @Test func pageChangesDoNotLabelOldRowsAsNewPageOrDiscardTheEditor() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await transport.largeList(true)
        await model.load()
        await model.select(dossierA)
        model.draft?.title = "Retained editor"
        await transport.pause(path: "/api/research-dossiers")
        let next = Task { await model.nextPage() }
        await transport.waitForPause()
        #expect(model.listOffset == 500 && model.items.isEmpty && model.listLoading)
        await transport.release()
        await next.value
        #expect(model.items.map(\.id) == [dossierB] && model.draft?.title == "Retained editor")
        await model.previousPage()
        #expect(model.listOffset == 0 && model.selectedId == dossierA)
    }
    @Test func evidenceDocumentSwitchPreservesCitationAndStripsOnlyAnchorKeys() async throws {
        let model = dossierModel(DossiersTransport())
        await model.load()
        model.requestNew()
        model.addEvidence()
        let id = try #require(model.draft?.evidence.first?.id)
        model.draft?.evidence[0].source.reference = "Preserved reference"
        model.draft?.evidence[0].source.accessedAt = "2026-10-01T12:34:00.000Z"
        model.updateSourceDocument(evidenceId: id, documentId: documentA)
        #expect(
            model.draft?.evidence[0].source.title == "Ready document"
                && model.draft?.evidence[0].source.documentVersion == 3)
        model.draft?.evidence[0].source.passageOrdinal = 8
        model.draft?.evidence[0].source.contentSha256 = "old"
        model.updateSourceDocument(evidenceId: id, documentId: nil)
        #expect(
            model.draft?.evidence[0].source.documentId == nil && model.draft?.evidence[0].source.contentSha256 == nil)
        #expect(
            model.draft?.evidence[0].source.reference == "Preserved reference"
                && model.draft?.evidence[0].source.accessedAt == "2026-10-01T12:34:00.000Z")
        model.draft?.evidence[0].source.title = " "
        model.updateSourceDocument(evidenceId: id, documentId: documentA)
        #expect(model.draft?.evidence[0].source.title == " ")
    }
    @Test func lineFilteringLinkTogglesAndEvidenceLimitAreStructuralOnly() async throws {
        let model = dossierModel(DossiersTransport())
        await model.load()
        model.requestNew()
        model.setLines(.assumptions, raw: " first \n\nsecond\n  ")
        #expect(model.draft?.assumptions == [" first ", "second"])
        model.toggleLink(.categoryIds, id: "7")
        model.toggleLink(.categoryIds, id: "7")
        model.toggleLink(.investmentIds, id: "2")
        model.toggleLink(.savedAnalysisIds, id: "analysis-string")
        #expect(model.draft?.links.categoryIds == [] && model.draft?.links.investmentIds == [2])
        #expect(model.draft?.links.savedAnalysisIds == ["analysis-string"])
        for _ in 0..<31 { model.addEvidence() }
        #expect(model.draft?.evidence.count == 30)
        let id = try #require(model.draft?.evidence.first?.id)
        model.removeEvidence(id)
        #expect(model.draft?.evidence.count == 29)
    }
    @Test func exportWaitsForSavePanelOutcomeAndKeepsServerVersionsAndFilename() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await model.select(dossierA)
        var captured: (Data, String)?
        model.saveExport = { data, name in
            captured = (data, name)
            return false
        }
        await model.exportOne()
        let value = try #require(captured)
        #expect(value.1 == "vision-dossier-" + dossierA + ".json")
        let raw = try JSONDecoder().decode(TaxValue.self, from: value.0)
        #expect(
            raw["schemaVersion"] == .number(1)
                && raw["dossiers"]?.arrayValue?.first?["versions"]?.arrayValue?.count == 1)
        #expect(model.error == nil && model.notice == nil)
        model.saveExport = { _, _ in throw APIError.invalidRequest("Synthetic disk error") }
        await model.exportAll()
        #expect(model.error != nil && model.notice == nil)
    }
    @Test func leavingDuringReadsCannotReopenTheEditorOrStartHiddenReconnectReads() async throws {
        let transport = DossiersTransport()
        let model = dossierModel(transport)
        await model.load()
        await transport.pause(path: "/api/research-dossiers/" + dossierA)
        let old = Task { await model.select(dossierA) }
        await transport.waitForPause()
        model.didDisappear()
        await transport.release()
        await old.value
        #expect(model.selectedId == nil && model.draft == nil && !model.detailLoading)
        let count = await transport.requests.count
        model.isOnline = false
        model.isOnline = true
        for _ in 0..<20 { await Task.yield() }
        #expect(await transport.requests.count == count)
    }
    private func dossierModel(_ transport: DossiersTransport) -> ResearchDossiersModel {
        .init(client: .init(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0))
    }
}

private let dossierA = "00000000-0000-4000-8000-000000000001"
private let dossierB = "00000000-0000-4000-8000-000000000002"
private let dossierCreated = "00000000-0000-4000-8000-000000000003"
private let documentA = "00000000-0000-4000-8000-000000000004"
private let evidenceA = "00000000-0000-4000-8000-000000000005"
private func dossierFixture(id: String, title: String? = nil, version: Int = 1, content: TaxValue? = nil) -> TaxValue {
    var raw = content ?? ResearchDossierContent().payload
    raw["title"] = .string(title ?? (id == dossierA ? "Alpha" : "Beta"))
    raw["question"] = raw["question"] == .string("") ? .string("Question") : raw["question"]
    raw["id"] = .string(id)
    raw["version"] = .number(Decimal(version))
    raw["createdAt"] = .string("2026-10-01T12:00:00.000Z")
    raw["updatedAt"] = .string("2026-10-01T13:00:00.000Z")
    raw["linkDetails"] = .array([])
    return raw
}
private func exportFixture(_ rows: [TaxValue]) -> TaxValue {
    .object([
        "schemaVersion": .number(1), "exportedAt": .string("2026-10-01T13:00:00.000Z"),
        "dossiers": .array(
            rows.map { row in
                var value = row
                value["versions"] = .array([
                    .object([
                        "version": row["version"] ?? .number(1),
                        "snapshot": (try? ResearchDossierContent(raw: row).payload) ?? row,
                        "createdAt": .string("2026-10-01T12:00:00.000Z"),
                    ])
                ])
                return value
            }),
    ])
}
private struct DossierTrace: Sendable {
    let path: String
    let method: HTTPMethod
    let query: [URLQueryItem]
}
private actor DossiersTransport: APITransport {
    private(set) var requests: [DossierTrace] = []
    private(set) var writes: [TaxValue] = []
    private(set) var restores: [TaxValue] = []
    private(set) var deletions: [String] = []
    private var records = [dossierA: dossierFixture(id: dossierA), dossierB: dossierFixture(id: dossierB)]
    private var large = false
    private var pausedPath: String?
    private var pausedMethod = HTTPMethod.get
    private var paused: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func largeList(_ value: Bool) { large = value }
    func externalVersion(id: String, title: String, version: Int) {
        records[id] = dossierFixture(id: id, title: title, version: version)
    }
    func pause(path: String, method: HTTPMethod = .get) {
        pausedPath = path
        pausedMethod = method
    }
    func waitForPause() async { if paused == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        paused?.resume()
        paused = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let path = request.url.path
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        requests.append(.init(path: path, method: request.method, query: query))
        let body = try request.body.map { try JSONDecoder().decode(TaxValue.self, from: $0) }
        let output: TaxValue
        var status = 200
        switch path {
        case "/api/research-dossiers" where request.method == .get:
            let offset = Int(query.first { $0.name == "offset" }?.value ?? "0") ?? 0
            let selected =
                offset == 500
                ? records[dossierB].map { [$0] } ?? []
                : [dossierA, dossierB, dossierCreated].compactMap { records[$0] }
            output = .object([
                "items": .array(selected), "total": .number(Decimal(large ? 501 : records.count)),
                "limit": .number(500), "offset": .number(Decimal(offset)),
            ])
        case "/api/research-dossiers" where request.method == .post:
            writes.append(body ?? .null)
            output = dossierFixture(id: dossierCreated, title: body?["title"]?.stringValue, content: body)
            records[dossierCreated] = output
            status = 201
        case "/api/research-dossiers/export": output = exportFixture([dossierA, dossierB].compactMap { records[$0] })
        case "/api/categories/tree":
            output = .object([
                "items": .array([
                    .object(["id": .number(7), "path": .array([.string("Expenses"), .string("Research")])])
                ])
            ])
        case "/api/investments":
            output = .object(["items": .array([.object(["id": .number(2), "name": .string("Investment")])])])
        case "/api/analysis/saved":
            output = .object([
                "items": .array([.object(["id": .string("analysis-string"), "name": .string("Saved analysis")])])
            ])
        case "/api/ai-research/documents":
            output = .object([
                "items": .array([
                    .object([
                        "id": .string(documentA), "title": .string("Ready document"), "version": .number(3),
                        "extractionStatus": .string("ready"),
                        "sourceName": .string("synthetic.txt"), "mediaType": .string("text/plain"),
                        "contentSha256": .string(String(repeating: "a", count: 64)), "extractionError": .null,
                        "createdAt": .string("2026-10-01T12:00:00.000Z"),
                        "updatedAt": .string("2026-10-01T12:00:00.000Z"),
                    ]),
                    .object([
                        "id": .string("failed-document"), "title": .string("Failed document"), "version": .number(1),
                        "extractionStatus": .string("failed"),
                        "sourceName": .string("failed.txt"), "mediaType": .string("text/plain"),
                        "contentSha256": .string(String(repeating: "b", count: 64)),
                        "extractionError": .string("Synthetic extraction failed"),
                        "createdAt": .string("2026-10-01T12:00:00.000Z"),
                        "updatedAt": .string("2026-10-01T12:00:00.000Z"),
                    ]),
                ])
            ])
        default:
            let parts = path.split(separator: "/")
            let id = parts.count >= 3 ? String(parts[2]) : ""
            guard let current = records[id] else {
                throw APIError.client(.init(status: 404, code: .notFound, message: "Dossier missing"))
            }
            if path.hasSuffix("/export") {
                output = exportFixture([current])
            } else if path.hasSuffix("/versions") {
                output = .object([
                    "items": .array([
                        .object([
                            "version": current["version"] ?? .number(1),
                            "snapshot": try ResearchDossierContent(raw: current).payload,
                            "createdAt": .string("2026-10-01T12:00:00.000Z"),
                        ])
                    ])
                ])
            } else if path.hasSuffix("/restore") {
                restores.append(body ?? .null)
                guard body?["expectedVersion"] == current["version"] else {
                    throw APIError.client(.init(status: 409, code: .conflict, message: "Dossier changed"))
                }
                output = dossierFixture(
                    id: id, title: "Restored by server",
                    version: NSDecimalNumber(decimal: current["version"]?.decimalValue ?? 1).intValue + 1)
                records[id] = output
            } else if request.method == .put {
                writes.append(body ?? .null)
                guard body?["expectedVersion"] == current["version"] else {
                    throw APIError.client(.init(status: 409, code: .conflict, message: "Dossier changed"))
                }
                var content = body ?? .null
                content["expectedVersion"] = nil
                var evidence = content["evidence"]?.arrayValue ?? []
                for index in evidence.indices where evidence[index]["source"]?["documentId"] != nil {
                    evidence[index]["source"]?["documentVersion"] = .number(3)
                    evidence[index]["source"]?["contentSha256"] = .string(String(repeating: "a", count: 64))
                }
                content["evidence"] = .array(evidence)
                output = dossierFixture(
                    id: id, title: content["title"]?.stringValue,
                    version: NSDecimalNumber(decimal: current["version"]?.decimalValue ?? 1).intValue + 1,
                    content: content)
                records[id] = output
            } else if request.method == .delete {
                deletions.append(id)
                records[id] = nil
                output = .null
                status = 204
            } else {
                output = current
            }
        }
        if pausedPath == path, pausedMethod == request.method {
            pausedPath = nil
            await withCheckedContinuation {
                paused = $0
                entered?.resume()
                entered = nil
            }
        }
        return .init(
            status: status,
            body: status == 204 ? Data() : try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": output])))
    }
}

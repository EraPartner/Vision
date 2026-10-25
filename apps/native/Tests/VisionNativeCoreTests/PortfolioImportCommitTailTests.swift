import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Portfolio reviewed commit checkpoint tails")
struct PortfolioImportCommitTailTests {
    @Test func reloadDrainWaitsForReceiptInvalidationAndPhysicalCheckpoint() async throws {
        let transport = CommitTailTransport()
        let store = try CommitTailStore()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        let model = PortfolioImportSessionModel(service: client, store: store)
        await model.load()
        await model.flushCheckpoint()
        await model.preview()
        #expect(model.canCommit)
        let receipt = CommitTailGate()
        model.didMutate = { await receipt.hold() }
        store.holdNextCheckpoint = true
        let commit = Task { await model.commit() }
        await receipt.waitUntilHeld()
        var drained = false
        var secondDrained = false
        let drain = Task {
            await model.flushAcceptedCommits()
            drained = true
        }
        let second = Task {
            await model.flushAcceptedCommits()
            secondDrained = true
        }
        await Task.yield()
        #expect(!drained && !secondDrained)
        #expect(try store.savedStatements().map(\.status) == ["staged"])
        receipt.release()
        await store.checkpoint.waitUntilHeld()
        await commit.value
        #expect(!drained && !secondDrained)
        #expect(model.result?.imported == 1)
        #expect(try store.savedStatements().map(\.status) == ["staged"])
        store.checkpoint.release()
        await drain.value
        await second.value
        #expect(drained && secondDrained)
        #expect(store.values[PortfolioImportSessionModel.sessionKey] == nil)
        #expect(await transport.commitRequests == 1)
    }

    @Test func lostAcknowledgementTailDrainsWithoutRetryingTheCommit() async throws {
        let transport = CommitTailTransport(lostAcknowledgement: true)
        let store = try CommitTailStore()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        let model = PortfolioImportSessionModel(service: client, store: store)
        await model.load()
        await model.flushCheckpoint()
        await model.preview()
        #expect(model.canCommit)
        let receipt = CommitTailGate()
        model.didMutate = { await receipt.hold() }
        store.holdNextCheckpoint = true
        let commit = Task { await model.commit() }
        await receipt.waitUntilHeld()
        var drained = false
        let drain = Task {
            await model.flushAcceptedCommits()
            drained = true
        }
        await Task.yield()
        #expect(!drained)
        receipt.release()
        await store.checkpoint.waitUntilHeld()
        await commit.value
        #expect(!drained)
        #expect(model.outcomeUncertain)
        #expect(!model.canCommit)
        store.checkpoint.release()
        await drain.value
        #expect(try store.savedStatements().map(\.batchId) == [7])
        #expect(await transport.commitRequests == 1)
    }
}

@MainActor private final class CommitTailGate {
    private var held = false
    private var completion: CheckedContinuation<Void, Never>?
    private var observer: CheckedContinuation<Void, Never>?
    func hold() async {
        held = true
        observer?.resume()
        observer = nil
        await withCheckedContinuation { completion = $0 }
    }
    func waitUntilHeld() async { if !held { await withCheckedContinuation { observer = $0 } } }
    func release() {
        completion?.resume()
        completion = nil
    }
}

@MainActor private final class CommitTailStore: PortfolioImportSessionStore {
    var values: [String: Data] = [:]
    var holdNextCheckpoint = false
    let checkpoint = CommitTailGate()
    init() throws {
        values[PortfolioImportSessionModel.sessionKey] = try JSONEncoder().encode(
            TaxValue.array([
                .object([
                    "id": .string("retained"), "name": .string("synthetic.csv"), "kind": .string("existing"),
                    "status": .string("staged"), "accountId": .number(42), "batchId": .number(7),
                ])
            ]))
    }
    func savedStatements() throws -> [PortfolioImportStatement] {
        try JSONDecoder().decode(
            [PortfolioImportStatement].self, from: #require(values[PortfolioImportSessionModel.sessionKey]))
    }
    func read(key: String) async -> Data? { values[key] }
    func write(key: String, data: Data?) async {
        if holdNextCheckpoint, key == PortfolioImportSessionModel.sessionKey {
            holdNextCheckpoint = false
            await checkpoint.hold()
        }
        values[key] = data
    }
}

private actor CommitTailTransport: APITransport {
    private(set) var commitRequests = 0
    private let lostAcknowledgement: Bool
    init(lostAcknowledgement: Bool = false) { self.lostAcknowledgement = lostAcknowledgement }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let value: TaxValue
        switch request.url.path {
        case "/api/accounts": value = .object(["items": .array([]), "total": .number(0)])
        case "/api/portfolio/import/reconciliation/preview":
            value = .object([
                "batchIds": .array([.number(7)]), "adoptPolicy": .null, "batchPolicies": .array([]),
                "planFingerprint": .string("synthetic-reviewed"), "ready": .bool(true), "actions": .array([]),
                "blockers": .array([]), "summary": .object([:]),
            ])
        case "/api/portfolio/import/reconciliation/commit":
            commitRequests += 1
            if lostAcknowledgement { throw APIError.network("Synthetic lost commit acknowledgement") }
            let counts: TaxValue = .object([
                "imported": .number(1), "duplicates": .number(0), "adopted": .number(0),
                "repaired": .number(0), "errors": .number(0),
            ])
            var batch = counts
            batch["batch_id"] = .number(7)
            var result = counts
            result["batches"] = .array([batch])
            value = result
        default: throw APIError.network("Synthetic unavailable recovery read")
        }
        return APIResponse(
            status: 200, body: try JSONEncoder().encode(TaxValue.object(["ok": .bool(true), "data": value])))
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Pending AI read sharing and scoped retirement")
struct NativeSettingsAIReadTests {
    @Test func pendingWaitersShareOneValueButCompletedReadsAreNotCached() async throws {
        let flights = NativeSettingsAIReadFlights()
        let gate = AIReadGate()
        let first = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        await gate.waitForCount(1)
        let second = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        try await waitForSubscribers(flights, count: 2)
        await flights.invalidate(origin: "other", keys: ["status"])
        await gate.release(1)
        #expect(try await first.value == 1)
        #expect(try await second.value == 1)
        #expect(await gate.count() == 1)
        let third = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        await gate.waitForCount(2)
        await gate.release(2)
        #expect(try await third.value == 2)
    }
    @Test func originsNeverSharePendingResponses() async throws {
        let flights = NativeSettingsAIReadFlights()
        let gate = AIReadGate()
        let a = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        await gate.waitForCount(1)
        let b = Task { try await flights.value(origin: "b", key: "status") { await gate.load() } }
        await gate.waitForCount(2)
        await gate.release(1)
        await gate.release(2)
        #expect(try await a.value == 1)
        #expect(try await b.value == 2)
    }
    @Test func retiredOldFlightCannotPublishOrRemoveItsReplacement() async throws {
        let flights = NativeSettingsAIReadFlights()
        let gate = AIReadGate()
        let old = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        await gate.waitForCount(1)
        await flights.invalidate(origin: "a", keys: ["status"])
        let replacement = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        await gate.waitForCount(2)
        await gate.release(1)
        do {
            _ = try await old.value
            Issue.record("Retired response published")
        } catch is CancellationError {} catch { Issue.record("Wrong retirement error") }
        let joined = Task { try await flights.value(origin: "a", key: "status") { await gate.load() } }
        try await waitForSubscribers(flights, count: 2)
        await gate.release(2)
        #expect(try await replacement.value == 2)
        #expect(try await joined.value == 2)
        #expect(await gate.count() == 2)
    }
    @Test func failedFlightIsRemovedForTheNextAttempt() async throws {
        let flights = NativeSettingsAIReadFlights()
        do {
            let _: Int = try await flights.value(origin: "a", key: "status") { throw APIError.network("fixture") }
            Issue.record("Failure not returned")
        } catch {}
        let next: Int = try await flights.value(origin: "a", key: "status") { 42 }
        #expect(next == 42)
    }
    @Test func actualClientScopesPendingStatusToTheBackendOrigin() async throws {
        let origin = AIReadOrigin()
        let transport = AIReadTransport()
        let client = APIClient(baseURL: { await origin.url() }, transport: transport)
        let first = Task { try await client.chatStatus() }
        await transport.waitForCount(1)
        await origin.set("http://second.invalid")
        let second = Task { try await client.settingsAIStatus() }
        await transport.waitForCount(2)
        await transport.release(1)
        await transport.release(2)
        #expect(try await first.value.baseUrl == "http://first.invalid")
        #expect(try await second.value.baseUrl == "http://second.invalid")
        #expect(await transport.hosts() == ["first.invalid", "second.invalid"])
    }
    @Test func providerPutRetainsTheSourceIdempotentTransportRetry() async throws {
        let transport = FakeTransport([
            .failure(.network("synthetic failure")), .response(200, #"{"ok":true,"data":{"items":[],"total":0}}"#),
        ])
        let delays = SleepRecorder()
        let client = APIClient(
            baseURL: { URL(string: "http://fixture.invalid") }, transport: transport,
            sleep: { await delays.record($0) }, jitter: { 0 })
        let result = try await client.settingsAISetProviderKey(provider: "fixture", input: "synthetic")
        #expect(result.total == 0)
        let requests = await transport.requests
        #expect(requests.count == 2)
        #expect(requests.first?.method == .put)
        #expect(requests.first?.url.path == "/api/research/provider-keys/fixture")
        #expect(await delays.delays == [.milliseconds(500)])
    }

}
private actor AIReadGate {
    private var reads = 0
    private var pending: [Int: CheckedContinuation<Int, Never>] = [:]
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func load() async -> Int {
        reads += 1
        let id = reads
        return await withCheckedContinuation { continuation in
            pending[id] = continuation
            let ready = waiters.filter { $0.0 <= reads }
            waiters.removeAll { $0.0 <= reads }
            for waiter in ready { waiter.1.resume() }
        }
    }
    func count() -> Int { reads }
    func waitForCount(_ count: Int) async {
        if reads >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
    func release(_ id: Int) { pending.removeValue(forKey: id)?.resume(returning: id) }
}

private func waitForSubscribers(_ flights: NativeSettingsAIReadFlights, count: Int) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while await flights.pendingWaiterCount(origin: "a", key: "status") < count {
        guard ContinuousClock.now < deadline else { throw APIError.timedOut }
        await Task.yield()
    }
}

private actor AIReadOrigin {
    private var value = "http://first.invalid"
    func url() -> URL? { URL(string: value) }
    func set(_ value: String) { self.value = value }
}
private actor AIReadTransport: APITransport {
    private var requests: [APIRequest] = []
    private var gates: [Int: CheckedContinuation<Void, Never>] = [:]
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func hosts() -> [String] { requests.compactMap { $0.url.host } }
    func waitForCount(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
    func release(_ id: Int) { gates.removeValue(forKey: id)?.resume() }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let id = requests.count
        await withCheckedContinuation { continuation in
            gates[id] = continuation
            let ready = waiters.filter { $0.0 <= id }
            waiters.removeAll { $0.0 <= id }
            for waiter in ready { waiter.1.resume() }
        }
        let raw: TaxValue = .object([
            "ok": .bool(true),
            "data": .object([
                "ok": .bool(true), "enabled": .bool(true), "baseUrl": .string("http://" + (request.url.host ?? "")),
                "defaultModel": .string("local"),
            ]),
        ])
        return .init(status: 200, body: try APIBody.encode(raw))
    }
}

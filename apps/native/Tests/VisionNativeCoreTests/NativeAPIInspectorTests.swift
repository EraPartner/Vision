import Foundation
import Testing

@testable import VisionNativeCore

private struct ScriptedTransport: APITransport {
    let result: @Sendable (APIRequest) throws -> APIResponse
    func send(_ request: APIRequest) async throws -> APIResponse { try result(request) }
}

@MainActor @Suite struct NativeAPIInspectorTests {
    private func event(
        _ id: String, _ phase: APIInspectorEvent.Phase, method: HTTPMethod = .get, endpoint: String = "/api/a",
        duration: Double? = nil, status: Int? = nil, attempt: Int = 0
    ) -> APIInspectorEvent {
        .init(
            requestId: id, method: method, endpoint: endpoint, startedAt: Date(timeIntervalSince1970: 0),
            attempt: attempt, phase: phase, durationMs: phase == .start ? nil : duration, status: status)
    }

    @Test func aCompletedAttemptLeavesInFlightAndTheLogIsNewestFirstAndCapped() {
        let model = NativeAPIInspectorModel()
        model.record(event("r1", .start))
        #expect(model.inFlight.count == 1 && model.log.isEmpty)
        model.record(event("r1", .success, duration: 12, status: 200))
        #expect(model.inFlight.isEmpty && model.log.first?.requestId == "r1")
        for index in 0..<250 { model.record(event("x\(index)", .success, duration: 1, status: 200)) }
        #expect(model.log.count == 200 && model.completed.count == 200)
        #expect(model.log.first?.requestId == "x249")
    }

    @Test func theFilterMatchesEndpointOrMethodCaseInsensitively() {
        let model = NativeAPIInspectorModel()
        model.record(event("a", .success, endpoint: "/api/transactions", duration: 1, status: 200))
        model.record(event("b", .success, method: .post, endpoint: "/api/tags", duration: 1, status: 201))
        model.filter = "TRANS"
        #expect(model.visibleEvents.map(\.requestId) == ["a"])
        model.filter = "post"
        #expect(model.visibleEvents.map(\.requestId) == ["b"])
    }

    @Test func metricsFollowQueryMetricsFormulas() {
        let model = NativeAPIInspectorModel()
        for (index, duration) in [10.0, 20, 30, 40, 1500].enumerated() {
            model.record(event("g\(index)", .success, duration: duration, status: 200))
        }
        model.record(event("e", .error, endpoint: "/api/a", duration: 5, status: 500))
        model.record(event("m", .success, method: .patch, endpoint: "/api/b", duration: 3, status: 200))
        #expect(model.totalRequests == 7)
        #expect(abs(model.errorRate - 1.0 / 7.0) < 1e-9)
        #expect(model.slowRequests.map(\.requestId) == ["g4"])
        let top = model.topEndpoints
        #expect(top.first?.key == "GET /api/a" && top.first?.count == 6 && top.first?.errorCount == 1)
        // Nearest rank on [5, 10, 20, 30, 40, 1500]: floor(6 * 0.5) = 3 → 30; floor(6 * 0.95) = 5 → 1500.
        #expect(top.first?.p50 == 30 && top.first?.p95 == 1500)
        #expect(model.mutationSuccess == 1 && model.mutationError == 0)
        #expect(model.queries["/api/a"]?.errorCount == 1)
        model.reset()
        #expect(model.totalRequests == 0 && model.log.isEmpty && model.queries.isEmpty)
    }

    @Test func theTransportRecordsEachAttemptWithoutHeadersOrBodies() async throws {
        let model = NativeAPIInspectorModel()
        let failure = Data(#"{"ok":false,"error":{"code":"NOT_FOUND","message":"Missing"}}"#.utf8)
        let transport = NativeAPIInspectorTransport(
            base: ScriptedTransport { request in
                APIResponse(status: request.url.path == "/api/missing" ? 404 : 200, body: failure)
            }, inspector: model)
        let headers = ["X-Request-Id": "rid-1", "Authorization": "Bearer secret"]
        _ = try await transport.send(
            APIRequest(
                method: .get, url: URL(string: "http://127.0.0.1:1/api/ok?q=a")!, headers: headers,
                body: Data("secret body".utf8), timeout: 5))
        _ = try await transport.send(
            APIRequest(
                method: .get, url: URL(string: "http://127.0.0.1:1/api/ok?q=a")!, headers: headers, body: nil,
                timeout: 5))
        _ = try await transport.send(
            APIRequest(
                method: .delete, url: URL(string: "http://127.0.0.1:1/api/missing")!,
                headers: ["X-Request-Id": "rid-2"], body: nil, timeout: 5))
        #expect(model.inFlight.isEmpty)
        let missing = try #require(model.log.first)
        #expect(missing.endpoint == "/api/missing" && missing.phase == .error && missing.status == 404)
        #expect(missing.errorCode == "NOT_FOUND" && missing.errorMessage == "Missing")
        let retried = model.log.filter { $0.requestId == "rid-1" }
        #expect(retried.map(\.attempt).sorted() == [0, 1])
        #expect(retried.allSatisfy { $0.endpoint == "/api/ok?q=a" && $0.phase == .success })
        #expect(!String(describing: model.log).contains("secret"))
        #expect(model.mutationError == 1)
    }
}

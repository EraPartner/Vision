import Foundation
import Synchronization
import Testing
import VisionNativeCore

@testable import VisionBackend

/// The routing transport of ADR-270 decision 2.
@Suite struct RoutingTests {
    final class Recorder: APITransport, APIStreamTransport {
        let requests = Mutex<[APIRequest]>([])

        var sent: [APIRequest] { requests.withLock { $0 } }

        func send(_ request: APIRequest) async throws -> APIResponse {
            requests.withLock { $0.append(request) }
            return APIResponse(status: 200, body: Data("bun".utf8))
        }

        func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
            requests.withLock { $0.append(request) }
            return APIResponse(status: 200, body: Data())
        }
    }

    static func request(_ method: HTTPMethod, _ path: String) throws -> APIRequest {
        APIRequest(
            method: method, url: try #require(URL(string: "http://127.0.0.1:3001\(path)")), headers: [:], body: nil,
            timeout: 30)
    }

    @Test func liveHandlersAreExactlyThePortedList() {
        #expect(InProcessBackend.live(database: BackendDatabase()).operationIds == PortedOperations.ids)
        #expect(PortedOperations.ids.isSubset(of: Set(OpenAPIOperations.operationIds)))
    }

    @Test func unportedOperationsGoToBun() async throws {
        let bun = Recorder()
        let database = BackendDatabase()
        await database.resume(databasePath: ":memory:")
        let transport = RoutingAPITransport(backend: .live(database: database), fallback: bun, streamFallback: bun)
        let response = try await transport.send(try Self.request(.get, "/api/accounts"))
        #expect(response.body == Data("bun".utf8))
        #expect(bun.sent.count == 1)
    }

    @Test func portedOperationsGoToBunWithoutADatabaseFile() async throws {
        let bun = Recorder()
        let transport = RoutingAPITransport(
            backend: .live(database: BackendDatabase()), fallback: bun, streamFallback: bun)
        let response = try await transport.send(try Self.request(.get, "/api/tags"))
        #expect(response.body == Data("bun".utf8))
    }

    @Test func aSuspendedDatabaseFailsLikeAStoppedBackend() async throws {
        let bun = Recorder()
        let database = BackendDatabase()
        await database.resume(databasePath: ":memory:")
        await database.suspend()
        let transport = RoutingAPITransport(backend: .live(database: database), fallback: bun, streamFallback: bun)
        await #expect(throws: APIError.self) { try await transport.send(try Self.request(.get, "/api/tags")) }
        #expect(bun.sent.isEmpty)
    }

    @Test func portedOperationsRunInProcessWithTheirPathParameters() async throws {
        let bun = Recorder()
        var backend = InProcessBackend()
        backend.register(OpenAPIOperations.GetTransaction.self) { request in
            let id = request.pathParameters["id"] ?? "?"
            return APIResponse(status: 200, body: Data("swift \(id) \(request.query("x") ?? "-")".utf8))
        }
        let transport = RoutingAPITransport(backend: backend, fallback: bun, streamFallback: bun)
        let template = OpenAPIOperations.GetTransaction.pathTemplate
        let path = template.replacingOccurrences(of: "{id}", with: "42") + "?x=a%20b"
        let response = try await transport.send(try Self.request(.get, path))
        #expect(response.body == Data("swift 42 a b".utf8))
        // Another method on the same path, and a longer path, still go to Bun.
        _ = try await transport.send(try Self.request(.delete, template.replacingOccurrences(of: "{id}", with: "42")))
        _ = try await transport.send(try Self.request(.get, template.replacingOccurrences(of: "{id}", with: "42") + "/x"))
        #expect(bun.sent.count == 2)
    }
}

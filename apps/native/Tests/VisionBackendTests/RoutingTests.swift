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

    /// The multipart and SSE uploads have no generated struct (`native-openapi.ts` writes JSON
    /// bodies only); their hand-written operations in VisionNativeCore carry the id too.
    static let handWrittenUploadIds: Set<String> = [
        AttachmentUploadRequest.operationId,
        NativeOnboardingImportRequest.operationId,
        ImportCsvCustomRequest.operationId,
        ImportCsvStreamRequest.operationId,
        ImportRecipientsRequest.operationId,
        ImportCategoriesRequest.operationId,
    ]

    @Test func liveHandlersAreExactlyThePortedList() {
        #expect(InProcessBackend.live(database: BackendDatabase()).operationIds == PortedOperations.ids)
        #expect(
            PortedOperations.ids.isSubset(of: Set(OpenAPIOperations.operationIds).union(Self.handWrittenUploadIds)))
    }

    /// Finding 16: a literal path wins over a `{id}` capture, and the literal paths Bun still
    /// serves beside a ported ID route go to Bun instead of the ID handler.
    @Test func literalPathsAreNotMistakenForIDs() async throws {
        let backend = InProcessBackend.live(database: BackendDatabase())
        #expect(backend.match(try Self.request(.get, "/api/investments/providers"))?.0.operationId == "listInvestmentProviders")
        #expect(backend.match(try Self.request(.get, "/api/investments/7"))?.0.operationId == "getInvestment")
        #expect(backend.match(try Self.request(.get, "/api/transactions/transfer-suggestions")) == nil)
        #expect(backend.match(try Self.request(.get, "/api/recipients/clusters")) == nil)

        let bun = Recorder()
        let database = BackendDatabase()
        await database.resume(databasePath: ":memory:")
        let transport = RoutingAPITransport(backend: .live(database: database), fallback: bun, streamFallback: bun)
        let response = try await transport.send(try Self.request(.get, "/api/recipients/clusters"))
        #expect(response.body == Data("bun".utf8))
    }

    /// Every literal path in `openapi.yaml` reaches its own operation: in-process when ported,
    /// else Bun. Keeps `InProcessBackend.bunStaticPaths` complete as routes are ported.
    @Test func everyLiteralSpecPathReachesItsOwnOperation() throws {
        let spec = try String(
            contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("openapi.yaml"), encoding: .utf8)
        var path: String?
        var method: HTTPMethod?
        var checked = 0
        let backend = InProcessBackend.live(database: BackendDatabase())
        for line in spec.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("  /"), !line.hasPrefix("   "), line.hasSuffix(":") {
                path = String(line.dropFirst(2).dropLast())
                method = nil
            } else if line.hasPrefix("    "), !line.hasPrefix("     "), line.hasSuffix(":") {
                method = HTTPMethod(rawValue: line.trimmingCharacters(in: .whitespaces).dropLast().uppercased())
            } else if line.hasPrefix("      operationId: "), let currentPath = path, let currentMethod = method,
                !currentPath.contains("{")
            {
                let id = line.dropFirst("      operationId: ".count).trimmingCharacters(in: .whitespaces)
                let matched = backend.match(try Self.request(currentMethod, currentPath))?.0.operationId
                #expect(
                    matched == (PortedOperations.ids.contains(id) ? id : nil),
                    "\(currentMethod.rawValue) \(currentPath) (\(id)) matched \(matched ?? "Bun")")
                checked += 1
            }
        }
        #expect(checked > 100)
    }

    @Test func unportedOperationsGoToBun() async throws {
        let bun = Recorder()
        let database = BackendDatabase()
        await database.resume(databasePath: ":memory:")
        let transport = RoutingAPITransport(backend: .live(database: database), fallback: bun, streamFallback: bun)
        let response = try await transport.send(try Self.request(.get, "/api/accounts/totals"))
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

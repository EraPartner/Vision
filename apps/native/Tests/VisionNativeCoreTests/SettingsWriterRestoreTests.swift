import Foundation
import Testing

@testable import VisionNativeCore

private actor RestoreSettingsTransport: SettingsTransport {
    private(set) var puts: [JSONValue] = []
    private var holdFirst = true
    private var release: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func waitForPut() async {
        if puts.isEmpty { await withCheckedContinuation { entered = $0 } }
    }
    func releasePut() {
        release?.resume()
        release = nil
    }
    func get(_ url: URL) async throws -> HTTPResponse { throw URLError(.cannotConnectToHost) }
    func put(_ url: URL, body: Data) async throws -> HTTPResponse {
        let value = try JSONValue.parse(body)
        puts.append(value)
        if holdFirst {
            holdFirst = false
            await withCheckedContinuation { continuation in
                release = continuation
                entered?.resume()
                entered = nil
            }
        }
        let reply = JSONValue.object([
            "ok": .bool(true),
            "data": .object(["key": .string(url.lastPathComponent), "value": value["value"] ?? .null]),
        ])
        return HTTPResponse(status: 200, body: try reply.serialized())
    }
}

@Suite("Host Settings writers across restore")
struct SettingsWriterRestoreTests {
    private let base = URL(string: "http://synthetic.invalid")!

    @Test func acceptedWriteSettlesBeforeFenceAndFailedRestorePreservesAcknowledgedBaseline() async throws {
        let transport = RestoreSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("k", data: .object(["expected": .object(["exists": .bool(false)])]))
        let first = Task { try await writer.save("k", value: .int(1), baseURL: base) }
        await transport.waitForPut()
        let fence = Task { await writer.suspendAndDrain() }
        while !(await writer.isSuspendedForRestore) { await Task.yield() }
        let second = Task { try await writer.save("k", value: .int(2), baseURL: base) }
        await transport.releasePut()
        _ = try await first.value
        await fence.value
        #expect(await transport.puts.count == 1)
        await writer.resumeAfterFailedRestore()
        _ = try await second.value
        #expect(await transport.puts.count == 2)
        #expect(await transport.puts.last?["expected"] == .object(["exists": .bool(true), "value": .int(1)]))
    }

    @Test func successfulReloadRetiresWaitingAndFutureWritesWithoutReplayingThem() async throws {
        let transport = RestoreSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("k", data: .object(["expected": .object(["exists": .bool(false)])]))
        await writer.suspendAndDrain()
        let waiting = Task { try await writer.save("k", value: .int(1), baseURL: base) }
        await writer.retireForReload()
        await #expect(throws: CancellationError.self) { try await waiting.value }
        await writer.resumeAfterFailedRestore()
        await #expect(throws: CancellationError.self) { try await writer.save("k", value: .int(2), baseURL: base) }
        #expect(await transport.puts.isEmpty)
    }

    @Test func cancelledPausedEditDoesNotLeakOrWriteWhenRestoreIsRefused() async throws {
        let transport = RestoreSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("k", data: .object(["expected": .object(["exists": .bool(false)])]))
        await writer.suspendAndDrain()
        let waiting = Task { try await writer.save("k", value: .int(1), baseURL: base) }
        waiting.cancel()
        await #expect(throws: CancellationError.self) { try await waiting.value }
        await writer.resumeAfterFailedRestore()
        #expect(await transport.puts.isEmpty)
        #expect(await writer.baseline("k") == .object(["exists": .bool(false)]))
    }
}

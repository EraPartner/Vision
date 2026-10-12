import Foundation
import Testing
@testable import VisionNativeCore

final class FakeSettingsTransport: SettingsTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var getResponses: [HTTPResponse]
    private var putResponses: [HTTPResponse]
    private var recordedPuts: [(URL, JSONValue)] = []

    init(get: [HTTPResponse] = [], put: [HTTPResponse] = []) {
        getResponses = get
        putResponses = put
    }

    var puts: [(URL, JSONValue)] { lock.withLock { recordedPuts } }

    func get(_ url: URL) async throws -> HTTPResponse {
        try lock.withLock {
            guard !getResponses.isEmpty else { throw URLError(.cannotConnectToHost) }
            return getResponses.removeFirst()
        }
    }

    func put(_ url: URL, body: Data) async throws -> HTTPResponse {
        try lock.withLock {
            recordedPuts.append((url, try JSONValue.parse(body)))
            guard !putResponses.isEmpty else { throw URLError(.cannotConnectToHost) }
            return putResponses.removeFirst()
        }
    }
}

actor MirrorRecorder {
    var values: [Bool] = []
    func record(_ value: Bool) { values.append(value) }
}

@Suite struct SettingsSyncTests {
    let base = URL(string: "http://localhost:41000")!

    private func json(_ text: String) -> HTTPResponse { HTTPResponse(status: 200, body: Data(text.utf8)) }

    @Test func loadReadsTheDatabaseRecordsTheBaselineAndMirrors() async {
        let transport = FakeSettingsTransport(get: [
            json(#"{"ok":true,"data":{"key":"services_settings","value":{"keepServicesOnQuit":true},"expected":{"exists":true,"value":{"keepServicesOnQuit":true}}}}"#)
        ])
        let writer = SettingsWriter(transport: transport)
        let mirror = MirrorRecorder()
        let keep = await ServicesSettings.load(
            baseURL: base, transport: transport, writer: writer, mirror: { await mirror.record($0) }, fallback: { false })
        #expect(keep)
        #expect(await mirror.values == [true])
        #expect(
            await writer.baseline("services_settings")
                == .object(["exists": .bool(true), "value": .object(["keepServicesOnQuit": .bool(true)])]))
    }

    @Test func loadFallsBackToTheMirrorWhenTheBackendIsDown() async {
        let transport = FakeSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        let keep = await ServicesSettings.load(
            baseURL: base, transport: transport, writer: writer, mirror: { _ in }, fallback: { true })
        #expect(keep)
        #expect(await writer.baseline("services_settings") == nil)
    }

    @Test func saveNeedsALoadedBaseline() async {
        let transport = FakeSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        await #expect(throws: SettingsWriteError("Settings were not loaded. Reopen Vision before saving.")) {
            try await ServicesSettings.save(keepServicesOnQuit: true, baseURL: base, writer: writer, mirror: { _ in })
        }
        #expect(transport.puts.isEmpty)
    }

    @Test func savePutsValueAndBaselineThenAdvancesIt() async throws {
        let transport = FakeSettingsTransport(put: [
            json(#"{"ok":true,"data":{"key":"services_settings","value":{"keepServicesOnQuit":false}}}"#)
        ])
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("services_settings", data: .object(["expected": .object(["exists": .bool(false)])]))
        let mirror = MirrorRecorder()
        try await ServicesSettings.save(
            keepServicesOnQuit: false, baseURL: base, writer: writer, mirror: { await mirror.record($0) })
        let put = try #require(transport.puts.first)
        #expect(put.0.absoluteString == "http://localhost:41000/api/settings/services_settings")
        #expect(
            put.1
                == .object([
                    "value": .object(["keepServicesOnQuit": .bool(false)]), "expected": .object(["exists": .bool(false)]),
                ]))
        #expect(await mirror.values == [false])
        #expect(
            await writer.baseline("services_settings")
                == .object(["exists": .bool(true), "value": .object(["keepServicesOnQuit": .bool(false)])]))
    }

    @Test func aRefusedWriteSurfacesTheBackendMessage() async {
        let transport = FakeSettingsTransport(put: [
            json(#"{"ok":false,"error":{"message":"Setting changed since it was loaded"}}"#)
        ])
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("services_settings", data: .object(["expected": .object(["exists": .bool(false)])]))
        await #expect(throws: SettingsWriteError("Setting changed since it was loaded")) {
            try await ServicesSettings.save(keepServicesOnQuit: true, baseURL: base, writer: writer, mirror: { _ in })
        }
    }

    @Test func onlyTheFirstBaselineIsKept() async {
        let writer = SettingsWriter(transport: FakeSettingsTransport())
        await writer.loaded("k", data: .object(["expected": .object(["exists": .bool(false)])]))
        await writer.loaded("k", data: .object(["expected": .object(["exists": .bool(true), "value": .int(1)])]))
        #expect(await writer.baseline("k") == .object(["exists": .bool(false)]))
        await writer.loaded("other", data: .object(["value": .int(1)]))
        #expect(await writer.baseline("other") == nil)
    }
}

actor BackupMirrorRecorder {
    var values: [BackupSettingsValue] = []
    func record(_ value: BackupSettingsValue) { values.append(value) }
}

@Suite struct BackupSettingsTests {
    let base = URL(string: "http://localhost:41000")!

    private func json(_ text: String) -> HTTPResponse { HTTPResponse(status: 200, body: Data(text.utf8)) }

    @Test func loadReadsTheDatabaseMirrorsTheRawValueAndRecordsTheBaseline() async {
        let transport = FakeSettingsTransport(get: [
            json(#"{"ok":true,"data":{"key":"backup_settings","value":{"backupDir":"  /Volumes/B  ","backupOnQuit":true},"expected":{"exists":true,"value":{"backupDir":"  /Volumes/B  ","backupOnQuit":true}}}}"#)
        ])
        let writer = SettingsWriter(transport: transport)
        let mirror = BackupMirrorRecorder()
        let settings = await BackupSettings.load(
            baseURL: base, transport: transport, writer: writer, mirror: { await mirror.record($0) }, fallback: { [:] })
        #expect(settings == BackupSettingsValue(backupDir: "/Volumes/B", backupOnQuit: true))
        #expect(await mirror.values == [BackupSettingsValue(backupDir: "  /Volumes/B  ", backupOnQuit: true)])
        #expect(await writer.baseline("backup_settings") != nil)
    }

    @Test func loadFallsBackToTheSettingsFileWhenTheBackendIsDown() async {
        let transport = FakeSettingsTransport()
        let writer = SettingsWriter(transport: transport)
        let settings = await BackupSettings.load(
            baseURL: base, transport: transport, writer: writer, mirror: { _ in },
            fallback: { ["backupDir": .string("/Volumes/B"), "backupOnQuit": .bool(true)] })
        #expect(settings == BackupSettingsValue(backupDir: "/Volumes/B", backupOnQuit: true))
        // No stored value and no directory: the toggle is off (no iCloud Drive default yet).
        let empty = await BackupSettings.load(
            baseURL: nil, transport: transport, writer: writer, mirror: { _ in }, fallback: { ["backupOnQuit": .bool(true)] })
        #expect(empty == BackupSettingsValue(backupDir: "", backupOnQuit: false))
    }

    @Test func savePutsTheValueWithItsBaselineThenMirrors() async throws {
        let transport = FakeSettingsTransport(put: [
            json(#"{"ok":true,"data":{"key":"backup_settings","value":{"backupDir":"/Volumes/B","backupOnQuit":false}}}"#)
        ])
        let writer = SettingsWriter(transport: transport)
        await writer.loaded("backup_settings", data: .object(["expected": .object(["exists": .bool(false)])]))
        let mirror = BackupMirrorRecorder()
        let value = BackupSettingsValue(backupDir: "/Volumes/B", backupOnQuit: false)
        try await BackupSettings.save(value, baseURL: base, writer: writer, mirror: { await mirror.record($0) })
        let put = try #require(transport.puts.first)
        #expect(put.0.absoluteString == "http://localhost:41000/api/settings/backup_settings")
        #expect(put.1 == .object(["value": value.jsonValue, "expected": .object(["exists": .bool(false)])]))
        #expect(await mirror.values == [value])
    }

    @Test func saveNeedsTheBackendAndABaseline() async {
        let writer = SettingsWriter(transport: FakeSettingsTransport())
        let value = BackupSettingsValue(backupDir: "", backupOnQuit: false)
        await #expect(throws: SettingsWriteError("The Vision backend is not running.")) {
            try await BackupSettings.save(value, baseURL: nil, writer: writer, mirror: { _ in })
        }
        await #expect(throws: SettingsWriteError("Settings were not loaded. Reopen Vision before saving.")) {
            try await BackupSettings.save(value, baseURL: self.base, writer: writer, mirror: { _ in })
        }
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeRawStateStoreTests {
    private enum InjectedFailure: Error { case save }

    private func withFile(_ body: (URL) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vision-raw-state-test-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await body(directory.appendingPathComponent("state.json"))
    }

    private func localValues(at url: URL) throws -> [String: String] {
        let envelope = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        return try #require(envelope?["localValues"] as? [String: String])
    }

    @Test func anAbsentFileIsAnEmptyStoreAndCreatesNothing() async throws {
        try await withFile { url in
            let store = try NativeRawStateStore(persistenceURL: url)
            #expect(await store.localKeyCount == 0)
            #expect(await store.value(for: .theme) == nil)
            #expect(await store.backupSnapshot().keys.isEmpty)
            #expect(!FileManager.default.fileExists(atPath: url.path))
        }
    }

    @Test func valuesRoundTripThroughTheFile() async throws {
        try await withFile { url in
            let store = try NativeRawStateStore(persistenceURL: url)
            try await store.setValue("dark", for: .theme)
            try await store.setValue("", for: .paletteRecents)
            try await store.setValue("null", for: .lastRoute)
            #expect(try localValues(at: url) == ["vision_theme": "dark", "vision.palette.recents": "", "vision.lastRoute": "null"])
            let reopened = try NativeRawStateStore(persistenceURL: url)
            #expect(await reopened.value(for: .theme) == "dark")
            #expect(await reopened.value(for: .paletteRecents) == "")
            #expect(await reopened.value(for: .lastRoute) == "null")
            #expect(await reopened.value(for: .language) == nil)
            try await reopened.setValue(nil, for: .theme)
            #expect(await reopened.value(for: .theme) == nil)
            #expect(await reopened.localKeyCount == 2)
        }
    }

    @Test func unknownHistoricalKeysSurviveWritesAndRestores() async throws {
        try await withFile { url in
            let seed = #"{"version":1,"localValues":{"legacy.unknown":"kept","vision_theme":"light"}}"#
            try Data(seed.utf8).write(to: url)
            let store = try NativeRawStateStore(persistenceURL: url)
            try await store.setValue("nl", for: .language)
            try await store.applyRestoredLocalValues(["other.unknown": "also", "vision_theme": "dark"])
            let values = try localValues(at: url)
            #expect(values["legacy.unknown"] == "kept")
            #expect(values["other.unknown"] == "also")
            #expect(values["vision_theme"] == "dark")
            #expect(values["vision.language"] == "nl")
        }
    }

    @Test func aCorruptOrFutureFileThrowsAndIsNeverOverwritten() async throws {
        try await withFile { url in
            let garbage = Data("{not json".utf8)
            try garbage.write(to: url)
            #expect(throws: (any Error).self) { try NativeRawStateStore(persistenceURL: url) }
            #expect(try Data(contentsOf: url) == garbage)

            let future = Data(#"{"version":2,"localValues":{"vision_theme":"dark"}}"#.utf8)
            try future.write(to: url)
            #expect(throws: NativeRawStateStore.StoreError.unsupportedVersion) {
                try NativeRawStateStore(persistenceURL: url)
            }
            #expect(try Data(contentsOf: url) == future)
        }
    }

    @Test func extraFieldsFromEarlierFilesAreIgnoredAndDroppedOnTheNextWrite() async throws {
        try await withFile { url in
            let old =
                #"{"version":1,"source":{"webOrigin":"http://127.0.0.1:43123"},"migrationCaptureID":"x","startedEmpty":true,"localValues":{"vision_theme":"dark"}}"#
            try Data(old.utf8).write(to: url)
            let store = try NativeRawStateStore(persistenceURL: url)
            #expect(await store.value(for: .theme) == "dark")
            try await store.setValue("nl", for: .language)
            let envelope = try #require(
                try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            #expect(Set(envelope.keys) == ["version", "localValues"])
            #expect(envelope["version"] as? Int == 1)
        }
    }

    @Test func aFailedSaveKeepsMemoryAndTheFileUnchanged() async throws {
        try await withFile { url in
            let seed = Data(#"{"version":1,"localValues":{"vision_theme":"dark"}}"#.utf8)
            try Data(seed).write(to: url)
            let failing = NativeRawStateStore.Persistence(
                load: { try Data(contentsOf: $0) }, save: { _, _ in throw InjectedFailure.save })
            let store = try NativeRawStateStore(persistenceURL: url, persistence: failing)
            await #expect(throws: InjectedFailure.self) { try await store.setValue("light", for: .theme) }
            await #expect(throws: InjectedFailure.self) { try await store.applyRestoredLocalValues(["vision.language": "nl"]) }
            #expect(await store.value(for: .theme) == "dark")
            #expect(await store.value(for: .language) == nil)
            #expect(try Data(contentsOf: url) == seed)
        }
    }

    @Test func sessionValuesStayInMemory() async throws {
        try await withFile { url in
            let store = try NativeRawStateStore(persistenceURL: url)
            await store.setSessionValue("secret", for: .adminToken)
            await store.setSessionValue("{}", for: .portfolioSession)
            #expect(await store.sessionValue(for: .adminToken) == "secret")
            #expect(!FileManager.default.fileExists(atPath: url.path))
            try await store.setValue("dark", for: .theme)
            let text = try String(contentsOf: url, encoding: .utf8)
            #expect(!text.contains("secret"))
            #expect(await store.backupSnapshot().keys.keys.contains("vision.adminToken") == false)
            await store.setSessionValue(nil, for: .adminToken)
            #expect(await store.sessionValue(for: .adminToken) == nil)
            let reopened = try NativeRawStateStore(persistenceURL: url)
            #expect(await reopened.sessionValue(for: .portfolioSession) == nil)
        }
    }

    @Test func theBackupCarriesTheRegistryKeysOnly() async throws {
        try await withFile { url in
            #expect(NativeRawStateStore.backupKeys.count == 15)
            let store = try NativeRawStateStore(persistenceURL: url)
            try await store.setValue("dark", for: .theme)
            try await store.setValue("5", for: .fxDismissedAt)
            try await store.applyRestoredLocalValues(["legacy.unknown": "kept"])
            let snapshot = await store.backupSnapshot()
            #expect(snapshot.keys == ["vision_theme": "dark"])
            for key in NativeRawStateStore.LocalKey.allCases {
                try await store.setValue("x", for: key)
            }
            #expect(Set(await store.backupSnapshot().keys.keys) == Set(NativeRawStateStore.backupKeys))
        }
    }

    @Test func aRestoreOverlaysAndLeavesOmittedKeysAlone() async throws {
        try await withFile { url in
            let store = try NativeRawStateStore(persistenceURL: url)
            try await store.setValue("dark", for: .theme)
            try await store.setValue("en", for: .language)
            try await store.applyRestoredLocalValues(["vision.language": "nl", "vision.sidebar.collapsed": "true"])
            #expect(await store.value(for: .theme) == "dark")
            #expect(await store.value(for: .language) == "nl")
            #expect(await store.value(for: .sidebarCollapsed) == "true")
        }
    }

    @Test func aNonFileURLIsRejected() throws {
        #expect(throws: NativeRawStateStore.StoreError.invalidPersistenceURL) {
            try NativeRawStateStore(persistenceURL: URL(string: "https://example.com/raw-state.json")!)
        }
    }
}

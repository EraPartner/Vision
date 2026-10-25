import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeRawStateStoreTests {
    private enum InjectedFailure: Error { case save }

    private func source(port: Int = 43123, store: String = "synthetic-wk-default") throws -> NativeRawStateStore.Source {
        try .init(webOrigin: URL(string: "http://127.0.0.1:\(port)")!, storeIdentifier: store)
    }

    private func capture(
        _ values: [String: String], source: NativeRawStateStore.Source,
        status: NativeRawStateStore.CaptureStatus = .complete,
        sessions: [NativeRawStateStore.SessionKey: String] = [:]
    ) -> NativeRawStateStore.MigrationCapture {
        .init(source: source, identifier: UUID(), status: status, localValues: values, sessionValues: sessions)
    }

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

    @Test func absentFileRequiresCompleteMigrationAndDoesNotCreateDefaults() async throws {
        try await withFile { url in
            let source = try source()
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            #expect(await store.isMigrated == false)
            await #expect(throws: NativeRawStateStore.StoreError.migrationRequired) { try await store.value(for: .theme) }
            await #expect(throws: NativeRawStateStore.StoreError.migrationRequired) { try await store.setValue("dark", for: .theme) }
            await #expect(throws: NativeRawStateStore.StoreError.migrationRequired) { try await store.backupSnapshot() }
            for status in [NativeRawStateStore.CaptureStatus.partial, .unavailable] {
                await #expect(throws: NativeRawStateStore.StoreError.incompleteCapture) {
                    try await store.migrate(capture([:], source: source, status: status))
                }
            }
            #expect(await store.isMigrated == false)
            #expect(!FileManager.default.fileExists(atPath: url.path))
            try await store.migrate(capture([:], source: source))
            #expect(await store.isMigrated)
            #expect(try await store.value(for: .theme) == nil)
            await #expect(throws: NativeRawStateStore.StoreError.alreadyMigrated) {
                try await store.migrate(capture(["vision_theme": "replacement"], source: source))
            }
        }
    }

    @Test func anEmptyCompleteCaptureIsRecordedAsAnEmptyStart() async throws {
        try await withFile { url in
            let source = try source()
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            try await store.migrate(capture([:], source: source))
            #expect(await store.startedEmpty)
            let reopened = try NativeRawStateStore(persistenceURL: url, source: source)
            #expect(await reopened.startedEmpty)
        }
        try await withFile { url in
            let source = try source()
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            try await store.migrate(capture(["vision_theme": "dark"], source: source))
            #expect(await store.startedEmpty == false)
        }
    }

    @Test func aMigratedStoreReportsTheSourceItWasCapturedFrom() async throws {
        try await withFile { url in
            #expect(try NativeRawStateStore.recordedSource(at: url) == nil)
            let original = try source(port: 43123)
            let store = try NativeRawStateStore(persistenceURL: url, source: original)
            try await store.migrate(capture(["vision_theme": "dark"], source: original))
            let recorded = try #require(try NativeRawStateStore.recordedSource(at: url))
            #expect(recorded == original)
            // After a port change the host opens the store under its recorded source.
            #expect(throws: NativeRawStateStore.StoreError.sourceMismatch) {
                _ = try NativeRawStateStore(persistenceURL: url, source: try source(port: 50000))
            }
            let reopened = try NativeRawStateStore(persistenceURL: url, source: recorded)
            #expect(try await reopened.value(for: .theme) == "dark")
        }
    }

    @Test func rawStringsUnknownKeysAndCaptureProvenanceSurviveReload() async throws {
        try await withFile { url in
            let source = try source()
            let values = [
                "vision_theme": "", "vision_theme_variant": "null", "vision.onboarding.draft.v1": "{malformed",
                "historical.future-key": "\"quoted\" \\ \n \u{2028}; value = true;",
            ]
            let captured = capture(values, source: source)
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            try await store.migrate(captured)
            #expect(try await store.value(for: .theme) == "")
            #expect(try await store.value(for: .themeVariant) == "null")
            #expect(try await store.value(for: .language) == nil)
            try await store.setValue("nl", for: .language)
            try await store.setValue(nil, for: .theme)
            let reloaded = try NativeRawStateStore(persistenceURL: url, source: source)
            #expect(try await reloaded.value(for: .theme) == nil)
            #expect(try await reloaded.value(for: .themeVariant) == "null")
            #expect(try await reloaded.value(for: .onboardingDraft) == "{malformed")
            #expect(try await reloaded.value(for: .language) == "nl")
            #expect(try localValues(at: url)["historical.future-key"] == values["historical.future-key"])
            let envelope = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
            #expect((envelope?["migrationCaptureID"] as? String)?.lowercased() == captured.identifier.uuidString.lowercased())
        }
    }

    @Test func wrongOriginPortOrWebsiteStoreCannotImportOrOpenState() async throws {
        try await withFile { url in
            let original = try source()
            let store = try NativeRawStateStore(persistenceURL: url, source: original)
            for foreign in [try source(port: 43124), try source(store: "synthetic-other-store")] {
                await #expect(throws: NativeRawStateStore.StoreError.sourceMismatch) {
                    try await store.migrate(capture(["vision_theme": "foreign"], source: foreign))
                }
            }
            #expect(!FileManager.default.fileExists(atPath: url.path))
            try await store.migrate(capture(["vision_theme": "original"], source: original))
            let before = try Data(contentsOf: url)
            for foreign in [try source(port: 43124), try source(store: "synthetic-other-store")] {
                #expect(throws: NativeRawStateStore.StoreError.sourceMismatch) {
                    _ = try NativeRawStateStore(persistenceURL: url, source: foreign)
                }
            }
            #expect(try Data(contentsOf: url) == before)
        }
    }

    @Test func corruptAndFutureFilesAreNeverReplacedByEmptyState() async throws {
        try await withFile { url in
            let source = try source()
            let corrupt = Data("{broken".utf8)
            try corrupt.write(to: url)
            #expect(throws: (any Error).self) { _ = try NativeRawStateStore(persistenceURL: url, source: source) }
            #expect(try Data(contentsOf: url) == corrupt)
            let future = Data("{\"version\":2,\"source\":{\"webOrigin\":\"\(source.webOrigin)\",\"storeIdentifier\":\"\(source.storeIdentifier)\"},\"migrationCaptureID\":\"\(UUID())\",\"localValues\":{}}".utf8)
            try future.write(to: url)
            #expect(throws: NativeRawStateStore.StoreError.unsupportedVersion) {
                _ = try NativeRawStateStore(persistenceURL: url, source: source)
            }
            #expect(try Data(contentsOf: url) == future)
        }
    }

    @Test func failedMigrationCommitAndRestoreKeepPriorAuthorityAndBytes() async throws {
        try await withFile { url in
            let source = try source()
            let persistence = NativeRawStateStore.Persistence(
                load: NativeRawStateStore.Persistence.atomicFile.load,
                save: { bytes, destination in
                    let envelope = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
                    if (envelope?["localValues"] as? [String: String])?["vision_theme"] == "reject-save" {
                        throw InjectedFailure.save
                    }
                    try NativeRawStateStore.Persistence.atomicFile.save(bytes, destination)
                }
            )
            let store = try NativeRawStateStore(persistenceURL: url, source: source, persistence: persistence)
            await #expect(throws: InjectedFailure.self) {
                try await store.migrate(capture(["vision_theme": "reject-save"], source: source, sessions: [.adminToken: "not-admitted"]))
            }
            #expect(await store.isMigrated == false)
            #expect(!FileManager.default.fileExists(atPath: url.path))
            try await store.migrate(capture(["vision_theme": "dark"], source: source))
            #expect(try await store.sessionValue(for: .adminToken) == nil)
            let before = try Data(contentsOf: url)
            await #expect(throws: InjectedFailure.self) { try await store.setValue("reject-save", for: .theme) }
            await #expect(throws: InjectedFailure.self) {
                try await store.applyRestoredLocalValues(["vision_theme": "reject-save", "historical": "partial"])
            }
            #expect(try await store.value(for: .theme) == "dark")
            #expect(try Data(contentsOf: url) == before)
        }
    }

    @Test func sessionsStayInMemoryAcrossLocalEditsAndRestoreButNotStoreReopen() async throws {
        try await withFile { url in
            let source = try source()
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            try await store.migrate(capture([:], source: source, sessions: [.portfolioSession: "staged-synthetic"]))
            #expect(try await store.sessionValue(for: .portfolioSession) == "staged-synthetic")
            try await store.setSessionValue("synthetic-secret-token", for: .adminToken)
            try await store.setSessionValue("", for: .portfolioReview)
            try await store.setValue("en", for: .language)
            try await store.applyRestoredLocalValues(["vision_theme": "dark"])
            #expect(try await store.sessionValue(for: .adminToken) == "synthetic-secret-token")
            #expect(try await store.sessionValue(for: .portfolioReview) == "")
            let persisted = String(decoding: try Data(contentsOf: url), as: UTF8.self)
            #expect(!persisted.contains("synthetic-secret-token"))
            #expect(!persisted.contains("staged-synthetic"))
            #expect(!persisted.contains("vision.adminToken"))
            let reopened = try NativeRawStateStore(persistenceURL: url, source: source)
            #expect(try await reopened.sessionValue(for: .adminToken) == nil)
            #expect(try await reopened.sessionValue(for: .portfolioSession) == nil)
            try await store.setSessionValue(nil, for: .portfolioReview)
            #expect(try await store.sessionValue(for: .portfolioReview) == nil)
        }
    }

    @Test func backupUsesOriginalRegistryAndRestoreOverlaysAlreadyNormalizedStrings() async throws {
        try await withFile { url in
            let source = try source()
            var values = Dictionary(uniqueKeysWithValues: NativeSettingsStorageBridge.knownKeys.map { ($0, "raw:\($0)") })
            values["fx-status-banner-dismissed-at"] = "123"
            values["dismissed_deduction_candidates_v1"] = "[]"
            values["historical"] = "keep me"
            let store = try NativeRawStateStore(persistenceURL: url, source: source)
            try await store.migrate(capture(values, source: source))
            try await store.setSessionValue("synthetic-token", for: .adminToken)
            let backup = try await store.backupSnapshot()
            #expect(Set(backup.keys.keys) == Set(NativeSettingsStorageBridge.knownKeys))
            #expect(backup.keys["vision.palette.recents"] != nil)
            #expect(backup.keys["vision.lastRoute"] != nil)
            #expect(backup.keys["vision.language"] != nil)
            #expect(backup.keys["vision.startupSection"] != nil)
            try await store.applyRestoredLocalValues([
                "vision_theme": "", "vision_theme_variant": "null", "historical-restored": "[object Object]",
                "source-array-coercion": "one,,two",
            ])
            let restored = try localValues(at: url)
            #expect(restored["historical"] == "keep me")
            #expect(restored["historical-restored"] == "[object Object]")
            #expect(restored["source-array-coercion"] == "one,,two")
            #expect(restored["fx-status-banner-dismissed-at"] == "123")
            #expect(try await store.value(for: .theme) == "")
            #expect(try await store.value(for: .themeVariant) == "null")
            let encoded = try JSONEncoder().encode(try await store.backupSnapshot())
            #expect(try NativeSettingsStorageBridge.readReply(.string(String(decoding: encoded, as: UTF8.self))) != nil)
        }
    }

    @Test func persistenceRejectsNonFileURLsBeforeCallingInjectedLoader() throws {
        let persistence = NativeRawStateStore.Persistence(
            load: { _ in throw InjectedFailure.save }, save: { _, _ in throw InjectedFailure.save }
        )
        let source = try source()
        #expect(throws: NativeRawStateStore.StoreError.invalidPersistenceURL) {
            _ = try NativeRawStateStore(persistenceURL: URL(string: "https://example.invalid/state")!, source: source, persistence: persistence)
        }
    }

    @Test func sourceRejectsPathsCredentialsAndUnidentifiedStores() throws {
        for text in ["file:///synthetic", "http://localhost:43123/path", "http://user:password@localhost:43123", "http://localhost:43123?query=1"] {
            #expect(throws: NativeRawStateStore.StoreError.invalidSource) {
                _ = try NativeRawStateStore.Source(webOrigin: URL(string: text)!, storeIdentifier: "synthetic")
            }
        }
        #expect(throws: NativeRawStateStore.StoreError.invalidSource) {
            _ = try NativeRawStateStore.Source(webOrigin: URL(string: "http://localhost:43123")!, storeIdentifier: "")
        }
        #expect(
            try NativeRawStateStore.Source(webOrigin: URL(string: "HTTP://LOCALHOST/")!, storeIdentifier: "synthetic")
                == NativeRawStateStore.Source(webOrigin: URL(string: "http://localhost:80")!, storeIdentifier: "synthetic")
        )
    }
}

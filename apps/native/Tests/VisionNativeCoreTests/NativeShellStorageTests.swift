import Foundation
import Testing

@testable import VisionNativeCore

/// The native-only shell's storage keeps each page-storage script's semantics (ADR-208).
@Suite struct NativeShellStorageTests {
    private func withStorage(
        _ values: [String: String] = [:], _ body: (NativeShellStorage, URL) async throws -> Void
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vision-shell-storage-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("raw-state.json")
        let source = try NativeRawStateStore.Source(webOrigin: URL(string: "http://127.0.0.1:43123")!, storeIdentifier: "default")
        let store = try NativeRawStateStore(persistenceURL: url, source: source)
        try await store.migrate(
            .init(source: source, identifier: UUID(), status: .complete, localValues: values, sessionValues: [:]))
        try await body(NativeShellStorage(store: store), url)
    }

    @Test func typedLocalKeysMapOneToOneAndKeepAbsentEmptyAndNullDistinct() async throws {
        try await withStorage(["vision.backup.passphrase.reminder.dismissed": "1"]) { storage, _ in
            #expect(try await storage.value(for: .reminder) == "1")
            #expect(try await storage.value(for: .paletteRecents) == nil)
            try await storage.setValue("", for: .paletteRecents)
            #expect(try await storage.value(for: .paletteRecents) == "")
            try await storage.setValue("null", for: .lastRoute)
            #expect(try await storage.value(for: .lastRoute) == "null")
            try await storage.setValue(nil, for: .reminder)
            #expect(try await storage.value(for: .reminder) == nil)
        }
        for key in NativeSettingsStorageBridge.LocalKey.allCases {
            #expect(NativeShellStorage.rawKey(key).rawValue == key.rawValue)
        }
    }

    @Test func exportMatchesTheBackupRegistryAndRestoreUsesJavaScriptStrings() async throws {
        try await withStorage(["vision_theme": "dark", "fx-status-banner-dismissed-at": "5", "legacy.unknown": "kept"]) {
            storage, _ in
            let reply = try await storage.exportReply()
            #expect(try NativeSettingsStorageBridge.readReply(reply) != nil)
            let snapshot = try JSONValue.parse(Data(try #require(reply.stringValue).utf8))
            #expect(snapshot == .object(["keys": .object(["vision_theme": .string("dark")])]))
            let restored = await storage.restore(
                .object([
                    "keys": .object([
                        "vision.sidebar.collapsed": .bool(true), "vision.palette.recents": .array([.string("/a"), .null]),
                        "vision.language": .int(7), "vision.lastRoute": .null, "vision.startupSection": .object([:]),
                    ])
                ]))
            #expect(restored)
            #expect(try await storage.store.value(for: .sidebarCollapsed) == "true")
            #expect(try await storage.store.value(for: .paletteRecents) == "/a,")
            #expect(try await storage.store.value(for: .language) == "7")
            #expect(try await storage.store.value(for: .lastRoute) == "null")
            #expect(try await storage.store.value(for: .startupSection) == "[object Object]")
            #expect(try await storage.store.value(for: .theme) == "dark")
            #expect(await storage.restore(.object([:])))
            #expect(await storage.restore(.null))
        }
    }

    @Test func adminTokensTrimAndBlankRemoves() async throws {
        try await withStorage { storage, _ in
            #expect(await storage.adminToken() == nil)
            #expect(await storage.setAdminToken("  secret \n"))
            #expect(await storage.adminToken() == "secret")
            #expect(await storage.setAdminToken("   "))
            #expect(await storage.adminToken() == nil)
        }
    }

    @Test func webStorageParsesValuesAndOnlySessionNullRemoves() async throws {
        try await withStorage(["vision.analysis.sqlHistory": ""]) { storage, _ in
            #expect(await storage.webStorage(key: "vision.analysis.sqlHistory", value: nil, session: false) == .null)
            #expect(await storage.webStorage(key: "not-allowed", value: nil, session: false) == nil)
            let ids: JSONValue = .array([.int(1), .int(2)])
            #expect(await storage.webStorage(key: "dismissed_upcoming_planned_payments", value: ids, session: false) == ids)
            #expect(
                await storage.webStorage(key: "dismissed_upcoming_planned_payments", value: .null, session: false) == .null)
            #expect(try await storage.store.value(for: .upcomingDismissals) != nil)
            let review: JSONValue = .object(["mode": .string("strict")])
            let sessionKey = "vision.portfolio-import.latest-review-settings.v1"
            #expect(await storage.webStorage(key: sessionKey, value: review, session: true) == review)
            #expect(await storage.webStorage(key: sessionKey, value: .null, session: true) == .null)
            #expect(try await storage.store.sessionValue(for: .portfolioReview) == nil)
        }
    }

    @Test func chartLayoutsWriteThenReadAndLegacyThemeIsReported() async throws {
        try await withStorage(["vision_theme": "light"]) { storage, _ in
            #expect(try await storage.chartLayouts(writing: nil) == nil)
            #expect(try await storage.chartLayouts(writing: "{\"v\":2}") == "{\"v\":2}")
            let legacy = try JSONValue.parse(Data(try #require(await storage.legacyThemeReply().stringValue).utf8))
            #expect(legacy == .object(["mode": .string("light"), "variant": .null]))
        }
    }

    @Test func theFixedScriptsAreAnsweredInThePagesReplyShape() async throws {
        try await withStorage(["vision_theme": "dark"]) { storage, _ in
            let bridge = NativeSettingsStorageBridge.self
            let write = try await storage.answer(
                script: bridge.writeScript, arguments: bridge.arguments(for: .paletteRecents, value: "[\"/a\"]"))
            #expect(try bridge.mutationReply(write))
            let read = try await storage.answer(script: bridge.readScript, arguments: bridge.arguments(for: .paletteRecents))
            #expect(try bridge.readLocalReply(read) == "[\"/a\"]")
            #expect(
                try bridge.mutationReply(
                    try await storage.answer(script: bridge.removeScript, arguments: bridge.arguments(for: .paletteRecents))))
            #expect(
                try await storage.answer(script: bridge.readScript, arguments: bridge.arguments(for: .paletteRecents))
                    == .null)
            #expect(try bridge.readReply(try await storage.answer(script: bridge.exportScript, arguments: [:])) != nil)
            let restore = try await storage.answer(
                script: bridge.restoreScript,
                arguments: try bridge.restoreArguments(.object(["keys": .object(["vision.language": .string("nl")])])))
            #expect(try bridge.mutationReply(restore))
            #expect(try await storage.store.value(for: .language) == "nl")
            #expect(try await storage.answer(script: bridge.editingScript, arguments: [:]) == .bool(false))
            #expect(try await storage.answer(script: bridge.legacyThemeScript, arguments: [:]).stringValue != nil)
            let event = "window.dispatchEvent(new CustomEvent('vision:native-settings', {detail}));"
            #expect(try await storage.answer(script: event, arguments: [:]) == .bool(true))
            await #expect(throws: NativeShellStorage.ScriptError.unsupportedScript) {
                try await storage.answer(script: "return document.title;", arguments: [:])
            }
            await #expect(throws: NativeShellStorage.ScriptError.unsupportedScript) {
                try await storage.answer(script: bridge.readScript, arguments: ["key": .string("vision_theme")])
            }
        }
    }

    @Test(arguments: [
        (1.0, "1"), (1.5, "1.5"), (-2.25, "-2.25"), (0.00001, "0.00001"), (0.0000001, "1e-7"), (1.5e-7, "1.5e-7"),
        (1e16, "10000000000000000"), (1e21, "1e+21"), (1.2345e22, "1.2345e+22"), (0.0, "0"),
    ])
    func numbersPrintAsJavaScriptDoes(_ value: Double, _ expected: String) {
        #expect(NativeShellStorage.jsNumber(value) == expected)
    }

    @Test func theLayoutKeepsTheStoreBesideTheRuntime() throws {
        let layout = try RuntimeLayout(
            userDataDirectory: "/Users/demo/Library/Application Support/Vision Native Demo", runtimeId: "vision_native_demo")
        #expect(layout.rawState == layout.nativeRoot + "/raw-state.json")
    }
}

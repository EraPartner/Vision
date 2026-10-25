import Foundation
import Testing

@testable import VisionNativeCore

/// The native shell's storage keeps the page-storage semantics the web app had (ADR-211).
@Suite struct NativeShellStorageTests {
    private func withStorage(
        _ seed: [String: String] = [:], _ body: (NativeShellStorage, URL) async throws -> Void
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vision-shell-storage-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("raw-state.json")
        if !seed.isEmpty {
            let document: [String: Any] = ["version": 1, "localValues": seed]
            try JSONSerialization.data(withJSONObject: document).write(to: url)
        }
        let store = try NativeRawStateStore(persistenceURL: url)
        try await body(NativeShellStorage(store: store), url)
    }

    @Test func typedLocalKeysKeepAbsentEmptyAndNullDistinct() async throws {
        try await withStorage(["vision.backup.passphrase.reminder.dismissed": "1"]) { storage, _ in
            #expect(await storage.value(for: .backupReminder) == "1")
            #expect(await storage.value(for: .paletteRecents) == nil)
            try await storage.setValue("", for: .paletteRecents)
            #expect(await storage.value(for: .paletteRecents) == "")
            try await storage.setValue("null", for: .lastRoute)
            #expect(await storage.value(for: .lastRoute) == "null")
            try await storage.setValue(nil, for: .backupReminder)
            #expect(await storage.value(for: .backupReminder) == nil)
        }
        let raw = NativeRawStateStore.LocalKey.allCases.map(\.rawValue)
        #expect(Set(raw).count == raw.count)
        #expect(Set(NativeRawStateStore.backupKeys).isSubset(of: Set(raw)))
    }

    @Test func theBackupStateMatchesTheRegistryAndRestoreUsesJavaScriptStrings() async throws {
        try await withStorage(["vision_theme": "dark", "fx-status-banner-dismissed-at": "5", "legacy.unknown": "kept"]) {
            storage, _ in
            let json = try await storage.backupStateJSON()
            #expect(try JSONValue.parse(Data(json.utf8)) == .object(["keys": .object(["vision_theme": .string("dark")])]))
            let restored = await storage.restore(
                .object([
                    "keys": .object([
                        "vision.sidebar.collapsed": .bool(true), "vision.palette.recents": .array([.string("/a"), .null]),
                        "vision.language": .int(7), "vision.lastRoute": .null, "vision.startupSection": .object([:]),
                    ])
                ]))
            #expect(restored)
            #expect(await storage.value(for: .sidebarCollapsed) == "true")
            #expect(await storage.value(for: .paletteRecents) == "/a,")
            #expect(await storage.value(for: .language) == "7")
            #expect(await storage.value(for: .lastRoute) == "null")
            #expect(await storage.value(for: .startupSection) == "[object Object]")
            #expect(await storage.value(for: .theme) == "dark")
            #expect(await storage.restore(.object([:])))
            #expect(await storage.restore(.null))
            #expect(await storage.restore(.object(["keys": .null])))
        }
    }

    @Test func aRestoreThatCannotBeWrittenReportsFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vision-shell-storage-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("raw-state.json")
        struct Refused: Error {}
        let persistence = NativeRawStateStore.Persistence(load: { _ in nil }, save: { _, _ in throw Refused() })
        let storage = NativeShellStorage(store: try NativeRawStateStore(persistenceURL: url, persistence: persistence))
        #expect(await storage.restore(.object(["keys": .object(["vision.language": .string("nl")])])) == false)
        #expect(await storage.value(for: .language) == nil)
    }

    @Test func theLegacyThemeIsReportedFromTheStore() async throws {
        try await withStorage(["vision_theme": "light"]) { storage, _ in
            let legacy = await storage.legacyTheme()
            #expect(legacy.mode == "light")
            #expect(legacy.variant == nil)
        }
        try await withStorage { storage, _ in
            let legacy = await storage.legacyTheme()
            #expect(legacy.mode == nil && legacy.variant == nil)
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
            #expect(await storage.value(for: .upcomingDismissals) != nil)
            let review: JSONValue = .object(["mode": .string("strict")])
            let sessionKey = "vision.portfolio-import.latest-review-settings.v1"
            #expect(await storage.webStorage(key: sessionKey, value: review, session: true) == review)
            #expect(await storage.webStorage(key: sessionKey, value: .null, session: true) == .null)
            #expect(await storage.store.sessionValue(for: .portfolioReview) == nil)
        }
    }

    @Test func chartLayoutsWriteThenRead() async throws {
        try await withStorage { storage, _ in
            let empty = try await storage.chartLayouts(writing: nil)
            #expect(empty == nil)
            let written = try await storage.chartLayouts(writing: "{\"v\":2}")
            #expect(written == "{\"v\":2}")
            let reread = try await storage.chartLayouts(writing: nil)
            #expect(reread == "{\"v\":2}")
        }
    }

    @Test func chartLayoutValuesAreBoundedUTF8() throws {
        let limit = NativeShellStorage.maximumChartLayoutBytes
        #expect(try NativeShellStorage.chartLayoutValue(Data(repeating: 0x61, count: limit)).utf8.count == limit)
        #expect(throws: APIError.self) {
            try NativeShellStorage.chartLayoutValue(Data(repeating: 0x61, count: limit + 1))
        }
        #expect(throws: APIError.self) { try NativeShellStorage.chartLayoutValue(Data([0xFF, 0xFE])) }
    }

    @Test func theDashboardArrivalFlagClears() async throws {
        try await withStorage { storage, _ in
            await storage.store.setSessionValue("1", for: .dashboardArrival)
            await storage.clearDashboardArrival()
            #expect(await storage.store.sessionValue(for: .dashboardArrival) == nil)
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

    @Test func validLargeChartSharesRemainBoundedToTheChartRoute() throws {
        let token = String(repeating: "A", count: 20_000)
        let route = try #require(NativeRoute("/research/charts?chart=" + token + "&unrelated=keep"))
        #expect(route.value("chart") == token)
        #expect(route.value("unrelated") == "keep")
        #expect(NativeRoute("/research/compare?chart=" + token) == nil)
        #expect(NativeRoute("/research/charts/extra?chart=" + token) == nil)
        #expect(NativeRoute("//research/charts?chart=" + token) == nil)
        #expect(NativeRoute("/research/charts?chart=" + token + "#fragment") == nil)
        #expect(NativeRoute("/research/charts?chart=" + String(repeating: "A", count: 32_768)) == nil)
    }
}

import AppKit
import SwiftUI
import Testing
import VisionNativeCore
@testable import VisionNativeUI

actor StaticRatesService: ExchangeRatesService {
    let result: OpenAPI.ExchangeRates

    init(_ result: OpenAPI.ExchangeRates) {
        self.result = result
    }

    func exchangeRates() async throws -> OpenAPI.ExchangeRates { result }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage { OpenAPI.InfoMessage(message: "ok") }
}

actor StaticAdminService: AdminService {
    let failing: Bool

    init(failing: Bool = false) {
        self.failing = failing
    }

    static let provider = OpenAPI.ProviderHealth(
        provider: "ecb", kind: "fx", label: "ECB", lastSuccessAt: "2026-10-09T08:05:00.000Z",
        lastErrorAt: "2026-10-09T09:30:00.000Z", lastError: "Fetch timeout after 5000ms", consecutiveFailures: 1,
        updatedAt: nil)

    private func check() throws {
        if failing { throw APIError.client(APIClientError(status: 401, code: .unauthorized, message: "Unauthorized")) }
    }

    func databaseStats() async throws -> OpenAPI.DbStats {
        try check()
        return OpenAPI.DbStats(tables: [], dbSize: "12 MB")
    }

    func providerHealth() async throws -> [OpenAPI.ProviderHealth] {
        try check()
        return [Self.provider]
    }

    func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult {
        OpenAPI.ProbeResult(ok: true, provider: Self.provider)
    }

    func requestMetrics() async throws -> [OpenAPI.RouteMetric] {
        try check()
        return [
            OpenAPI.RouteMetric(
                route: "GET:/api/x", method: "GET", path: "/api/x", count: 10, errors: 1,
                errorRate: Decimal(string: "0.1")!, p50Ms: 12, p95Ms: nil, windowMinutes: 15)
        ]
    }

    func endpointManifest() async throws -> [OpenAPI.EndpointEntry] {
        try check()
        return [
            OpenAPI.EndpointEntry(method: "GET", path: "/api/x"),
            OpenAPI.EndpointEntry(method: "DELETE", path: "/api/x/:id"),
        ]
    }
}

/// An audit history with one verified, partly anchored page.
@MainActor
final class StaticAuditHistory: AuditHistoryService {
    static func entry(_ sequence: Int, anchored: Bool) -> JSONValue {
        let hash = String(repeating: String(sequence % 10), count: 64)
        return .object([
            "sequence": .int(sequence), "previousHash": .string(hash), "hash": .string(hash), "version": .int(1),
            "payload": .object(["stream": .string("transactions"), "event": .string("update")]),
            "createdAt": .string("2026-01-01T00:00:00.000Z"),
            "anchorStatus": .string(anchored ? "anchored" : "pending_anchor"),
        ])
    }

    func read(_ range: AuditViewer.ReadRange) async -> JSONValue {
        .object([
            "success": .bool(true),
            "verification": .object([
                "status": .string("partially_verified"), "sequence": .int(2),
                "hash": .string(String(repeating: "2", count: 64)), "anchoredThrough": .int(1),
            ]),
            "entries": .array([Self.entry(1, anchored: true), Self.entry(2, anchored: false)]),
            "hasMore": .bool(false),
        ])
    }

    func enroll() async -> JSONValue { .object(["success": .bool(false), "cancelled": .bool(true)]) }
    func exportSnapshot() async -> JSONValue { .object(["success": .bool(false), "cancelled": .bool(true)]) }
    func exportTransfer(password: String) async -> JSONValue { .object(["success": .bool(true)]) }
    func importTransfer(password: String) async -> JSONValue { .object(["success": .bool(true)]) }
    func rotateKey() async -> JSONValue { .object(["success": .bool(true)]) }
}

/// The SwiftUI screens build and lay out in both languages and appearances.
@MainActor
@Suite struct NativeScreenStructureTests {
    static let rates = OpenAPI.ExchangeRates(
        totalRates: 3,
        rates: [
            OpenAPI.ExchangeRate(
                currency: "USD", rateToEur: Decimal(string: "1.0842")!, rateDate: "2026-10-09",
                fetchedAt: "2026-10-09T15:05:00.000Z")
        ],
        fallbackRates: ["EUR": 1, "USD": Decimal(string: "0.92")!], source: "database", isStale: false,
        lastFetchedAt: nil)

    func makeShell(language: NativeLanguage, appearance: ThemeAppearance, failing: Bool = false) -> NativeShellModel {
        NativeShellModel(
            strings: CatalogStrings(language: language),
            theme: ThemeSelection(appearance: appearance),
            exchangeRates: ExchangeRatesModel(service: StaticRatesService(Self.rates)),
            admin: AdminScreens.make(
                service: StaticAdminService(failing: failing),
                token: AdminTokenAccess(read: { "token" }, write: { _ in true }), audit: StaticAuditHistory()),
            loadSettings: { NativeAppSettings(adminMode: true) },
            onNavigate: { _ in })
    }

    func layOut<Content: View>(_ view: Content) -> NSHostingView<Content> {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        host.layoutSubtreeIfNeeded()
        return host
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theExchangeRatesScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        // Loading, then loaded.
        let loading = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loading.fittingSize.width > 0)
        await shell.exchangeRates.appear()
        #expect(shell.exchangeRates.data == Self.rates)
        let loaded = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loaded.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAdminScreensLayOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let admin = shell.admin
        // Loading.
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        // Loaded, with an expanded error row, a filter and an audit page.
        await admin.overview.appear()
        await admin.providers.appear()
        await admin.endpoints.appear()
        #expect(admin.overview.audit.page?.entries.count == 2)
        #expect(admin.overview.hasToken)
        admin.providers.toggleExpanded("ecb")
        admin.endpoints.filter = "delete"
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The empty state.
        admin.endpoints.filter = "nothing matches"
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test func theAdminErrorStatesLayOut() async {
        let shell = makeShell(language: .nl, appearance: .dark, failing: true)
        let theme = VisionTheme(selection: shell.theme)
        await shell.admin.providers.appear()
        #expect(shell.admin.providers.errorState(strings: shell.strings) == .authentication)
        #expect(layOut(ProviderHealthView(model: shell.admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await shell.admin.overview.appear()
        #expect(layOut(AdminOverviewView(model: shell.admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test func theShellHostsTheWebContentAndTheNativeScreen() async throws {
        let shell = makeShell(language: .nl, appearance: .light)
        let root = ShellRootView(model: shell) { hidden in
            Color.clear.accessibilityHidden(hidden)
        }
        let host = layOut(root)
        #expect(host.fittingSize.width > 0)
        shell.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.exchangeRates))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test(arguments: [ThemeAppearance.light, .dark])
    func theGlassBackgroundsLayOut(_ appearance: ThemeAppearance) {
        let theme = VisionTheme(selection: ThemeSelection(appearance: appearance))
        #expect(theme.glass == ShellGlass(selection: theme.selection))
        let sidebar = layOut(SidebarGlassBackground().environment(\.visionTheme, theme))
        let detail = layOut(DetailGlassBackground().environment(\.visionTheme, theme))
        #expect(sidebar.frame.width == 1100)
        #expect(detail.frame.width == 1100)
    }

    @Test func themeColoursComeFromTheTokens() {
        let theme = VisionTheme(selection: ThemeSelection(variant: .default, appearance: .dark))
        #expect(theme.isDark && theme.colorScheme == .dark)
        #expect(theme.palette == DesignTokens.palette(.default, .dark))
        #expect(VisionTheme.fallback.colorScheme == .light)
    }
}

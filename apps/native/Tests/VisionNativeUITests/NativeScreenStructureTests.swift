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

    func makeShell(language: NativeLanguage, appearance: ThemeAppearance) -> NativeShellModel {
        NativeShellModel(
            strings: CatalogStrings(language: language),
            theme: ThemeSelection(appearance: appearance),
            exchangeRates: ExchangeRatesModel(service: StaticRatesService(Self.rates)),
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

    @Test func themeColoursComeFromTheTokens() {
        let theme = VisionTheme(selection: ThemeSelection(variant: .default, appearance: .dark))
        #expect(theme.isDark && theme.colorScheme == .dark)
        #expect(theme.palette == DesignTokens.palette(.default, .dark))
        #expect(VisionTheme.fallback.colorScheme == .light)
    }
}

import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct NativeAppSettingsTests {
    @Test func migrateKeepsValidFieldsAndDefaultsTheRest() {
        let raw = JSONValue.object([
            "dateFormat": .string("DD.MM.YYYY"), "numberFormat": .string("in"), "showDecimalPlaces": .int(0),
            "adminMode": .bool(true), "colorblindGainLoss": .bool(true), "unrelated": .string("x"),
        ])
        let settings = NativeAppSettings.migrate(raw)
        #expect(settings == NativeAppSettings(
            dateFormat: .dayMonthYearDot, numberFormat: .in, showDecimalPlaces: 0, adminMode: true,
            colorblindGainLoss: true))
        let invalid = NativeAppSettings.migrate(.object(["dateFormat": .string("YY"), "numberFormat": .int(1)]))
        #expect(invalid == .defaults)
        #expect(NativeAppSettings.migrate(.string("nope")) == .defaults)
        #expect(NativeAppSettings.migrate(nil) == .defaults)
    }

    @Test func numberFormatsUseTheWebLocales() {
        #expect(NumberFormat.eu.locale.identifier == "de_DE")
        #expect(NumberFormat.us.locale.identifier == "en_US")
        #expect(NumberFormat.ch.locale.identifier == "de_CH")
        #expect(NumberFormat.in.locale.identifier == "en_IN")
    }
}

@Suite struct ThemeSelectionTests {
    @Test func theVariantIsTheOneWhoseSurfaceAndTextMatch() {
        // themes.ts nord dark `--background` and `--foreground`; the primary differs with the
        // macOS accent colour on, so it does not take part.
        let splash = SplashTheme(
            mode: .dark, background: "1 2% 3%", foreground: "4 5% 6%", surface: "220 16% 22%", text: "218 27% 94%")
        let selection = ThemeSelection.resolve(splashTheme: splash, systemIsDark: false)
        #expect(selection.appearance == .dark)
        #expect(selection.variant == .nord)
    }

    @Test func withoutAPersistedThemeTheSystemAppearanceApplies() {
        #expect(ThemeSelection.resolve(splashTheme: nil, systemIsDark: true) == ThemeSelection(appearance: .dark))
        #expect(ThemeSelection.resolve(splashTheme: nil, systemIsDark: false) == ThemeSelection(appearance: .light))
    }

    @Test func gainAndLossFollowTheColorblindSkin() {
        var selection = ThemeSelection(appearance: .light)
        // tokens.css `:root` and skin-v2.css `:root.skin-v2`.
        #expect(selection.gain == HSLColor(hue: 36, saturation: 74, lightness: 33))
        selection.colorblindGainLoss = true
        #expect(selection.gain == HSLColor(hue: 162, saturation: 84, lightness: 30))
        #expect(selection.loss == selection.palette.colorblindLoss)
    }

    @Test func todaysColoursAreKept() {
        // tokens.css `:root` and `.dark` backgrounds, which the launch view and window use too.
        #expect(DesignTokens.palette(.default, .light).background == HSLColor(hue: 40, saturation: 36, lightness: 96))
        #expect(DesignTokens.palette(.default, .light).foreground == HSLColor(hue: 200, saturation: 20, lightness: 9))
        for variant in ThemeVariant.allCases {
            #expect(DesignTokens.palette(variant, .light) != DesignTokens.palette(variant, .dark), "\(variant)")
        }
        #expect(ThemeVariant(rawValue: "high-contrast") == .highContrast)
    }
}

@Suite struct NativeRouteTests {
    @Test func parsesPathAndQueryLikeTheRouter() throws {
        let route = try #require(NativeRoute("/admin/exchange-rates?tab=fallback&x=a+b%26c"))
        #expect(route.path == "/admin/exchange-rates")
        #expect(route.value("tab") == "fallback")
        #expect(route.value("x") == "a b&c")
        #expect(route.string == "/admin/exchange-rates?tab=fallback&x=a%20b%26c")
        #expect(NativeRoute("/")?.query.isEmpty == true)
    }

    @Test func readsAMalformedQueryLikeURLSearchParams() throws {
        // An invalid percent-escape stays as written instead of failing the route.
        let badEscape = try #require(NativeRoute("/p?a=%zz"))
        #expect(badEscape.value("a") == "%zz")
        let brackets = try #require(NativeRoute("/p?x=[1]"))
        #expect(brackets.value("x") == "[1]")
        let trailing = try #require(NativeRoute("/admin/exchange-rates?tab=live&"))
        #expect(trailing.query.count == 1)
        #expect(trailing.value("tab") == "live")
        let bare = try #require(NativeRoute("/p?k"))
        #expect(bare.value("k") == "")
        #expect(bare.string == "/p?k=")
        let equals = try #require(NativeRoute("/p?a=b=c"))
        #expect(equals.value("a") == "b=c")
    }

    @Test func refusesAnythingButAnAppRelativeRoute() {
        for raw in ["", "admin", "//evil.example/x", "https://evil.example/", "/a#b", "/a\\b", "/a\nb"] {
            #expect(NativeRoute(raw) == nil, "\(raw)")
        }
        #expect(NativeRoute("/" + String(repeating: "a", count: NativeRoute.maximumLength)) == nil)
    }

    @Test func removingAQueryValueDropsEveryValueOfThatName() throws {
        let route = try #require(NativeRoute("/planned?show_all=true&tab=x&show_all=false"))
        #expect(route.removing("show_all").string == "/planned?tab=x")
        #expect(route.removing("missing") == route)
        #expect(NativeRoute(path: "/planned").removing("show_all").string == "/planned")
    }

    @Test func settingAQueryValueReplacesItAndKeepsTheRest() throws {
        let route = try #require(NativeRoute("/admin/exchange-rates?settings=general&tab=live&tab=x"))
        let next = route.setting("tab", to: "fallback")
        #expect(next.string == "/admin/exchange-rates?settings=general&tab=fallback")
        #expect(NativeRoute(path: "/p").setting("tab", to: "live").string == "/p?tab=live")
    }

    @Test func theAdminScreensAreBehindTheAdminGateAndPlannedIsNot() {
        #expect(NativeScreen.screen(forPath: "/") == .home)
        #expect(!NativeScreen.home.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/statistics") == .statistics)
        #expect(!NativeScreen.statistics.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/admin/exchange-rates") == .exchangeRates)
        #expect(NativeScreen.screen(forPath: "/admin/exchange-rates/x") == nil)
        #expect(NativeScreen.exchangeRates.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/admin") == .adminOverview)
        #expect(NativeScreen.screen(forPath: "/admin/providers") == .providerHealth)
        #expect(NativeScreen.screen(forPath: "/admin/endpoints") == .endpointLiveness)
        #expect(NativeScreen.screen(forPath: "/admin/db") == .databaseMaintenance)
        #expect(NativeScreen.screen(forPath: "/admin/db/transactions") == NativeScreen.tableEditor(table: "transactions"))
        let adminScreens = NativeScreen.fixedScreens.filter {
            $0 != .plannedPayments && $0 != .importExport && $0 != .transactions && $0 != .accounts
                && $0 != .categories && $0 != .recipients
        }
        #expect(adminScreens.allSatisfy { screen in screen.requiresAdmin })
        #expect(NativeScreen.tableEditor(table: "x").requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/planned") == .plannedPayments)
        #expect(!NativeScreen.plannedPayments.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/planned/x") == nil)
        #expect(NativeScreen.screen(forPath: "/transactions") == .transactions)
        #expect(!NativeScreen.transactions.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/owes") == .owes)
        #expect(!NativeScreen.owes.requiresAdmin)
    }
}

@Suite struct NavigationRegistryTests {
    @Test func theAdminSectionShowsOnlyInAdminMode() {
        #expect(!NavigationRegistry.visibleSections(adminMode: false).contains { $0.id == .admin })
        #expect(NavigationRegistry.visibleSections(adminMode: true).last?.id == .admin)
        #expect(NavigationRegistry.sections.map(\.id) == [.top, .money, .wealth, .research])
    }

    @Test func everyItemHasASymbolAndAUniqueURL() {
        let items = NavigationRegistry.allItems
        #expect(Set(items.map(\.url)).count == items.count)
        #expect(items.allSatisfy { !$0.symbol.isEmpty && $0.titleKey.hasPrefix("nav.") })
        #expect(NavigationRegistry.adminSection.items.contains { $0.url == NativeScreen.exchangeRates.path })
    }

    @Test func matchingPrefersTheLongestURLAndTheRootOnlyExactly() {
        #expect(NavigationRegistry.matchItem(path: "/")?.url == "/")
        #expect(NavigationRegistry.matchItem(path: "/portfolio/stocks/AAPL")?.url == "/portfolio/stocks")
        #expect(NavigationRegistry.matchItem(path: "/portfolio")?.url == "/portfolio")
        #expect(NavigationRegistry.matchItem(path: "/nowhere") == nil)
        #expect(NavigationRegistry.matchSection(path: "/admin/exchange-rates") == .admin)
        #expect(NavigationRegistry.matchSection(path: "/research/markets") == .research)
    }

    @Test func exactItemsAreActiveOnlyOnTheirOwnPath() throws {
        let portfolio = try #require(NavigationRegistry.allItems.first { $0.url == "/portfolio" })
        #expect(portfolio.exact)
        #expect(portfolio.isActive(path: "/portfolio"))
        #expect(!portfolio.isActive(path: "/portfolio/stocks"))
    }
}

@Suite struct NativeShortcutsTests {
    let start = Date(timeIntervalSinceReferenceDate: 1_000)

    @Test func goToSequencesNavigateWithinTheWindow() {
        var shortcuts = NativeShortcuts()
        #expect(shortcuts.handle(key: "g", path: "/admin/exchange-rates", now: start) == .consumed)
        #expect(shortcuts.handle(key: "h", path: "/admin/exchange-rates", now: start + 0.5) == .navigate("/"))
        #expect(shortcuts.handle(key: "g", path: "/", now: start + 1) == .consumed)
        #expect(shortcuts.handle(key: "t", path: "/", now: start + 2) == .ignored)
    }

    @Test func modifiersDisarmAndCommandKOpensThePalette() {
        var shortcuts = NativeShortcuts()
        _ = shortcuts.handle(key: "g", path: "/", now: start)
        #expect(shortcuts.handle(key: "k", command: true, path: "/", now: start) == .openPalette)
        #expect(shortcuts.handle(key: "t", path: "/", now: start) == .ignored)
        #expect(shortcuts.handle(key: "K", control: true, path: "/", now: start) == .openPalette)
        #expect(shortcuts.handle(key: "x", command: true, path: "/", now: start) == .ignored)
    }

    @Test func singleKeyShortcuts() {
        var shortcuts = NativeShortcuts()
        #expect(shortcuts.handle(key: "n", path: "/", now: start) == .navigate("/transactions?new=1"))
        #expect(shortcuts.handle(key: "?", shift: true, path: "/", now: start) == .openShortcuts)
        #expect(shortcuts.handle(key: "]", path: "/admin/exchange-rates", now: start) == .navigate("/portfolio"))
        #expect(shortcuts.handle(key: "[", path: "/admin/exchange-rates", now: start) == .navigate("/research"))
        #expect(shortcuts.handle(key: "]", path: "/research/markets", now: start) == .navigate("/"))
        #expect(shortcuts.handle(key: "q", path: "/", now: start) == .ignored)
    }

    @Test func goToRoutesFollowTheShortcutKeys() {
        let routes = NativeShortcuts.goToRoutes
        #expect(routes.first { $0.key == "t" }?.url == "/transactions")
        #expect(Set(routes.map(\.key)).count == routes.count)
    }
}

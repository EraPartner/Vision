import Testing

@testable import VisionNativeCore

@Suite struct NativeNavigationStartupTests {
    private func resolve(
        _ mirror: String?, last: String? = nil, current: String = "/?keep=a+b&keep=%2f&flag",
        section: String = "budgeting", context: NativeNavigationStartup.Context = .documentReload
    ) -> NativeNavigationStartup.Resolution {
        var startup = NativeNavigationStartup(context: context, mirroredStartupSection: mirror, lastRoute: last)
        return startup.evaluate(currentLocation: current, settings: .loaded(startupSection: section))
    }

    @Test func validBootMirrorWinsBeforeAndAfterSettingsHydrate() {
        for (section, path) in ["portfolio": "/portfolio", "research": "/research", "ai-chat": "/ai-chat"] {
            var startup = NativeNavigationStartup(
                context: .documentReload, mirroredStartupSection: section, lastRoute: nil)
            let early = startup.evaluate(currentLocation: "/?discard=1", settings: .loading)
            #expect(early == .replaceCurrentEntry(path))
            #expect(startup.hasResolved)
            let later = startup.evaluate(currentLocation: "/", settings: .loaded(startupSection: "last"))
            #expect(later == .unchanged)
            #expect(resolve(section, section: "budgeting") == .replaceCurrentEntry(path))
        }
    }

    @Test func missingEmptyAndInvalidMirrorsWaitThenUseHydratedSetting() {
        let mirrors: [String?] = [nil, "", "null", "undefined", "Portfolio", " portfolio ", "unknown"]
        for mirror in mirrors {
            var startup = NativeNavigationStartup(
                context: .documentReload, mirroredStartupSection: mirror, lastRoute: nil)
            let waiting = startup.evaluate(currentLocation: "/?settings=backup", settings: .loading)
            #expect(waiting == .waitingForSettings)
            #expect(!startup.hasResolved)
            let ready = startup.evaluate(
                currentLocation: "/?settings=backup", settings: .loaded(startupSection: "research"))
            #expect(ready == .replaceCurrentEntry("/research"))
            #expect(startup.hasResolved)
        }
    }

    @Test func budgetingAndRootLastTargetPreserveTheExactRootQuery() {
        let current = "/?settings=backup&x=a+b&x=%2f&bare"
        #expect(resolve("budgeting", current: current, section: "portfolio") == .unchanged)
        #expect(resolve("last", last: "/", current: current) == .unchanged)
        #expect(resolve(nil, current: current, section: "budgeting", context: .newSession) == .seedNewSession(current))
        #expect(resolve("last", last: "/", current: current, context: .newSession) == .seedNewSession(current))
        #expect(resolve(nil, current: current, section: "future-setting") == .unchanged)
    }

    @Test func lastPageRetainsRawDuplicateQuerySpellingAndReplacesEvenTheSameRootQuery() {
        let last = "/tax?year=2020&settings=backup&export=pdf&x=a+b&x=%2f&bare"
        #expect(resolve("last", last: last) == .replaceCurrentEntry(last))
        #expect(resolve(nil, last: last, section: "last", context: .newSession) == .seedNewSession(last))
        #expect(resolve("portfolio", last: last) == .replaceCurrentEntry("/portfolio"))
        #expect(resolve("last", last: "/?x=a+b", current: "/?x=a+b") == .replaceCurrentEntry("/?x=a+b"))
    }

    @Test func missingEmptyAndNonAbsoluteLastPageDoNotReplaceRootQuery() {
        let values: [String?] = [nil, "", "null", "undefined", "tax", "https://example.invalid/tax", " /tax"]
        for value in values {
            #expect(resolve("last", last: value) == .unchanged)
            #expect(
                resolve(nil, last: value, current: "/?keep=1", section: "last", context: .newSession)
                    == .seedNewSession("/?keep=1"))
        }
    }

    @Test func sourceSelectionDoesNotSilentlyApplyNativeAdmissionOrAdminRedirects() {
        // Source readLastPage accepts startsWith('/'); route admission is a later
        // boundary. A selected invalid target must not silently become Home here.
        for raw in [
            "//example.invalid", "/tax#section", "/tax\\path", "/tax\n", "/" + String(repeating: "x", count: 2050),
        ] {
            #expect(resolve("last", last: raw) == .replaceCurrentEntry(raw))
        }
        #expect(resolve("last", last: "/admin/db/ledger?keep=%2f") == .replaceCurrentEntry("/admin/db/ledger?keep=%2f"))
        #expect(
            resolve("last", last: "/portfolio/performance?x=a+b")
                == .replaceCurrentEntry("/portfolio/performance?x=a+b"))
    }

    @Test func deepLinksKeepTheirLocationAndConsumeTheOneTimeDecision() {
        for path in ["/tax?year=2020&settings=backup", "/admin/db/ledger?x=%2f", "/portfolio/performance?x=a+b", "//"] {
            #expect(resolve("portfolio", current: path) == .unchanged)
            #expect(resolve("portfolio", current: path, context: .newSession) == .seedNewSession(path))
        }
        var startup = NativeNavigationStartup(
            context: .documentReload, mirroredStartupSection: "portfolio", lastRoute: nil)
        let initial = startup.evaluate(currentLocation: "/tax", settings: .loading)
        let returnHome = startup.evaluate(currentLocation: "/", settings: .loaded(startupSection: "research"))
        #expect(initial == .unchanged)
        #expect(startup.hasResolved)
        #expect(returnHome == .unchanged)
    }

    @Test func locationAtSettingsArrivalWinsOverTheFirstPendingRootOrDeepLink() {
        var leavingRoot = NativeNavigationStartup(
            context: .documentReload, mirroredStartupSection: nil, lastRoute: "/portfolio")
        let rootWaiting = leavingRoot.evaluate(currentLocation: "/", settings: .loading)
        let arrivedElsewhere = leavingRoot.evaluate(
            currentLocation: "/tax?year=2020", settings: .loaded(startupSection: "research"))
        #expect(rootWaiting == .waitingForSettings)
        #expect(arrivedElsewhere == .unchanged)

        var enteringRoot = NativeNavigationStartup(
            context: .documentReload, mirroredStartupSection: nil, lastRoute: "/portfolio")
        let deepWaiting = enteringRoot.evaluate(currentLocation: "/tax", settings: .loading)
        let arrivedHome = enteringRoot.evaluate(currentLocation: "/?keep=1", settings: .loaded(startupSection: "last"))
        #expect(deepWaiting == .waitingForSettings)
        #expect(arrivedHome == .replaceCurrentEntry("/portfolio"))
    }

    @Test func newSessionSeedsWhileEachReloadReplacesTheExistingVisitOnlyOnce() {
        #expect(resolve("research", context: .newSession) == .seedNewSession("/research"))
        #expect(resolve("research", context: .documentReload) == .replaceCurrentEntry("/research"))
        for _ in 0..<2 {
            var document = NativeNavigationStartup(
                context: .documentReload, mirroredStartupSection: "research", lastRoute: nil)
            let first = document.evaluate(currentLocation: "/", settings: .loading)
            let duplicate = document.evaluate(currentLocation: "/", settings: .loading)
            #expect(first == .replaceCurrentEntry("/research"))
            #expect(duplicate == .unchanged)
        }
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Opt-in native route and history authority")
struct NativeNavigationHistoryTests {
    private func location(_ raw: String) -> NativeNavigationLocation { NativeNavigationLocation(raw)! }

    @Test func navigationPreservesRawSearchUntilAnExplicitQueryEdit() {
        let raw = "/portfolio/performance?period=1y&q=a+b&x=%2f&x=%2F&flag&empty=&broken=%zz"
        let value = location(raw)
        #expect(value.raw == raw)
        #expect(value.route.value("q") == "a b")
        #expect(
            NativeNavigationHistory.resolve(value, adminMode: false)?.raw
                == raw.replacingOccurrences(of: "/performance", with: ""))
        #expect(location("/portfolio/performance?").replacingPath("/portfolio")?.raw == "/portfolio?")
        #expect(
            location("/transactions?q=a+b&flag&x=~*").setting("new", to: "a b~*")?.raw
                == "/transactions?q=a+b&flag=&x=%7E*&new=a+b%7E*")
    }

    @Test func invalidLocationsNeverBecomeHistoryEntries() {
        for raw in ["https://example.com", "//example.com", "/foo#fragment", "/foo\\bar", "/foo\nbar"] {
            #expect(NativeNavigationLocation(raw) == nil)
        }
        #expect(
            NativeNavigationLocation("/transactions?q=" + String(repeating: "a", count: NativeRoute.maximumLength))
                == nil)
        #expect(NativeNavigationLocation("/research/charts?chart=" + String(repeating: "a", count: 20_000)) != nil)
    }

    @Test func malformedQueryBytesAndInvalidSettingsMatchURLSearchParamsCleanup() {
        let malformed = location("/transactions?q=%C3%28%zz+%2f&flag")
        #expect(malformed.route.value("q") == "�(%zz /")
        #expect(malformed.setting("new", to: "1")?.raw == "/transactions?q=%EF%BF%BD%28%25zz+%2F&flag=&new=1")
        #expect(
            NativeNavigationHistory.resolve(location("/planned?settings=invalid&x=keep"), adminMode: true)?.raw
                == "/planned?x=keep")
        #expect(
            NativeNavigationHistory.resolve(location("/planned?settings=&x=keep"), adminMode: true)?.raw
                == "/planned?settings=&x=keep")
    }

    @Test func pushReplaceBackForwardAndBranchingHaveBrowserSemantics() {
        var history = NativeNavigationHistory()
        let first = location("/transactions?account=1&flag")
        let second = location("/accounts/2?q=a+b")
        #expect(history.request(.push(first), adminMode: true, hasUnsavedChanges: false) == .committed(first))
        history.request(.push(second), adminMode: true, hasUnsavedChanges: false)
        #expect(history.count == 3 && history.index == 2 && history.canGoBack && !history.canGoForward)
        history.request(.traverse(-1), adminMode: true, hasUnsavedChanges: false)
        #expect(history.location == first && history.canGoForward)
        history.request(.traverse(1), adminMode: true, hasUnsavedChanges: false)
        #expect(history.location == second)
        let replacement = location("/accounts/2?q=x%20y")
        history.request(.replace(replacement), adminMode: true, hasUnsavedChanges: false)
        #expect(history.count == 3 && history.location == replacement)
        history.request(.traverse(-1), adminMode: true, hasUnsavedChanges: false)
        history.request(.push(location("/planned")), adminMode: true, hasUnsavedChanges: false)
        #expect(history.count == 3 && !history.canGoForward)
        #expect(history.request(.traverse(Int.max), adminMode: true, hasUnsavedChanges: false) == .unchanged)
        #expect(history.request(.traverse(Int.min), adminMode: true, hasUnsavedChanges: false) == .unchanged)
        #expect(history.request(.traverse(0), adminMode: true, hasUnsavedChanges: false) == .unchanged)
    }

    @Test func repeatedAndQueryOnlyPushesRemainDistinctVisitsWithoutDiscardingDrafts() {
        let first = location("/transactions?search=a+b")
        let second = location("/transactions?search=a%20b")
        var history = NativeNavigationHistory(initial: first)
        #expect(history.request(.push(second), adminMode: true, hasUnsavedChanges: true) == .committed(second))
        history.request(.push(second), adminMode: true, hasUnsavedChanges: true)
        #expect(history.count == 3 && history.pending == nil)
        history.request(.traverse(-2), adminMode: true, hasUnsavedChanges: true)
        #expect(history.location.raw == first.raw)
    }

    @Test func allPathChangingOperationsWaitWithoutMutatingHistory() {
        for replace in [false, true] {
            var history = NativeNavigationHistory(initial: location("/transactions?q=keep"))
            let next = location("/accounts/1")
            let intent: NativeNavigationHistory.Intent = replace ? .replace(next) : .push(next)
            #expect(history.request(intent, adminMode: true, hasUnsavedChanges: true) == .blocked(next))
            #expect(history.location.raw == "/transactions?q=keep" && history.count == 1)
            history.cancelPending()
            #expect(history.pending == nil && history.location.raw == "/transactions?q=keep")
            history.request(intent, adminMode: true, hasUnsavedChanges: true)
            #expect(history.confirmPending(adminMode: true) == .committed(next))
            #expect(history.count == (replace ? 1 : 2))
        }
    }

    @Test func confirmingBackAndForwardRetainsTheTraversalOperation() {
        var history = NativeNavigationHistory(initial: location("/transactions"))
        history.request(.push(location("/accounts")), adminMode: true, hasUnsavedChanges: false)
        #expect(
            history.request(.traverse(-1), adminMode: true, hasUnsavedChanges: true)
                == .blocked(location("/transactions")))
        #expect(history.index == 1 && history.count == 2)
        history.confirmPending(adminMode: true)
        #expect(history.index == 0 && history.count == 2 && history.canGoForward)
        #expect(
            history.request(.traverse(1), adminMode: true, hasUnsavedChanges: true) == .blocked(location("/accounts")))
        history.confirmPending(adminMode: true)
        #expect(history.index == 1 && history.count == 2)
    }

    @Test func legacyRedirectIsOneVisitAndKeepsExactQuery() {
        var history = NativeNavigationHistory()
        let legacy = location("/PORTFOLIO/PERFORMANCE/?period=1y&q=a+b&x=%2f&flag")
        let expected = location("/portfolio?period=1y&q=a+b&x=%2f&flag")
        #expect(history.request(.push(legacy), adminMode: true, hasUnsavedChanges: false) == .committed(expected))
        #expect(history.count == 2)
        history.request(.traverse(-1), adminMode: true, hasUnsavedChanges: false)
        #expect(history.location == .home)
        history.request(.traverse(1), adminMode: true, hasUnsavedChanges: false)
        #expect(history.location == expected)
    }

    @Test func adminWaitsForHydrationThenReplacesWithHomeWithoutQuery() {
        var history = NativeNavigationHistory(initial: location("/transactions"))
        #expect(
            history.request(.push(location("/admin/db?settings=general")), adminMode: nil, hasUnsavedChanges: true)
                == .waitingForSettings)
        #expect(history.count == 1 && history.location.path == "/transactions")
        #expect(history.settingsDidLoad(adminMode: false, hasUnsavedChanges: true) == .blocked(.home))
        #expect(history.count == 1)
        history.confirmPending(adminMode: false)
        #expect(history.location == .home && history.count == 2)
        var direct = NativeNavigationHistory(initial: location("/admin/providers?keep=discard"))
        #expect(direct.settingsDidLoad(adminMode: false, hasUnsavedChanges: false) == .committed(.home))
        #expect(direct.count == 1)
    }

    @Test func adminModeChangeAndTraversalRecheckTheGate() {
        var history = NativeNavigationHistory(initial: location("/admin/db"))
        history.request(.push(location("/planned")), adminMode: true, hasUnsavedChanges: false)
        history.request(.traverse(-1), adminMode: false, hasUnsavedChanges: false)
        #expect(history.location == .home && history.count == 2 && history.index == 0)
        #expect(
            NativeNavigationHistory.resolve(location("/admin/unknown?x=keep"), adminMode: false)?.raw
                == "/admin/unknown?x=keep")
        #expect(NativeNavigationHistory.resolve(location("/administer"), adminMode: false)?.path == "/administer")
    }

    @Test func recognizedCanonicalPathsResolveWithoutChangingDynamicParameterSpelling() {
        for (raw, expected) in [
            ("/TRANSACTIONS/?q=a+b", "/transactions?q=a+b"),
            ("/ACCOUNTS/42/?q=%2f", "/accounts/42?q=%2f"),
            ("/PORTFOLIO/IMPORT/AbC%2fDeF/REVIEW/", "/portfolio/import/AbC%2fDeF/review"),
            ("/ADMIN/DB/Transactions/", "/admin/db/Transactions"),
            ("/OWES/", "/owes"),
        ] {
            let resolved = NativeNavigationHistory.resolve(location(raw), adminMode: true)
            #expect(resolved?.raw == expected)
            #expect(resolved.map { NativeScreen.screen(forPath: $0.path) != nil } == true)
        }
    }

    @Test func encodedStaticSegmentsMatchRouterWithoutTurningEncodedSlashesIntoBoundaries() {
        // Confirmed against installed react-router 8.3.0 matchRoutes/decodePath.
        for (raw, expected) in [
            ("/tr%61nsactions/?q=a+b&x=%2f&flag", "/transactions?q=a+b&x=%2f&flag"),
            ("/acc%6Funts/42/", "/accounts/42"),
            ("/im%70ort/123/rev%69ew/", "/import/123/review"),
            ("/%61dmin/d%62/Transactions%2fArchive/", "/admin/db/Transactions%2fArchive"),
            ("/p%6Frtfolio/perf%6Frmance?period=1y&flag", "/portfolio?period=1y&flag"),
            ("/portf%6Flio/im%70ort/AbC%2fDeF/rev%69ew/", "/portfolio/import/AbC%2fDeF/review"),
        ] {
            let original = location(raw)
            #expect(original.raw == raw && original.path == raw.split(separator: "?").first.map(String.init))
            let resolved = NativeNavigationHistory.resolve(original, adminMode: true)
            #expect(resolved?.raw == expected)
            #expect(resolved.map { NativeScreen.screen(forPath: $0.path) != nil } == true)
        }
        for raw in ["/admin%2Fdb/Transactions", "/%74ransactions%2f", "/transactions/%2f", "/%2561dmin"] {
            let resolved = NativeNavigationHistory.resolve(location(raw), adminMode: false)
            #expect(resolved?.raw == raw)
            #expect(resolved.flatMap { NativeScreen.screen(forPath: $0.path) } == nil)
        }
        let table = NativeNavigationHistory.resolve(location("/admin/db/one%2ftwo"), adminMode: true)
        #expect(table?.raw == "/admin/db/one%2ftwo")
        #expect(table.flatMap { NativeScreen.screen(forPath: $0.path) } == .tableEditor(table: "one/two"))
    }

    @Test func oneMalformedPathSegmentPreventsDecodingEveryOtherSegment() {
        for raw in ["/%61dmin/db/%zz", "/%61dmin/db/%C3%28", "/%61dmin/db/%ED%A0%80", "/%61dmin/db/%"] {
            let resolved = NativeNavigationHistory.resolve(location(raw), adminMode: false)
            #expect(resolved?.raw == raw)
            #expect(resolved.flatMap { NativeScreen.screen(forPath: $0.path) } == nil)
        }
        // The same malformed parameter still matches when the static segments
        // need no decoding; RequireAdmin then redirects normally.
        #expect(NativeNavigationHistory.resolve(location("/admin/db/%zz"), adminMode: false) == .home)
    }

    @Test func settingsOpenDeferredForHydrationStillOwnsItsPushedEntry() {
        let initial = location("/admin/db?q=a+b&flag")
        var history = NativeNavigationHistory(initial: initial)
        #expect(history.openSettings(section: "backup", adminMode: nil) == .waitingForSettings)
        #expect(history.location == initial && history.count == 1)
        #expect(
            history.settingsDidLoad(adminMode: true, hasUnsavedChanges: false)
                == .committed(location("/admin/db?q=a+b&flag=&settings=backup")))
        #expect(history.count == 2 && history.index == 1)
        history.closeSettings(adminMode: true)
        #expect(history.location == initial && history.count == 2 && history.index == 0)
    }

    @Test func deferredSettingsOwnershipSurvivesLeaveConfirmationButNotCancellationOrRedirect() {
        var guarded = NativeNavigationHistory(initial: location("/ADMIN/DB?keep=1"))
        #expect(guarded.openSettings(adminMode: nil, hasUnsavedChanges: true) == .waitingForSettings)
        #expect(
            guarded.settingsDidLoad(adminMode: true, hasUnsavedChanges: true)
                == .blocked(location("/admin/db?keep=1&settings=general")))
        guarded.confirmPending(adminMode: true)
        #expect(guarded.count == 2 && guarded.index == 1)
        guarded.closeSettings(adminMode: true)
        #expect(guarded.index == 0 && guarded.location.raw == "/admin/db?keep=1")

        var cancelled = NativeNavigationHistory(initial: location("/admin/db"))
        cancelled.openSettings(adminMode: nil)
        cancelled.cancelPending()
        cancelled.request(.push(location("/planned?settings=about")), adminMode: true, hasUnsavedChanges: false)
        cancelled.closeSettings(adminMode: true)
        #expect(cancelled.index == 1 && cancelled.location.raw == "/planned" && cancelled.count == 2)

        var redirected = NativeNavigationHistory(initial: location("/admin/db"))
        redirected.openSettings(adminMode: nil)
        redirected.settingsDidLoad(adminMode: false, hasUnsavedChanges: false)
        #expect(redirected.location == .home && redirected.count == 2)
        redirected.request(.push(location("/planned?settings=about")), adminMode: false, hasUnsavedChanges: false)
        redirected.closeSettings(adminMode: false)
        #expect(redirected.index == 2 && redirected.location.raw == "/planned" && redirected.count == 3)
    }

    @Test func settingsFirstOpenPushesSectionChangesReplaceAndCloseReturnsExactly() {
        let initial = location("/transactions?q=a+b&flag&settingsOther=keep")
        var history = NativeNavigationHistory(initial: initial)
        history.openSettings(adminMode: true, hasUnsavedChanges: true)
        #expect(history.count == 2 && history.location.route.value("settings") == "general")
        history.openSettings(section: "backup", adminMode: true)
        #expect(history.count == 2 && history.location.route.value("settings") == "backup")
        history.closeSettings(adminMode: true)
        #expect(history.count == 2 && history.index == 0 && history.location == initial)
        // Returning with Forward is a direct-link-style close after the original window closed.
        history.request(.traverse(1), adminMode: true, hasUnsavedChanges: true)
        history.closeSettings(adminMode: true)
        #expect(history.index == 1 && history.count == 2 && history.location.route.value("settings") == nil)
    }

    @Test func settingsDirectLinkClosesByReplacementAndPreservesOtherPairs() {
        var history = NativeNavigationHistory(
            initial: location("/tax?year=2024&settings=backup&settings=about&export=pdf&q=a+b"))
        history.openSettings(section: "about", adminMode: true)
        #expect(history.count == 1)
        history.closeSettings(adminMode: true)
        #expect(history.count == 1 && history.location.raw == "/tax?year=2024&export=pdf&q=a+b")
    }

    @Test func reportAndSettingsQueryChangesDoNotConsumeAnotherEntryOrDropDrafts() {
        var history = NativeNavigationHistory(initial: location("/tax?year=2024&widget=income&widget=refund"))
        history.openSettings(adminMode: true)
        let report = history.location.setting("export", to: "pdf")!
        #expect(history.request(.replace(report), adminMode: true, hasUnsavedChanges: true) == .committed(report))
        let closed = history.location.setting("export", to: nil)!
        history.request(.replace(closed), adminMode: true, hasUnsavedChanges: true)
        #expect(history.count == 2 && history.location.route.value("year") == "2024")
        #expect(history.location.route.query.filter { $0.name == "widget" }.count == 2)
        history.closeSettings(adminMode: true)
        #expect(history.index == 0 && history.location.raw == "/tax?year=2024&widget=income&widget=refund")
    }

    @Test func entriesKeepTheirIdentityAndOnlyTraversalCountsAsBackOrForward() {
        var history = NativeNavigationHistory(initial: location("/transactions?q=a"))
        let first = history.entryID
        history.request(.replace(location("/transactions?q=b")), adminMode: false, hasUnsavedChanges: false)
        #expect(history.entryID == first && !history.lastCommitWasTraversal)
        history.request(.push(location("/planned")), adminMode: false, hasUnsavedChanges: false)
        #expect(history.entryID != first && !history.lastCommitWasTraversal)
        history.request(.traverse(-1), adminMode: false, hasUnsavedChanges: false)
        #expect(history.entryID == first && history.lastCommitWasTraversal)
        history.request(.push(location("/accounts")), adminMode: false, hasUnsavedChanges: false)
        #expect(!history.lastCommitWasTraversal)
    }
}

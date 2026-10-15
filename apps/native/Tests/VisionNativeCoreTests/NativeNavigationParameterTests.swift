import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native-only router parameter matching")
struct NativeNavigationParameterTests {
    @Test func parametersMatchInstalledReactRouterEightPointThreeOracle() throws {
        // Values from installed react-router 8.3.0 matchRoutes, including its
        // case-sensitive final %2F replacement after all-or-nothing decodePath.
        let cases = [
            ("%31", "1"), ("%2531", "%31"), ("01", "01"), ("1e2", "1e2"),
            ("%201%20", " 1 "), ("+1", "+1"), ("%2F", "/"), ("%2f", "/"),
            ("%252F", "/"), ("%252f", "%2f"), ("%25252F", "%252F"),
            ("one%2Ftwo%zz", "one/two%zz"), ("one%2ftwo%zz", "one%2ftwo%zz"),
            ("%ED%A0%80", "%ED%A0%80"), ("%C3%A9", "é"), ("%25", "%"),
            ("one%2Ftwo%3Fq%23fragment", "one/two?q#fragment"),
        ]
        for (template, name) in [
            ("/accounts/{value}", "id"), ("/import/{value}/review", "batchId"),
            ("/portfolio/import/{value}/review", "batchId"), ("/admin/db/{value}", "table"),
        ] {
            for (raw, expected) in cases {
                let pathname = template.replacingOccurrences(of: "{value}", with: raw)
                let location = try #require(NativeNavigationLocation(pathname + "?q=a+b&flag&x=%2f"))
                #expect(location.match?.parameters == [name: expected])
                #expect(location.path == pathname)
                #expect(location.raw == pathname + "?q=a+b&flag&x=%2f")
            }
        }
    }

    @Test func malformedSegmentRetiresDecodingForTheWholePathBeforeMatching() throws {
        for raw in ["/%61dmin/db/%zz", "/acc%6Funts/%C3%28", "/im%70ort/%ED%A0%80/review"] {
            #expect(try #require(NativeNavigationLocation(raw)).match == nil)
        }
        let table = try #require(NativeNavigationLocation("/admin/db/one%2Ftwo%zz"))
        #expect(table.match?.screen == .tableEditor(table: "one/two%zz"))
        #expect(table.match?.parameters["table"] == "one/two%zz")
        #expect(table.raw == "/admin/db/one%2Ftwo%zz")
    }

    @Test func encodedStaticSegmentsAndTrailingSlashesDoNotRewriteDynamicDataOrSearch() throws {
        let raw = "/PORTF%6FLIO/IM%70ORT/AbC%252FDeF/REV%69EW///?q=a+b&flag&x=%2f"
        let location = try #require(NativeNavigationLocation(raw))
        let resolved = try #require(NativeNavigationHistory.resolve(location, adminMode: true))
        #expect(resolved.raw == "/portfolio/import/AbC%252FDeF/review?q=a+b&flag&x=%2f")
        #expect(resolved.match?.screen == .portfolioImportReview(batchId: "AbC/DeF"))
        #expect(resolved.match?.parameters["batchId"] == "AbC/DeF")
        let numeric = try #require(NativeNavigationLocation("/im%70ort/%31/rev%69ew///?flag"))
        #expect(NativeNavigationHistory.resolve(numeric, adminMode: true)?.raw == "/import/%31/review?flag")
        #expect(numeric.match?.screen == .importReview(batchId: 1))
    }

    @Test func decodedSlashesStayInsideParametersAndCannotBecomeStaticRouteBoundaries() throws {
        for raw in ["/admin%2Fdb/table", "/accounts/one/two", "/accounts//1", "/portfolio/import//review"] {
            #expect(try #require(NativeNavigationLocation(raw)).match == nil)
        }
        #expect(try #require(NativeNavigationLocation("/admin/db/%2F")).match?.screen == .tableEditor(table: "/"))
        #expect(try #require(NativeNavigationLocation("/transactions///")).match?.screen == .transactions)
        #expect(try #require(NativeNavigationLocation("/")).match?.screen == .home)
    }

    @Test func rendererModeRouteAndScreenDecodingRemainUnchanged() throws {
        let raw = "/portfolio/import/%31/review?q=%C3%28%zz"
        let renderer = try #require(NativeRoute(raw))
        #expect(renderer.path == "/portfolio/import/%31/review")
        #expect(NativeScreen.screen(forPath: renderer.path) == .portfolioImportReview(batchId: "%31"))
        #expect(renderer.value("q") == "%C3%28%zz")
        #expect(NativeScreen.screen(forPath: "/admin/db/%252F") == .tableEditor(table: "%2F"))
        #expect(NativeScreen.screen(forPath: "/import/%31/review") == nil)
        #expect(try #require(NativeNavigationLocation(raw)).match?.screen == .portfolioImportReview(batchId: "1"))
    }

    @Test @MainActor func numericCoercionRemainsAnExplicitGateBeyondParameterDecoding() throws {
        for value in ["01", "1e2", "+1", "%201%20", "0x10"] {
            let location = try #require(NativeNavigationLocation("/portfolio/import/\(value)/review"))
            let parameter = try #require(location.match?.parameters["batchId"])
            #expect(PortfolioImportReviewModel.parseBatchId(parameter) == nil)
        }
        #expect(try #require(NativeNavigationLocation("/accounts/1e2")).match?.screen == .accountDetail(id: 0))
        let invalidImport = try #require(NativeNavigationLocation("/import/1e2/review"))
        #expect(invalidImport.match?.parameters["batchId"] == "1e2")
        #expect(invalidImport.match?.screen == nil)
    }
}

@MainActor @Suite("Native matched parameters reach shell consumers")
struct NativeNavigationParameterShellTests {
    private func makeShell(native: Bool, initial: String, recorder: ShellRecorder) -> NativeShellModel {
        let settings = NativeAppSettings(adminMode: true)
        let client = APIClient(baseURL: { nil }, maxRetries: 0)
        let shell = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            portfolio: PortfolioScreens(client: client), portfolioImports: PortfolioImportScreens(service: client),
            nativeFallback: true,
            nativeNavigation: native ? NativeNavigationHistory(initial: NativeNavigationLocation(initial)!) : nil,
            loadSettings: { settings }, onNavigate: { recorder.actions.append($0) })
        shell.apply(settings: settings)
        if !native { shell.routeDidChange(NativeRoute(initial)!) }
        return shell
    }

    @Test func nativeTableMatchReachesEditorWithoutASecondDecodeWhileRendererKeepsItsParser() async {
        let raw = "/admin/db/%252F?q=a+b&flag"
        let recorder = ShellRecorder()
        let native = makeShell(native: true, initial: raw, recorder: recorder)
        #expect(native.detail == .native(.tableEditor(table: "/")))
        #expect(native.admin.database.editor?.table == "/")
        #expect(native.nativeNavigationLocation?.raw == raw)
        let renderer = makeShell(native: false, initial: raw, recorder: recorder)
        #expect(renderer.detail == .native(.tableEditor(table: "%2F")))
        #expect(renderer.admin.database.editor?.table == "%2F")
        #expect(renderer.route.path == "/admin/db/%252F" && recorder.actions.isEmpty)
        await native.settingsSettled()
        await renderer.settingsSettled()
    }

    @Test func nativePortfolioMatchPublishesDecodedBatchWhileRendererRetainsItsRawSegment() async {
        let raw = "/portfolio/import/%31/review?flag"
        let recorder = ShellRecorder()
        let native = makeShell(native: true, initial: raw, recorder: recorder)
        let renderer = makeShell(native: false, initial: raw, recorder: recorder)
        #expect(native.detail == .native(.portfolioImportReview(batchId: "1")))
        #expect(renderer.detail == .native(.portfolioImportReview(batchId: "%31")))
        #expect(native.route.path == renderer.route.path && native.nativeNavigationLocation?.raw == raw)
        #expect(recorder.actions.isEmpty)
        await native.settingsSettled()
        await renderer.settingsSettled()
    }
}

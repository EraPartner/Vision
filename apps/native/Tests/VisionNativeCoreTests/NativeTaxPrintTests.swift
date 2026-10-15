import Foundation
import Testing

@testable import VisionNativeCore

private actor NativeTaxPrintTransport: APITransport {
    private(set) var requests: [APIRequest] = []
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let data: String
        switch request.url.path {
        case "/api/belgian-tax/overview": data = NativeTaxPrintFixtures.overview
        case "/api/belgian-tax/dashboard": data = NativeTaxPrintFixtures.dashboard
        case "/api/settings/dashboard_settings":
            data = #"{"key":"dashboard_settings","value":{},"expected":{"exists":true,"value":{}}}"#
        case "/api/settings/widget_visibility":
            data =
                #"{"key":"widget_visibility","value":{"budgetTax":{"trendStrip":false,"pitBreakdown":false}},"expected":{"exists":true,"value":{"budgetTax":{"trendStrip":false,"pitBreakdown":false}}}}"#
        case "/api/info/deduction-candidates":
            data = #"{"year":2025,"from":"2025-01-01","to":"2025-12-31","currency":"EUR","byDeductionType":[]}"#
        default: return APIResponse(status: 500, body: Data())
        }
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(data)}".utf8))
    }
}

@Suite("Loaded native Tax page printing") @MainActor struct NativeTaxPrintTests {
    private func snapshot(
        widgets: Set<String> = ["summaryCards"], localState: NativeTaxPrintLocalState = .init(), empty: Bool = false
    ) throws -> NativeTaxPrintSnapshot {
        let overview = try JSONDecoder().decode(
            OpenAPI.BelgianTaxOverview.self, from: Data(NativeTaxPrintFixtures.overview.utf8))
        let body =
            empty
            ? NativeTaxPrintFixtures.dashboard.replacingOccurrences(of: "\"isEmpty\":false", with: "\"isEmpty\":true")
            : NativeTaxPrintFixtures.dashboard
        let dashboard = try JSONDecoder().decode(TaxDashboardData.self, from: Data(body.utf8))
        return try NativeTaxPrintSnapshot(
            overview: overview, dashboard: dashboard, settings: .defaults,
            strings: DictionaryStrings(language: .nl, table: [:]),
            theme: ThemeSelection(variant: .nord, appearance: .dark),
            visibleWidgets: widgets, localState: localState)
    }
    @Test func currentVisibleSectionsAndOriginalFrozenFiguresArePreserved() throws {
        let value = try snapshot(widgets: ["summaryCards", "incomeBreakdown", "yearlyOverview", "unknownFutureWidget"])
        #expect(
            value.sections == [
                .header, .masthead, .disclaimer, .summaryCards, .incomeBreakdown, .currentInputs, .suggestions,
                .deductionCandidates, .yearlyOverview, .automation,
            ])
        #expect(value.year == 2025 && value.overview.calculation.totalPIT == Decimal(string: "123.4567"))
        #expect(value.dashboard.yearlyIncome.first?.income == Decimal(string: "0.1234567890123456789"))
        #expect(value.overview.calculation.grossIncome == nil && value.overview.calculationSource == "frozen")
    }
    @Test func viewComparisonAndRulesExpansionAreImmutableSnapshotValues() throws {
        var local = NativeTaxPrintLocalState(
            comparisonYear: 2020, rulesExpanded: true, pitExpanded: true, householdExpanded: true)
        let value = try snapshot(localState: local)
        local.comparisonYear = 2024
        local.rulesExpanded = false
        local.pitExpanded = false
        local.householdExpanded = false
        #expect(value.localState.comparisonYear == 2020 && value.localState.rulesExpanded)
        #expect(value.localState.pitExpanded && value.localState.householdExpanded)
    }
    @Test func emptyPageKeepsMastheadTrendAndDisclaimerWithoutAddingWidgets() throws {
        let value = try snapshot(widgets: ["trendStrip", "summaryCards", "yearComparison"], empty: true)
        #expect(value.sections == [.header, .masthead, .trendStrip, .disclaimer, .noProfile])
    }
    @Test func wrongCurrencyCannotProduceAMixedPrintDocument() throws {
        let value = try snapshot()
        var settings = value.settings
        settings.defaultCurrency = "USD"
        #expect(throws: APIError.self) {
            try NativeTaxPrintSnapshot(
                overview: value.overview, dashboard: value.dashboard,
                settings: settings, strings: value.strings, theme: value.theme, visibleWidgets: [])
        }
    }
    @Test func inertPreparationUsesFrozenDataAndCannotReachBackend() async throws {
        let value = try snapshot(localState: .init(comparisonYear: 2024, rulesExpanded: true))
        let presentation = try await NativeTaxPrintPresentation.prepare(value)
        #expect(presentation.snapshot.localState == value.localState)
        #expect(presentation.dashboard.data?.year == value.year)
        #expect(presentation.dashboard.data?.portfolioTaxesForYear == value.dashboard.portfolioTaxesForYear)
        #expect(presentation.shell.settings == value.settings)
        #expect(presentation.shell.strings.language == .nl)
        #expect(presentation.shell.tax == nil && presentation.shell.reports == nil)
        // Even an escaped navigation/settings action is bound to inert state and no backend URL.
        presentation.shell.replaceQuery("year", with: "2020")
        presentation.shell.reloadSettings()
        #expect(presentation.snapshot.year == 2025)
        #expect(presentation.dashboard.data?.year == 2025)
    }
    @Test func captureUsesActiveLoadedYearWidgetsAndLocalViewStateWithoutNewReads() async throws {
        let transport = NativeTaxPrintTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport, maxRetries: 0)
        let tax = TaxScreens(client: client)
        let shell = NativeShellModelTests().makeModel(recorder: ShellRecorder(), tax: tax)
        shell.routeDidChange(NativeRoute("/tax?year=2025")!)
        await tax.load(year: 2025, currency: "EUR")
        try #require(tax.overview.error == nil && tax.dashboard.error == nil)
        try #require(tax.dashboard.data != nil)
        tax.printLocalState = .init(comparisonYear: 2024, rulesExpanded: true)
        let before = await transport.requests.count
        let captured = try NativeTaxPrintSnapshot.capture(shell: shell)
        let presentation = try await NativeTaxPrintPresentation.prepare(captured)
        #expect(await transport.requests.count == before)
        #expect(!captured.visibleWidgets.contains("trendStrip") && !captured.visibleWidgets.contains("pitBreakdown"))
        #expect(captured.localState == tax.printLocalState && captured.year == 2025)
        tax.dashboard.invalidate()
        tax.printLocalState = .init()
        #expect(presentation.dashboard.data?.year == 2025 && presentation.snapshot.localState.rulesExpanded)
        #expect(throws: APIError.self) { try NativeTaxPrintSnapshot.capture(shell: shell) }
    }
    @Test func missingOrDifferentRouteDataCannotBePrintedAsCurrent() {
        let shell = NativeShellModelTests().makeModel(recorder: ShellRecorder())
        #expect(throws: APIError.self) { try NativeTaxPrintSnapshot.capture(shell: shell) }
        shell.routeDidChange(NativeRoute("/tax?year=2020")!)
        #expect(throws: APIError.self) { try NativeTaxPrintSnapshot.capture(shell: shell) }
    }
}

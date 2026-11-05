import Foundation
import Testing

@testable import VisionNativeCore

actor ReportTestService: NativeReportService {
    private(set) var requests: [NativeReportRequest] = []
    var failure: APIError?
    private var hold = false
    private var release: CheckedContinuation<NativeReportFile, Error>?
    private var observers: [CheckedContinuation<Void, Never>] = []
    init(failure: APIError? = nil, hold: Bool = false) {
        self.failure = failure
        self.hold = hold
    }
    func generate(_ request: NativeReportRequest) async throws -> NativeReportFile {
        requests.append(request)
        for observer in observers { observer.resume() }
        observers.removeAll()
        if let failure { throw failure }
        if hold { return try await withCheckedThrowingContinuation { release = $0 } }
        return NativeReportFile(filename: "vision-\(request.type.rawValue)-2026-09-22.pdf", pdf: Data("%PDF-synthetic".utf8))
    }
    func waitForRequest() async {
        if !requests.isEmpty { return }
        await withCheckedContinuation { observers.append($0) }
    }
    func finish() {
        release?.resume(returning: NativeReportFile(filename: "vision-financial-2026-09-22.pdf", pdf: Data("%PDF-delayed".utf8)))
        release = nil
    }
}

actor ReportPrintedDocuments {
    private(set) var documents: [NativeReportDocument] = []
    func record(_ document: NativeReportDocument) { documents.append(document) }
}

actor ReportTestTransport: APITransport {
    private(set) var requests: [APIRequest] = []
    let response: APIResponse
    init(_ response: APIResponse) { self.response = response }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return response
    }
}

@MainActor private final class ReportCallbackRecorder {
    var preferences = NativeReportPreferences(
        currency: CurrencyCode(rawValue: "USD")!, excludedCategoryIds: [3], excludedRecipientIds: [7])
    var theme: TaxValue = .object(["mode": .string("dark"), "primary": .string("158 62% 32%")])
    var contexts: [Int: TaxValue] = [:]
    var contextYears: [Int] = []
    var saves: [(Data, String)] = []
    var prints: [(Data, String)] = []
    var saved = true
    var saveFailure: APIError?
    var closes = 0
    var notices: [ScreenNotice] = []
    var duringTheme: (@MainActor () -> Void)?
    var duringSave: (@MainActor () -> Void)?
    func callbacks() -> NativeReportCallbacks {
        NativeReportCallbacks(
            preferences: { self.preferences },
            theme: {
                self.duringTheme?()
                return self.theme
            },
            taxContext: { year in
                self.contextYears.append(year)
                return self.contexts[year] ?? .object([:])
            },
            save: { data, name in
                self.saves.append((data, name))
                self.duringSave?()
                if let error = self.saveFailure { throw error }
                return self.saved
            },
            print: { data, name in
                self.prints.append((data, name))
                return self.saved
            },
            close: { self.closes += 1 }, notice: { self.notices.append($0) })
    }
}

@Suite("Native PDF report source parity") @MainActor struct NativeReportTests {
    private static let instant = Date(timeIntervalSince1970: 1_790_035_200)  // 2026-09-22 UTC
    private func calendar(zone: String = "UTC") -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar
    }
    private func model(_ service: ReportTestService, _ recorder: ReportCallbackRecorder) -> NativeReportModel {
        NativeReportModel(
            service: service, callbacks: recorder.callbacks(), now: { Self.instant }, calendar: calendar())
    }
    @Test func defaultsAndTypeChangesRetainSourceSelectionsAndCurrencyPrefix() {
        let recorder = ReportCallbackRecorder()
        let model = model(ReportTestService(), recorder)
        model.configure(type: .financial, origin: "/tax?year=2020")
        #expect(model.periodPreset == .rolling12 && model.currency == CurrencyCode(rawValue: "USD"))
        #expect(model.customYear == String(model.currentYear))
        #expect(model.customFrom == "\(model.currentYear - 1)-01-01" && model.customTo == model.today)
        #expect(model.sections.count == 7 && model.allSectionsSelected && model.canSubmit)
        model.setAllSections(false)
        #expect(!model.canSubmit && !model.someSectionsSelected)
        model.setType(.portfolio)
        #expect(model.sections.count == 6 && model.allSectionsSelected)
        model.setType(.tax)
        #expect(model.sections.count == 7 && model.allSectionsSelected)
        #expect(
            NativeReportForm.currencies.map(\.rawValue) == [
                "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK",
            ])
    }
    @Test func formValidationUsesSourceUiBoundsAndShapeOrdering() {
        #expect(NativeReportForm.isValidYear("2027", currentYear: 2026))
        for year in ["1999", "2028", "26", "2026.0", "٢٠٢٦"] {
            #expect(!NativeReportForm.isValidYear(year, currentYear: 2026))
        }
        #expect(NativeReportForm.isValidCustomRange(from: "2025-01-01", to: "2025-12-31"))
        #expect(NativeReportForm.isValidCustomRange(from: "2025-99-99", to: "2026-01-01"))
        #expect(!NativeReportForm.isValidCustomRange(from: "2026-01-01", to: "2025-12-31"))
        #expect(!NativeReportForm.isValidCustomRange(from: "2025-1-01", to: "2025-12-31"))
    }
    @Test func allSelectedFinancialBodyUsesBackendDefaultsAndLiveExclusions() async throws {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .financial)
        recorder.preferences.excludedCategoryIds = [8, 3]
        await model.submit()
        let request = try #require(await service.requests.first)
        #expect(request.type == .financial)
        #expect(
            request.body
                == .object([
                    "currency": .string("USD"), "period": .object(["kind": .string("rolling"), "months": .number(12)]),
                    "sections": .array([]), "theme": recorder.theme,
                    "excludedCategoryIds": .array([.number(8), .number(3)]),
                    "excludedRecipientIds": .array([.number(7)]),
                ]))
        #expect(recorder.saves.first?.0 == Data("%PDF-synthetic".utf8))
        // The file keeps the document's own name, dated by the server (ADR-234).
        #expect(recorder.saves.first?.1 == "vision-financial-2026-09-22.pdf")
        #expect(recorder.notices.map(\.key) == ["statsPage.report.downloadSuccess"] && recorder.closes == 1)
    }
    @Test func partialSelectionPreservesJavaScriptSetReinsertOrder() async throws {
        let service = ReportTestService()
        let model = model(service, ReportCallbackRecorder())
        model.configure(type: .financial)
        model.setSection("executiveSummary", selected: false)
        model.setSection("topRecipients", selected: false)
        model.setSection("executiveSummary", selected: true)
        #expect(model.someSectionsSelected && !model.allSectionsSelected)
        await model.submit()
        let body = try #require(await service.requests.first?.body)
        #expect(
            body["sections"]
                == .array(
                    [
                        "cashflowTrend", "categoryBreakdown", "bankBalances", "rollingAverages", "plannedOutlook",
                        "executiveSummary",
                    ].map(TaxValue.string)))
    }
    @Test(arguments: ["everywhere", "statistics", "dashboard", "unknown"])
    func exclusionsMatchSourceScope(_ scope: String) async throws {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        recorder.preferences.exclusionScope = scope
        let model = model(service, recorder)
        model.configure(type: .financial)
        await model.submit()
        let body = try #require(await service.requests.first?.body)
        #expect(
            body["excludedCategoryIds"] == .array(["everywhere", "statistics"].contains(scope) ? [.number(3)] : []))
    }
    @Test(arguments: [NativeReportType.portfolio, .tax])
    func nonFinancialIgnoresExclusions(_ type: NativeReportType) async throws {
        let service = ReportTestService()
        let model = model(service, ReportCallbackRecorder())
        model.configure(type: type)
        await model.submit()
        let body = try #require(await service.requests.first?.body)
        #expect(body["excludedCategoryIds"] == .array([]) && body["excludedRecipientIds"] == .array([]))
    }
    /// ExportDialog: annual tax figures need a full calendar year, so other periods never ask.
    @Test func nonAnnualTaxPeriodsRequestNoTaxContext() async throws {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .tax)
        model.periodPreset = .rolling12
        await model.submit()
        let requestCount = await service.requests.count
        #expect(recorder.contextYears.isEmpty && requestCount == 1)
    }
    @Test func taxContextUsesSelectedFrozenYearAndRetainsDecimalUnknownHouseholdFields() async throws {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        let precise = Decimal(string: "1234567890.1234567890123456789")!
        let household: TaxValue = .object(["version": .number(2), "unknownFutureField": .number(precise)])
        let pit: TaxValue = .object([
            "taxableIncome": .number(precise),
            "brackets": .array([.object(["label": .string("25%"), "rate": .number(25)])]),
        ])
        recorder.contexts[2020] = .object(["household": household, "precomputedPIT": pit, "currency": .string("JPY")])
        model.configure(type: .tax)
        model.periodPreset = .year
        model.customYear = "2020"
        await model.submit()
        let request = try #require(await service.requests.first)
        let encoded = try #require(try NativeReportPDFOperation(request: request).encodedBody())
        let value = try JSONDecoder().decode(TaxValue.self, from: encoded)
        #expect(recorder.contextYears == [2020])
        #expect(
            value["household"] == household && value["precomputedPIT"] == pit && value["currency"] == .string("USD"))
        #expect(value["taxProfile"] == nil && value["precomputedHousehold"] == nil)
    }
    @Test func taxPeriodYearMatchesSourceFrozenBoundaryRules() {
        #expect(NativeReportPeriod.year(2020).taxYear(today: "2026-01-01") == 2020)
        #expect(NativeReportPeriod.custom(from: "2024-12-31", to: "2025-01-01").taxYear(today: "2026-01-01") == 2024)
        #expect(NativeReportPeriod.rolling(months: 12).taxYear(today: "2026-01-01") == 2026)
        #expect(NativeReportPeriod.ytd.taxYear(today: "2026-01-01") == 2026)
    }
    @Test func localDayAndYearAvoidUtcFilenameBoundary() {
        let date = Date(timeIntervalSince1970: 1_767_225_600 + 1800)  // 2026-01-01 00:30 UTC
        #expect(NativeReportForm.day(date, calendar: calendar(zone: "America/Los_Angeles")) == "2025-12-31")
    }
    @Test func savePanelCancellationKeepsDraftAndPublishesNoSuccess() async {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        recorder.saved = false
        let model = model(service, recorder)
        model.configure(type: .portfolio)
        model.currency = CurrencyCode(rawValue: "GBP")!
        await model.submit()
        #expect(model.isPresented && model.canSubmit && model.currency == CurrencyCode(rawValue: "GBP"))
        #expect(recorder.saves.count == 1 && recorder.notices.isEmpty && recorder.closes == 0)
    }
    @Test func receiptFailureKeepsDialogAndShowsSourceFailure() async {
        let service = ReportTestService(failure: .network("Synthetic report failure"))
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .financial)
        await model.submit()
        #expect(model.isPresented && model.canSubmit && model.errorDetail != nil)
        #expect(recorder.saves.isEmpty && recorder.closes == 0)
        #expect(recorder.notices.first?.key == "statsPage.report.downloadError")
    }
    @Test func saveFailureDoesNotCloseOrClaimSuccess() async {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        recorder.saveFailure = .network("Synthetic save failure")
        let model = model(service, recorder)
        model.configure(type: .financial)
        await model.submit()
        #expect(model.isPresented && recorder.closes == 0)
        #expect(recorder.notices.map(\.key) == ["statsPage.report.downloadError"])
    }
    @Test func retiredVisitCannotSaveLatePdfOrChangeNewDraft() async {
        let service = ReportTestService(hold: true)
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .financial)
        let task = Task { await model.submit() }
        await service.waitForRequest()
        model.didDisappear()
        model.configure(type: .tax)
        model.currency = CurrencyCode(rawValue: "CHF")!
        await service.finish()
        await task.value
        #expect(model.isPresented && model.type == .tax && model.currency == CurrencyCode(rawValue: "CHF") && model.canSubmit)
        #expect(recorder.saves.isEmpty && recorder.closes == 0 && recorder.notices.isEmpty)
    }
    @Test func staleThemeCallbackCannotStartReportRequest() async {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .tax)
        recorder.duringTheme = { model.didDisappear() }
        await model.submit()
        #expect(await service.requests.isEmpty)
        #expect(recorder.saves.isEmpty && recorder.notices.isEmpty)
    }
    @Test func saveReceiptCannotCloseNewVisit() async {
        let service = ReportTestService()
        let recorder = ReportCallbackRecorder()
        let model = model(service, recorder)
        model.configure(type: .financial)
        recorder.duringSave = { model.configure(type: .tax) }
        await model.submit()
        #expect(model.isPresented && model.type == .tax && model.canSubmit)
        #expect(recorder.closes == 0 && recorder.notices.isEmpty)
    }
    @Test func duplicateSubmissionHasOneRequest() async {
        let service = ReportTestService(hold: true)
        let model = model(service, ReportCallbackRecorder())
        model.configure(type: .financial)
        let task = Task { await model.submit() }
        await service.waitForRequest()
        await model.submit()
        #expect(await service.requests.count == 1)
        await service.finish()
        await task.value
    }
    @Test func printUsesSamePdfWithoutClaimingDownload() async {
        let recorder = ReportCallbackRecorder()
        let model = model(ReportTestService(), recorder)
        model.configure(type: .tax)
        await model.submit(output: .print)
        #expect(recorder.prints.first?.0 == Data("%PDF-synthetic".utf8))
        #expect(recorder.saves.isEmpty && recorder.notices.isEmpty && recorder.closes == 1)
    }
    @Test func samePageReopenKeepsTypePeriodCurrencyAndSections() {
        let model = model(ReportTestService(), ReportCallbackRecorder())
        model.configure(type: .tax, origin: "/tax?year=2025&export=pdf")
        model.setType(.financial)
        model.periodPreset = .year
        model.customYear = "2020"
        model.currency = CurrencyCode(rawValue: "CHF")!
        model.setSection("plannedOutlook", selected: false)
        model.didDisappear()
        model.configure(type: .tax, origin: "/tax?year=2024&export=pdf")
        #expect(model.type == .financial && model.periodPreset == .year && model.customYear == "2020")
        #expect(model.currency == CurrencyCode(rawValue: "CHF") && !model.selectedSections.contains("plannedOutlook"))
        #expect(model.isPresented && model.canSubmit)
    }
    @Test func pageUnmountDropsDraftBeforeSameRouteReturns() {
        let model = model(ReportTestService(), ReportCallbackRecorder())
        model.configure(type: .tax, origin: "/tax?year=2025&export=pdf")
        model.currency = CurrencyCode(rawValue: "CHF")!
        model.periodPreset = .year
        model.customYear = "2020"
        model.didLeavePage()
        model.configure(type: .tax, origin: "/tax?year=2025&export=pdf")
        #expect(model.type == .tax && model.periodPreset == .rolling12 && model.currency == CurrencyCode(rawValue: "USD"))
        #expect(model.customYear == String(model.currentYear) && model.allSectionsSelected)
    }
    @Test func graphRetirementPermanentlyRejectsReconfigureAndSubmission() async {
        let recorder = ReportCallbackRecorder()
        let service = ReportTestService()
        let model = model(service, recorder)
        model.configure(type: .financial)
        model.retireForReload()
        model.configure(type: .tax)
        model.close()
        await model.submit()
        #expect(model.isRetired && !model.isPresented && !model.canSubmit)
        #expect(await service.requests.isEmpty)
        #expect(recorder.closes == 0 && recorder.notices.isEmpty)
    }
    @Test func serviceDecodesTheReportDocumentPrintsItAndKeepsOneAttempt() async throws {
        let body = #"""
            {"ok":true,"data":{"filename":"vision-tax-2026-09-22.pdf","html":"<!DOCTYPE html><p>tax</p>","footerTemplate":"<span class=\"pageNumber\"></span>"}}
            """#
        let transport = ReportTestTransport(APIResponse(status: 200, body: Data(body.utf8)))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let printed = ReportPrintedDocuments()
        let service = NativeReportsAPIService(
            client: client,
            render: { document in
                await printed.record(document)
                return Data("%PDF-printed".utf8)
            })
        let result = try await service.generate(.init(type: .tax, body: .object(["currency": .string("EUR")])))
        #expect(result == NativeReportFile(filename: "vision-tax-2026-09-22.pdf", pdf: Data("%PDF-printed".utf8)))
        let document = try #require(await printed.documents.first)
        #expect(document.html == "<!DOCTYPE html><p>tax</p>" && document.footerTemplate.contains("pageNumber"))
        let request = try #require(await transport.requests.first)
        #expect(request.method == .post && request.url.path == "/api/reports/tax")
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(
            try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
                == .object(["currency": .string("EUR")]))
    }
    @Test func aPrintFailureReachesTheCaller() async {
        let body = #"{"ok":true,"data":{"filename":"vision-financial-2026-09-22.pdf","html":"<!DOCTYPE html>","footerTemplate":""}}"#
        let transport = ReportTestTransport(APIResponse(status: 200, body: Data(body.utf8)))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let service = NativeReportsAPIService(client: client, render: { _ in throw APIError.network("Synthetic print failure") })
        do {
            _ = try await service.generate(.init(type: .financial, body: .object([:])))
            Issue.record("A failed print must fail the report")
        } catch { #expect(error as? APIError == .network("Synthetic print failure")) }
    }
    @Test func binaryServiceDoesNotReplayRetryableFailure() async {
        let transport = ReportTestTransport(
            APIResponse(
                status: 503,
                body: Data(
                    #"{"ok":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Synthetic report unavailable"}}"#
                        .utf8)))
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport,
            sleep: { _ in Issue.record("Reports must not retry") })
        do {
            _ = try await NativeReportsAPIService(client: client).generate(.init(type: .financial, body: .object([:])))
            Issue.record("503 must fail")
        } catch { #expect(error is APIError) }
        #expect(await transport.requests.count == 1)
    }
}

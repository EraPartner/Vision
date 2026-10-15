import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Portfolio and Tax coordinator invalidation")
struct PortfolioCoordinatorTests {
    @Test func siblingWritesInvalidateTheCachedPortfolioTaxRead() async throws {
        let transport = PortfolioCoordinatorTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let portfolio = PortfolioScreens(client: client, now: { PlannedFixture.today })
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(portfolio.tax.dashboard?.totals.totalTaxes == 1)
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(await transport.dashboardReads == 1)
        portfolio.dataDidChange()
        #expect(portfolio.dataRevision == 1)
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(await transport.dashboardReads == 2)
        #expect(portfolio.tax.dashboard?.totals.totalTaxes == 2)
    }

    @Test func taxOverviewInvalidationRejectsAnOlderPortfolioTaxResponse() async throws {
        let transport = PortfolioCoordinatorTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let portfolio = PortfolioScreens(client: client, now: { PlannedFixture.today })
        let tax = TaxScreens(client: client)
        var invalidations = 0
        tax.didInvalidate = { [weak portfolio] in
            invalidations += 1
            portfolio?.tax.invalidate()
        }
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        await transport.pauseNextDashboard()
        let oldRead = Task { await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR", force: true) }
        await transport.waitForPause()
        tax.overview.invalidate()
        #expect(invalidations == 1)
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR", force: true)
        #expect(portfolio.tax.dashboard?.totals.totalTaxes == 3)
        await transport.release()
        await oldRead.value
        #expect(portfolio.tax.dashboard?.totals.totalTaxes == 3 && portfolio.tax.error == nil)
        tax.invalidate()
        #expect(invalidations == 2)
    }

    @Test func siblingInvalidationKeepsAnActiveAdjustmentFormAndItsOriginalCAS() async throws {
        let transport = PortfolioCoordinatorTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let portfolio = PortfolioScreens(client: client, now: { PlannedFixture.today })
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        let original = try #require(portfolio.tax.dashboard?.records.first?.expected)
        #expect(portfolio.tax.beginAdjustments(numberFormat: .eu))
        portfolio.tax.updateDraft(id: 7) { $0.taxes = "42,5" }
        portfolio.dataDidChange()
        await portfolio.tax.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(portfolio.tax.isAdjustmentsPresented && portfolio.tax.draftRows.first?.taxes == "42,5")
        #expect(await portfolio.tax.saveAdjustments())
        let write = try #require(await transport.writes.first)
        #expect(write["expected"]?[PortfolioTaxSettingsDraft.adjustmentsKey] == (try TaxValue(encoding: original)))
        #expect(
            write["settings"]?[PortfolioTaxSettingsDraft.adjustmentsKey]?["2026:7"]?["taxes"]
                == .number(Decimal(string: "42.5")!))
        #expect(portfolio.tax.dashboard?.year == 2025 && !portfolio.tax.isAdjustmentsPresented)
    }
}

private actor PortfolioCoordinatorTransport: APITransport {
    var dashboardReads = 0
    var writes: [TaxValue] = []
    private var pauseDashboard = false
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func pauseNextDashboard() { pauseDashboard = true }
    func waitForPause() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        held?.resume()
        held = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let value: TaxValue
        switch request.url.path {
        case "/api/belgian-tax/portfolio-dashboard":
            dashboardReads += 1
            value = try TaxValue(encoding: Self.dashboard(read: dashboardReads))
            if pauseDashboard {
                pauseDashboard = false
                await withCheckedContinuation {
                    held = $0
                    entered?.resume()
                    entered = nil
                }
            }
        case "/api/settings/widget_visibility":
            value = .object([
                "key": .string("widget_visibility"), "value": .object([:]),
                "expected": .object(["exists": .bool(false)]),
            ])
        case "/api/settings":
            writes.append(try JSONDecoder().decode(TaxValue.self, from: #require(request.body)))
            value = .object(["saved": .number(2)])
        default: throw APIError.invalidRequest("Unexpected coordinator fixture request")
        }
        return APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": value])))
    }
    private static func dashboard(read: Int) -> PortfolioTaxDashboard {
        let amount = Decimal(read)
        let stored: TaxValue = .object(["2026:7": .object(["taxes": .number(amount), "fees": .number(0)])])
        let raw: JSONValue = .object(["2026:7": .object(["taxes": .int(read), "fees": .int(0)])])
        return .init(
            year: 2025, currency: "EUR", isEmpty: false, hasProfile: false, hasInKindIncomeUnclassified: false,
            totals: .init(
                totalTaxes: amount, totalFees: 0, totalTaxesAndFees: amount, totalRecordedTaxes: amount,
                totalRecordedFees: 0, totalManualTaxes: 0, totalManualFees: 0, totalManualCosts: 0,
                totalRealizedGain: 0, totalUnrealizedGain: 0, effectiveTaxRate: 0, totalPIT: 0,
                portfolioTaxesPlusPIT: amount),
            taxBreakdown: [], feeBreakdown: [], taxByAssetClass: [], investmentBreakdown: [], yearlyCostTrend: [],
            dividend: .init(
                totalDividendIncome: 0, grossDividendWht: 0, dividendWhtReclaim: 0, dividendWhtNetCost: 0,
                unknownDividendConventionCount: 0, dividendExemption: 859),
            estimates: .init(tobRecorded: 0, tobAutoEstimate: 0, tacrEstimate: 0, reyndersEstimate: 0, cgtEstimate: 0),
            taxTable: .init(
                securitiesAccountTaxRate: 0, capitalGainsTaxRate: 0, reyndersTaxRate: 0, dividendWHTRate: 0,
                securitiesAccountTaxThreshold: 1_000_000,
                badgePercent: .init(
                    securitiesAccountTaxRate: 0, capitalGainsTaxRate: 0, reyndersTaxRate: 0, dividendWHTRate: 0)),
            summaries: [.init(id: 7, name: "Synthetic ETF", symbol: nil, assetClass: "etf", currency: "EUR")],
            records: [
                .init(
                    key: PortfolioTaxSettingsDraft.adjustmentsKey, value: stored,
                    expected: .object(["exists": .bool(true), "value": raw])),
                .init(
                    key: PortfolioTaxSettingsDraft.classificationsKey, value: .null,
                    expected: .object(["exists": .bool(false)])),
            ])
    }
}

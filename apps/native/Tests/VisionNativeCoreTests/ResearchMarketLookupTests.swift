import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native Market Lookup scopes, mappings, and writes")
struct ResearchMarketLookupTests {
    @Test func routeKeepsRawHoldingIdentifierAndUnrelatedQueryWhileSelectingRangesAndSymbols() {
        let state = ResearchMarketLookupState(
            route: .init(
                path: "/research/market",
                query: [
                    .init(name: "symbol", value: " synth "), .init(name: "investmentId", value: "02"),
                    .init(name: "range", value: "bogus"), .init(name: "tab", value: "bogus"),
                    .init(name: "future", value: "keep"),
                ]))
        #expect(state.symbol == "SYNTH")
        #expect(state.mappingInvestmentId == 2)
        #expect(state.rawInvestmentId == "02")
        #expect(state.range.range == "1mo")
        #expect(state.tab == "fundamentals")
        #expect(state.selectingTab("fundamentals").value("tab") == "fundamentals")
        #expect(state.selectingTab("fundamentals").value("future") == "keep")
        #expect(state.selecting("OTHER").value("future") == "keep")
        #expect(state.selecting("OTHER").value("investmentId") == nil)
        #expect(state.selectingRange("1mo").value("range") == nil)
        #expect(ResearchMarketLookupState.historyDays("3mo") == 91)
        #expect(ResearchMarketLookupState.historyDays("max") == 0)
    }
    @Test func deferredProviderResolutionAvoidsYahooAndCopiesExactNativeHistoryToBackendBridge() async throws {
        let transport = LookupTransport()
        await transport.pause("/api/info/portfolio-summary")
        let model = ResearchMarketLookupModel(
            service: lookupClient(transport), now: { Date(timeIntervalSince1970: 1_800_000_000) })
        let load = Task {
            await model.load(route: NativeRoute("/research/market?symbol=SYNTH&investmentId=2&range=3mo")!)
        }
        await transport.waitForPause()
        #expect(model.isResolvingProvider)
        #expect(!(await transport.requests).contains { $0.url.path.hasPrefix("/api/market") })
        await transport.release()
        await load.value
        #expect(model.isProviderAsset)
        #expect(model.quote?.currency == "EUR")
        #expect(model.chart?.currency == "EUR")
        #expect(model.chart?.points.first?.close == Decimal(string: "123.456789012345678901"))
        let body = try #require(await transport.presentations.first)
        #expect(body["kind"] == .string("providerQuote"))
        #expect(body["investment"]?["priceProvider"] == .string("manual"))
        #expect(body["points"]?.arrayValue?.first?["close"] == .number(Decimal(string: "123.456789012345678901")!))
        #expect(!(await transport.requests).contains { $0.url.path.hasPrefix("/api/research/scorecard") })
        model.didDisappear()
    }
    @Test func currencyChangeRetiresLateProviderBridge() async throws {
        let transport = LookupTransport()
        await transport.pause("research-presentation")
        let model = ResearchMarketLookupModel(service: lookupClient(transport))
        let route = NativeRoute("/research/market?symbol=SYNTH&investmentId=2")!
        let first = Task { await model.load(route: route) }
        await transport.waitForPause()
        model.configure(settings: .init(defaultCurrency: "USD"))
        await model.load(route: route)
        #expect(model.quote?.currency == "USD")
        await transport.release()
        await first.value
        #expect(model.quote?.currency == "USD")
        #expect(model.chart?.currency == "USD")
        model.didDisappear()
    }
    @Test func mappingSameContextReopensButNewInstrumentRequiresFreshConfirmationAndIgnoresLateProposal() async throws {
        let transport = LookupTransport()
        let mapping = ResearchMarketMappingModel(service: lookupClient(transport))
        mapping.configure(instrumentKey: "FIRST", displayName: "First", investmentId: nil)
        await mapping.begin()
        #expect(mapping.selectedCount == 1)
        mapping.selected["yahoo"] = false
        mapping.close()
        await mapping.begin()
        #expect(mapping.selectedCount == 0)
        await transport.pause("/api/research/mappings/resolve")
        let old = Task { await mapping.resolve() }
        await transport.waitForPause()
        mapping.configure(instrumentKey: "SECOND", displayName: "Second", investmentId: nil)
        #expect(mapping.proposals.isEmpty)
        #expect(mapping.selected.isEmpty)
        #expect(mapping.audit == nil)
        await transport.release()
        await old.value
        #expect(mapping.proposals.isEmpty)
        await mapping.begin()
        await mapping.save()
        let saved = try #require(await transport.mappingWrites.last)
        #expect(saved["instrument_key"] == .string("SECOND"))
        #expect(saved["mappings"]?.arrayValue?.first?["resolvedName"] == .null)
        #expect(saved["mappings"]?.arrayValue?.first?["currency"] == nil)
    }
    @Test func actionDismissKeepsBothDraftsPollingKeepsNativePriceAndSymbolChangeResets() async throws {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        let quote = try lookupQuote("SYNTH", price: 10)
        let holding = try lookupHolding(currency: "EUR").decode(PortfolioHolding.self)
        action.configure(quote: quote, holding: holding, numberFormat: .us)
        await action.begin(notes: "Initial")
        action.investment.name = "Edited"
        action.trade.amount = "123"
        action.step = "transaction"
        action.close()
        action.configure(quote: try lookupQuote("SYNTH", price: 20), holding: holding, numberFormat: .us)
        await action.begin(notes: "Fresh")
        #expect(action.investment.name == "Edited")
        #expect(action.trade.amount == "123")
        #expect(action.trade.price == "10")
        #expect(action.step == "transaction")
        #expect(action.isDirty)
        action.configure(quote: try lookupQuote("OTHER", price: 30), holding: nil, numberFormat: .us)
        #expect(!action.isDirty)
        #expect(action.step == "choose")
        #expect(!action.isPresented)
    }
    @Test func recordBusyGatePreventsDuplicatePostAndPreservesSummaryCurrencyAndExplicitUnassignedBroker() async throws
    {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        action.configure(
            quote: try lookupQuote("SYNTH", price: 10),
            holding: try lookupHolding(currency: "EUR").decode(PortfolioHolding.self), numberFormat: .us)
        action.brokerContext = { _ in .init(accounts: [], preferredBrokerId: 42) }
        await action.begin(notes: "Initial")
        action.step = "transaction"
        action.trade.amount = "20"
        action.trade.units = "2"
        action.trade.broker = .unassigned
        #expect(action.effectiveBrokerId == nil)
        await transport.pause("research-presentation")
        let first = Task { await action.recordTransaction() }
        await transport.waitForPause()
        #expect(action.isSubmitting)
        await action.recordTransaction()
        await transport.release()
        await first.value
        let writes = await transport.tradeWrites
        #expect(writes.count == 1)
        #expect(writes.first?["currency"] == .string("EUR"))
        #expect(writes.first?["account_id"] == nil)
        #expect(writes.first?["price_per_unit"] == .number(10))
        #expect(!action.isSubmitting)
        #expect(!action.isDirty)
        #expect(action.notice?.key == "addPortTxn.toast.recorded")
    }
    @Test func lostCreateAcknowledgementCannotReplayAndBusyCleanupSurvivesSymbolChange() async throws {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        action.configure(quote: try lookupQuote("SYNTH", price: 10), holding: nil, numberFormat: .us)
        await action.begin(notes: "Initial")
        await transport.failCreate()
        await transport.pause("/api/investments")
        let first = Task { await action.createInvestment() }
        await transport.waitForPause()
        action.configure(quote: try lookupQuote("OTHER", price: 11), holding: nil, numberFormat: .us)
        await transport.release()
        await first.value
        #expect(!action.isSubmitting)
        #expect(action.hasUncertainWrite)
        await action.begin(notes: "Next")
        await action.createInvestment()
        #expect(await transport.investmentWrites.count == 1)
    }
    @Test func yahooPriceChartAndBothDirtyFormsSurviveDefaultCurrencyChange() async throws {
        let transport = LookupTransport()
        let model = ResearchMarketLookupModel(service: lookupClient(transport))
        let route = NativeRoute("/research/market?symbol=SYNTH")!
        model.configure(settings: .init(numberFormat: .us))
        await model.load(route: route)
        let initialChart = model.chart
        #expect(model.quote?.currency == "USD")
        await model.action.begin(notes: "Initial")
        model.action.investment.name = "Keep investment draft"
        model.action.trade.units = "2"
        model.action.step = "transaction"
        model.configure(settings: .init(defaultCurrency: "USD", numberFormat: .us))
        #expect(model.quote?.price == 10)
        #expect(model.chart == initialChart)
        #expect(model.action.investment.name == "Keep investment draft")
        #expect(model.action.trade.units == "2")
        #expect(model.action.trade.price == "10")
        await model.load(route: route)
        #expect(model.action.holding?.currency == CurrencyCode(rawValue: "USD"))
        #expect(model.action.step == "transaction")
        #expect(model.action.isDirty)
        #expect((await transport.requests).filter { $0.url.path == "/api/market/quote" }.count == 1)
        model.didDisappear()
    }
    @Test func bookingCurrencyChangeRetiresAwaitedTradeValidationWithoutDiscardingDraft() async throws {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        let quote = try lookupQuote("SYNTH", price: 10)
        action.configure(
            quote: quote, holding: try lookupHolding(currency: "EUR").decode(PortfolioHolding.self), numberFormat: .us)
        await action.begin(notes: "Initial")
        action.step = "transaction"
        action.trade.units = "2"
        action.trade.amount = "20"
        action.investment.name = "Keep both drafts"
        await transport.pause("research-presentation")
        let stale = Task { await action.recordTransaction() }
        await transport.waitForPause()
        action.configure(
            quote: quote, holding: try lookupHolding(currency: "USD").decode(PortfolioHolding.self), numberFormat: .us)
        await transport.release()
        await stale.value
        #expect(await transport.tradeWrites.isEmpty)
        #expect(action.trade.amount == "20")
        #expect(action.investment.name == "Keep both drafts")
        #expect(action.isDirty)
        await action.recordTransaction()
        #expect(await transport.tradeWrites.count == 1)
        #expect(await transport.tradeWrites.first?["currency"] == .string("USD"))
    }
    @Test func lateSuccessfulWriteAfterUnmountDoesNotResetFreshSameSymbolDraft() async throws {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        let quote = try lookupQuote("SYNTH", price: 10)
        action.configure(quote: quote, holding: nil, numberFormat: .us)
        await action.begin(notes: "First visit")
        await transport.pause("/api/investments")
        let write = Task { await action.createInvestment() }
        await transport.waitForPause()
        action.discardDrafts()
        action.investment.name = "Fresh same-symbol draft"
        await transport.release()
        await write.value
        #expect(!action.isSubmitting)
        #expect(action.investment.name == "Fresh same-symbol draft")
        #expect(action.isDirty)
    }
    @Test func malformedOptionalFeesAndEmptyDateBlockWritesButInvalidNewPriceIsOmitted() async throws {
        let transport = LookupTransport()
        let action = ResearchMarketActionModel(service: lookupClient(transport))
        action.configure(
            quote: try lookupQuote("SYNTH", price: 10),
            holding: try lookupHolding(currency: "EUR").decode(PortfolioHolding.self), numberFormat: .us)
        await action.begin(notes: "Initial")
        action.trade.date = ""
        await action.recordTransaction()
        #expect(action.errorKey == "addPortTxn.error.dateRequired")
        action.trade.date = "2026-01-01"
        action.trade.type = "fee"
        action.trade.amount = "5"
        action.trade.fees = "garbage"
        await action.recordTransaction()
        #expect(action.errorKey == "addPortTxn.error.invalidNumber")
        #expect(await transport.tradeWrites.isEmpty)
        action.step = "new"
        action.investment.currentPrice = "garbage"
        await action.createInvestment()
        #expect(await transport.investmentWrites.last?["current_price"] == nil)
    }
}

private func lookupClient(_ transport: LookupTransport) -> PresentationStubService {
    PresentationStubService(
        base: .init(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0),
        presentation: { try await transport.presentation($0) })
}
private func lookupQuote(_ symbol: String, price: Decimal) throws -> ResearchQuote {
    try .init(
        raw: .object([
            "symbol": .string(symbol), "name": .string(symbol + " name"), "type": .string("EQUITY"),
            "currency": .string("USD"), "price": .number(price),
        ]))
}
private func lookupHolding(currency: String) -> TaxValue {
    var raw: TaxValue = .object([
        "id": .number(2), "name": .string("Synthetic"), "symbol": .string("SYNTH"), "assetClass": .string("stock"),
        "is_active": .bool(true), "currency": .string(currency), "originalCurrency": .string("USD"),
        "created_at": .string("2026-01-01"), "updated_at": .string("2026-01-01"), "price_provider": .string("manual"),
        "fullyAssigned": .bool(true), "oversold": .bool(false), "byAccount": .array([]),
    ])
    for key in [
        "totalUnits", "currentPrice", "interestRate", "totalInvested", "totalBuyCost", "totalSellProceeds",
        "currentValue", "totalFees", "totalTaxes", "totalDividends", "totalIncome", "avgCostBasis", "realizedGain",
        "unrealizedGain", "totalGain", "gainLoss", "gainLossPercent", "accruedInterest", "projectedAnnualInterest",
        "totalAppreciation",
    ] { raw[key] = .number(0) }
    return raw
}
private actor LookupTransport: APITransport {
    var requests: [APIRequest] = [], presentations: [TaxValue] = [], mappingWrites: [TaxValue] = [],
        tradeWrites: [TaxValue] = [], investmentWrites: [TaxValue] = []
    private var pausePath: String?, gate: CheckedContinuation<Void, Never>?, waiter: CheckedContinuation<Void, Never>?
    private var began = false, createFails = false
    func failCreate() { createFails = true }
    func pause(_ path: String) {
        pausePath = path
        began = false
    }
    func waitForPause() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    private func pauseIfRequested(_ path: String) async {
        if pausePath == path {
            pausePath = nil
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
    }
    /// The research presentation runs in the app: the transport only scripts, records and pauses it.
    func presentation(_ input: TaxValue) async throws -> TaxValue {
        presentations.append(input)
        await pauseIfRequested("research-presentation")
        if input["kind"] == .string("providerQuote") {
            return .object([
                "kind": .string("providerQuote"),
                "result": .object([
                    "symbol": .string("SYNTH"), "currency": input["investment"]?["currency"] ?? .string("EUR"),
                    "price": .number(123), "change": .number(0),
                ]),
            ])
        }
        return .object([
            "kind": .string("marketAdd"),
            "result": .object([
                "providedCount": .number(3), "isConsistent": .bool(true), "effectiveAmount": .number(20),
                "effectiveUnits": .number(2), "effectivePrice": .number(10),
            ]),
        ])
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let path = request.url.path
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        var input: TaxValue = .null
        if let body = request.body {
            if let text = String(data: body, encoding: .utf8), text.hasPrefix("--"),
                let start = text.range(of: "\r\n\r\n"),
                let end = text.range(of: "\r\n--", range: start.upperBound..<text.endIndex)
            {
                input = try JSONDecoder().decode(
                    TaxValue.self, from: Data(text[start.upperBound..<end.lowerBound].utf8))
            } else {
                input = try JSONDecoder().decode(TaxValue.self, from: body)
            }
        }
        if path == "/api/investments", request.method == .post { investmentWrites.append(input) }
        if path.contains("/transactions"), request.method == .post { tradeWrites.append(input) }
        if path == "/api/research/mappings", request.method == .post { mappingWrites.append(input) }
        await pauseIfRequested(path)
        if path == "/api/investments", request.method == .post, createFails {
            throw APIError.network("Lost acknowledgement")
        }
        let payload: TaxValue
        switch path {
        case "/api/market/quote":
            payload = .object([
                "items": .array([try TaxValue(encoding: lookupQuote("SYNTH", price: 10))]), "total": .number(1),
            ])
        case "/api/market/chart":
            payload = .object([
                "symbol": .string("SYNTH"), "currency": .string("USD"),
                "points": .array([.object(["time": .number(1_700_000_000_000), "close": .number(10)])]),
            ])
        case "/api/research/scorecard": payload = .null
        case "/api/info/portfolio-summary":
            let currency = query.first { $0.name == "currency" }?.value ?? "EUR"
            var totals: TaxValue = .object(["usedFallbackRate": .bool(false)])
            for key in [
                "totalPortfolioValue", "totalInvested", "totalGainLoss", "totalRealizedGain", "totalUnrealizedGain",
                "totalGain", "totalIncome", "totalFees", "totalTaxes", "totalAssetGain", "totalFxGain",
                "totalReturnPct",
            ] { totals[key] = .number(0) }
            payload = .object([
                "currency": .string(currency), "computed_at": .string("2026-01-01"), "totals": totals,
                "summaries": .array([lookupHolding(currency: currency)]), "byAccount": .array([]),
            ])
        case "/api/investments/2/price-history":
            payload = .object([
                "investment_id": .number(2), "provider": .string("manual"),
                "points": .array([
                    .object([
                        "timestampMs": .number(1_700_000_000_000),
                        "price": .number(Decimal(string: "123.456789012345678901")!),
                    ])
                ]),
            ])
        case "/api/research/mappings/resolve":
            payload = .object([
                "instrument_key": input["instrument_key"]!, "key_type": .string("internal"),
                "proposals": .array([
                    .object([
                        "provider": .string("yahoo"), "providerSymbol": .string("SYNTH"), "status": .string("auto"),
                        "resolvedName": .null,
                    ])
                ]), "existing": .array([]),
            ])
        case "/api/research/mappings": payload = .object(["items": .array([]), "total": .number(0)])
        case "/api/investments":
            payload = .object([
                "id": .number(2), "name": .string("Synthetic"), "asset_class": .string("stock"),
                "currency": .string("EUR"), "is_active": .bool(true), "price_provider": .string("yahoo"),
                "created_at": .string("2026-01-01"), "updated_at": .string("2026-01-01"),
            ])
        case "/api/investments/2/transactions":
            payload = .object([
                "id": .number(5), "investment_id": .number(2), "type": .string("buy"), "date": .string("2026-01-01"),
                "amount": .number(20), "currency": .string("EUR"), "is_recurring": .bool(false),
                "dividend_amount_convention": .string("unknown"), "created_at": .string("2026-01-01"),
                "updated_at": .string("2026-01-01"),
            ])
        default: throw APIError.invalidRequest("Unexpected lookup fixture endpoint " + path)
        }
        return .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": payload])))
    }
}

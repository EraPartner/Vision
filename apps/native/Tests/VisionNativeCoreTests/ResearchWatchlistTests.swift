import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Research Watchlist request scopes and drafts")
@MainActor struct ResearchWatchlistTests {
    @Test func preservesAPIOrderAndConsumesAuthoritativeMetricsWithoutCurrencyConversion() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        #expect(model.page?.items.map(\.id) == [2, 1])
        #expect(model.page?.items.first?.currency == "EUR")
        #expect(model.quotes["BBB"]?.currency == "USD")
        #expect(model.metrics[2]?.distancePercent == 77)
        #expect(model.metrics[2]?.sinceAddedPercent == Decimal(string: "0.1234567890123456789"))
        #expect(model.page?.items.first?.raw["future"] == .string("retained"))
        let requests = await transport.requests
        #expect(requests.first?.url.query == nil)
        #expect(await transport.presentationCalls == 1)
        let quote = try #require(requests.first { $0.url.path == "/api/market/quote" })
        #expect(
            URLComponents(url: quote.url, resolvingAgainstBaseURL: false)?.queryItems?.contains(
                .init(name: "symbols", value: "BBB,AAA")) == true)
    }

    @Test func validLocaleTargetPatchRetainsSnapshotAndRefreshesOpenChart() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        await model.openChart(id: 1)
        model.beginTargetEdit(numberFormat: .eu)
        model.targetDraft = "200,125"
        #expect(await model.saveTarget(numberFormat: .eu))
        #expect(model.selectedItemID == 1 && model.selectedItem?.targetPrice == Decimal(string: "200.125"))
        #expect(!model.isEditingTarget && model.selectedItem?.addedPrice == 80)
        let body = try #require(await transport.patchBody)
        #expect(body.objectValue?.count == 1 && body["target_price"] == .number(Decimal(string: "200.125")!))
        #expect(model.chartMetrics?.distancePercent == 77)
    }

    @Test func invalidTargetsNeverWriteAndCancelDoesNotWrite() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        await model.openChart(id: 1)
        for raw in ["0", "-1", "1e999", "999999999999,01", "letters"] {
            model.beginTargetEdit(numberFormat: .eu)
            model.targetDraft = raw
            #expect(await model.saveTarget(numberFormat: .eu) == false)
            #expect(model.targetValidationFailed)
        }
        model.cancelTargetEdit()
        #expect(await transport.requests.filter { $0.method == .patch }.isEmpty)
    }

    @Test func failedQuoteRefreshRetainsCacheAndOfflinePollDoesNothing() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        let before = model.quotes
        let metrics = model.metrics
        await transport.failQuotes(true)
        await model.poll()
        #expect(model.quotesError != nil && model.quotes == before && model.metrics == metrics)
        let count = await transport.requests.count
        model.isOnline = false
        await model.poll()
        #expect(await transport.requests.count == count && model.quotesUnavailable)
    }

    @Test func failedListIsNotEmptyAndRetryKeepsCachedRows() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await transport.failList(true)
        await model.load()
        #expect(model.error != nil && model.page == nil)
        await transport.failList(false)
        await model.load(force: true)
        #expect(model.error == nil && model.page?.total == 2)
        await transport.failList(true)
        await model.load(force: true)
        #expect(model.error != nil && model.page?.items.count == 2)
    }

    @Test func prefillSeedsTargetButSnapshotUsesSelectedSymbolsActualQuote() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistAddModel(service: client(transport))
        model.begin(
            prefill: .init(symbol: "AAA", name: "Alpha", type: "ETF", currency: "GBP", price: 99), numberFormat: .eu)
        await eventually { !model.isQuoteLoading }
        #expect(model.draft.targetPrice == "99" && model.draft.assetClass == "etf")
        model.update {
            $0.targetPrice = "85,5"
            $0.notes = "thesis"
        }
        #expect(await model.submit())
        let body = try #require(await transport.createBody)
        #expect(body["added_price"] == .number(150) && body["target_price"] == .number(Decimal(string: "85.5")!))
        #expect(body["currency"] == .string("GBP") && body["price_provider_id"] == .string("AAA"))
        #expect(!model.isPresented && model.draft.targetPrice.isEmpty && model.draft.notes.isEmpty)
        #expect(model.draft.currency == "GBP" && model.draft.assetClass == "etf")
    }

    @Test func changeRetainsFieldsButOldSymbolsLateQuoteCannotSnapshot() async throws {
        let transport = WatchlistTransport()
        let gate = WatchlistGate()
        await transport.setQuoteGate(gate)
        let model = ResearchWatchlistAddModel(service: client(transport))
        model.begin(
            prefill: .init(symbol: "AAA", name: "Alpha", type: "ETF", currency: "EUR", price: 85), numberFormat: .eu)
        await gate.started()
        model.update { $0.notes = "keep" }
        model.changeAsset()
        #expect(model.draft.targetPrice == "85" && model.draft.notes == "keep" && model.draft.currency == "EUR")
        let next = try ResearchSearchItem(
            raw: .object([
                "symbol": .string("BBB"), "name": .string("Beta"), "type": .string("crypto"), "exchange": .string("X"),
            ]))
        model.select(next)
        await eventually { !model.isQuoteLoading }
        await gate.release()
        await Task.yield()
        #expect(model.quote?.symbol == "BBB" && model.draft.assetClass == "crypto")
        #expect(await model.submit())
        #expect(await transport.createBody?["added_price"] == .number(125))
    }

    @Test func unacknowledgedCreateReadsBackAndNeverAutomaticallyRepeatsPOST() async throws {
        let transport = WatchlistTransport()
        await transport.loseCreateAcknowledgement()
        let model = ResearchWatchlistAddModel(
            service: APIClient(
                baseURL: { URL(string: "http://fixture.test") }, transport: transport, maxRetries: 3))
        var callbacks = 0
        model.didMutate = { callbacks += 1 }
        model.begin(prefill: .init(symbol: "AAA", name: "Alpha", price: 100), numberFormat: .us)
        await eventually { !model.isQuoteLoading }
        #expect(await model.submit() == false)
        #expect(model.hasUncertainCreate && model.isPresented && model.draft.targetPrice == "100" && callbacks == 1)
        #expect(await model.submit() == false)
        let requests = await transport.requests
        #expect(requests.filter { $0.method == .post && $0.url.path == "/api/watchlist" }.count == 1)
        #expect(requests.contains { $0.method == .get && $0.url.path == "/api/watchlist" })
    }

    @Test func missingQuoteDoesNotInventAddedSnapshotAndInvalidAddNeverWrites() async throws {
        let transport = WatchlistTransport()
        await transport.failQuotes(true)
        let model = ResearchWatchlistAddModel(service: client(transport))
        model.begin(prefill: .init(symbol: "AAA", name: "Alpha", price: 999), numberFormat: .eu)
        await eventually { !model.isQuoteLoading }
        for raw in ["0", "1e999", "999999999999,01"] {
            model.update { $0.targetPrice = raw }
            #expect(await model.submit() == false && model.validationFailed)
        }
        #expect(await transport.createBody == nil)
        model.update { $0.targetPrice = "85" }
        #expect(await model.submit())
        #expect(await transport.createBody?["added_price"] == nil)
    }

    @Test func presentationRejectsMissingNullableFieldsAndNumericStrings() throws {
        let raw: TaxValue = .object([
            "distancePercent": .null, "absoluteDistancePercent": .null,
            "isAtOrBelowTarget": .bool(false), "sinceAddedPercent": .null,
        ])
        #expect(try raw.decode(ResearchWatchlistMetrics.self).distancePercent == nil)
        var missing = raw
        missing["sinceAddedPercent"] = nil
        #expect(throws: (any Error).self) { try missing.decode(ResearchWatchlistMetrics.self) }
        var string = raw
        string["distancePercent"] = .string("0.1234567890123456789")
        #expect(throws: (any Error).self) { try string.decode(ResearchWatchlistMetrics.self) }
    }

    @Test func lateSearchDoesNotReopenResultsAfterChoosingAnAsset() async throws {
        let transport = WatchlistTransport()
        let gate = WatchlistGate()
        await transport.setSearchGate(gate)
        let model = ResearchWatchlistAddModel(service: client(transport))
        model.begin(numberFormat: .eu)
        model.updateSearch("AA")
        await gate.started()
        model.select(try ResearchSearchItem(raw: .object(["symbol": .string("BBB"), "name": .string("Beta")])))
        await gate.release()
        await eventually { !model.isQuoteLoading }
        #expect(
            model.selected?.symbol == "BBB" && model.query.isEmpty && model.searchResults.isEmpty && !model.isSearching)
    }

    @Test func oldChartRangeAndSelectionCannotReplaceNewRange() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        let gate = WatchlistGate()
        await transport.setChartGate(gate)
        let old = Task { await model.openChart(id: 1) }
        await gate.started()
        await model.selectRange(.year)
        #expect(model.chart?.raw["range"] == .string("1y"))
        await gate.release()
        await old.value
        #expect(model.range == .year && model.chart?.raw["range"] == .string("1y") && !model.isChartLoading)
        await model.openChart(id: 2)
        #expect(model.range == .month && model.selectedItemID == 2 && !model.isEditingTarget)
    }

    @Test func readStartedDuringWriteCannotReplacePostCommitAuthority() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        await model.openChart(id: 1)
        model.beginTargetEdit(numberFormat: .us)
        model.targetDraft = "200"
        let writeGate = WatchlistGate()
        await transport.setWriteGate(writeGate)
        let write = Task { await model.saveTarget(numberFormat: .us) }
        await writeGate.started()
        let readGate = WatchlistGate()
        await transport.setListGate(readGate)
        let oldRead = Task { await model.load(force: true) }
        await readGate.started()
        await writeGate.release()
        #expect(await write.value)
        #expect(model.selectedItem?.targetPrice == 200)
        await readGate.release()
        await oldRead.value
        #expect(model.selectedItem?.targetPrice == 200 && !model.isLoading)
    }

    @Test func leavingDuringTargetWriteStillReadsAuthorityWithoutRestartingHiddenQuotes() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        var callbacks = 0
        model.didMutate = { callbacks += 1 }
        await model.load()
        await model.openChart(id: 1)
        model.beginTargetEdit(numberFormat: .us)
        model.targetDraft = "200"
        let gate = WatchlistGate()
        await transport.setWriteGate(gate)
        let pending = Task { await model.saveTarget(numberFormat: .us) }
        await gate.started()
        let providerCount = await transport.requests.filter { $0.url.path.hasPrefix("/api/market/") }.count
        let listCount = await transport.requests.filter { $0.method == .get && $0.url.path == "/api/watchlist" }.count
        model.didDisappear()
        await gate.release()
        #expect(await pending.value && callbacks == 1)
        #expect(model.selectedItemID == nil && !model.isEditingTarget && model.targetDraft.isEmpty)
        #expect(await transport.requests.filter { $0.url.path.hasPrefix("/api/market/") }.count == providerCount)
        #expect(
            await transport.requests.filter { $0.method == .get && $0.url.path == "/api/watchlist" }.count == listCount
                + 1)
        await model.load()
        #expect(model.page?.items.first { $0.id == 1 }?.targetPrice == 200)
    }

    @Test func targetWriteAndListRetryReuseSameSymbolQuotesWhilePollAndNewScopeFetch() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        await model.openChart(id: 1)
        let before = await transport.requests.filter { $0.url.path == "/api/market/quote" }.count
        model.beginTargetEdit(numberFormat: .us)
        model.targetDraft = "200"
        #expect(await model.saveTarget(numberFormat: .us))
        #expect(model.metrics[1]?.distancePercent == -25 && model.chartMetrics?.distancePercent == -25)
        await model.load(force: true)
        #expect(await transport.requests.filter { $0.url.path == "/api/market/quote" }.count == before)
        await model.poll()
        #expect(await transport.requests.filter { $0.url.path == "/api/market/quote" }.count == before + 1)
        await transport.replaceItems([watchlistItem(3, "CCC", target: 60)])
        await model.load(force: true)
        #expect(await transport.requests.filter { $0.url.path == "/api/market/quote" }.count == before + 2)
        #expect(model.quotes["CCC"] != nil && model.quotes["AAA"] == nil)
    }

    @Test func newerFullReadRejectsPriorQuotesFromDifferentSymbolScope() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await model.load()
        let gate = WatchlistGate()
        await transport.setQuoteGate(gate)
        let old = Task { await model.poll() }
        await gate.started()
        await transport.replaceItems([watchlistItem(3, "CCC", target: 60)])
        await model.load(force: true)
        await gate.release()
        await old.value
        #expect(model.page?.items.map(\.id) == [3] && model.quotes["CCC"] != nil && model.quotes["AAA"] == nil)
        #expect(Set(model.metrics.keys) == [3])
    }

    @Test func restartedVisitDuringAReadStillShowsTheList() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        let gate = WatchlistGate()
        await transport.setListGate(gate)
        let first = Task { await model.load() }
        await gate.started()
        first.cancel()
        await model.load()
        await gate.release()
        await first.value
        #expect(model.page?.items.map(\.id) == [2, 1] && !model.isLoading && model.error == nil)
    }

    @Test func failedFirstQuoteFetchIsRetriedByTheNextLoadOfTheSameSymbols() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        await transport.failQuotes(true)
        await model.load()
        #expect(model.quotes.isEmpty && model.quotesError != nil)
        await transport.failQuotes(false)
        await model.load(force: true)
        #expect(model.quotes["BBB"]?.currency == "USD" && model.quotesError == nil)
    }

    @Test func deletingSelectedItemClosesChartAndCallsMutationCallback() async throws {
        let transport = WatchlistTransport()
        let model = ResearchWatchlistModel(service: client(transport))
        var count = 0
        model.didMutate = { count += 1 }
        await model.load()
        await model.openChart(id: 2)
        model.deletingItem = model.selectedItem
        #expect(await model.deleteConfirmed())
        #expect(model.selectedItemID == nil && model.page?.items.map(\.id) == [1] && count == 1)
    }

    private func client(_ transport: WatchlistTransport) -> PresentationStubService {
        PresentationStubService(
            base: APIClient(baseURL: { URL(string: "http://fixture.test") }, transport: transport, maxRetries: 0),
            presentation: { try await transport.presentation($0) })
    }
    private func eventually(_ predicate: () -> Bool) async {
        for _ in 0..<10_000 {
            if predicate() { return }
            await Task.yield()
        }
        #expect(predicate())
    }
}

private actor WatchlistGate {
    private var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }
    func started() async { while !entered { await Task.yield() } }
    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private func watchlistItem(_ id: Int, _ symbol: String, target: Decimal) -> TaxValue {
    .object([
        "id": .number(Decimal(id)), "name": .string(symbol == "AAA" ? "Alpha" : "Beta"), "symbol": .string(symbol),
        "asset_class": .string("stock"), "target_price": .number(target), "added_price": .number(80),
        "currency": .string("EUR"), "notes": .null, "price_provider_id": .string(symbol),
        "created_at": .string("2026-01-02T12:30:00Z"), "updated_at": .string("2026-01-02T12:30:00Z"),
        "future": .string("retained"),
    ])
}

private actor WatchlistTransport: APITransport {
    private(set) var requests: [APIRequest] = []
    private(set) var presentationCalls = 0
    private(set) var patchBody: TaxValue?
    private(set) var createBody: TaxValue?
    private var items = [watchlistItem(2, "BBB", target: 90), watchlistItem(1, "AAA", target: 100)]
    private var quotesFail = false, listFail = false, loseCreate = false
    private var quoteGate: WatchlistGate?, chartGate: WatchlistGate?, writeGate: WatchlistGate?,
        listGate: WatchlistGate?
    private var searchGate: WatchlistGate?
    func failQuotes(_ value: Bool) { quotesFail = value }
    func failList(_ value: Bool) { listFail = value }
    func loseCreateAcknowledgement() { loseCreate = true }
    func replaceItems(_ value: [TaxValue]) { items = value }
    func setQuoteGate(_ gate: WatchlistGate) { quoteGate = gate }
    func setChartGate(_ gate: WatchlistGate) { chartGate = gate }
    func setWriteGate(_ gate: WatchlistGate) { writeGate = gate }
    func setListGate(_ gate: WatchlistGate) { listGate = gate }
    func setSearchGate(_ gate: WatchlistGate) { searchGate = gate }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ name: String) -> String { query.first { $0.name == name }?.value ?? "" }
        let path = request.url.path
        if path == "/api/market/search" {
            if let gate = searchGate {
                searchGate = nil
                await gate.wait()
            }
            return try response(
                .object([
                    "items": .array([
                        .object([
                            "symbol": .string("AAA"), "name": .string("Alpha"),
                            "type": .string("stock"), "exchange": .string("X"),
                        ])
                    ])
                ]))
        }
        if path == "/api/watchlist", request.method == .get {
            if listFail { throw APIError.network("list failed") }
            let snapshot = items
            if let gate = listGate {
                listGate = nil
                await gate.wait()
            }
            return try response(
                .object([
                    "items": .array(snapshot), "total": .number(Decimal(snapshot.count)), "limit": .number(50),
                    "offset": .number(0),
                ]))
        }
        if path == "/api/market/quote" {
            if quotesFail { throw APIError.network("quotes failed") }
            let symbols = q("symbols").split(separator: ",").map(String.init)
            let snapshot: [TaxValue] = symbols.map {
                .object(["symbol": .string($0), "currency": .string("USD"), "price": .number($0 == "AAA" ? 150 : 125)])
            }
            if let gate = quoteGate {
                quoteGate = nil
                await gate.wait()
            }
            return try response(.object(["items": .array(snapshot), "total": .number(Decimal(snapshot.count))]))
        }
        if path == "/api/market/chart" {
            let range = q("range")
            if let gate = chartGate {
                chartGate = nil
                await gate.wait()
            }
            return try response(
                .object([
                    "symbol": .string(q("symbol")), "currency": .string("USD"), "range": .string(range),
                    "items": .array([.object(["time": .number(1_700_000_000_000), "close": .number(140)])]),
                    "total": .number(1),
                ]))
        }
        if path == "/api/watchlist", request.method == .post {
            createBody = try requestBody(request)
            var item = watchlistItem(3, "NEW", target: createBody?["target_price"]?.decimalValue ?? 100)
            for (key, value) in createBody?.objectValue ?? [:] { item[key] = value }
            items.insert(item, at: 0)
            if loseCreate { throw APIError.network("connection lost after commit") }
            return try response(item, status: 201)
        }
        if path.hasPrefix("/api/watchlist/"), request.method == .patch {
            let id = Int(path.split(separator: "/").last ?? "") ?? 0
            let body = try requestBody(request)
            patchBody = body
            if let gate = writeGate {
                writeGate = nil
                await gate.wait()
            }
            let index = try #require(items.firstIndex { $0["id"]?.decimalValue == Decimal(id) })
            items[index]["target_price"] = body["target_price"]
            return try response(items[index])
        }
        if path.hasPrefix("/api/watchlist/"), request.method == .delete {
            let id = Int(path.split(separator: "/").last ?? "") ?? 0
            items.removeAll { $0["id"]?.decimalValue == Decimal(id) }
            return .init(status: 204, body: Data())
        }
        throw APIError.invalidRequest("unexpected fixture path " + path)
    }
    /// The research presentation runs in the app: the transport only scripts and counts it.
    func presentation(_ body: TaxValue) async throws -> TaxValue {
        presentationCalls += 1
        func list(_ target: Decimal?) -> TaxValue {
            .object([
                "distancePercent": .number(target == 100 ? 50 : target == 200 ? -25 : 77),
                "absoluteDistancePercent": .number(target == 200 ? 25 : 77),
                "isAtOrBelowTarget": .bool(target == 200),
                "sinceAddedPercent": .number(Decimal(string: "0.1234567890123456789")!),
            ])
        }
        if body["kind"] == .string("watchlistBatch") {
            let values = (body["entries"]?.arrayValue ?? []).map {
                .object(["id": $0["id"]!, "list": list($0["targetPrice"]?.decimalValue)]) as TaxValue
            }
            return .object(["kind": .string("watchlistBatch"), "result": .object(["entries": .array(values)])])
        }
        let target = body["targetPrice"]?.decimalValue
        var chart = list(target)
        chart["sinceAddedPercent"] = nil
        chart["hasValidTarget"] = .bool(true)
        chart["domain"] = .array([.number(10), .number(400)])
        return .object([
            "kind": .string("watchlist"),
            "result": .object([
                "list": list(target), "chart": chart,
                "preview": .object(["absolutePercent": .number(12), "direction": .string("below")]),
            ]),
        ])
    }
    private func response(_ value: TaxValue, status: Int = 200) throws -> APIResponse {
        .init(
            status: status,
            body: try APIBody.encode(
                TaxValue.object(["ok": .bool(true), "data": value, "meta": .object(["requestId": .string("fixture")])]))
        )
    }
    private func requestBody(_ request: APIRequest) throws -> TaxValue {
        try JSONDecoder().decode(TaxValue.self, from: request.body ?? Data())
    }
}

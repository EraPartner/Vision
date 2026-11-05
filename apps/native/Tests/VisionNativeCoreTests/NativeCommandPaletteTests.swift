import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native palette source query helpers")
struct NativeCommandPaletteQueryTests {
    // Exact cmdk 1.1.1 commandScore outputs, generated from the installed source
    // used by CommandPalette.tsx, including transpositions and UTF-16 boundaries.
    @Test(arguments: [
        ("Transactions /transactions", "tr", 0.989901),
        ("Transactions /transactions", "tx", 0),
        ("Transactions /transactions", "transaction", 0.989901),
        ("Market lookup /research/market", "market", 0.989901),
        ("Market lookup /research/market", "mklt", 0.02541576286526639),
        ("Net worth /portfolio/net-worth", "nw", 0.8909109000000001),
        ("Chart builder /research/charts", "chart", 0.989901),
        ("Chart builder /research/charts", "chatr", 0.13449190946400003),
        ("Payees /recipients", "payeess", 0.16812250807382095),
        ("aab", "aa", 0.99), ("abc", "ac", 0.16983), ("ab", "ba", 0.1),
        ("Alpha beta gamma", "abg", 0.80181981),
        ("Alpha/beta.gamma", "abg", 0.6335366400000001),
        ("Échanges /admin/exchange-rates", "éCH", 0.98970302969901),
        ("İstanbul", "i", 0.989901), ("a\u{85}b", "ab", 0.16983),
        ("a\u{FEFF}b", "ab", 0.9), ("x-a", "a", 0.9),
        ("", "", 1), ("abc", "", 0.99), ("abc", "z", 0), ("😀abc", "ab", 0.1683),
    ])
    func matchesInstalledCmdkScore(_ golden: (String, String, Double)) {
        #expect(abs(NativeCommandPaletteQueries.score(golden.0, query: golden.1) - golden.2) < 1e-14)
    }

    @Test func tickerRecognizesSourceCashtagsAndCaseSensitiveBareSymbols() {
        for (query, expected) in [
            ("$aapl", "AAPL"), ("BRK-B", "BRK-B"), ("ASML.AS", "ASML.AS"),
            ("BTC-USD", "BTC-USD"), ("Aa", "AA"), ("$A123456789", "A123456789"),
        ] { #expect(NativeCommandPaletteQueries.ticker(query) == expected) }
        for query in ["aapl", "A", "ABCDEF", "$123", "$A1234567890", " AAPL ", "$$A", "éA"] {
            #expect(NativeCommandPaletteQueries.ticker(query) == nil)
        }
    }

    @Test func trimmingMatchesJavaScriptBomAndNelBoundaries() {
        #expect(NativeCommandPaletteQueries.trim(" \u{FEFF}\t$AAPL\n\u{3000}") == "$AAPL")
        #expect(NativeCommandPaletteQueries.trim("\u{85}$AAPL\u{85}") == "\u{85}$AAPL\u{85}")
        #expect(NativeCommandPaletteQueries.trim("-AAPL-") == "-AAPL-")
        #expect(NativeCommandPaletteQueries.trim("\u{FEFF}").isEmpty)
    }

    @Test func recentsFilterUnknownTypesAndKeepSourceOrderBeforePushingFive() {
        #expect(NativeCommandPaletteQueries.recents(#"["/",3,null,"/tax",true,{"url":"/accounts"}]"#) == ["/", "/tax"])
        #expect(NativeCommandPaletteQueries.recents(#"{"url":"/"}"#).isEmpty)
        #expect(NativeCommandPaletteQueries.recents("broken").isEmpty)
        #expect(
            NativeCommandPaletteQueries.pushing("/tax", into: ["/", "/tax", "/a", "/b", "/c", "/d"]) == [
                "/tax", "/", "/a", "/b", "/c",
            ])
    }
}

private actor PaletteTestGate {
    private var released = false
    private var continuations: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        guard !released else { return }
        await withCheckedContinuation { continuations.append($0) }
    }
    func release() {
        released = true
        let pending = continuations
        continuations = []
        for continuation in pending { continuation.resume() }
    }
}

private final class PaletteTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}

private actor PaletteTestService: NativeCommandPaletteService, NativeCommandPaletteAnswers {
    private(set) var recipientQueries: [String] = []
    private(set) var quoteSymbols: [String] = []
    private(set) var answerQueries: [String] = []
    let slow = PaletteTestGate()
    var emptyQuotes = false
    func useEmptyQuotes() { emptyQuotes = true }
    func paletteRecipients(query: String) async throws -> [OpenAPI.Recipient] {
        recipientQueries.append(query)
        if query == "slow" { await slow.wait() }
        return [.init(id: query == "slow" ? 1 : 2, name: query, isActive: true, createdAt: "2026-10-13T00:00:00.000Z", links: [])]
    }
    func paletteQuote(symbol: String) async throws -> ResearchQuote? {
        quoteSymbols.append(symbol)
        if symbol == "SLOW" { await slow.wait() }
        if emptyQuotes { return nil }
        return try .init(raw: .object(["symbol": .string(symbol), "currency": .string("EUR"), "price": .number(12.5)]))
    }
    func paletteAnswer(query: String, numberFormat: NumberFormat, currency: CurrencyCode, decimals: Int) async throws
        -> NativeCommandPaletteAnswer?
    {
        answerQueries.append(query)
        if query == "slow" { await slow.wait() }
        return .init(kind: .arithmetic, text: "\(query)|\(numberFormat.rawValue)|\(currency)|\(decimals)")
    }
}

private actor PaletteRequestTransport: APITransport {
    private(set) var requests: [APIRequest] = []
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let body =
            request.url.path == "/api/recipients"
            ? #"{"ok":true,"data":{"total":0,"limit":5,"offset":0,"items":[],"links":[]}}"#
            : #"{"ok":true,"data":{"items":[{"symbol":"SYNTH","currency":"EUR","price":12.5}],"total":1}}"#
        return .init(status: 200, body: Data(body.utf8))
    }
}

@MainActor @Suite("Native palette source requests and lifecycle")
struct NativeCommandPaletteModelTests {
    private let strings = DictionaryStrings(
        language: .en, table: ["nav.transactions": "Transactions", "nav.marketLookup": "Market lookup"])
    private func make(_ service: PaletteTestService, clock: PaletteTestClock = .init()) -> NativeCommandPaletteModel {
        .init(service: service, answers: service, sleep: { _ in }, now: { clock.now() })
    }
    private func eventually(_ check: () async -> Bool) async throws {
        for _ in 0..<1000 {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("Palette operation did not settle")
    }

    @Test func debounceDoesNotSendRecipientOrTickerRequestsBeforeThreeHundredMilliseconds() async throws {
        let gate = PaletteTestGate()
        let service = PaletteTestService()
        let model = NativeCommandPaletteModel(
            service: service, answers: service,
            sleep: { duration in
                #expect(duration == .milliseconds(300))
                await gate.wait()
            })
        model.open()
        model.query = "AAPL"
        await Task.yield()
        #expect(await service.recipientQueries.isEmpty)
        #expect(await service.quoteSymbols.isEmpty)
        await gate.release()
        try await eventually { model.quote?.symbol == "AAPL" && model.recipients.first?.name == "AAPL" }
        #expect(await service.recipientQueries == ["AAPL"])
        #expect(await service.quoteSymbols == ["AAPL"])
        model.close()
    }

    @Test func sourceFrequentCacheSurvivesCloseAndExpiresAtThirtySeconds() async throws {
        let clock = PaletteTestClock()
        let service = PaletteTestService()
        let model = make(service, clock: clock)
        model.open()
        model.query = "SYNTH"
        try await eventually { model.quote?.symbol == "SYNTH" && model.recipients.count == 1 }
        model.close()
        clock.advance(29.999)
        model.open()
        model.query = "SYNTH"
        try await eventually { model.quote?.symbol == "SYNTH" && model.recipients.count == 1 }
        #expect(await service.recipientQueries == ["SYNTH"])
        #expect(await service.quoteSymbols == ["SYNTH"])
        model.close()
        clock.advance(0.001)
        model.open()
        model.query = "SYNTH"
        try await eventually {
            let quotes = await service.quoteSymbols.count
            let recipients = await service.recipientQueries.count
            return quotes == 2 && recipients == 2
        }
        model.close()
    }

    @Test func noQuoteIsCachedAndDoesNotLeaveAFalseMarketCard() async throws {
        let service = PaletteTestService()
        await service.useEmptyQuotes()
        let model = make(service)
        model.open()
        model.query = "SYNTH"
        try await eventually {
            await service.quoteSymbols.count == 1 && !model.tickerLoading && model.recipients.count == 1
        }
        #expect(!model.groups(strings: strings).contains { $0.id == "ticker" })
        model.close()
        model.open()
        model.query = "SYNTH"
        try await eventually { model.recipients.count == 1 }
        #expect(await service.quoteSymbols.count == 1)
        model.close()
    }

    @Test func lateQueryAndClosedVisitResultsCannotOverwriteCurrentHitsOrAnswer() async throws {
        let service = PaletteTestService()
        let model = make(service)
        model.open()
        model.query = "slow"
        try await eventually {
            let recipients = await service.recipientQueries
            let answers = await service.answerQueries
            return recipients.contains("slow") && answers.contains("slow")
        }
        model.query = "fast"
        try await eventually { model.recipients.first?.name == "fast" && model.answer?.text.hasPrefix("fast|") == true }
        await service.slow.release()
        await Task.yield()
        #expect(model.recipients.first?.name == "fast")
        #expect(model.answer?.text.hasPrefix("fast|") == true)
        model.close()
        #expect(model.query.isEmpty && model.recipients.isEmpty && model.answer == nil && model.quote == nil)
    }

    @Test func preferenceChangeReevaluatesSharedAnswersWithoutRefetchingRecipientQuery() async throws {
        let service = PaletteTestService()
        let model = make(service)
        model.open()
        model.query = "12+3"
        try await eventually { model.answer?.text == "12+3|eu|EUR|2" && model.recipients.count == 1 }
        model.configure(settings: .init(defaultCurrency: "USD", numberFormat: .us, showDecimalPlaces: 4))
        try await eventually { model.answer?.text == "12+3|us|USD|4" }
        #expect(await service.recipientQueries == ["12+3"])
        model.close()
    }

    @Test func closeRetiresAnUncooperativePendingAnswerAndRecipientRead() async throws {
        let service = PaletteTestService()
        let model = make(service)
        model.open()
        model.query = "slow"
        try await eventually {
            let recipients = await service.recipientQueries
            let answers = await service.answerQueries
            return recipients.contains("slow") && answers.contains("slow")
        }
        model.close()
        model.open()
        await service.slow.release()
        await Task.yield()
        #expect(model.isOpen && model.query.isEmpty)
        #expect(model.recipients.isEmpty && model.answer == nil)
        model.close()
    }

    @Test func asyncRecentWritesKeepRapidSelectionsAndOpeningWaitsForAcceptedWrites() async throws {
        let service = PaletteTestService()
        let gate = PaletteTestGate()
        var raw: String? = #"["/tax","/accounts"]"#
        var writes: [String] = []
        let model = NativeCommandPaletteModel(
            service: service, answers: service, readRecents: { raw },
            writeRecents: { value in
                if writes.isEmpty { await gate.wait() }
                writes.append(value)
                raw = value
            }, sleep: { _ in })
        model.open()
        let first = try #require(
            model.groups(strings: strings).flatMap(\.entries).first {
                $0.action == .navigate(.home)
            })
        model.activate(first)
        model.open()
        let second = try #require(
            model.groups(strings: strings).flatMap(\.entries).first {
                $0.action == .navigate(.init(path: "/transactions"))
            })
        model.activate(second)
        model.open()
        var flushed = false
        let flush = Task {
            await model.flushRecents()
            flushed = true
        }
        await Task.yield()
        #expect(!flushed)
        await gate.release()
        await flush.value
        #expect(flushed && writes.count == 2)
        try await eventually { writes.count == 2 && model.recents.first == "/transactions" }
        #expect(NativeCommandPaletteQueries.recents(raw) == ["/transactions", "/", "/tax", "/accounts"])
        #expect(model.recents == ["/transactions", "/", "/tax", "/accounts"])
        model.close()
    }

    @Test func retiredFactoryGraphCannotReopenSearchOrDispatchCapturedActions() async throws {
        let service = PaletteTestService()
        let model = make(service)
        model.open()
        let entry = try #require(model.groups(strings: strings).flatMap(\.entries).first)
        var dispatched = false
        model.onAction = { _ in dispatched = true }
        await model.flushRecents()
        model.retireForReload()
        model.open()
        model.query = "SYNTH"
        model.activate(entry)
        await Task.yield()
        #expect(!model.isOpen && !dispatched && model.onAction == nil)
        #expect(await service.recipientQueries.isEmpty)
        #expect(await service.quoteSymbols.isEmpty)
        #expect(await service.answerQueries.isEmpty)
    }

    @Test func sourceGroupsKeepAllRoutesAndAdminIsConditionalWithNoHints() {
        let service = PaletteTestService()
        let model = make(service)
        let groups = model.groups(strings: strings)
        #expect(groups.map(\.id) == ["nav.money", "nav.wealth", "nav.research", "actions"])
        #expect(
            groups.flatMap(\.entries).filter {
                if case .navigate = $0.action { return true }
                return false
            }.count == NavigationRegistry.sections.flatMap(\.items).count + NavigationRegistry.footerItems.count)
        #expect(groups.last?.entries.count == 7)
        model.configure(settings: .init(adminMode: true))
        let admin = model.groups(strings: strings).first { $0.id == "nav.admin" }
        #expect(admin?.entries.count == 5)
        #expect(admin?.entries.allSatisfy { $0.hint == nil } == true)
    }

    @Test func recipientAndTransactionActionsCaptureOriginalQueryAndCloseBeforeCallback() async throws {
        let service = PaletteTestService()
        let model = make(service)
        model.open()
        model.query = "Acme & Sons"
        try await eventually { model.recipients.count == 1 }
        let groups = model.groups(strings: strings)
        let recipient = try #require(groups.first { $0.id == "recipients" }?.entries.first)
        #expect(
            recipient.action
                == .navigate(
                    .init(
                        path: "/transactions",
                        query: [
                            .init(name: "recipient_id", value: "2"), .init(name: "filter_label", value: "Acme & Sons"),
                        ])))
        let search = try #require(groups.first { $0.id == "transaction-search" }?.entries.first)
        #expect(
            search.action
                == .navigate(.init(path: "/transactions", query: [.init(name: "search", value: "Acme & Sons")])))
        var dispatched: NativeCommandPaletteAction?
        model.onAction = { action in
            #expect(!model.isOpen && model.query.isEmpty)
            dispatched = action
        }
        model.activate(recipient)
        #expect(dispatched == recipient.action)
    }

    @Test func requestsUseExistingSourceSearchAndBasicQuoteContracts() async throws {
        let transport = PaletteRequestTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        #expect(try await client.paletteRecipients(query: "Acme & Sons").isEmpty)
        #expect(try await client.paletteQuote(symbol: "SYNTH")?.symbol == "SYNTH")
        let requests = await transport.requests
        #expect(requests.map(\.method) == [.get, .get])
        let recipients = try #require(URLComponents(url: requests[0].url, resolvingAgainstBaseURL: false))
        #expect(recipients.path == "/api/recipients")
        #expect(recipients.queryItems?.contains(.init(name: "search", value: "Acme & Sons")) == true)
        #expect(recipients.queryItems?.contains(.init(name: "active", value: "true")) == true)
        #expect(recipients.queryItems?.contains(.init(name: "limit", value: "5")) == true)
        let quote = try #require(URLComponents(url: requests[1].url, resolvingAgainstBaseURL: false))
        #expect(quote.path == "/api/market/quote")
        #expect(quote.queryItems == [.init(name: "symbols", value: "SYNTH"), .init(name: "detail", value: "basic")])
    }
}

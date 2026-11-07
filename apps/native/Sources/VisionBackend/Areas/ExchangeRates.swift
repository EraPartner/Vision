import Foundation
import VisionNativeCore

/// `routes/info/rates.ts` (the exchange-rate half) with `currencyConversionService.warmCache`,
/// `rateFetcher.ts` (latest ECB and open.er-api rates, `saveToDatabase`) and the provider
/// health writes, for `getExchangeRates` and `refreshExchangeRates`. The inflation-rate
/// routes are not in the generated client and stay on Bun.
///
/// The Swift backend keeps no rate cache. Bun's latest-rate and historical-index caches reload
/// when another connection has committed (`externalWriteVersion`), so a Swift refresh never
/// leaves them stale (ADR-270 decision 4). The routes' rate limiters guard a network listener;
/// in-process calls have none.
enum ExchangeRatesArea {
    static let ecbLatest = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
    static let erApiLatest = "https://open.er-api.com/v6/latest/EUR"

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase, fetcher: any ProviderFetching) {
        backend.serve(OpenAPIOperations.GetExchangeRates.self) { request in
            let raw = request.queryItems.filter { $0.name == "db_only" }.map { $0.value ?? "" }
            // `parseBooleanQueryParam` of a repeated parameter reads the comma-joined array.
            let dbOnly = QueryInput.boolean(raw.isEmpty ? nil : raw.joined(separator: ","), default: false)
            let listed = try await database.run { session in
                try ExchangeRatesArea.list(session)
            }
            if listed.isStale && !dbOnly {
                // `warmCache()` in the background; its failures are only logged.
                Task.detached { await ExchangeRatesArea.refresh(database: database, fetcher: fetcher) }
            }
            return HandlerResult(data: listed.body.envelopeValue)
        }
        backend.serve(OpenAPIOperations.RefreshExchangeRates.self) { _ in
            await ExchangeRatesArea.refresh(database: database, fetcher: fetcher)
            return HandlerResult(data: .object(["message": .string("Exchange rates refreshed from ECB")]))
        }
    }

    // MARK: - GET /api/info/exchange-rates

    /// The list body and whether the first currency's rate predates today.
    struct Listed: Sendable {
        let body: JSValue
        let isStale: Bool
    }

    /// The latest stored rate of each currency, by code, with the staleness of the first.
    static func list(_ session: BackendSession) throws -> Listed {
        let rows = try session.rows(
            """
            SELECT currency_code, rate_to_eur, rate_date, fetched_at FROM exchange_rates \
            WHERE is_latest = 1 ORDER BY currency_code ASC
            """)
        var rates: [JSValue] = []
        var firstDate: String?
        var lastFetched: Instant?
        for row in rows {
            let date = try row.text("rate_date")
            let fetched = try row.instant("fetched_at")
            if firstDate == nil { firstDate = date }
            if fetched.date.timeIntervalSince1970 > 0, lastFetched.map({ fetched > $0 }) ?? true { lastFetched = fetched }
            rates.append(
                .object(
                    JSObject([
                        ("currency", .string(try row.text("currency_code"))),
                        ("rate_to_eur", .number(JavaScriptNumber.fromString(try row.text("rate_to_eur")))),
                        ("rate_date", .string(date)),
                        ("fetched_at", .string(fetched.text)),
                    ])))
        }
        let isStale = firstDate.map { $0 < session.today() } ?? true
        let body = JSObject([
            ("total_rates", .int(rates.count)),
            ("rates", .array(rates)),
            ("source", .string(rates.isEmpty ? "fallback" : "database")),
            ("is_stale", .bool(isStale)),
            ("last_fetched_at", lastFetched.map { .string($0.text) } ?? .null),
        ])
        return Listed(body: .object(body), isStale: isStale)
    }

    // MARK: - Refresh (`warmCache`)

    /// Both providers at once; ECB wins where they overlap, and only the fetched rates are
    /// written, dated today. With neither, nothing is written. Failures are swallowed.
    static func refresh(database: BackendDatabase, fetcher: any ProviderFetching) async {
        async let ecb = fetchEcb(fetcher)
        async let erApi = fetchErApi(fetcher)
        let (ecbRates, erApiRates) = await (ecb, erApi)
        _ = try? await database.run { session in
            recordProvider(session, "ecb", succeeded: ecbRates != nil, error: "ECB fetch returned no rates")
            recordProvider(
                session, "open.er-api", succeeded: erApiRates != nil, error: "open.er-api fetch returned no rates")
            guard ecbRates != nil || erApiRates != nil else { return }
            var fresh = erApiRates ?? JSObject()
            for (currency, rate) in ecbRates?.entries ?? [] { fresh[currency] = rate }
            save(session, fresh)
        }
    }

    /// `fetchFromEcb`: the daily feed, 5 seconds at most.
    static func fetchEcb(_ fetcher: any ProviderFetching) async -> JSObject? {
        guard let url = URL(string: ecbLatest),
            let response = try? await fetcher.get(url, timeout: 5), response.ok
        else { return nil }
        return parseEcbXml(response.text)
    }

    /// `fetchFromErApi`: `result` must be "success" and `rates` a plain object; each finite
    /// numeric quote in range but EUR is inverted.
    static func fetchErApi(_ fetcher: any ProviderFetching) async -> JSObject? {
        guard let url = URL(string: erApiLatest),
            let response = try? await fetcher.get(url, timeout: 5), response.ok,
            let data = JSValue.parse(response.body)?.objectValue,
            data["result"] == .string("success"), let quotes = data["rates"]?.objectValue
        else { return nil }
        var rates = JSObject([("EUR", .number(1))])
        for (currency, quote) in quotes.entries where currency != "EUR" && currency != "__proto__" {
            guard case .number(let eurToX) = quote, eurToX.isFinite, eurToX > 0.0001, eurToX < 100_000 else {
                continue
            }
            rates[currency] = .number(1 / eurToX)
        }
        return rates
    }

    /// JavaScript's `\s`, spelled out: ICU's `\s` leaves out U+000B and U+FEFF.
    private static let space = #"[\t\n\x{0B}\f\r\x{20}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"#
    private static let cubePattern: NSRegularExpression? = try? NSRegularExpression(
        pattern: "<Cube\(space)+currency=['\"]([A-Z]{3})['\"]\(space)+rate=['\"]([0-9.]+)['\"]\(space)*/>")

    /// `parseEcbXml`: every `<Cube currency=… rate=…/>` in document order, EUR→X inverted to
    /// X→EUR when the quote is in range; nil without one.
    static func parseEcbXml(_ text: String) -> JSObject? {
        guard let cubePattern else { return nil }
        var rates = JSObject([("EUR", .number(1))])
        let source = text as NSString
        for match in cubePattern.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            let currency = source.substring(with: match.range(at: 1))
            let eurToX = parseFloat(source.substring(with: match.range(at: 2)))
            if eurToX.isFinite, eurToX > 0.0001, eurToX < 100_000 { rates[currency] = .number(1 / eurToX) }
        }
        return rates.count > 1 ? rates : nil
    }

    /// `parseFloat` of a `[0-9.]+` run: the longest `digits[.digits]` prefix, NaN without a digit.
    static func parseFloat(_ text: String) -> Double {
        var literal = ""
        var seenDot = false
        var digits = 0
        for scalar in text.unicodeScalars {
            if scalar == "." {
                if seenDot { break }
                seenDot = true
            } else if ("0"..."9").contains(scalar) {
                digits += 1
            } else {
                break
            }
            literal.unicodeScalars.append(scalar)
        }
        guard digits > 0 else { return .nan }
        if literal.hasPrefix(".") { literal = "0" + literal }
        if literal.hasSuffix(".") { literal += "0" }
        return Double(literal) ?? .nan
    }

    /// `saveToDatabase`: in one transaction, clear the latest marker of the fetched currencies
    /// and upsert each rate dated today as the latest. A failure rolls back and is only logged.
    static func save(_ session: BackendSession, _ rates: JSObject) {
        let entries = rates.entries.filter { $0.0 != "EUR" }
        guard !entries.isEmpty else { return }
        let today = session.today()
        let codes = JSValue.array(entries.map { .string($0.0) }).jsonText
        _ = try? session.transaction {
            _ = try session.rows(
                """
                UPDATE exchange_rates SET is_latest = 0, updated_at = now() \
                WHERE currency_code IN (SELECT value FROM json_each(?)) AND is_latest = 1
                """, [.text(codes)])
            for (currency, rate) in entries {
                guard case .number(let value) = rate else { continue }
                _ = try session.rows(
                    """
                    INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) \
                    VALUES (?, vision_numeric(?, 20, 10), ?, 1) \
                    ON CONFLICT (currency_code, rate_date) DO UPDATE SET rate_to_eur = excluded.rate_to_eur, \
                    is_latest = 1, fetched_at = now(), updated_at = now()
                    """,
                    [.text(currency), .text(SQLArguments.javaScriptText(value)), .text(today)])
            }
        }
    }

    /// `providerHealthService.recordSuccess` / `recordError` for an FX provider; a failed
    /// write is only logged.
    static func recordProvider(_ session: BackendSession, _ provider: String, succeeded: Bool, error: String) {
        if succeeded {
            _ = try? session.rows(
                """
                INSERT INTO provider_health (provider, kind, last_success_at, consecutive_failures, updated_at) \
                VALUES (?, 'fx', now(), 0, now()) ON CONFLICT (provider) DO UPDATE SET \
                last_success_at = now(), consecutive_failures = 0, updated_at = now()
                """, [.text(provider)])
        } else {
            _ = try? session.rows(
                """
                INSERT INTO provider_health (provider, kind, last_error_at, last_error, consecutive_failures, \
                updated_at) VALUES (?, 'fx', now(), ?, 1, now()) ON CONFLICT (provider) DO UPDATE SET \
                last_error_at = now(), last_error = ?, \
                consecutive_failures = provider_health.consecutive_failures + 1, updated_at = now()
                """, [.text(provider), .text(error), .text(error)])
        }
    }
}

import Foundation

/// The transaction-triggered half of `services/quoteBackfillService.ts`:
/// `refreshQuotesForInvestment` with the pure helpers it runs (`computeHoldingWindows`,
/// `sanitizeIsolatedSpikes`), its holding-window read (`getInvestmentWithHoldingWindows`),
/// `backfillInvestmentQuotes` and `cleanupStaleQuotes`. After a portfolio transaction is
/// created, updated or deleted, the investment's stored daily closes (`asset_price_history`)
/// are backfilled over every period the position was held and pruned outside them.
///
/// The scheduled entry points of the same service (`backfillHistoricalAssetQuotes` at startup,
/// `refreshActiveHoldingQuotes` hourly, `backfillHoldingGaps` daily) are not ported here: they
/// are started by the Bun backend's `startup/warmup.ts`, not by a route.
enum QuoteBackfill {
    /// `SPIKE_RATIO_THRESHOLD`: a 3× single-day jump is a spike.
    static let spikeRatioThreshold = 3.0

    /// The asset classes `selectHoldingWindowRows` reads: the only ones with a provider
    /// quote series to backfill.
    static let priceableAssetClasses = ["stock", "etf", "crypto", "metals"]

    /// `HoldingWindow`: a continuous period where net units > 0; `toDate` nil while open.
    struct HoldingWindow: Equatable, Sendable {
        var fromDate: String
        var toDate: String?
    }

    /// `HoldingWindowTx`: one buy, gift or sell leg.
    struct HoldingTx: Equatable, Sendable {
        var id: Int
        var type: String
        /// `YYYY-MM-DD`.
        var date: String
        var units: Double
    }

    // MARK: - Pure functions

    /// `computeHoldingWindows(transactions)`: the transactions of one investment, sorted by
    /// date then id, walked into the windows where the held units are above zero.
    static func holdingWindows(_ transactions: [HoldingTx]) -> [HoldingWindow] {
        guard !transactions.isEmpty else { return [] }
        // `a.date.localeCompare(b.date)`: on `YYYY-MM-DD` keys of digits and hyphens at the same
        // positions, the code-unit order. Ties go to the id, so the order is total.
        let sorted = transactions.sorted { a, b in
            a.date != b.date ? a.date < b.date : a.id < b.id
        }
        var windows: [HoldingWindow] = []
        var heldUnits = 0.0
        var windowStart: String? = nil
        for tx in sorted {
            let units = RobustStatistics.nanToZero(tx.units)
            let previousHeld = heldUnits
            switch tx.type {
            case "buy", "gift": heldUnits += units  // lint:allow string-literal-compare the stored portfolio_txn_type values the TypeScript dispatches on
            case "sell": heldUnits -= units  // lint:allow string-literal-compare as above
            default: break
            }
            // Clamped to zero against floating-point drift.
            if heldUnits < 0 { heldUnits = 0 }
            if previousHeld <= 0 && heldUnits > 0 {
                windowStart = String(tx.date.prefix(10))
            }
            if previousHeld > 0 && heldUnits <= 0, let start = windowStart {
                windows.append(HoldingWindow(fromDate: start, toDate: String(tx.date.prefix(10))))
                windowStart = nil
            }
        }
        if heldUnits > 0, let start = windowStart {
            windows.append(HoldingWindow(fromDate: start, toDate: nil))
        }
        return windows
    }

    /// `_isPositive(value)`.
    static func isPositive(_ value: Double) -> Bool { value.isFinite && value > 0 }

    /// `sanitizeIsolatedSpikes(points)`: an isolated single-day spike (a 3× jump away from both
    /// neighbours, then a MAD-based needle over the log returns) is replaced with the geometric
    /// mean of its neighbours. Both passes rewrite in place, left to right, as the TypeScript.
    static func sanitizeIsolatedSpikes(_ points: [PricePoint]) -> [PricePoint] {
        guard points.count >= 3 else { return points }
        var sanitized = points

        // Pass 1: the ratio test for obvious spikes (e.g. 10× jumps).
        for index in 1..<(sanitized.count - 1) {
            let previous = sanitized[index - 1].price
            let current = sanitized[index].price
            let next = sanitized[index + 1].price
            guard isPositive(previous), isPositive(current), isPositive(next) else { continue }
            let spikeUp = current / previous >= spikeRatioThreshold && current / next >= spikeRatioThreshold
            let spikeDown = previous / current >= spikeRatioThreshold && next / current >= spikeRatioThreshold
            if spikeUp || spikeDown {
                sanitized[index].price = (previous * next).squareRoot()
            }
        }

        // Pass 2: the MAD-based needle test for subtler spikes.
        guard sanitized.count >= 5 else { return sanitized }
        var logReturns: [Double] = []
        for index in 1..<sanitized.count {
            let previous = sanitized[index - 1].price
            let current = sanitized[index].price
            guard isPositive(previous), isPositive(current) else { continue }
            logReturns.append(log(current / previous))
        }
        guard logReturns.count >= 4 else { return sanitized }
        let statistics = RobustStatistics.returnStatistics(logReturns)
        for index in 1..<(sanitized.count - 1) {
            let previous = sanitized[index - 1].price
            let current = sanitized[index].price
            let next = sanitized[index + 1].price
            guard isPositive(previous), isPositive(current), isPositive(next) else { continue }
            if RobustStatistics.isNeedle(previous: previous, current: current, next: next, statistics) {
                sanitized[index].price = (previous * next).squareRoot()
            }
        }
        return sanitized
    }

    // MARK: - Database

    /// `getInvestmentWithHoldingWindows(investmentId)` over `selectHoldingWindowRows`: the
    /// investment's provider columns and its buy, gift and sell legs, or nil when it is not
    /// priceable, has no such legs, or holds nothing in any window. The projection has no
    /// `name` and no `current_price`, as the TypeScript's.
    static func investmentWithHoldingWindows(
        _ session: BackendSession, _ investment: Int  // lint:allow raw-id the investments row id the TypeScript passes as a number
    ) throws -> (investment: PricesArea.Investment, windows: [HoldingWindow])? {
        let classes = JSValue.array(priceableAssetClasses.map { .string($0) }).jsonText
        let rows = try session.rows(
            """
            SELECT i.id, NULL AS name, NULL AS current_price, i.asset_class, i.currency, \
            i.price_provider, i.price_provider_id, i.symbol, i.price_provider_url, \
            i.price_provider_latest_url, i.price_provider_latest_path, i.price_provider_history_url, \
            i.price_provider_history_path, i.price_provider_history_ts_path, \
            i.price_provider_history_price_path, \
            pt.id AS tx_id, pt.type AS tx_type, pt.date AS tx_date, COALESCE(pt.units, '0') AS tx_units \
            FROM investments i \
            JOIN portfolio_transactions pt ON pt.investment_id = i.id AND pt.type IN ('buy', 'gift', 'sell') \
            WHERE i.asset_class IN (SELECT value FROM json_each(?)) AND i.id = ? \
            ORDER BY pt.date, pt.id
            """,
            [.text(classes), .integer(Int64(investment))])
        guard let first = rows.first else { return nil }
        let loaded = try PricesArea.Investment(first)
        var transactions: [HoldingTx] = []
        for row in rows {
            transactions.append(HoldingTx(
                id: try row.integerId("tx_id"), type: try row.text("tx_type"), date: try row.text("tx_date"),
                units: JavaScriptNumber.fromString(try row.optionalText("tx_units") ?? "0")))
        }
        let windows = holdingWindows(transactions)
        guard !windows.isEmpty else { return nil }
        return (loaded, windows)
    }

    /// `cleanupStaleQuotes` for one investment: delete its stored closes outside every
    /// holding window, an open window ending on UTC today. One statement.
    static func cleanupStaleQuotes(
        _ session: BackendSession, _ investment: Int, _ windows: [HoldingWindow], todayUtc: String  // lint:allow raw-id as above
    ) throws {
        guard !windows.isEmpty else { return }
        let ids = JSValue.array([.int(investment)]).jsonText
        let bounds = JSValue.array(windows.map { window in
            .object(JSObject([
                ("inv", .int(investment)), ("from", .string(window.fromDate)),
                ("to", .string(window.toDate ?? todayUtc)),
            ]))
        }).jsonText
        _ = try session.rows(
            """
            DELETE FROM asset_price_history AS aph \
             WHERE aph.investment_id IN (SELECT value FROM json_each(?)) \
               AND NOT EXISTS ( \
                 SELECT 1 FROM json_each(?) AS w \
                 WHERE w.value ->> 'inv' = aph.investment_id \
                   AND aph.price_date >= w.value ->> 'from' AND aph.price_date <= w.value ->> 'to' \
               )
            """,
            [.text(ids), .text(bounds)])
    }

    // MARK: - Orchestration

    /// `backfillInvestmentQuotes(investment, holdingWindows)`: per window, the provider series
    /// (`fetchHistoricalPrices`, not forced), spike-sanitized and re-saved over what the fetch
    /// persisted. True when any window had points.
    @discardableResult
    static func backfillInvestmentQuotes(
        _ investment: PricesArea.Investment, _ windows: [HoldingWindow], now: Double,
        database: BackendDatabase, service: PricesService
    ) async throws -> Bool {
        var hasHistory = false
        for window in windows {
            // `Date.parse("<from>T00:00:00.000Z")` and `"<to>T23:59:59.999Z"`, or `Date.now()`.
            let fromMs = PriceHistory.noon(window.fromDate) - 12 * 3_600_000
            let toMs = window.toDate.map { PriceHistory.noon($0) + 12 * 3_600_000 - 1 } ?? now
            guard fromMs.isFinite else { continue }
            let raw = try await PricesArea.historicalPoints(
                investment, from: fromMs, to: toMs.isFinite ? toMs : nil, dbOnly: false, force: false,
                now: now, database: database, service: service)
            guard !raw.isEmpty else { continue }
            hasHistory = true
            let clean = sanitizeIsolatedSpikes(raw)
            try await database.run { session in
                try PricesArea.storePoints(session, investment.id, clean, investment.provider)
            }
        }
        return hasHistory
    }

    /// `refreshQuotesForInvestment(investmentId)`: with no holding window left, every stored
    /// close of the investment is deleted; otherwise its windows are backfilled and the closes
    /// outside them pruned. A failed backfill or cleanup is swallowed (the TypeScript logs it),
    /// so the cleanup still runs after a provider failure.
    static func refreshQuotes(
        forInvestment investment: Int, database: BackendDatabase, service: PricesService  // lint:allow raw-id as above
    ) async throws {
        let data = try await database.run { session in
            try investmentWithHoldingWindows(session, investment)
        }
        guard let data else {
            try await database.run { session in
                _ = try session.rows(
                    "DELETE FROM asset_price_history WHERE investment_id = ?", [.integer(Int64(investment))])
            }
            return
        }
        let instant = try await database.run { session in session.currentInstant() }
        let now = Double(instant.ms)
        _ = try? await backfillInvestmentQuotes(
            data.investment, data.windows, now: now, database: database, service: service)
        // `getDayKeyUtc(new Date())`: the stored price dates are UTC days.
        guard let today = try? PriceHistory.dateOnly(now) else { return }
        _ = try? await database.run { session in
            try cleanupStaleQuotes(session, investment, data.windows, todayUtc: today)
        }
    }
}

/// The fire-and-forget `refreshQuotesForInvestment(id).catch(...)` the portfolio transaction
/// routes start after a successful create, update or delete: the answer does not wait for it.
final class QuoteRefresher: Sendable {
    let database: BackendDatabase
    let service: PricesService

    init(database: BackendDatabase, service: PricesService) {
        self.database = database
        self.service = service
    }

    func schedule(investment: Int) {  // lint:allow raw-id as above
        let database = database
        let service = service
        Task {
            try? await QuoteBackfill.refreshQuotes(forInvestment: investment, database: database, service: service)
        }
    }
}

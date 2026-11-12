import Foundation

/// `research/projection/portfolioProjection.ts` and `stats.ts`: a Monte Carlo projection of the
/// portfolio's value. The portfolio summary, the value snapshots, the provider data for the
/// forward view and today's date are passed in; nothing is read or stored here.
enum PortfolioProjection {
    struct Input: Equatable, Sendable {
        var horizonMonths: Double?
        var monthlyContribution: Double?
        /// Month 1 first; later months use `monthlyContribution`.
        var monthlyContributionSchedule: [Double]?
        var paths: Double?
        /// 0 is the historical drift alone, 1 the forward view alone.
        var forwardBlend: Double?
        var method: String?
        var targetValue: Double?
        var goalMonth: Double?
        var currency: String?
        var seed: String?
    }

    struct Holding: Equatable, Sendable {
        /// The holding's identity, as the summary gives it (a number or a text).
        let id: JSValue
        let symbol: String?
        let assetClass: String?
        let currentValue: Double
    }

    struct Summary: Equatable, Sendable {
        /// `Number(totals.totalPortfolioValue)`; NaN when absent.
        let totalPortfolioValue: Double
        /// `Number(totals.totalInvested)`; NaN when absent.
        let totalInvested: Double
        let holdings: [Holding]
    }

    struct Snapshot: Equatable, Sendable {
        let value: Double
        let invested: Double
    }

    /// What the research providers answered for one symbol; nil where a provider had nothing.
    struct ProviderData: Equatable, Sendable {
        var quote: JSObject?
        var analyst: JSObject?
        var fundamentals: JSObject?
    }

    struct ScheduleError: Error, Equatable {
        let message = "monthlyContributionSchedule must contain at most horizonMonths nonnegative finite amounts"
    }

    static let tradingDaysPerMonth = 21.0
    static let tradingDaysPerYear = 252.0
    static let defaultPaths = 1000.0
    static let maximumPaths = 5000.0
    static let maximumHorizonMonths = 600.0
    static let meanBlockLength = 5.0
    static let forwardEligible: Set<String> = ["stock", "etf", "stocks_etfs", "equity", "fund"]
    static let maximumForwardHoldings = 25
    static let returnClamp = 0.5

    // MARK: stats.ts

    static func mean(_ values: [Double]) -> Double {
        values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
    }

    /// Sample standard deviation; 0 for fewer than two values.
    static func standardDeviation(_ values: [Double]) -> Double {
        guard values.count >= 2 else { return 0 }
        let center = mean(values)
        var sum = 0.0
        for value in values { sum += (value - center) * (value - center) }
        return (sum / Double(values.count - 1)).squareRoot()
    }

    static func clamp(_ value: Double, _ lower: Double, _ upper: Double) -> Double {
        TaxMath.min(upper, TaxMath.max(lower, value))
    }

    /// `flowAdjustedLogReturns(values, invested)`: daily log returns with the change in cost
    /// basis taken out as that day's external flow.
    static func flowAdjustedLogReturns(_ values: [Double], invested: [Double], maximumDailyMove: Double = 0.5) -> (
        returns: [Double], droppedDays: Int
    ) {
        var out: [Double] = []
        var dropped = 0
        for i in values.indices.dropFirst() {
            let v0 = values[i - 1]
            let v1 = values[i]
            guard v0 > 0, v1.isFinite else { continue }
            let inv0 = i - 1 < invested.count ? invested[i - 1] : .nan
            let inv1 = i < invested.count ? invested[i] : .nan
            let flow = inv0.isFinite && inv1.isFinite ? inv1 - inv0 : 0
            let r = (v1 - v0 - flow) / v0
            if !r.isFinite || 1 + r <= 0 || abs(r) > maximumDailyMove {
                dropped += 1
                continue
            }
            out.append(log(1 + r))
        }
        return (out, dropped)
    }

    // MARK: The projection

    private static func round2(_ value: Double) -> Double { JavaScriptNumber.round(value * 100) / 100 }
    private static func round4(_ value: Double) -> Double { JavaScriptNumber.round(value * 10000) / 10000 }

    private static func clampInteger(_ value: Double?, _ lower: Double, _ upper: Double, _ fallback: Double) -> Double {
        guard let value, value.isFinite else { return fallback }
        return min(upper, max(lower, JavaScriptNumber.round(value)))
    }

    private static func number(_ object: JSObject?, _ key: String) -> Double {
        object?[key]?.javaScriptNumber ?? .nan
    }

    private struct Forward {
        let symbol: String
        let expectedAnnual: Double
        let growth: Double
        let dividendYield: Double?
    }

    private static func forward(_ holding: Holding, _ providers: (String) -> ProviderData) -> Forward? {
        guard let symbol = holding.symbol, !symbol.isEmpty,
            forwardEligible.contains(JavaScriptCase.lowercased(holding.assetClass ?? ""))
        else { return nil }
        let data = providers(symbol)
        let price = number(data.quote, "price")
        let target = number(data.analyst, "targetMean")
        guard price > 0, target > 0 else { return nil }
        let growth = target / price - 1
        let yield = number(data.fundamentals, "dividendYield")
        let dividendYield = yield.isFinite ? yield : nil
        return Forward(
            symbol: symbol, expectedAnnual: clamp(growth + (dividendYield ?? 0), -returnClamp, returnClamp),
            growth: growth, dividendYield: dividendYield)
    }

    private static func sumBootstrapResiduals(_ residuals: [Double], _ random: inout ForecastRandom) -> Double {
        let count = residuals.count
        func draw(_ random: inout ForecastRandom) -> Int { Int((random.next() * Double(count)).rounded(.down)) % count }
        let restart = 1 / meanBlockLength
        var index = draw(&random)
        var sum = 0.0
        for _ in 0..<Int(tradingDaysPerMonth) {
            sum += residuals[index]
            if random.next() < restart { index = draw(&random) } else { index = (index + 1) % count }
        }
        return sum
    }

    private static func mapKey(_ id: JSValue) -> String {
        if case .string(let text) = id { return "s:" + text }
        return "v:" + id.javaScriptString
    }

    /// `runPortfolioForecast(input, deps)`, as the JSON the route answers with.
    static func run(
        _ input: Input, summary: Summary, snapshots: [Snapshot], today: String,
        providers: (String) -> ProviderData = { _ in ProviderData() }
    ) throws -> JSObject {
        let currency = JavaScriptCase.uppercased(input.currency.flatMap { $0.isEmpty ? nil : $0 } ?? "EUR")
        let horizonMonths = clampInteger(input.horizonMonths, 1, maximumHorizonMonths, 120)
        let horizon = Int(horizonMonths)
        let monthlyContribution =
            input.monthlyContribution.flatMap { $0.isFinite ? TaxMath.max(0, $0) : nil } ?? 0
        let schedule = input.monthlyContributionSchedule
        if let schedule, schedule.count > horizon || schedule.contains(where: { !$0.isFinite || $0 < 0 }) {
            throw ScheduleError()
        }
        let hasScheduleOverride = schedule?.contains { $0 != monthlyContribution } ?? false
        let contributions = (0..<horizon).map { month in
            schedule.flatMap { month < $0.count ? $0[month] : nil } ?? monthlyContribution
        }
        var cumulativeContributions: [Double] = []
        if hasScheduleOverride {
            for contribution in contributions {
                cumulativeContributions.append((cumulativeContributions.last ?? 0) + contribution)
            }
        } else {
            cumulativeContributions = contributions.indices.map { monthlyContribution * Double($0 + 1) }
        }
        let paths = clampInteger(input.paths, 100, maximumPaths, defaultPaths)
        let pathCount = Int(paths)
        let forwardBlend = clamp(input.forwardBlend.flatMap { $0.isFinite ? $0 : nil } ?? 0, 0, 1)
        let method = input.method == "block_bootstrap" ? "block_bootstrap" : "parametric"
        let targetValue = input.targetValue.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let goalMonth: Double? =
            targetValue != nil && input.goalMonth != nil
            ? clampInteger(input.goalMonth, 1, horizonMonths, horizonMonths) : nil
        let text = JavaScriptNumber.text
        let seed =
            input.seed.flatMap { $0.isEmpty ? nil : $0 }
            ?? "pf:\(currency):\(text(horizonMonths)):\(text(paths)):\(method):\(text(forwardBlend)):\(text(monthlyContribution))"
            + (hasScheduleOverride ? ":" + contributions.map(text).joined(separator: ",") : "")

        let startValue = summary.totalPortfolioValue.isNaN ? 0 : summary.totalPortfolioValue
        guard startValue > 0 else { return JSObject([("available", .bool(false)), ("reason", .string("no_holdings"))]) }
        let startInvested = summary.totalInvested > 0 ? summary.totalInvested : startValue

        let (logReturns, flowArtifactDays) = flowAdjustedLogReturns(
            snapshots.map(\.value), invested: snapshots.map(\.invested))
        if logReturns.count < 2 {
            return JSObject([
                ("available", .bool(false)), ("reason", .string("insufficient_history")),
                ("historyDays", .number(Double(logReturns.count))),
            ])
        }
        let historicalDailyDrift = mean(logReturns)
        let dailyVolatility = standardDeviation(logReturns)

        var blendedDailyDrift = historicalDailyDrift
        var forwardHoldings: [Forward] = []
        if forwardBlend > 0 {
            let holdings = summary.holdings.filter { $0.currentValue > 0 }
            // A stable sort, largest first, as Array.prototype.sort is.
            let ranked = holdings.enumerated()
                .sorted { $0.element.currentValue != $1.element.currentValue
                    ? $0.element.currentValue > $1.element.currentValue : $0.offset < $1.offset }
                .prefix(maximumForwardHoldings).map(\.element)
            var byID: [(key: String, forward: Forward)] = []
            for holding in ranked {
                guard let found = forward(holding, providers) else { continue }
                let key = mapKey(holding.id)
                if let index = byID.firstIndex(where: { $0.key == key }) {
                    byID[index].forward = found
                } else {
                    byID.append((key, found))
                }
            }
            forwardHoldings = byID.map(\.forward)
            var forwardDailyDrift = 0.0
            for holding in holdings {
                let weight = holding.currentValue / startValue
                let key = mapKey(holding.id)
                let drift =
                    byID.first { $0.key == key }.map { log(1 + $0.forward.expectedAnnual) / tradingDaysPerYear }
                    ?? historicalDailyDrift
                forwardDailyDrift += weight * drift
            }
            blendedDailyDrift = forwardBlend * forwardDailyDrift + (1 - forwardBlend) * historicalDailyDrift
        }

        let monthlyDrift = blendedDailyDrift * tradingDaysPerMonth
        let monthlyVolatility = dailyVolatility * tradingDaysPerMonth.squareRoot()
        let residuals = method == "block_bootstrap" ? logReturns.map { $0 - historicalDailyDrift } : nil

        var random = ForecastRandom(.text(seed))
        var monthValues = [[Double]](repeating: [Double](repeating: 0, count: pathCount), count: horizon)
        var finals = [Double](repeating: 0, count: pathCount)
        for p in 0..<pathCount {
            var value = startValue
            for month in 0..<horizon {
                let logReturn =
                    residuals.map { monthlyDrift + sumBootstrapResiduals($0, &random) }
                    ?? monthlyDrift + monthlyVolatility * random.gaussian()
                value = value * exp(logReturn) + contributions[month]
                monthValues[month][p] = value
            }
            finals[p] = value
        }

        let quantile = ForecastCalendar.quantile
        func percentiles(_ sorted: [Double]) -> [(String, JSValue)] {
            [("p10", 10.0), ("p25", 25), ("p50", 50), ("p75", 75), ("p90", 90)].map {
                ($0.0, ForecastJSON.number(round2(quantile(sorted, $0.1))))
            }
        }
        let points = try monthValues.enumerated().map { h, values -> JSValue in
            .object(
                JSObject(
                    [
                        ("monthIndex", .number(Double(h + 1))),
                        ("date", .string(try CalendarDays.firstOfMonth(today, monthOffset: h + 1))),
                        ("netInvested", ForecastJSON.number(round2(startInvested + cumulativeContributions[h]))),
                    ] + percentiles(values.sorted())))
        }
        let totalContributions = cumulativeContributions[horizon - 1]
        let netInvested = startInvested + totalContributions
        let probabilityBelowInvested = Double(finals.filter { $0 < netInvested }.count) / paths
        let goalValues = goalMonth.map { monthValues[Int($0) - 1] } ?? finals
        let probabilityTarget = targetValue.map { target in Double(goalValues.filter { $0 >= target }.count) / paths }

        var out = JSObject([
            ("available", .bool(true)), ("currency", .string(currency)), ("method", .string(method)),
            ("horizonMonths", .number(horizonMonths)), ("paths", .number(paths)), ("seed", .string(seed)),
            ("historyDays", .number(Double(logReturns.count))), ("flowArtifactDays", .number(Double(flowArtifactDays))),
            ("lowConfidence", .bool(logReturns.count < 60)), ("startValue", ForecastJSON.number(round2(startValue))),
            ("startInvested", ForecastJSON.number(round2(startInvested))),
            ("monthlyContribution", ForecastJSON.number(round2(monthlyContribution))),
            ("totalContributions", ForecastJSON.number(round2(totalContributions))),
            ("netInvested", ForecastJSON.number(round2(netInvested))),
            ("expectedAnnualReturn", ForecastJSON.number(round4(exp(blendedDailyDrift * tradingDaysPerYear) - 1))),
            (
                "historicalAnnualReturn",
                ForecastJSON.number(round4(exp(historicalDailyDrift * tradingDaysPerYear) - 1))
            ),
            ("annualVolatility", ForecastJSON.number(round4(dailyVolatility * tradingDaysPerYear.squareRoot()))),
            ("forwardBlend", .number(forwardBlend)), ("usedForward", .bool(!forwardHoldings.isEmpty)),
            (
                "forwardHoldings",
                .array(
                    forwardHoldings.map { holding in
                        var entry = JSObject([
                            ("symbol", .string(holding.symbol)),
                            ("expectedAnnual", ForecastJSON.number(round4(holding.expectedAnnual))),
                            ("growth", ForecastJSON.number(round4(holding.growth))),
                        ])
                        if let yield = holding.dividendYield { entry["dividendYield"] = ForecastJSON.number(round4(yield)) }
                        return .object(entry)
                    })
            ),
            (
                "projected",
                .object(JSObject([("mean", ForecastJSON.number(round2(mean(finals))))] + percentiles(finals.sorted())))
            ),
            ("probBelowInvested", ForecastJSON.number(round4(probabilityBelowInvested))),
        ])
        if let targetValue { out["targetValue"] = .number(targetValue) }
        if let goalMonth { out["goalMonth"] = .number(goalMonth) }
        if let probabilityTarget { out["probTarget"] = ForecastJSON.number(round4(probabilityTarget)) }
        out["points"] = .array(points)
        return out
    }
}

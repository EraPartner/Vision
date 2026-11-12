import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/forecast.jsonl`: calls of the cash-flow forecast methods
/// (`services/calculations/forecast`) and of the portfolio projection
/// (`services/research/projection`), with what the TypeScript answered
/// (`bun run native:parity-plans`). The random draws are compared as exact integers.
@Suite struct ForecastParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("forecast.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func array(_ value: JSValue?) -> [JSValue] {
        if case .array(let items)? = value { return items }
        return []
    }

    private static func seed(_ value: JSValue?) -> ForecastRandom.Seed {
        if case .string(let text)? = value { return .text(text) }
        return .number(value?.javaScriptNumber ?? .nan)
    }

    private static func history(_ value: JSValue?) -> [DailyNet] {
        array(value).compactMap(\.objectValue).map {
            DailyNet(date: $0["date"]?.stringValue ?? "", net: $0["net"]?.javaScriptNumber ?? .nan)
        }
    }

    private static func strings(_ value: JSValue?) -> [String] { array(value).compactMap(\.stringValue) }

    private static func points(_ value: JSValue?) -> [ForecastPoint] {
        array(value).compactMap(\.objectValue).map {
            ForecastPoint(date: $0["date"]?.stringValue ?? "", value: $0["value"]?.javaScriptNumber ?? .nan)
        }
    }

    private static func weights(_ value: JSValue?) -> ForecastEnsemble.Weights {
        array(value).map { entry in
            let pair = array(entry)
            return (pair[0].stringValue ?? "", pair[1].javaScriptNumber)
        }
    }

    private static func json(_ weights: ForecastEnsemble.Weights) -> JSValue {
        .array(weights.map { .array([.string($0.id), ForecastJSON.number($0.weight)]) })
    }

    private static func number(_ object: JSObject?, _ key: String) -> Double? {
        guard let value = object?[key] else { return nil }
        return value.javaScriptNumber
    }

    static func method(_ id: String, _ options: JSObject?) -> (@Sendable ([DailyNet], [String]) throws -> JSValue)? {
        let paths = number(options, "paths").map { Int($0) } ?? MonteCarloForecast.defaultPaths
        let percentiles =
            options?["percentiles"].map { array($0).map(\.javaScriptNumber) } ?? MonteCarloForecast.defaultPercentiles
        let seed = options?["seed"].map { Self.seed($0) } ?? .text("default")
        let alpha = number(options, "alpha") ?? 0.15
        switch id {
        case "simple_avg": return { ForecastJSON.points(try PointForecast.simpleAverage(history: $0, dates: $1)) }
        case "weighted_avg": return { ForecastJSON.points(try PointForecast.weightedAverage(history: $0, dates: $1)) }
        case "ewma": return { ForecastJSON.points(try PointForecast.ewma(history: $0, dates: $1, alpha: alpha)) }
        case "holt_winters": return { ForecastJSON.points(try PointForecast.holtWinters(history: $0, dates: $1)) }
        case "prophet_lite": return { ForecastJSON.points(try PointForecast.prophetLite(history: $0, dates: $1)) }
        case "monte_carlo_parametric":
            return {
                try MonteCarloForecast.parametric(
                    history: $0, dates: $1, paths: paths, percentiles: percentiles, seed: seed
                ).jsonValue
            }
        case "monte_carlo_block_bootstrap":
            return {
                try MonteCarloForecast.blockBootstrap(
                    history: $0, dates: $1, paths: paths, percentiles: percentiles, seed: seed
                ).jsonValue
            }
        default: return nil
        }
    }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        switch name {
        case "hash": return .number(Double(ForecastRandom.hash(at(1)?.stringValue ?? "")))
        case "draws":
            var random = ForecastRandom(seed(at(1)))
            return .array((0..<Int(at(2)?.javaScriptNumber ?? 0)).map { _ in .number(random.next() * 4_294_967_296) })
        case "gaussian":
            var random = ForecastRandom(seed(at(1)))
            return .array((0..<Int(at(2)?.javaScriptNumber ?? 0)).map { _ in ForecastJSON.number(random.gaussian()) })
        case "densify":
            return .array(
                try ForecastCalendar.densify(history(at(1)), through: at(2)?.stringValue).map {
                    .object(JSObject([("date", .string($0.date)), ("net", ForecastJSON.number($0.net))]))
                })
        case "holiday": return .bool(BelgianHolidays.contains(at(1)?.stringValue ?? ""))
        case "method":
            guard let run = method(at(1)?.stringValue ?? "", at(4)?.objectValue) else { throw UnknownOperation(name: name) }
            return try run(history(at(2)), strings(at(3)))
        case "weights":
            let rows = array(at(1)).compactMap(\.objectValue).map { row in
                ForecastEnsemble.Accuracy(
                    method: row["methodId"]?.stringValue ?? "",
                    rmse: row["rmse"].flatMap { $0 == .null ? nil : $0.javaScriptNumber },
                    sampleDays: row["sampleDays"].flatMap { $0 == .null ? nil : $0.javaScriptNumber })
            }
            return json(ForecastEnsemble.weights(accuracy: rows, methodIDs: strings(at(2))))
        case "effective": return json(ForecastEnsemble.effectiveWeights(weights(at(1)), eligible: strings(at(2))))
        case "ensemble":
            let outputs = array(at(2)).compactMap(\.objectValue).map {
                ForecastEnsemble.MethodOutput(
                    id: $0["id"]?.stringValue ?? "", series: points($0["series"]), failed: $0["error"] != nil)
            }
            return ForecastJSON.points(
                ForecastEnsemble.forecast(dates: strings(at(1)), outputs: outputs, weights: weights(at(3))))
        case "backtest":
            let methods = strings(at(2)).compactMap { id -> ForecastBacktest.Method? in
                guard let run = method(id, nil) else { return nil }
                return ForecastBacktest.Method(id: id, label: id) { history, dates in
                    let value = try run(history, dates)
                    return points(value.objectValue?["series"] ?? value)
                }
            }
            return .array(
                try ForecastBacktest.walkForward(
                    history: history(at(1)), methods: methods, asOfMonth: at(3)?.stringValue ?? "",
                    windowMonths: Int(at(4)?.javaScriptNumber ?? 12)
                ).map(\.jsonValue))
        case "projection":
            let wire = at(1)?.objectValue
            let input = PortfolioProjection.Input(
                horizonMonths: number(wire, "horizonMonths"), monthlyContribution: number(wire, "monthlyContribution"),
                monthlyContributionSchedule: wire?["monthlyContributionSchedule"].map { array($0).map(\.javaScriptNumber) },
                paths: number(wire, "paths"), forwardBlend: number(wire, "forwardBlend"),
                method: wire?["method"]?.stringValue, targetValue: number(wire, "targetValue"),
                goalMonth: number(wire, "goalMonth"), currency: wire?["currency"]?.stringValue,
                seed: wire?["seed"]?.stringValue)
            let summary = at(2)?.objectValue
            let totals = summary?["totals"]?.objectValue
            let holdings = array(summary?["summaries"]).compactMap(\.objectValue).map { row in
                PortfolioProjection.Holding(
                    id: row["id"] ?? .null, symbol: row["symbol"]?.stringValue,
                    assetClass: [row["asset_class"]?.stringValue, row["assetClass"]?.stringValue]
                        .compactMap { $0 }.first { !$0.isEmpty },
                    currentValue: number(row, "currentValue") ?? .nan)
            }
            let snapshots = array(at(3)).compactMap(\.objectValue).map {
                PortfolioProjection.Snapshot(value: number($0, "value") ?? .nan, invested: number($0, "invested") ?? .nan)
            }
            let providers = at(5)?.objectValue
            do {
                return .object(
                    try PortfolioProjection.run(
                        input,
                        summary: PortfolioProjection.Summary(
                            totalPortfolioValue: number(totals, "totalPortfolioValue") ?? .nan,
                            totalInvested: number(totals, "totalInvested") ?? .nan, holdings: holdings),
                        snapshots: snapshots, today: at(4)?.stringValue ?? ""
                    ) { symbol in
                        let entry = providers?[symbol]?.objectValue
                        return PortfolioProjection.ProviderData(
                            quote: entry?["quote"]?.objectValue, analyst: entry?["analyst"]?.objectValue,
                            fundamentals: entry?["fundamentals"]?.objectValue)
                    })
            } catch is PortfolioProjection.ScheduleError {
                return .object(JSObject([("error", .string("RangeError"))]))
            }
        default: throw UnknownOperation(name: name)
        }
    }

    /// Numbers that differ only in the last bits are equal here: `Math.log`, `Math.cos`,
    /// `Math.sin` and `Math.exp` are not required to round the same way in every engine.
    static func close(_ a: JSValue, _ b: JSValue, tolerance: Double) -> Bool {
        switch (a, b) {
        case (.number(let x), .number(let y)):
            return x == y || abs(x - y) <= tolerance * Swift.max(1, abs(x), abs(y))
        case (.array(let x), .array(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { close($0, $1, tolerance: tolerance) }
        case (.object(let x), .object(let y)):
            return x.keys.sorted() == y.keys.sorted()
                && x.keys.allSatisfy { key in
                    guard let left = x[key], let right = y[key] else { return false }
                    return close(left, right, tolerance: tolerance)
                }
        default: return a == b
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var inexact = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"], let expected = recorded["r"] else { continue }
            let actual = try Self.evaluate(op)
            let name = op.first?.stringValue ?? ""
            // The seeded sequence itself has no tolerance.
            // The regression solves a linear system, which magnifies a last-bit difference.
            let solved = name == "backtest" || (name == "method" && op.count > 1 && op[1] == .string("prophet_lite"))
            let tolerance = ["draws", "hash", "holiday", "densify"].contains(name) ? 0 : solved ? 1e-6 : 1e-9
            if PlanFixture.canonical(actual) != PlanFixture.canonical(expected) { inexact += 1 }
            if !Self.close(actual, expected, tolerance: tolerance) {
                failures.append("case \(index + 1) \(name) \(op.count > 1 ? op[1].stringValue ?? "" : "")")
            }
        }
        print("forecast parity: \(lines.count) cases, \(inexact) not bit-identical")
        #expect(lines.count > 100)
        #expect(failures.isEmpty, "\(failures.count) differ: \(failures.prefix(12).joined(separator: "; "))")
    }
}

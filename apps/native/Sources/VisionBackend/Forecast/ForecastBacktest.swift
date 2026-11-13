import Foundation

/// `backtest.ts`: each method forecasts past months from the history before them, and the
/// forecasts are scored against what happened.
enum ForecastBacktest {
    struct Method: Sendable {
        let id: String
        let label: String
        /// The method's series; an error counts as a forecast of zero.
        let forecast: @Sendable (_ history: [DailyNet], _ dates: [String]) throws -> [ForecastPoint]
    }

    struct MonthResult: Equatable, Sendable {
        let month: String
        let mae: Double
        let rmse: Double
        let mape: Double?
        let residuals: [Double]
        let sampleDays: Int
    }

    struct MethodResult: Equatable, Sendable {
        let id: String
        let label: String
        var perMonth: [MonthResult] = []
        var mae = 0.0
        var rmse = 0.0
        var mape: Double?
        var months = 0

        var jsonValue: JSValue {
            func optional(_ value: Double?) -> JSValue { value.map(ForecastJSON.number) ?? .null }
            return .object(
                JSObject([
                    ("id", .string(id)), ("label", .string(label)),
                    (
                        "perMonth",
                        .array(
                            perMonth.map { month in
                                .object(
                                    JSObject([
                                        ("month", .string(month.month)), ("mae", ForecastJSON.number(month.mae)),
                                        ("rmse", ForecastJSON.number(month.rmse)), ("mape", optional(month.mape)),
                                        ("residuals", .array(month.residuals.map(ForecastJSON.number))),
                                        ("sampleDays", .number(Double(month.sampleDays))),
                                    ]))
                            })
                    ),
                    (
                        "aggregate",
                        .object(
                            JSObject([
                                ("mae", ForecastJSON.number(mae)), ("rmse", ForecastJSON.number(rmse)),
                                ("mape", optional(mape)), ("months", .number(Double(months))),
                            ]))
                    ),
                ]))
        }
    }

    static let defaultWindowMonths = 12
    static let minimumPercentageActual = 0.01

    private static func pad(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }

    /// `YYYY-MM` moved by `delta` months.
    static func addMonths(_ month: String, _ delta: Int) throws -> String {
        let first = try CalendarDays.firstOfMonth(month.prefix(7) + "-01", monthOffset: delta)
        return String(first.prefix(7))
    }

    static func daysInMonth(_ month: String) throws -> Int {
        let next = try CalendarDays.firstOfMonth(month.prefix(7) + "-01", monthOffset: 1)
        return try CalendarDays.difference(from: month.prefix(7) + "-01", to: next)
    }

    private static func precedes(_ a: String, _ b: String) -> Bool {
        Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16))
    }

    private static func score(_ predicted: [ForecastPoint], _ actual: [DailyNet]) -> MonthResult {
        var sumAbsolute = 0.0
        var sumSquares = 0.0
        var totalPredicted = 0.0
        var totalActual = 0.0
        var residuals: [Double] = []
        for (index, day) in actual.enumerated() {
            let value = index < predicted.count ? predicted[index].value : 0
            let error = value - day.net
            residuals.append(error)
            sumAbsolute += abs(error)
            sumSquares += error * error
            totalPredicted += value
            totalActual += day.net
        }
        let n = Double(actual.count)
        return MonthResult(
            month: "", mae: actual.isEmpty ? 0 : sumAbsolute / n, rmse: actual.isEmpty ? 0 : (sumSquares / n).squareRoot(),
            mape: abs(totalActual) > minimumPercentageActual + Double.ulpOfOne
                ? abs(totalPredicted - totalActual) / abs(totalActual) : nil,
            residuals: residuals, sampleDays: actual.count)
    }

    /// `walkForwardBacktest({ history, methods, asOfMonth, windowMonths })`. Method ids must
    /// be distinct.
    static func walkForward(
        history: [DailyNet], methods: [Method], asOfMonth: String, windowMonths: Int = defaultWindowMonths
    ) throws -> [MethodResult] {
        var results = methods.map { MethodResult(id: $0.id, label: $0.label) }
        for k in stride(from: windowMonths, through: 1, by: -1) {
            let target = try addMonths(asOfMonth, -k)
            let previous = try addMonths(target, -1)
            let trainEnd = "\(previous)-\(pad(try daysInMonth(previous)))"
            let training = try ForecastCalendar.densify(
                history.filter { precedes(String($0.date.prefix(7)), target) }, through: trainEnd)
            if training.isEmpty { continue }
            var byDate: [String: Double] = [:]
            for row in history where row.date.prefix(7) == target { byDate[row.date, default: 0] += row.net }
            let actual = (1...(try daysInMonth(target))).map { day -> DailyNet in
                let date = "\(target)-\(pad(day))"
                return DailyNet(date: date, net: byDate[date] ?? 0)
            }
            let dates = actual.map(\.date)
            for (index, method) in methods.enumerated() {
                let predicted =
                    (try? method.forecast(training, dates)) ?? dates.map { ForecastPoint(date: $0, value: 0) }
                let scored = score(predicted, actual)
                results[index].perMonth.append(
                    MonthResult(
                        month: target, mae: scored.mae, rmse: scored.rmse, mape: scored.mape,
                        residuals: scored.residuals, sampleDays: scored.sampleDays))
            }
        }
        for index in results.indices where !results[index].perMonth.isEmpty {
            let months = results[index].perMonth
            var mae = 0.0
            var rmse = 0.0
            var mape = 0.0
            var percentageSamples = 0
            for month in months {
                mae += month.mae
                rmse += month.rmse
                if let value = month.mape {
                    mape += value
                    percentageSamples += 1
                }
            }
            results[index].mae = mae / Double(months.count)
            results[index].rmse = rmse / Double(months.count)
            results[index].mape = percentageSamples > 0 ? mape / Double(percentageSamples) : nil
            results[index].months = months.count
        }
        return results
    }
}

import Foundation

/// `methods/ensemble.ts`: the point methods combined by weights from their backtest accuracy.
enum ForecastEnsemble {
    struct Accuracy: Equatable, Sendable {
        let method: String
        let rmse: Double?
        let sampleDays: Double?
    }

    struct MethodOutput: Equatable, Sendable {
        let id: String
        let series: [ForecastPoint]
        let failed: Bool
    }

    /// Weights in the order their methods were first seen, as a JavaScript `Map` keeps them.
    typealias Weights = [(id: String, weight: Double)]

    static let minimumRMSE = 1e-6
    static let shrinkagePriorDays = 30.0
    static let uniformFloor = 0.05

    private static func set(_ weights: inout Weights, _ id: String, _ weight: Double) {
        if let index = weights.firstIndex(where: { $0.id == id }) {
            weights[index].weight = weight
        } else {
            weights.append((id, weight))
        }
    }

    private static func weight(_ weights: Weights, _ id: String) -> Double? { weights.first { $0.id == id }?.weight }

    /// `computeWeights(accuracyRows, methodIds)`: inverse squared error on an error shrunk
    /// towards the mean by sample size, blended with a small equal share.
    static func weights(accuracy: [Accuracy], methodIDs: [String]) -> Weights {
        let rows = accuracy.compactMap { row -> (id: String, rmse: Double, sampleDays: Double?)? in
            guard let rmse = row.rmse, rmse > 0, methodIDs.contains(row.method) else { return nil }
            return (row.method, rmse, row.sampleDays)
        }
        if rows.isEmpty { return [] }
        let meanRMSE = rows.reduce(0) { $0 + $1.rmse } / Double(rows.count)
        let raw = rows.map { row -> (id: String, weight: Double) in
            let n = row.sampleDays.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? shrinkagePriorDays
            let shrunk = (n * row.rmse + shrinkagePriorDays * meanRMSE) / (n + shrinkagePriorDays)
            let bounded = max(shrunk, minimumRMSE)
            return (row.id, 1 / (bounded * bounded))
        }
        let total = raw.reduce(0) { $0 + $1.weight }
        var out: Weights = []
        for entry in raw {
            set(&out, entry.id, (1 - uniformFloor) * (entry.weight / total) + uniformFloor / Double(raw.count))
        }
        return out
    }

    /// `effectiveWeights(weights, eligibleIds)`.
    static func effectiveWeights(_ weights: Weights, eligible: [String]) -> Weights {
        var out: Weights = []
        if eligible.isEmpty { return out }
        if weights.isEmpty {
            for id in eligible { set(&out, id, 1 / Double(eligible.count)) }
            return out
        }
        let sum = eligible.reduce(0) { $0 + (weight(weights, $1) ?? 0) }
        for id in eligible { set(&out, id, sum > 0 ? (weight(weights, id) ?? 0) / sum : 0) }
        return out
    }

    /// `forecast({ forecastDates, methodOutputs, weights })`.
    static func forecast(dates: [String], outputs: [MethodOutput], weights: Weights) -> [ForecastPoint] {
        let eligible = outputs.filter { !$0.failed }
        if eligible.isEmpty { return dates.map { ForecastPoint(date: $0, value: 0) } }
        let effective = effectiveWeights(weights, eligible: eligible.map(\.id))
        return dates.map { date in
            var value = 0.0
            for method in eligible {
                let point = method.series.first { $0.date == date }
                value += (weight(effective, method.id) ?? 0) * (point?.value ?? 0)
            }
            return ForecastPoint(date: date, value: value)
        }
    }
}

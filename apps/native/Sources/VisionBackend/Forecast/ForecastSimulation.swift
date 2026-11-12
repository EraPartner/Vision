import Foundation

/// `simulationBands.ts`: the percentile bands of simulated paths, per day and cumulative.
struct SimulationSummary: Equatable, Sendable {
    var series: [ForecastPoint] = []
    /// Keyed `p10`, `p50`, … in the order the percentiles were asked for.
    var bands: [(key: String, points: [ForecastPoint])] = []
    var cumulativeBands: [(key: String, points: [ForecastPoint])] = []

    static func == (lhs: SimulationSummary, rhs: SimulationSummary) -> Bool {
        lhs.series == rhs.series && lhs.bands.elementsEqual(rhs.bands, by: ==)
            && lhs.cumulativeBands.elementsEqual(rhs.cumulativeBands, by: ==)
    }

    var jsonValue: JSValue {
        func object(_ bands: [(key: String, points: [ForecastPoint])]) -> JSValue {
            var out = JSObject()
            for band in bands { out[band.key] = ForecastJSON.points(band.points) }
            return .object(out)
        }
        return .object(
            JSObject([
                ("series", ForecastJSON.points(series)), ("bands", object(bands)),
                ("cumulative_bands", object(cumulativeBands)),
            ]))
    }

    /// `summarizeSimulationPaths(samples, forecastDates, percentiles)`: `samples[h][p]` is day
    /// `h` of path `p`. The samples must be finite.
    static func summarize(samples: [[Double]], dates: [String], percentiles: [Double]) -> SimulationSummary {
        let pathCount = samples.first?.count ?? 0
        var cumulative = [Double](repeating: 0, count: pathCount)
        var daily: [[ForecastPoint]] = percentiles.map { _ in [] }
        var running: [[ForecastPoint]] = percentiles.map { _ in [] }
        var series: [ForecastPoint] = []
        for (h, date) in dates.enumerated() {
            let day = samples[h]
            let dailySorted = day.sorted()
            for p in 0..<pathCount { cumulative[p] += p < day.count ? day[p] : .nan }
            let cumulativeSorted = cumulative.sorted()
            for (index, q) in percentiles.enumerated() {
                daily[index].append(ForecastPoint(date: date, value: ForecastCalendar.quantile(dailySorted, q)))
                running[index].append(ForecastPoint(date: date, value: ForecastCalendar.quantile(cumulativeSorted, q)))
            }
            series.append(ForecastPoint(date: date, value: ForecastCalendar.quantile(dailySorted, 50)))
        }
        let keys = percentiles.map { "p" + JavaScriptNumber.text($0) }
        return SimulationSummary(
            series: series, bands: merged(keys, daily), cumulativeBands: merged(keys, running))
    }

    /// `Object.fromEntries`: a repeated key keeps its first place and its last value.
    private static func merged(_ keys: [String], _ values: [[ForecastPoint]]) -> [(key: String, points: [ForecastPoint])] {
        var out: [(key: String, points: [ForecastPoint])] = []
        for (key, points) in zip(keys, values) {
            if let index = out.firstIndex(where: { $0.key == key }) {
                out[index].points = points
            } else {
                out.append((key, points))
            }
        }
        return out
    }
}

/// The two Monte Carlo forecast methods (`methods/monteCarloParametric.ts`,
/// `methods/monteCarloBlockBootstrap.ts`).
enum MonteCarloForecast {
    static let defaultPaths = 1000
    static let defaultPercentiles: [Double] = [10, 50, 90]
    static let meanBlockLength = 7.0

    /// Normal draws around each day's bucket mean, with the bucket's standard deviation.
    static func parametric(
        history: [DailyNet], dates: [String], paths: Int = defaultPaths, percentiles: [Double] = defaultPercentiles,
        seed: ForecastRandom.Seed = .text("default")
    ) throws -> SimulationSummary {
        let buckets = try SeasonalityBuckets(history)
        var random = ForecastRandom(seed)
        if dates.isEmpty { return SimulationSummary() }
        let rows = try dates.map { date -> (mean: Double, std: Double) in
            let bucket = try buckets.lookup(date)
            return (bucket.mean, bucket.std.isFinite ? bucket.std : 0)
        }
        var samples = [[Double]](repeating: [Double](repeating: 0, count: max(paths, 0)), count: rows.count)
        for p in 0..<max(paths, 0) {
            for (h, row) in rows.enumerated() { samples[h][p] = row.mean + row.std * random.gaussian() }
        }
        return SimulationSummary.summarize(samples: samples, dates: dates, percentiles: percentiles)
    }

    /// Stationary block bootstrap: residuals around the bucket means, resampled in blocks of
    /// seven days on average.
    static func blockBootstrap(
        history: [DailyNet], dates: [String], paths: Int = defaultPaths, percentiles: [Double] = defaultPercentiles,
        seed: ForecastRandom.Seed = .text("default")
    ) throws -> SimulationSummary {
        if dates.isEmpty { return SimulationSummary() }
        let buckets = try SeasonalityBuckets(history)
        let residuals = try history.map { $0.net - (try buckets.lookup($0.date).mean) }
        var random = ForecastRandom(seed)
        if residuals.isEmpty {
            let zeros = dates.map { ForecastPoint(date: $0, value: 0) }
            var bands: [(key: String, points: [ForecastPoint])] = []
            for q in percentiles {
                let key = "p" + JavaScriptNumber.text(q)
                if !bands.contains(where: { $0.key == key }) { bands.append((key, zeros)) }
            }
            return SimulationSummary(series: zeros, bands: bands, cumulativeBands: bands)
        }
        let restart = 1 / meanBlockLength
        let count = Double(residuals.count)
        let means = try dates.map { try buckets.lookup($0).mean }
        var samples = [[Double]](repeating: [Double](repeating: 0, count: max(paths, 0)), count: means.count)
        for p in 0..<max(paths, 0) {
            var index = Int((random.next() * count).rounded(.down))
            for (h, mean) in means.enumerated() {
                if random.next() < restart { index = Int((random.next() * count).rounded(.down)) }
                samples[h][p] = mean + residuals[index]
                index = (index + 1) % residuals.count
            }
        }
        return SimulationSummary.summarize(samples: samples, dates: dates, percentiles: percentiles)
    }
}

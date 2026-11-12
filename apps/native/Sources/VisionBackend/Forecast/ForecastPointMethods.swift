import Foundation

/// The point forecast methods of `calculations/forecast/methods`: each answers one value per
/// forecast date from the daily history.
enum PointForecast {
    private static func zeros(_ dates: [String]) -> [ForecastPoint] { dates.map { ForecastPoint(date: $0, value: 0) } }

    // MARK: simple_avg

    /// The mean of history on the same day of the month.
    static func simpleAverage(history: [DailyNet], dates: [String]) throws -> [ForecastPoint] {
        var byDay: [Int: [Double]] = [:]
        for row in history { byDay[try ForecastCalendar.dayOfMonth(row.date), default: []].append(row.net) }
        let means = byDay.mapValues { values in values.reduce(0, +) / Double(values.count) }
        return try dates.map { ForecastPoint(date: $0, value: means[try ForecastCalendar.dayOfMonth($0)] ?? 0) }
    }

    // MARK: weighted_avg

    /// The same, with a month weighted by its rank in the history (the oldest is 1).
    static func weightedAverage(history: [DailyNet], dates: [String]) throws -> [ForecastPoint] {
        let months = ForecastCalendar.orderedMonthKeys(history)
        let rank = Dictionary(uniqueKeysWithValues: months.enumerated().map { ($1, $0) })
        var buckets: [Int: (weight: Double, weighted: Double)] = [:]
        for row in history {
            let weight = Double((rank[ForecastCalendar.monthKey(row.date)] ?? 0) + 1)
            var bucket = buckets[try ForecastCalendar.dayOfMonth(row.date)] ?? (0, 0)
            bucket.weight += weight
            bucket.weighted += weight * row.net
            buckets[try ForecastCalendar.dayOfMonth(row.date)] = bucket
        }
        return try dates.map { date in
            let bucket = buckets[try ForecastCalendar.dayOfMonth(date)]
            return ForecastPoint(date: date, value: bucket.map { $0.weight > 0 ? $0.weighted / $0.weight : 0 } ?? 0)
        }
    }

    // MARK: ewma

    /// Exponential smoothing over the months, per day of the month.
    static func ewma(history: [DailyNet], dates: [String], alpha: Double = 0.15) throws -> [ForecastPoint] {
        let months = ForecastCalendar.orderedMonthKeys(history)
        var series: [Int: [String: Double]] = [:]
        for row in history {
            series[try ForecastCalendar.dayOfMonth(row.date), default: [:]][ForecastCalendar.monthKey(row.date), default: 0] +=
                row.net
        }
        var levels: [Int: Double] = [:]
        for (day, byMonth) in series {
            var level: Double?
            for month in months {
                guard let x = byMonth[month] else { continue }
                level = level.map { alpha * x + (1 - alpha) * $0 } ?? x
            }
            levels[day] = level ?? 0
        }
        return try dates.map { ForecastPoint(date: $0, value: levels[try ForecastCalendar.dayOfMonth($0)] ?? 0) }
    }

    // MARK: holt_winters

    private static let weekly = 7
    private static let monthly = 30
    private static let grid: [Double] = [0.05, 0.2, 0.4]

    private struct HoltWintersFit {
        let sse: Double
        let level: Double
        let trend: Double
        let weeklySeason: [Double]
        let monthlySeason: [Double]
    }

    private static func fit(_ y: [Double], _ alpha: Double, _ beta: Double, _ g1: Double, _ g2: Double) throws
        -> HoltWintersFit
    {
        let n = y.count
        var s1 = [Double](repeating: 0, count: n)
        var s2 = [Double](repeating: 0, count: n)
        let initialMean = y[0..<monthly].reduce(0, +) / Double(monthly)
        for i in 0..<weekly {
            let deviations = stride(from: i, to: monthly, by: weekly).map { y[$0] - initialMean }
            s1[i] = deviations.isEmpty ? 0 : try ForecastCalendar.decimalMean(deviations)
        }
        for i in 0..<monthly { s2[i] = y[i] - initialMean - s1[i % weekly] }
        var level = initialMean
        var trend = (y[monthly - 1] - y[0]) / Double(monthly)
        var sse = 0.0
        for t in 0..<n {
            let s1Lag = s1[t >= weekly ? t - weekly : t]
            let s2Lag = s2[t >= monthly ? t - monthly : t]
            let yt = y[t]
            let error = yt - (level + trend + s1Lag + s2Lag)
            sse += error * error
            let newLevel = alpha * (yt - s1Lag - s2Lag) + (1 - alpha) * (level + trend)
            let newTrend = beta * (newLevel - level) + (1 - beta) * trend
            s1[t] = g1 * (yt - newLevel - s2Lag) + (1 - g1) * s1Lag
            s2[t] = g2 * (yt - newLevel - s1Lag) + (1 - g2) * s2Lag
            level = newLevel
            trend = newTrend
        }
        return HoltWintersFit(sse: sse, level: level, trend: trend, weeklySeason: s1, monthlySeason: s2)
    }

    /// Double-seasonal additive Holt-Winters, its four parameters chosen from a small grid by
    /// the in-sample squared error.
    static func holtWinters(history: [DailyNet], dates: [String]) throws -> [ForecastPoint] {
        let y = try ForecastCalendar.densify(history).map(\.net)
        guard y.count >= monthly * 2 else { return zeros(dates) }
        var best: HoltWintersFit?
        for a in grid {
            for b in grid {
                for g1 in grid {
                    for g2 in grid {
                        let candidate = try fit(y, a, b, g1, g2)
                        if best.map({ candidate.sse < $0.sse }) ?? true { best = candidate }
                    }
                }
            }
        }
        guard let best else { return zeros(dates) }
        let n = y.count
        return dates.enumerated().map { index, date in
            let h = index + 1
            let value =
                best.level + Double(h) * best.trend + best.weeklySeason[n - weekly + (h - 1) % weekly]
                + best.monthlySeason[n - monthly + (h - 1) % monthly]
            return ForecastPoint(date: date, value: value)
        }
    }

    // MARK: prophet_lite

    private static let weeklyTerms = 3
    private static let yearlyTerms = 10
    private static let ridge = 1.0
    private static let changepointFraction = 0.8
    private static let changepointCount = 10

    private static func features(_ t: Double, _ date: String, _ changepoints: [Double]) throws -> [Double] {
        var row: [Double] = [1, t]
        for changepoint in changepoints { row.append(max(0, t - changepoint)) }
        let weekPhase = (2 * Double.pi * t) / 7
        for k in 1...weeklyTerms {
            row.append(sin(Double(k) * weekPhase))
            row.append(cos(Double(k) * weekPhase))
        }
        let dayOfYear = try CalendarDays.difference(from: "\(date.prefix(4))-01-01", to: date)
        let yearPhase = (2 * Double.pi * Double(dayOfYear)) / 365.25
        for k in 1...yearlyTerms {
            row.append(sin(Double(k) * yearPhase))
            row.append(cos(Double(k) * yearPhase))
        }
        row.append(BelgianHolidays.contains(date) ? 1 : 0)
        return row
    }

    private static func solveRidge(_ x: [[Double]], _ y: [Double], _ lambda: Double) -> [Double] {
        let p = x[0].count
        var xtx = [[Double]](repeating: [Double](repeating: 0, count: p), count: p)
        var xty = [Double](repeating: 0, count: p)
        for (row, target) in zip(x, y) {
            for a in 0..<p {
                xty[a] += row[a] * target
                for b in a..<p { xtx[a][b] += row[a] * row[b] }
            }
        }
        for a in 0..<p {
            for b in (a + 1)..<max(p, a + 1) { xtx[b][a] = xtx[a][b] }
            if a > 0 { xtx[a][a] += lambda }
        }
        return eliminate(xtx, xty)
    }

    private static func eliminate(_ a: [[Double]], _ b: [Double]) -> [Double] {
        let n = a.count
        var m = zip(a, b).map { $0 + [$1] }
        for i in 0..<n {
            var pivot = i
            for k in (i + 1)..<max(n, i + 1) where abs(m[k][i]) > abs(m[pivot][i]) { pivot = k }
            if pivot != i { m.swapAt(i, pivot) }
            let pivotValue = m[i][i]
            if abs(pivotValue) < 1e-12 { continue }
            for k in (i + 1)..<max(n, i + 1) {
                let factor = m[k][i] / pivotValue
                for j in i...n { m[k][j] -= factor * m[i][j] }
            }
        }
        var x = [Double](repeating: 0, count: n)
        for i in stride(from: n - 1, through: 0, by: -1) {
            var sum = m[i][n]
            for j in (i + 1)..<max(n, i + 1) { sum -= m[i][j] * x[j] }
            x[i] = abs(m[i][i]) < 1e-12 ? 0 : sum / m[i][i]
        }
        return x
    }

    /// A ridge regression on a piecewise-linear trend, weekly and yearly Fourier terms and a
    /// Belgian public holiday flag.
    static func prophetLite(history: [DailyNet], dates: [String]) throws -> [ForecastPoint] {
        let dense = try ForecastCalendar.densify(history)
        guard dense.count >= 60, !dates.isEmpty else { return zeros(dates) }
        let start = try CalendarDays.epochDay(dense[0].date)
        let times = try dense.map { Double(try CalendarDays.epochDay($0.date) - start) }
        let changepointEnd = (times.last ?? 0) * changepointFraction
        let changepoints = (1...changepointCount).map { changepointEnd * Double($0) / Double(changepointCount + 1) }
        let x = try zip(times, dense).map { try features($0, $1.date, changepoints) }
        let beta = solveRidge(x, dense.map(\.net), ridge)
        return try dates.map { date in
            let row = try features(Double(try CalendarDays.epochDay(date) - start), date, changepoints)
            var value = 0.0
            for (feature, coefficient) in zip(row, beta) { value += feature * coefficient }
            return ForecastPoint(date: date, value: value)
        }
    }
}

/// `holidays/be.ts`: the Belgian public holidays of a year.
enum BelgianHolidays {
    private static func iso(_ year: Int, _ month: Int, _ day: Int) -> String {
        func pad(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
        return "\(year)-\(pad(month))-\(pad(day))"
    }

    /// Easter Sunday by the anonymous Gregorian computus, as a day number.
    private static func easter(_ year: Int) -> Int {
        let a = year % 19
        let b = year / 100
        let c = year % 100
        let d = b / 4
        let e = b % 4
        let f = (b + 8) / 25
        let g = (b - f + 1) / 3
        let h = (19 * a + b - d - g + 15) % 30
        let i = c / 4
        let k = c % 4
        let l = (32 + 2 * e + 2 * i - h - k) % 7
        let m = (a + 11 * h + 22 * l) / 451
        let month = (h + l - 7 * m + 114) / 31
        let day = (h + l - 7 * m + 114) % 31 + 1
        return ImportInterop.daysFromCivil(year: year, month: month, day: day)
    }

    static func dates(in year: Int) -> Set<String> {
        let easterDay = easter(year)
        func moved(_ days: Int) -> String {
            let day = FormulaSemantics.CalendarDay(dayNumber: easterDay + days)
            return iso(day.year, day.month, day.day)
        }
        return [
            iso(year, 1, 1), moved(1), iso(year, 5, 1), moved(39), moved(50), iso(year, 7, 21), iso(year, 8, 15),
            iso(year, 11, 1), iso(year, 11, 11), iso(year, 12, 25),
        ]
    }

    /// `isBelgianHoliday(date)` for a `YYYY-MM-DD` date.
    static func contains(_ date: String) -> Bool {
        guard let year = Int(date.prefix(4)), date.prefix(4).utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else {
            return false
        }
        return dates(in: year).contains(date)
    }
}

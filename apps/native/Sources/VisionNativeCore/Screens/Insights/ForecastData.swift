import Foundation

public struct InsightForecast: Decodable, Equatable, Sendable {
    public struct Actual: Decodable, Equatable, Sendable {
        public let date: String
        public let net: Decimal?
        public let cumulative: Decimal?
    }
    public struct Point: Decodable, Equatable, Sendable {
        public let date: String
        public let value: Decimal
    }
    public struct Method: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let daily: [Point]
        public let cumulative: [Point]
        public let bands: [String: [Point]]?
        public let cumulative_bands: [String: [Point]]?
        public let error: String?
    }
    public struct Scheduled: Decodable, Equatable, Sendable {
        public let date: String
        public let net: Decimal
    }
    public struct Diagnostics: Decodable, Equatable, Sendable {
        public let history_months: Int
        /// The weights the ensemble applied to each point method, computed on the server.
        public let ensemble_weights: [String: Decimal]?
        public let backtest: [Backtest]
    }
    public struct Backtest: Decodable, Equatable, Sendable, Identifiable {
        public let method_id: String
        public let label: String
        public let mae: Decimal
        public let rmse: Decimal
        public let mape: Decimal?
        public let months: Int
        public let per_month: [BacktestMonth]
        public var id: String { method_id }
    }
    public struct BacktestMonth: Decodable, Equatable, Sendable, Identifiable {
        public let month: String
        public let mae: Decimal
        public let rmse: Decimal
        public let mape: Decimal?
        public let sample_days: Int
        public var id: String { month }
    }
    public let actual: [Actual]
    public let methods: [Method]
    public let scheduled_actual: [Scheduled]
    public let planned: [Scheduled]
    public let diagnostics: Diagnostics?
    public let currency: CurrencyCode
    public let history_months: Int
    public let include_planned: Bool
    public let month: String?
    public let today: String?
    public let window_start: String?
    public let window_end: String?
    /// Inputs left out for want of a stored rate; absent on older cache entries (ADR-216).
    public let unconverted_count: Int?
    public let unconverted_currencies: [CurrencyCode]?
    public var unconvertedCount: Int { unconverted_count ?? 0 }

    /// The server already includes scheduled ledger rows and planned payments in every
    /// method. Adding them again here would count future transactions twice.
    public func series(cumulative: Bool, visible: Set<String>, actualLabel: String)
        -> [InsightChartSeries]
    {
        var result = [
            InsightChartSeries(
                id: "actual", label: actualLabel,
                points: actual.compactMap { point in
                    (cumulative ? point.cumulative : point.net).map {
                        InsightChartPoint(key: point.date, value: $0)
                    }
                })
        ]
        for method in methods where visible.contains(method.id) {
            let points = cumulative ? method.cumulative : method.daily
            result.append(
                InsightChartSeries(
                    id: method.id, label: method.label,
                    points: points.map { InsightChartPoint(key: $0.date, value: $0.value) }))
            guard method.bands != nil,
                let bands = cumulative ? method.cumulative_bands : method.bands, !bands.isEmpty
            else { continue }
            let keys = bands.keys.sorted { percentile($0) < percentile($1) }
            for key in Set([keys.first!, keys.last!]).sorted() {
                let source = bands[key] ?? []
                let values = source.map { point -> InsightChartPoint in
                    InsightChartPoint(key: point.date, value: point.value)
                }
                result.append(
                    InsightChartSeries(
                        id: "\(method.id)__\(key)", label: "\(method.label) \(key.uppercased())",
                        points: values, dashed: true))
            }
        }
        return result
    }

    private func percentile(_ key: String) -> Int { Int(key.dropFirst()) ?? 0 }
    public var defaultMethod: String? {
        let available = methods.filter { $0.error == nil && !$0.daily.isEmpty }
        return available.first(where: { $0.id == "ensemble_imse" })?.id ?? available.first?.id
    }
}

public struct InsightChartSeries: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let points: [InsightChartPoint]
    public let dashed: Bool
    public init(id: String, label: String, points: [InsightChartPoint], dashed: Bool = false) {
        self.id = id
        self.label = label
        self.points = points
        self.dashed = dashed
    }
}

public struct InsightForecastOptions: Equatable, Hashable, Sendable {
    public enum Mode: String, Sendable { case month, rolling }
    public var mode: Mode = .month
    public var rollingDays = 90
    public var includePlanned = false
    public var diagnostics = false
    public init() {}
    public init(route: NativeRoute) {
        mode = route.value("forecastMode") == "rolling" ? .rolling : .month
        let days = Int(route.value("rollingDays") ?? "") ?? 90
        rollingDays = [30, 60, 90, 180].contains(days) ? days : 90
    }
    public var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "include_planned", value: includePlanned ? "true" : "false"),
            URLQueryItem(
                name: "include_backtest", value: mode == .month || diagnostics ? "true" : "false"),
            URLQueryItem(name: "mc_paths", value: "500"),
            URLQueryItem(name: "mc_percentiles", value: "25"),
            URLQueryItem(name: "mc_percentiles", value: "75"),
        ]
        if mode == .rolling {
            items += [
                URLQueryItem(name: "days_back", value: String(rollingDays)),
                URLQueryItem(name: "days_forward", value: String(rollingDays)),
            ]
        }
        return items
    }
    public func applying(to route: NativeRoute) -> NativeRoute {
        var next =
            mode == .rolling
            ? route.setting("forecastMode", to: "rolling") : route.removing("forecastMode")
        next =
            rollingDays == 90
            ? next.removing("rollingDays") : next.setting("rollingDays", to: String(rollingDays))
        return next
    }
}

public struct InsightForecastAccuracy: Decodable, Equatable, Sendable {
    public struct Method: Decodable, Equatable, Sendable, Identifiable {
        public let method_id: String
        public let history: [InsightForecast.BacktestMonth]
        public var id: String { method_id }
    }
    public let methods: [Method]
}

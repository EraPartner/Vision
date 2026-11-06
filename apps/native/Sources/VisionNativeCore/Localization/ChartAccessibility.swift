import Foundation

/// Spoken one-line data summaries for charts, the native counterpart of the web's
/// `components/charts/chartAria.ts`. The web puts them on each chart's `role="img"` label;
/// native charts keep their title as the label and give this summary as the value.
public enum ChartAccessibility {
    /// The chart kinds the web names (`chart.aria.kind.*`).
    public enum Kind: String, CaseIterable, Sendable {
        case area, bar, composed, donut, line, pie
        case stackedBar
        var key: String { "chart.aria.kind." + rawValue }
    }

    /// `summarizeSeriesChart`: bar, line, area, stacked bar and combined charts.
    public static func series(
        _ strings: any Localizing, kind: Kind, categoryCount: Int, seriesLabels: [String?]
    ) -> String {
        let named = seriesLabels.compactMap { $0 }.filter { !$0.isEmpty }
        let base = strings.t(
            categoryCount == 1 ? "chart.aria.seriesOne" : "chart.aria.seriesOther",
            ["kind": strings.t(kind.key), "count": String(categoryCount)])
        guard !named.isEmpty else { return base }
        return base + strings.t("chart.aria.series", ["names": named.joined(separator: ", ")])
    }

    /// `summarizeProportionChart`: pie and donut charts, naming the first six segments.
    public static func proportion(_ strings: any Localizing, kind: Kind, names: [String]) -> String {
        let named = names.filter { !$0.isEmpty }
        let shown = Array(named.prefix(6))
        var out = strings.t(
            names.count == 1 ? "chart.aria.segmentOne" : "chart.aria.segmentOther",
            ["kind": strings.t(kind.key), "count": String(names.count)])
        if !shown.isEmpty {
            out += strings.t("chart.aria.segmentNames", ["names": shown.joined(separator: ", ")])
            if named.count > shown.count {
                out += strings.t("chart.aria.andMore", ["count": String(named.count - shown.count)])
            }
        }
        return out
    }

    /// `summarizeSparkline`: the point count and the value range, rounded to two decimals.
    public static func sparkline(_ strings: any Localizing, values: [Double]) -> String {
        let finite = values.filter(\.isFinite)
        guard let min = finite.min(), let max = finite.max() else { return strings.t("chart.aria.sparklineEmpty") }
        return strings.t(
            finite.count == 1 ? "chart.aria.sparklineOne" : "chart.aria.sparklineOther",
            ["count": String(finite.count), "min": number(min), "max": number(max)])
    }

    /// `Math.round(v * 100) / 100` printed as JavaScript prints a number: no trailing `.0`.
    static func number(_ value: Double) -> String {
        let rounded = (value * 100 + 0.5).rounded(.down) / 100
        if rounded == rounded.rounded(), abs(rounded) < 1e15 { return String(Int64(rounded)) }
        return String(rounded)
    }
}

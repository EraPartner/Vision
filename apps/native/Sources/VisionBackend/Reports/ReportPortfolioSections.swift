import Foundation

/// The portfolio report's sections (`services/reports/sections`), from the data
/// `fetchPortfolioData` returns.
enum ReportPortfolioSections {
    private typealias F = ReportFormat
    private typealias M = ReportMarkup
    private static func escape(_ text: String) -> String { ReportFormat.escape(text) }
    private static func symbol(_ row: JSValue) -> String { row["symbol"].isNullish ? "—" : row["symbol"].s }

    /// `renderPortfolioExecutiveSummary(data, { currency })`.
    static func executiveSummary(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let summary = data["executiveSummary"]
        guard summary.isTruthy else {
            return M.emptySection(
                title: "Portfolio Overview", subtitle: "Key performance indicators",
                message: "Add investments to see the executive summary.", heading: "No portfolio data")
        }
        let gainClass = F.sign(summary["totalGainLoss"].n)
        let first = M.grid([
            M.Card(label: "Total Value", value: F.currency(summary["totalValue"].n, currency)),
            M.Card(label: "Total Invested", value: F.currency(summary["totalInvested"].n, currency)),
            M.Card(
                label: "Gain/loss", value: F.currency(summary["totalGainLoss"].n, currency), cls: gainClass,
                sub: F.percent(summary["returnPct"].n, raw: true), subCls: gainClass),
            M.Card(label: "Dividends", value: F.currency(summary["totalDividends"].n, currency), sub: "period total"),
        ])
        let second = M.grid(
            [
                M.Card(label: "Return %", value: F.percent(summary["returnPct"].n, raw: true), cls: F.sign(summary["returnPct"].n)),
                M.Card(
                    label: "Inflation-Adj. Value",
                    value: summary["inflationAdjustedValue"] == .some(.null)
                        ? "Unavailable" : F.currency(summary["inflationAdjustedValue"].n, currency)),
                M.Card(label: "Holdings", value: summary["holdingsCount"].s, sub: "current active investments"),
            ], columns: 3)
        let holdings = summary["topHoldings"].items
        let rows = holdings.map { row in
            """
<tr>
      <td>\(escape(row["name"].s))</td>
      <td>\(escape(symbol(row)))</td>
      <td class="num">\(F.currency(row["currentValue"].n, currency))</td>
      <td class="num \(F.sign(row["gainLoss"].n))">\(F.currency(row["gainLoss"].n, currency))</td>
    </tr>
"""
        }.joined()
        let table =
            holdings.isEmpty
            ? ""
            : """

        <h3>Current top holdings</h3>
        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th>
            <th class="num">Value (\(escape(currency)))</th>
            <th class="num">Unrealised P/L</th>
          </tr></thead>
          <tbody>\(rows)</tbody>
        </table>
"""
        return M.page(
            title: "Portfolio Overview",
            subtitle: summary["valuationDate"].isTruthy
                ? "Valuation as of \(summary["valuationDate"].s); dividends for the selected period"
                : "Current valuation; dividends for the selected period",
            content: """

      \(first)
      \(second)
      \(table)
""")
    }

    /// `renderPortfolioAllocation(data, { currency })`.
    static func allocation(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let latest = data["snapshots"].items.last
        let breakdown = data["breakdown"].items
        if !latest.isTruthy && breakdown.isEmpty {
            return M.emptySection(
                title: "Asset Allocation", subtitle: "Distribution across asset classes",
                message: "Add investments to see the allocation breakdown.", heading: "No allocation data")
        }
        let classes = F.sorted(M.assetClassBuckets(latest: latest, breakdown: breakdown)) { a, b in b.value - a.value }
        let total = classes.reduce(0) { $0 + $1.value }
        let bars = classes.map { M.Bar(label: $0.label, value: $0.value, formatted: F.currency($0.value, currency)) }
        let rows = classes.map { c in
            let gain = c.value - c.invested
            return """
<tr>
      <td>\(escape(c.label))</td>
      <td class="num">\(F.currency(c.value, currency))</td>
      <td class="num">\(F.currency(c.invested, currency))</td>
      <td class="num">\(F.percent(total > 0 ? c.value / total : 0))</td>
      <td class="num \(gain >= 0 ? "pos" : "neg")">\(F.currency(gain, currency))</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Asset Allocation", subtitle: "Distribution of portfolio value across asset classes",
            content: """

      <div class="chart-wrap">\(M.horizontalBars(bars, maxItems: 8))</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Value</th>
          <th class="num">Invested</th>
          <th class="num">Allocation</th>
          <th class="num">Unrealised P/L</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderTopHoldings(data, { currency })`.
    static func topHoldings(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let breakdown = data["breakdown"].items
        if breakdown.isEmpty {
            return M.emptySection(
                title: "Top Holdings", subtitle: "Largest positions by current value",
                message: "Add investments to see the top holdings.", heading: "No holdings data")
        }
        let sorted = F.sorted(breakdown) { a, b in F.descending(a["currentValue"].n, b["currentValue"].n) }.prefix(15)
        let totalValue = F.decimalSum(breakdown.map { $0["currentValue"].n })
        let rows = sorted.enumerated().map { index, row in
            let value = row["currentValue"].n
            let gain = row["gainLoss"].n
            let share = totalValue > 0 ? value / totalValue * 100 : 0
            return """
<tr>
      <td style="color:hsl(var(--muted));font-size:10px;">\(index + 1)</td>
      <td>\(escape(row["name"].s))</td>
      <td>\(escape(symbol(row)))</td>
      <td><span class="badge badge-neutral">\(escape(F.assetClassLabel(row["assetClass"].s)))</span></td>
      <td class="num">\(F.currency(row["totalInvested"].n, currency))</td>
      <td class="num">\(F.currency(value, currency))</td>
      <td class="num \(F.sign(gain))">\(F.currency(gain, currency))</td>
      <td class="num \(F.sign(gain))">\(F.percent(row["gainLossPercent"].n, raw: true))</td>
      <td class="num" style="color:hsl(var(--muted))">\(JavaScriptNumber.toFixed(share, 1))%</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Top Holdings", subtitle: "Largest positions by current value (top \(sorted.count) of \(breakdown.count))",
            content: """

      <table class="data-table">
        <thead><tr>
          <th>#</th>
          <th>Investment</th>
          <th>Symbol</th>
          <th>Type</th>
          <th class="num">Invested</th>
          <th class="num">Value</th>
          <th class="num">P/L</th>
          <th class="num">Return</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderPerformanceTrend(data, { currency })`.
    static func performanceTrend(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let trend = data["performanceTrend"]
        let points = trend["points"].items
        if !trend.isTruthy || points.isEmpty {
            return M.emptySection(
                title: "Performance Trend", subtitle: "Portfolio value vs. invested capital over time",
                message: "Performance snapshots are generated nightly. Check back tomorrow.", heading: "No snapshot data")
        }
        let chart = M.lineChart(
            [
                ("Portfolio Value", "hsl(var(--chart-1))", points.map { $0["value"].n }),
                ("Invested Capital", "hsl(var(--chart-2))", points.map { $0["invested"].n }),
                ("Inflation-Adj. Value", "hsl(var(--chart-4))", points.map { $0["inflationAdjustedValue"].n }),
            ], labels: points.map { F.monthLabel($0["year"], $0["month"]) }, height: 180)
        let rows = trend["tablePoints"].items.map { point in
            let cls = F.sign(point["gainLoss"].n)
            return """
<tr>
      <td>\(F.monthLabel(point["year"], point["month"]))</td>
      <td class="num">\(F.currency(point["invested"].n, currency))</td>
      <td class="num">\(F.currency(point["value"].n, currency))</td>
      <td class="num \(cls)">\(F.currency(point["gainLoss"].n, currency))</td>
      <td class="num \(cls)">\(F.percent(point["returnPct"].n, raw: true))</td>
    </tr>
"""
        }.joined()
        let table =
            rows.isEmpty
            ? ""
            : """

        <table class="data-table">
          <thead><tr>
            <th>Month</th>
            <th class="num">Invested</th>
            <th class="num">Value</th>
            <th class="num">P/L</th>
            <th class="num">Return %</th>
          </tr></thead>
          <tbody>\(rows)</tbody>
        </table>
"""
        return M.page(
            title: "Performance Trend", subtitle: "Portfolio value vs. invested capital (\(points.count) data points)",
            content: """

      <div class="chart-wrap">\(chart)</div>
      \(table)
""")
    }

    /// `renderAssetClassDetail(data, { currency })`.
    static func assetClassDetail(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let latest = data["snapshots"].items.last
        let breakdown = data["breakdown"].items
        if !latest.isTruthy && breakdown.isEmpty {
            return M.emptySection(
                title: "Asset Class Detail", subtitle: "Invested vs. current value per asset class",
                message: "Add investments to see the asset class breakdown.", heading: "No data")
        }
        let classes = F.sorted(M.assetClassBuckets(latest: latest, breakdown: breakdown)) { a, b in b.value - a.value }
        let chart = M.groupedBars(
            classes.map { ($0.label, ["value": $0.value, "invested": $0.invested]) },
            [
                M.Series(key: "invested", color: "hsl(var(--chart-2))", label: "Invested"),
                M.Series(key: "value", color: "hsl(var(--chart-1))", label: "Value"),
            ])
        let total = classes.reduce(0) { $0 + $1.value }
        let rows = classes.map { c in
            let gain = c.value - c.invested
            let cls = F.sign(gain)
            return """
<tr>
      <td>\(escape(c.label))</td>
      <td class="num">\(F.currency(c.invested, currency))</td>
      <td class="num">\(F.currency(c.value, currency))</td>
      <td class="num \(cls)">\(F.currency(gain, currency))</td>
      <td class="num \(cls)">\(F.percent(c.invested > 0 ? gain / c.invested * 100 : 0, raw: true))</td>
      <td class="num" style="color:hsl(var(--muted))">\(JavaScriptNumber.toFixed(total > 0 ? c.value / total * 100 : 0, 1))%</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Asset Class Detail", subtitle: "Invested capital vs. current value per asset class",
            content: """

      <div class="chart-wrap">\(chart)</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Invested</th>
          <th class="num">Value</th>
          <th class="num">P/L</th>
          <th class="num">Return</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderDividendIncome(data, { currency })`.
    static func dividendIncome(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let dividends = data["dividends"]
        let byMonth = dividends["byMonth"].items
        let byInvestment = dividends["byInvestment"].items
        let unconverted = dividends["unconvertedCount"].isNullish ? 0 : dividends["unconvertedCount"].n
        let currencies = dividends["unconvertedCurrencies"].items.map { $0 == .null ? "" : $0.s }.joined(separator: ", ")
        let warning =
            unconverted > 0
            ? "<p style=\"color:hsl(var(--warning, 38 92% 50%));font-size:11px;margin:0 0 12px;\"><strong>Incomplete:</strong> no exchange rate was available for \(escape(currencies)); \(unconverted == 1 ? "1 dividend was" : "\(JavaScriptNumber.text(unconverted)) dividends were") left out of these figures.</p>"
            : ""
        if byMonth.isEmpty && byInvestment.isEmpty && unconverted == 0 {
            return M.emptySection(
                title: "Dividend Income", subtitle: "Dividend cash flows over the selected period",
                message: "No dividend transactions found for the selected period.", heading: "No dividend data")
        }
        let total = F.decimalSum(byMonth.map { $0["amount"].n })
        let chart = M.groupedBars(
            byMonth.map { (F.monthLabel($0["year"], $0["month"]), ["amount": $0["amount"].n]) },
            [M.Series(key: "amount", color: "hsl(var(--chart-3))", label: "Dividends")])
        let rows = byInvestment.prefix(10).map { row in
            """
<tr>
    <td>\(escape(row["name"].s))</td>
    <td>\(escape(symbol(row)))</td>
    <td>\(escape(row["assetClass"].s))</td>
    <td class="num">\(F.currency(row["total"].n, currency))</td>
  </tr>
"""
        }.joined()
        let table =
            rows.isEmpty
            ? ""
            : """

        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th><th>Type</th>
            <th class="num">Total Dividends</th>
          </tr></thead>
          <tbody>\(rows)</tbody>
        </table>
"""
        return M.page(
            title: "Dividend Income",
            subtitle: "Total: \(F.currency(total, currency)) across \(byMonth.count) month\(byMonth.count == 1 ? "" : "s")",
            content: """

      \(warning)
      <div class="chart-wrap">\(chart)</div>
      \(table)
""")
    }
}

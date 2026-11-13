import Foundation

/// The shared markup of `services/reports/sectionHelpers.ts`: the section page, notices, KPI
/// cards and the SVG charts. The strings are the TypeScript's, white space included.
enum ReportMarkup {
    private static func escape(_ text: String) -> String { ReportFormat.escape(text) }
    private static func fixed(_ value: Double, _ digits: Int) -> String { JavaScriptNumber.toFixed(value, digits) }
    private static func text(_ value: Double) -> String { JavaScriptNumber.text(value) }

    /// `sectionPage({ title, subtitle, content, pageBreak })`.
    static func page(title: String, subtitle: String, content: String, pageBreak: Bool = false) -> String {
        """

    <div class="\(pageBreak ? "page page-break" : "page")">
      <div class="section-title">\(escape(title))</div>
      <div class="section-subtitle">\(escape(subtitle))</div>
      <hr class="section-divider">
      \(content)
    </div>
"""
    }

    /// `emptyNotice(message)`.
    static func emptyNotice(_ message: String) -> String { "<div class=\"empty-notice\">\(escape(message))</div>" }

    /// `emptySection({ title, subtitle, message, heading, pageBreak })`.
    static func emptySection(title: String, subtitle: String, message: String, heading: String? = nil, pageBreak: Bool = false) -> String {
        let content: String
        if let heading, !heading.isEmpty {
            content = "<div class=\"placeholder-notice\"><strong>\(escape(heading))</strong>\(escape(message))</div>"
        } else {
            content = emptyNotice(message)
        }
        return page(title: title, subtitle: subtitle, content: content, pageBreak: pageBreak)
    }

    /// `comparisonChartPair({ filteredLabel, filteredChart, allLabel, allChart })`.
    static func chartPair(filteredLabel: String, filteredChart: String, allLabel: String, allChart: String) -> String {
        """

      <div class="chart-pair">
        <div>
          <div class="chart-pair-label">\(escape(filteredLabel))</div>
          \(filteredChart)
        </div>
        <div>
          <div class="chart-pair-label">\(escape(allLabel))</div>
          \(allChart)
        </div>
      </div>
"""
    }

    /// `filterNotice({ filteredCount, excludedCount, singular, plural })`.
    static func filterNotice(filteredCount: Int, excludedCount: Int, singular: String, plural: String) -> String {
        "<div class=\"filter-notice\">Table shows \(filteredCount) \(escape(filteredCount == 1 ? singular : plural)) matching active filters. \(excludedCount) \(escape(excludedCount == 1 ? singular : plural)) excluded — see \"All data\" chart above.</div>"
    }

    /// One KPI card (`KpiCardSpec`). `subHTML` is markup and wins over the plain `sub`.
    struct Card {
        var label: String
        var value: String
        var cls = ""
        var sub: String?
        var subCls = ""
        var subHTML: String?
        var valueStyle: String?
    }

    /// `kpiCard(spec)`.
    static func card(_ card: Card) -> String {
        let subInner = card.subHTML ?? card.sub.map(escape)
        let subLine = subInner.map { "<div class=\"\(card.subCls.isEmpty ? "kpi-sub" : "kpi-sub \(card.subCls)")\">\($0)</div>" } ?? ""
        let style = (card.valueStyle?.isEmpty ?? true) ? "" : " style=\"\(card.valueStyle ?? "")\""
        return """

    <div class="kpi-card">
      <div class="kpi-label">\(escape(card.label))</div>
      <div class="\(card.cls.isEmpty ? "kpi-value" : "kpi-value \(card.cls)")"\(style)>\(escape(card.value))</div>
      \(subLine)
    </div>
"""
    }

    /// `kpiGrid(cards, { cols, style })`.
    static func grid(_ cards: [Card], columns: Int = 4, style: String? = nil) -> String {
        let styleAttribute = (style?.isEmpty ?? true) ? "" : " style=\"\(style ?? "")\""
        return "<div class=\"\(columns == 3 ? "kpi-grid kpi-grid-3" : "kpi-grid")\"\(styleAttribute)>\(cards.map(card).joined())</div>"
    }

    // MARK: Charts

    private static let chartColors = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"]

    private static func emptyChart(_ width: Double, _ height: Double) -> String {
        "<svg viewBox=\"0 0 \(text(width)) \(text(height))\" width=\"100%\" xmlns=\"http://www.w3.org/2000/svg\"><text x=\"\(text(width / 2))\" y=\"\(text(height / 2))\" text-anchor=\"middle\" fill=\"hsl(var(--muted))\" font-size=\"12\">No data</text></svg>"
    }

    /// Every Nth axis label is drawn as the count grows.
    private static func labelStep(_ count: Int) -> Int { count > 12 ? 3 : count > 6 ? 2 : 1 }

    struct Bar {
        var label: String
        var value: Double
        var formatted: String = ""
    }

    /// `svgHorizontalBars(items, { maxItems })`.
    static func horizontalBars(_ items: [Bar], maxItems: Int = 10) -> String {
        let top = Array(items.prefix(maxItems))
        if top.isEmpty {
            return "<svg viewBox=\"0 0 500 40\" width=\"100%\" xmlns=\"http://www.w3.org/2000/svg\"><text x=\"250\" y=\"22\" text-anchor=\"middle\" fill=\"hsl(var(--muted))\" font-size=\"12\">No data</text></svg>"
        }
        let rowHeight = 24
        let height = top.count * rowHeight + 8
        let width = 500
        let labelWidth = 160
        let barArea = Double(width - labelWidth - 70)
        let maxValue = ReportFormat.maximum(top.map { Swift.abs($0.value) } + [1])
        var rows = ""
        for (index, item) in top.enumerated() {
            let y = 4 + index * rowHeight
            let barHeight = 14
            let barWidth = ReportFormat.maximum([2, Swift.abs(item.value) / maxValue * barArea])
            let color = chartColors[index % chartColors.count]
            let units = Array(item.label.utf16)
            let label = units.count > 26 ? String(decoding: Array(units.prefix(24)), as: UTF16.self) + "\u{2026}" : item.label
            rows += "<text x=\"\(labelWidth - 4)\" y=\"\(y + barHeight - 2)\" text-anchor=\"end\" font-size=\"10\" fill=\"hsl(var(--text))\">\(escape(label))</text>"
            rows += "<rect x=\"\(labelWidth)\" y=\"\(y)\" width=\"\(fixed(barWidth, 1))\" height=\"\(barHeight)\" fill=\"hsl(var(\(color)))\" rx=\"3\" opacity=\"0.8\"/>"
            rows += "<text x=\"\(fixed(Double(labelWidth) + barWidth + 6, 1))\" y=\"\(y + barHeight - 2)\" font-size=\"10\" fill=\"hsl(var(--muted))\">\(escape(item.formatted))</text>"
        }
        return "<svg viewBox=\"0 0 \(width) \(height)\" width=\"100%\" xmlns=\"http://www.w3.org/2000/svg\">\(rows)</svg>"
    }

    struct Series {
        var key: String
        var color: String
        var label: String
        /// `opacity: null` leaves the attribute out; otherwise bars are drawn at 0.85.
        var opaque = false
    }

    struct BarLayout {
        var topPadding: Double = 18
        var maxBarWidth: Double = 14
        var barGap: Double = 1
        var legendRectY = 4
        var legendTextY = 11
    }

    /// `svgGenericGroupedBarChart(groups, seriesDefs, opts)`. A group is its label and the
    /// value of each series by key.
    static func groupedBars(_ groups: [(label: String, values: [String: Double])], _ series: [Series], _ layout: BarLayout = BarLayout()) -> String {
        let width = 500.0
        let height = 160.0
        let padLeft = 10.0
        let padRight = 10.0
        let chartWidth = width - padLeft - padRight
        let chartHeight = height - layout.topPadding - 28
        if groups.isEmpty || series.isEmpty { return emptyChart(width, height) }
        // `nanToZero(Number(value))`: a missing or NaN value is zero.
        func value(_ group: [String: Double], _ key: String) -> Double {
            let number = group[key] ?? .nan
            return Swift.abs(number.isNaN ? 0 : number)
        }
        let maxValue = ReportFormat.maximum(groups.flatMap { group in series.map { value(group.values, $0.key) } } + [1])
        let groupWidth = chartWidth / Double(groups.count)
        let barWidth = Swift.max(3, Swift.min(layout.maxBarWidth, (groupWidth - 6) / Double(series.count)))
        let baseline = layout.topPadding + chartHeight
        var rects = "<line x1=\"\(text(padLeft))\" y1=\"\(text(baseline))\" x2=\"\(text(width - padRight))\" y2=\"\(text(baseline))\" stroke=\"hsl(var(--border))\" stroke-width=\"1\"/>"
        var labels = ""
        let step = labelStep(groups.count)
        for (index, group) in groups.enumerated() {
            let center = padLeft + Double(index) * groupWidth + groupWidth / 2
            let groupTotal = Double(series.count) * barWidth + Double(series.count - 1) * layout.barGap
            var startX = center - groupTotal / 2
            for definition in series {
                let barHeight = Swift.max(1, value(group.values, definition.key) / maxValue * chartHeight)
                let opacity = definition.opaque ? "" : " opacity=\"0.85\""
                rects += "<rect x=\"\(fixed(startX, 1))\" y=\"\(fixed(baseline - barHeight, 1))\" width=\"\(fixed(barWidth, 1))\" height=\"\(fixed(barHeight, 1))\" fill=\"\(definition.color)\" rx=\"2\"\(opacity)/>"
                startX += barWidth + layout.barGap
            }
            if index % step == 0 {
                labels += "<text x=\"\(fixed(center, 1))\" y=\"\(fixed(height - 6, 1))\" text-anchor=\"middle\" font-size=\"8.5\" fill=\"hsl(var(--muted))\">\(escape(group.label))</text>"
            }
        }
        var legend = ""
        var legendX = 10
        for definition in series {
            legend += "<rect x=\"\(legendX)\" y=\"\(layout.legendRectY)\" width=\"8\" height=\"8\" rx=\"2\" fill=\"\(definition.color)\"/>"
            legend += "<text x=\"\(legendX + 10)\" y=\"\(layout.legendTextY)\" font-size=\"8\" fill=\"hsl(var(--muted))\">\(escape(definition.label))</text>"
            legendX += 70
        }
        return "<svg viewBox=\"0 0 \(text(width)) \(text(height))\" width=\"100%\" xmlns=\"http://www.w3.org/2000/svg\">\(legend)\(rects)\(labels)</svg>"
    }

    /// `svgGroupedBarChart(groups)`: income against spending per month.
    static func incomeSpendingBars(_ groups: [(label: String, income: Double, spending: Double)]) -> String {
        groupedBars(
            groups.map { ($0.label, ["income": $0.income, "spending": $0.spending]) },
            [
                Series(key: "income", color: "hsl(var(--success))", label: "Income", opaque: true),
                Series(key: "spending", color: "hsl(var(--expense))", label: "Expenses"),
            ],
            BarLayout(topPadding: 12, maxBarWidth: 18, barGap: 2, legendRectY: 0, legendTextY: 7))
    }

    /// `svgLineChart(series, { labels, height })`.
    static func lineChart(_ series: [(label: String, color: String, values: [Double])], labels: [String], height: Double = 160) -> String {
        let width = 500.0
        let padLeft = 10.0
        let chartWidth = width - padLeft - 10
        let chartHeight = height - 18 - 28
        let all = series.flatMap(\.values)
        if all.isEmpty || labels.isEmpty { return emptyChart(width, height) }
        let maxValue = ReportFormat.maximum(all.map { Swift.abs($0) } + [1])
        let count = labels.count
        let baseline = 18 + chartHeight
        func x(_ index: Int) -> Double { padLeft + Double(index) / Double(Swift.max(count - 1, 1)) * chartWidth }
        func y(_ value: Double) -> Double { baseline - value / maxValue * chartHeight }
        var paths = ""
        var dots = ""
        for line in series {
            let points = line.values.enumerated().map { "\(fixed(x($0.offset), 1)),\(fixed(y($0.element), 1))" }
            paths += "<polyline points=\"\(points.joined(separator: " "))\" fill=\"none\" stroke=\"\(line.color)\" stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>"
            for (index, value) in line.values.enumerated() {
                dots += "<circle cx=\"\(fixed(x(index), 1))\" cy=\"\(fixed(y(value), 1))\" r=\"2.5\" fill=\"\(line.color)\"/>"
            }
        }
        let axis = "<line x1=\"\(text(padLeft))\" y1=\"\(text(baseline))\" x2=\"\(text(width - 10))\" y2=\"\(text(baseline))\" stroke=\"hsl(var(--border))\" stroke-width=\"1\"/>"
        var axisLabels = ""
        for index in stride(from: 0, to: count, by: labelStep(count)) {
            axisLabels += "<text x=\"\(fixed(x(index), 1))\" y=\"\(fixed(height - 6, 1))\" text-anchor=\"middle\" font-size=\"8.5\" fill=\"hsl(var(--muted))\">\(escape(labels[index]))</text>"
        }
        var legend = ""
        var legendX = 10
        for line in series {
            legend += "<line x1=\"\(legendX)\" y1=\"8\" x2=\"\(legendX + 16)\" y2=\"8\" stroke=\"\(line.color)\" stroke-width=\"2\"/>"
            legend += "<text x=\"\(legendX + 20)\" y=\"11\" font-size=\"8\" fill=\"hsl(var(--muted))\">\(escape(line.label))</text>"
            legendX += 80
        }
        return "<svg viewBox=\"0 0 \(text(width)) \(text(height))\" width=\"100%\" xmlns=\"http://www.w3.org/2000/svg\">\(legend)\(axis)\(paths)\(dots)\(axisLabels)</svg>"
    }

    /// One allocation bucket: a label with its current value and invested amount.
    struct Bucket {
        var label: String
        var value: Double
        var invested: Double
    }

    /// `buildAssetClassBuckets(latest, breakdown)`.
    static func assetClassBuckets(latest: JSValue?, breakdown: [JSValue]) -> [Bucket] {
        var buckets: [Bucket] = []
        if latest.isTruthy {
            func amount(_ key: String) -> Double { latest[key].isNullish ? 0 : latest[key].n }
            func add(_ label: String, _ value: String, _ invested: String) {
                let current = amount(value)
                let total = amount(invested)
                if current > 0 || total > 0 { buckets.append(Bucket(label: label, value: current, invested: total)) }
            }
            add("Stocks & ETFs", "stocks_etfs_value", "stocks_etfs_invested")
            add("Crypto", "crypto_value", "crypto_invested")
            add("Metals", "metals_value", "metals_invested")
            let cash = amount("cash_value")
            if cash > 0 { buckets.append(Bucket(label: "Cash / Savings", value: cash, invested: cash)) }
            return buckets
        }
        var order: [String] = []
        var grouped: [String: Bucket] = [:]
        for investment in breakdown {
            let assetClass = investment["assetClass"].s
            if grouped[assetClass] == nil {
                order.append(assetClass)
                grouped[assetClass] = Bucket(label: ReportFormat.assetClassLabel(assetClass, plural: true), value: 0, invested: 0)
            }
            grouped[assetClass]?.value += investment["currentValue"].n
            grouped[assetClass]?.invested += investment["totalInvested"].n
        }
        return order.compactMap { grouped[$0] }
    }
}

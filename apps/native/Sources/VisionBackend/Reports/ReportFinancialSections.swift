import Foundation

/// A report period (`Period` of `services/reports/dataFetcher.ts`).
enum ReportPeriod: Equatable, Sendable {
    case yearToDate
    case rolling(months: Double)
    case custom(from: String, to: String)
    case year(Double)
    /// Any other kind: all time.
    case allTime

    /// The period of a request body.
    init(_ wire: JSValue?) {
        switch wire["kind"]?.stringValue {
        case "ytd": self = .yearToDate
        case "rolling": self = .rolling(months: wire["months"].n)
        case "custom": self = .custom(from: wire["from"].s, to: wire["to"].s)
        case "year": self = .year(wire["year"].n)
        default: self = .allTime
        }
    }
}

/// What every section renderer receives beside its data (`SectionContext`), and the clock
/// and zones the TypeScript reads from the process.
struct ReportContext {
    var currency: String
    var period: ReportPeriod
    /// "Now", for year-to-date and rolling periods.
    var nowMs: Int
    var zone: AppTimeZone
    /// The machine's zone: a date and time without a zone is shown as its day there.
    var localZone: TimeZone = .current
}

/// The financial report's sections (`services/reports/sections`), from the data
/// `fetchFinancialData` returns.
enum ReportFinancialSections {
    private typealias F = ReportFormat
    private typealias M = ReportMarkup
    private static func escape(_ text: String) -> String { ReportFormat.escape(text) }

    /// `filterMonthsByPeriod(months, period)`.
    static func months(_ months: JSValue?, in context: ReportContext) -> [JSValue] {
        let rows = months.items
        if rows.isEmpty { return [] }
        let now = context.zone.parts(atEpochMilliseconds: context.nowMs)
        switch context.period {
        case .yearToDate:
            return rows.filter { $0["year"].n == Double(now.year) }
        case .rolling(let count):
            // `Date.UTC` truncates its arguments; a month count that is not finite matches nothing.
            guard count.isFinite else { return [] }
            let cutoff = CalendarDays.utc(year: now.year, monthIndex: now.month - Int(count), day: 1)
            return rows.filter { row in
                let year = row["year"].n
                let month = row["month"].n
                guard year.isFinite, month.isFinite else { return false }
                return CalendarDays.utc(year: Int(year), monthIndex: Int(month) - 1, day: 1) >= cutoff
            }
        case .custom(let from, let to):
            let lower = Array(from.utf16.prefix(7))
            let upper = Array(to.utf16.prefix(7))
            return rows.filter { row in
                let month = row["month"].s
                let key = Array("\(row["year"].s)-\(String(repeating: "0", count: max(0, 2 - month.utf16.count)))\(month)".utf16)
                return !key.lexicographicallyPrecedes(lower) && !upper.lexicographicallyPrecedes(key)
            }
        case .year(let year):
            return rows.filter { $0["year"].n == year }
        case .allTime:
            return rows
        }
    }

    private static func sum(_ rows: [JSValue], _ key: String) -> Double { rows.reduce(0) { $0 + $1[key].n } }
    private static func plural(_ count: Int) -> String { count != 1 ? "s" : "" }

    /// `renderExecutiveSummary(data, { currency, period })`.
    static func executiveSummary(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        guard data["monthly"].isTruthy else {
            return M.emptySection(
                title: "Executive Summary", subtitle: "Period overview — income, expenses & net position",
                message: "Monthly totals could not be loaded. Retry the report.", heading: "Data unavailable")
        }
        let months = months(data["monthly"]["months"], in: context)
        let totalIncome = sum(months, "total_income")
        let totalSpending = sum(months, "total_spending")
        let netAmount = sum(months, "net_amount")
        let txCount = sum(months, "transaction_count")
        let count = Double(months.count)
        let averageSpending = months.isEmpty ? 0 : abs(totalSpending) / count
        let averageIncome = months.isEmpty ? 0 : totalIncome / count

        let kpi = M.grid([
            M.Card(label: "Total Income", value: F.currency(totalIncome, currency), cls: "pos", sub: "\(months.count) month\(plural(months.count))"),
            M.Card(label: "Total Expenses", value: F.currency(abs(totalSpending), currency), cls: "neg"),
            M.Card(label: "Net Position", value: F.currency(netAmount, currency), cls: F.sign(netAmount)),
            M.Card(
                label: "Transactions", value: F.count(txCount),
                sub: "avg \(JavaScriptNumber.text(JavaScriptNumber.round(txCount / Double(max(months.count, 1)))))/mo"),
        ])
        let averages = M.grid(
            [
                M.Card(label: "Avg Monthly Income", value: F.currency(averageIncome, currency), cls: "pos"),
                M.Card(label: "Avg Monthly Expenses", value: F.currency(averageSpending, currency), cls: "neg"),
                M.Card(
                    label: "Avg Monthly Net", value: F.currency(averageIncome - averageSpending, currency),
                    cls: F.sign(averageIncome - averageSpending)),
            ], columns: 3, style: "margin-top:0")

        let rows = months.reversed().prefix(24).map { m in
            """

      <tr>
        <td>\(escape(F.monthLabel(m["year"], m["month"])))</td>
        <td class="num pos">\(escape(F.currency(m["total_income"].n, currency)))</td>
        <td class="num neg">\(escape(F.currency(abs(m["total_spending"].n), currency)))</td>
        <td class="num \(F.sign(m["net_amount"].n))">\(escape(F.currency(m["net_amount"].n, currency)))</td>
        <td class="num">\(m["transaction_count"].s)</td>
      </tr>
"""
        }.joined()
        let table =
            months.isEmpty
            ? M.emptyNotice("No transactions in selected period.")
            : """

    <table class="data-table" style="margin-top:24px">
      <thead>
        <tr>
          <th>Month</th>
          <th class="num">Income</th>
          <th class="num">Expenses</th>
          <th class="num">Net</th>
          <th class="num">Txns</th>
        </tr>
      </thead>
      <tbody>\(rows)</tbody>
    </table>
"""

        var impact = ""
        if data["filteredMonthly"].isTruthy {
            let filtered = Self.months(data["filteredMonthly"]["months"], in: context)
            let fIncome = sum(filtered, "total_income")
            let fSpending = sum(filtered, "total_spending")
            let fNet = sum(filtered, "net_amount")
            let fCount = sum(filtered, "transaction_count")
            func difference(_ value: Double, isCount: Bool = false) -> String {
                if value == 0 { return "<span class=\"badge badge-neutral\">—</span>" }
                let sign = value > 0 ? "+" : ""
                let formatted = isCount ? "\(sign)\(JavaScriptNumber.text(value))" : "\(sign)\(F.currency(value, currency))"
                let percent = isCount && txCount != 0 ? " (\(F.percent(value / txCount * 100, raw: true)))" : ""
                return "<span class=\"badge \(value > 0 ? "badge-pos" : "badge-neg")\">\(escape(formatted + percent))</span>"
            }
            let lines: [(label: String, filtered: String, all: String, difference: String)] = [
                ("Total Income", F.currency(fIncome, currency), F.currency(totalIncome, currency), difference(fIncome - totalIncome)),
                (
                    "Total Expenses", F.currency(abs(fSpending), currency), F.currency(abs(totalSpending), currency),
                    difference(abs(fSpending) - abs(totalSpending))
                ),
                ("Net Position", F.currency(fNet, currency), F.currency(netAmount, currency), difference(fNet - netAmount)),
                ("Transactions", F.count(fCount), F.count(txCount), difference(fCount - txCount, isCount: true)),
            ]
            let impactRows = lines.map { line in
                """

      <tr>
        <td>\(escape(line.label))</td>
        <td class="num">\(escape(line.filtered))</td>
        <td class="num">\(escape(line.all))</td>
        <td class="num">\(line.difference)</td>
      </tr>
"""
            }.joined()
            impact = """

      <div class="filter-impact">
        <div class="filter-impact-title">Filter Impact</div>
        <div class="filter-impact-subtitle">Comparison of filtered view vs. all data for selected period</div>
        <table class="filter-impact-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th class="num">With Filters</th>
              <th class="num">All Data</th>
              <th class="num">Difference</th>
            </tr>
          </thead>
          <tbody>\(impactRows)</tbody>
        </table>
      </div>
"""
        }

        return M.page(
            title: "Executive Summary", subtitle: "Period overview — income, expenses & net position",
            content: """

      \(kpi)
      \(averages)
      \(table)
      \(impact)
""")
    }

    /// `renderCashflowTrend(data, { currency, period })`.
    static func cashflowTrend(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        guard data["monthly"].isTruthy else {
            return M.emptySection(
                title: "Cashflow Trend", subtitle: "Monthly income vs. expenses",
                message: "Monthly totals could not be loaded. Retry the report.", heading: "Data unavailable", pageBreak: true)
        }
        let months = months(data["monthly"]["months"], in: context)
        if months.isEmpty {
            return M.emptySection(
                title: "Cashflow Trend", subtitle: "Monthly income vs. expenses", message: "No data for selected period.",
                pageBreak: true)
        }
        let chart = M.incomeSpendingBars(
            months.map { (F.monthLabel($0["year"], $0["month"]), $0["total_income"].n, $0["total_spending"].n) })
        let rows = months.reversed().map { m in
            let net = m["net_amount"].n
            return """

      <tr>
        <td>\(escape(F.monthLabel(m["year"], m["month"])))</td>
        <td class="num pos">\(escape(F.currency(m["total_income"].n, currency)))</td>
        <td class="num neg">\(escape(F.currency(abs(m["total_spending"].n), currency)))</td>
        <td class="num \(F.sign(net))">\(escape(F.currency(net, currency)))</td>
        <td class="num">\(m["transaction_count"].s)</td>
      </tr>
"""
        }.joined()
        return M.page(
            title: "Cashflow Trend", subtitle: "Monthly income vs. expenses — \(months.count) month\(plural(months.count))",
            content: """

      <div class="chart-wrap">\(chart)</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Month</th>
            <th class="num">Income</th>
            <th class="num">Expenses</th>
            <th class="num">Net</th>
            <th class="num">Txns</th>
          </tr>
        </thead>
        <tbody>\(rows)</tbody>
      </table>
""", pageBreak: true)
    }

    private static func byAbsoluteTotal(_ rows: [JSValue]) -> [JSValue] {
        F.sorted(rows) { a, b in abs(b["total"].n) - abs(a["total"].n) }
    }

    /// `renderCategoryBreakdown(data, { currency })`.
    static func categoryBreakdown(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let categories = data["categories"]["categories"].items
        let excluded = data["exclusions"]["categoryIds"].items
        let hasExclusions = !excluded.isEmpty || !data["exclusions"]["recipientIds"].items.isEmpty
        if categories.isEmpty {
            return M.emptySection(
                title: "Category Breakdown", subtitle: "Spending by category", message: "No category data available.",
                pageBreak: true)
        }
        let sorted = byAbsoluteTotal(categories)
        let filtered = hasExclusions ? byAbsoluteTotal(data["filteredCategories"]["categories"].items) : nil
        func bars(_ rows: [JSValue]) -> [M.Bar] {
            rows.prefix(10).map { M.Bar(label: $0["name"].s, value: abs($0["total"].n), formatted: F.currency(abs($0["total"].n), currency)) }
        }
        func noun(_ count: Int) -> String { count == 1 ? "y" : "ies" }
        let chart: String
        if let filtered {
            chart = M.chartPair(
                filteredLabel: "With active filters (\(filtered.count) categor\(noun(filtered.count)))",
                filteredChart: M.horizontalBars(bars(filtered)),
                allLabel: "All data (\(sorted.count) categor\(noun(sorted.count)))", allChart: M.horizontalBars(bars(sorted)))
        } else {
            chart = "<div class=\"chart-wrap\">\(M.horizontalBars(bars(sorted)))</div>"
        }
        let source = filtered ?? sorted
        let rows = source.prefix(20).enumerated().map { index, c in
            let total = abs(c["total"].n)
            let average = c["count"].n > 0 ? total / c["count"].n : 0
            return """

      <tr>
        <td style="color:hsl(var(--muted));font-size:10px">\(index + 1)</td>
        <td>\(escape(c["name"].s))</td>
        <td class="num neg">\(escape(F.currency(total, currency)))</td>
        <td class="num">\(c["count"].s)</td>
        <td class="num">\(escape(F.currency(average, currency)))</td>
      </tr>
"""
        }.joined()
        let note =
            source.count > 20
            ? "<p style=\"font-size:10px;color:hsl(var(--muted));margin-top:8px\">Showing top 20 of \(source.count) categories by spend.</p>"
            : ""
        let notice =
            hasExclusions
            ? M.filterNotice(filteredCount: filtered?.count ?? 0, excludedCount: excluded.count, singular: "category", plural: "categories")
            : ""
        return """
\(M.page(title: "Category Breakdown", subtitle: "Top spending categories for the selected period", content: chart, pageBreak: true))
    <div class="page-continuation">
      \(notice)
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Category</th>
            <th class="num">Total Spent</th>
            <th class="num">Txns</th>
            <th class="num">Avg/Txn</th>
          </tr>
        </thead>
        <tbody>\(rows)</tbody>
      </table>
      \(note)
    </div>
"""
    }

    /// `renderTopRecipients(data, { currency })`.
    static func topRecipients(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let merchants = data["recipients"]["topMerchants"].items
        let excluded = data["exclusions"]["recipientIds"].items
        let hasExclusions = !excluded.isEmpty || !data["exclusions"]["categoryIds"].items.isEmpty
        let monthOverMonth = (hasExclusions ? data["filteredRecipients"] : data["recipients"])["monthOverMonth"].items
        if merchants.isEmpty {
            return M.emptySection(
                title: "Top Recipients", subtitle: "Merchants by total spend", message: "No recipient data available.",
                pageBreak: true)
        }
        let filtered = hasExclusions ? data["filteredRecipients"]["topMerchants"].items : nil
        func bars(_ rows: [JSValue]) -> [M.Bar] {
            rows.prefix(10).map { M.Bar(label: $0["name"].s, value: $0["totalSpend"].n, formatted: F.currency($0["totalSpend"].n, currency)) }
        }
        func noun(_ count: Int) -> String { count == 1 ? "" : "s" }
        let chart: String
        if let filtered {
            chart = M.chartPair(
                filteredLabel: "With active filters (\(filtered.count) recipient\(noun(filtered.count)))",
                filteredChart: M.horizontalBars(bars(filtered)),
                allLabel: "All data (\(merchants.count) recipient\(noun(merchants.count)))", allChart: M.horizontalBars(bars(merchants)))
        } else {
            chart = "<div class=\"chart-wrap\">\(M.horizontalBars(bars(merchants)))</div>"
        }
        let source = filtered ?? merchants
        let rows = source.prefix(15).enumerated().map { index, m in
            """

      <tr>
        <td style="color:hsl(var(--muted));font-size:10px">\(index + 1)</td>
        <td>\(escape(m["name"].s))</td>
        <td class="num neg">\(escape(F.currency(m["totalSpend"].n, currency)))</td>
        <td class="num">\(m["transactionCount"].s)</td>
        <td class="num">\(escape(F.currency(m["avgAmount"].n, currency)))</td>
        <td style="font-size:10px;color:hsl(var(--muted))">\(escape(F.date(m["lastSeen"], zone: context.localZone)))</td>
      </tr>
"""
        }.joined()
        let note =
            source.count > 15
            ? "<p style=\"font-size:10px;color:hsl(var(--muted));margin-top:8px\">Showing top 15 of \(source.count) recipients.</p>" : ""
        let notice =
            hasExclusions
            ? M.filterNotice(filteredCount: filtered?.count ?? 0, excludedCount: excluded.count, singular: "recipient", plural: "recipients")
            : ""
        var change = ""
        if !monthOverMonth.isEmpty {
            let changeRows = monthOverMonth.prefix(8).map { m in
                let delta = m["changePercent"].n
                let badge = delta > 10 ? "badge-neg" : delta < -10 ? "badge-pos" : "badge-neutral"
                let arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "—"
                return """

        <tr>
          <td>\(escape(m["name"].s))</td>
          <td class="num neg">\(escape(F.currency(m["currentSpend"].n, currency)))</td>
          <td class="num">\(escape(F.currency(m["previousSpend"].n, currency)))</td>
          <td class="num"><span class="badge \(badge)">\(arrow) \(escape(F.percent(delta, raw: true)))</span></td>
        </tr>
"""
            }.joined()
            change = """

      <div style="margin-top:24px">
        <div class="section-title" style="font-size:14px">Month-over-Month</div>
        <div class="section-subtitle" style="margin-bottom:12px">Current vs. previous month spend</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th class="num">This Month</th>
              <th class="num">Last Month</th>
              <th class="num">Change</th>
            </tr>
          </thead>
          <tbody>\(changeRows)</tbody>
        </table>
      </div>
"""
        }
        return """
\(M.page(title: "Top Recipients", subtitle: "Merchants ranked by total spend (selected period)", content: chart, pageBreak: true))
    <div class="page-continuation">
      \(notice)
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Recipient</th>
            <th class="num">Total Spent</th>
            <th class="num">Txns</th>
            <th class="num">Avg/Txn</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>\(rows)</tbody>
      </table>
      \(note)
      \(change)
    </div>
"""
    }

    /// `renderBankBalances(data, { currency })`.
    static func bankBalances(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let accounts = data["banks"]["accounts"].items
        let position = data["banks"]["total_net_position"].isNullish ? 0 : data["banks"]["total_net_position"].n
        if accounts.isEmpty {
            return M.emptySection(
                title: "Bank Balances", subtitle: "Current balance per account", message: "No bank balance data available.",
                pageBreak: true)
        }
        let cards = F.sorted(accounts) { a, b in abs(b["balance"].n) - abs(a["balance"].n) }.map { account in
            let last = account["last_transaction"].isTruthy ? F.date(account["last_transaction"], zone: context.localZone) : "—"
            return """

      <div class="account-card">
        <div class="account-name">\(escape(account["bank_account"].s))</div>
        <div class="account-balance \(F.sign(account["balance"].n))">\(escape(F.currency(account["balance"].n, currency)))</div>
        <div class="account-meta">\(F.count(account["transaction_count"].n)) txns · last \(escape(last))</div>
      </div>
"""
        }.joined()
        return M.page(
            title: "Bank Balances", subtitle: "Current balance per account",
            content: """

      <div class="account-grid">\(cards)</div>
      <div class="stat-row" style="border-top:1px solid hsl(var(--border));padding-top:12px;margin-top:4px">
        <span class="stat-label" style="font-weight:700;color:hsl(var(--text))">Total Net Position</span>
        <span class="stat-value \(F.sign(position))" style="font-size:18px">\(escape(F.currency(position, currency)))</span>
      </div>
""", pageBreak: true)
    }

    /// `renderRollingAverages(data, { currency })`.
    static func rollingAverages(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let averages = data["averages"]
        guard averages.isTruthy else {
            return M.emptySection(
                title: "Rolling Averages", subtitle: "Current month vs. 6-month average",
                message: "No rolling average data available.", pageBreak: true)
        }
        let past = averages["past_6_months"]
        let current = averages["current_month"]
        let comparison = averages["comparison"]
        func or(_ value: JSValue?, _ fallback: Double) -> Double { value.isNullish ? fallback : value.n }
        func text(_ value: JSValue?, _ fallback: String) -> String { value.isNullish ? fallback : value.s }
        let pace: Double? = comparison["pace"].isNullish ? nil : comparison["pace"].n
        let variance = or(comparison["variance"], 0)
        let projected = or(comparison["projected_monthly_total"], 0)
        let monthly = or(comparison["avg_monthly_spending"], or(past["avg_monthly_spending"], 0))
        var badge = "badge-neutral"
        var paceLabel = "On track"
        if let pace {
            if pace > 1.15 {
                badge = "badge-neg"
                paceLabel = "Over pace"
            } else if pace < 0.85 {
                badge = "badge-pos"
                paceLabel = "Under pace"
            }
        }
        let projectedClass = projected > monthly ? "neg" : projected < monthly ? "pos" : ""
        let kpi = M.grid(
            [
                M.Card(
                    label: "Avg Daily Spend (6mo)", value: F.currency(or(past["avg_daily_spending"], 0), currency),
                    sub: "\(text(past["months_counted"], "0")) months"),
                M.Card(label: "Avg Monthly Spend (6mo)", value: F.currency(monthly, currency)),
                M.Card(
                    label: "This Month So Far", value: F.currency(or(current["total_spending"], 0), currency),
                    sub: "\(text(current["days_elapsed"], "0")) of \(text(current["days_in_month"], "30")) days"),
                M.Card(
                    label: "Projected This Month", value: F.currency(projected, currency), cls: projectedClass,
                    subHTML: "<span class=\"badge \(badge)\">\(escape(paceLabel))</span>"),
            ], style: "margin-bottom:28px")
        let stats = """

    <div style="max-width:400px">
      <div class="stat-row">
        <span class="stat-label">Projected vs. average</span>
        <span class="stat-value \(F.sign(-variance))">\(escape(F.currency(variance, currency))) \(variance > 0 ? "over" : variance < 0 ? "under" : "")</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Pace ratio</span>
        <span class="stat-value">\(pace.map { "\(JavaScriptNumber.toFixed($0 * 100, 0))%" } ?? "—")</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Days elapsed</span>
        <span class="stat-value">\(text(current["days_elapsed"], "0")) / \(text(current["days_in_month"], "30"))</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Months in sample</span>
        <span class="stat-value">\(text(past["months_counted"], "0"))</span>
      </div>
    </div>
"""
        return M.page(
            title: "Rolling Averages", subtitle: "Current month spending pace vs. 6-month rolling average",
            content: """

      \(kpi)
      \(stats)
""", pageBreak: true)
    }

    /// `renderPlannedOutlook(data, { currency })`.
    static func plannedOutlook(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let planned = data["planned"]
        guard planned.isTruthy else {
            return M.emptySection(
                title: "Planned Outlook", subtitle: "Next month's expected transactions",
                message: "No planned transaction data available.", pageBreak: true)
        }
        let summary = planned["summary"]
        let label =
            planned["period_start"].isTruthy && planned["period_end"].isTruthy
            ? "\(F.date(planned["period_start"], zone: context.localZone)) – \(F.date(planned["period_end"], zone: context.localZone))"
            : "Next month"
        let kpi = M.grid(
            [
                M.Card(label: "Expected Income", value: F.currency(summary["total_income"].n, currency), cls: "pos"),
                M.Card(label: "Expected Expenses", value: F.currency(abs(summary["total_expenses"].n), currency), cls: "neg"),
                M.Card(
                    label: "Net", value: F.currency(summary["net_amount"].n, currency), cls: F.sign(summary["net_amount"].n),
                    sub: "\(summary["transaction_count"].s) planned txns"),
            ], columns: 3, style: "margin-bottom:24px")
        let days = planned["daily_data"].items.prefix(31)
        if days.isEmpty {
            return M.page(
                title: "Planned Outlook", subtitle: label,
                content: """

        \(kpi)
        \(M.emptyNotice("No planned transactions found."))
""", pageBreak: true)
        }
        let groups = days.map { day in
            let rows = day["transactions"].items.map { tx in
                var category = ""
                if tx["category_name"].isTruthy {
                    category = tx["category_name"].s
                    if let colon = category.range(of: ":") { category.replaceSubrange(colon, with: " › ") }
                }
                let recurring = tx["is_recurring"].isTruthy ? "<span class=\"badge badge-neutral\" style=\"margin-left:4px\">recurring</span>" : ""
                let name = tx["recipient_name"].isNullish ? "Unknown" : tx["recipient_name"].s
                return """

        <div class="planned-row">
          <span class="planned-row-name">\(escape(name))\(recurring)</span>
          <span class="planned-row-cat">\(escape(category))</span>
          <span class="planned-row-amt \(F.sign(tx["amount"].n))">\(escape(F.currency(tx["amount"].n, currency)))</span>
        </div>
"""
            }.joined()
            return """

      <div class="planned-day">
        <div class="planned-day-header">\(escape(F.date(day["date"], zone: context.localZone)))</div>
        \(rows)
      </div>
"""
        }.joined()
        return M.page(
            title: "Planned Outlook", subtitle: label,
            content: """

      \(kpi)
      \(groups)
""", pageBreak: true)
    }
}

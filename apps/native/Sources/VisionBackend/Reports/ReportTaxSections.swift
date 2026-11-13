import Foundation

/// The tax report's sections (`services/reports/sections`), from the data `fetchTaxData`
/// returns.
enum ReportTaxSections {
    private typealias F = ReportFormat
    private typealias M = ReportMarkup
    private static func escape(_ text: String) -> String { ReportFormat.escape(text) }
    /// `value ?? 0` as a number.
    private static func amount(_ value: JSValue?) -> Double { value.isNullish ? 0 : value.n }
    private static func symbol(_ row: JSValue) -> String { row["symbol"].isNullish ? "—" : row["symbol"].s }
    private static func year(_ data: JSValue?) -> String { data["taxYear"].isNullish ? "—" : data["taxYear"].s }
    private static let warningStyle = "color:hsl(var(--warning, 38 92% 50%));font-size:11px;margin:0 0 12px;"
    private static let mutedStyle = "color:hsl(var(--muted));font-size:11px;margin:0 0 12px;"
    private static let captionStyle =
        "font-size:11px;font-weight:600;color:hsl(var(--muted));text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;"

    /// `renderTaxExecutiveSummary(data, { currency })`.
    static func executiveSummary(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let taxYear = year(data)
        let tob = amount(data["tobTotal"])
        let withholding = amount(data["dividendWHTTotal"])
        let sell = amount(data["sellTaxTotal"])
        let fees = amount(data["feesTotal"])
        let other = amount(data["otherTaxTotal"])
        let dividends = amount(data["dividendsReceived"])
        let grossBase: Double? = data["grossDividendBase"].isNullish ? nil : data["grossDividendBase"].n
        let netResult: Double? = data["netDividendResult"].isNullish ? nil : data["netDividendResult"].n
        let unknownConvention = amount(data["unknownDividendConventionCount"])
        let taxes = tob + withholding + sell + other
        let costs = taxes + fees
        let effectiveRate: Double? = grossBase.flatMap { $0 > 0 ? withholding / $0 * 100 : nil }
        guard costs > 0 || dividends > 0 else {
            return M.emptySection(
                title: "Tax Summary", subtitle: "Overview of taxes and fees for \(taxYear)",
                message: "No tax transactions found for the selected period.", heading: "No tax data")
        }
        let note = data["periodNote"].isTruthy ? "<p style=\"\(mutedStyle)\">\(data["periodNote"].s)</p>" : ""
        var unconverted: [JSValue] = []
        if case .array(let list)? = data["unconvertedCurrencies"] { unconverted = list }
        // `nanToZero(Number(value))`.
        let unconvertedCount = data["unconvertedCount"].n.isNaN ? 0 : data["unconvertedCount"].n
        let fxWarning =
            unconverted.isEmpty
            ? ""
            : "<p style=\"\(warningStyle)\"><strong>Incomplete:</strong> no exchange rate was available for \(unconverted.map { $0 == .null ? "" : $0.s }.joined(separator: ", ")); \(unconvertedCount == 1 ? "1 transaction was" : "\(JavaScriptNumber.text(unconvertedCount)) transactions were") left out of these totals.</p>"
        let profile = data["taxProfile"]
        func field(_ value: JSValue?) -> String { value.isNullish ? "" : value.s }
        let profileLine =
            profile.isTruthy
            ? "<p style=\"\(mutedStyle)\">Tax profile: \(escape(field(profile["filingStatus"]))) · \(escape(field(profile["region"])))</p>" : ""
        let conventionWarning =
            unknownConvention > 0
            ? "<p style=\"\(warningStyle)\"><strong>Incomplete dividend metrics:</strong> \(JavaScriptNumber.text(unknownConvention)) dividend \(unknownConvention == 1 ? "row has" : "rows have") an unknown gross/net amount convention. Recorded amounts and taxes remain shown, but the effective withholding rate and net dividend result are unavailable.</p>"
            : ""
        func share(_ value: Double) -> String { costs > 0 ? F.percent(value / costs * 100, raw: true) : "—" }
        let small = "font-size:18px;"
        let first = M.grid([
            M.Card(label: "Total Taxes Paid", value: F.currency(taxes, currency), cls: "neg"),
            M.Card(label: "Total Fees", value: F.currency(fees, currency), cls: "neg"),
            M.Card(label: "Total Cost", value: F.currency(costs, currency), cls: "neg"),
            M.Card(label: "Dividend Amounts Recorded", value: F.currency(dividends, currency)),
        ])
        let second = M.grid(
            [
                M.Card(label: "TOB (Transaction Tax)", value: F.currency(tob, currency), valueStyle: small),
                M.Card(label: "Dividend WHT", value: F.currency(withholding, currency), valueStyle: small),
                M.Card(label: "Capital Gains Tax", value: F.currency(sell, currency), valueStyle: small),
                M.Card(
                    label: "Effective WHT Rate", value: effectiveRate.map { F.percent($0, raw: true) } ?? "Incomplete", valueStyle: small),
            ], style: "margin-top: 8px;")
        return M.page(
            title: "Tax Summary", subtitle: "Taxes and fees for tax year \(taxYear)",
            content: """

      \(note)\(profileLine)\(fxWarning)\(conventionWarning)
      \(first)
      \(second)
      <table class="data-table" style="margin-top:16px;">
        <thead><tr>
          <th>Tax Component</th>
          <th class="num">Amount</th>
          <th class="num">% of Total Cost</th>
        </tr></thead>
        <tbody>
          <tr><td>TOB (Transaction Tax)</td><td class="num neg">\(F.currency(tob, currency))</td><td class="num">\(share(tob))</td></tr>
          <tr><td>Dividend Withholding Tax</td><td class="num neg">\(F.currency(withholding, currency))</td><td class="num">\(share(withholding))</td></tr>
          <tr><td>Capital Gains / Sell Tax</td><td class="num neg">\(F.currency(sell, currency))</td><td class="num">\(share(sell))</td></tr>
          <tr><td>Other Taxes</td><td class="num neg">\(F.currency(other, currency))</td><td class="num">\(share(other))</td></tr>
          <tr><td>Broker / Management Fees</td><td class="num neg">\(F.currency(fees, currency))</td><td class="num">\(share(fees))</td></tr>
          <tr style="font-weight:600;border-top:2px solid hsl(var(--border));">
            <td>Net Dividend Result</td>
            <td class="num \(netResult.map(F.sign) ?? "")">\(netResult.map { F.currency($0, currency) } ?? "Incomplete")</td>
            <td class="num">—</td>
          </tr>
        </tbody>
      </table>
""")
    }

    /// `renderTaxTypeBreakdown(data, { currency })`.
    static func typeBreakdown(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let all: [(label: String, amount: Double)] = [
            ("TOB (Transaction Tax)", amount(data["tobTotal"])), ("Dividend WHT", amount(data["dividendWHTTotal"])),
            ("Capital Gains / Sell Tax", amount(data["sellTaxTotal"])), ("Broker / Management Fees", amount(data["feesTotal"])),
            ("Other Taxes", amount(data["otherTaxTotal"])),
        ]
        let components = F.sorted(all.filter { $0.amount > 0 }) { a, b in F.descending(a.amount, b.amount) }
        if components.isEmpty {
            return M.emptySection(
                title: "Tax Type Breakdown", subtitle: "Distribution of taxes and fees by type",
                message: "No tax transactions found for the selected period.", heading: "No tax data")
        }
        let total = F.decimalSum(components.map(\.amount))
        let bars = components.map { M.Bar(label: $0.label, value: $0.amount, formatted: F.currency($0.amount, currency)) }
        let rows = components.map { c in
            """
<tr>
    <td>\(escape(c.label))</td>
    <td class="num neg">\(F.currency(c.amount, currency))</td>
    <td class="num">\(total > 0 ? F.percent(c.amount / total * 100, raw: true) : "—")</td>
  </tr>
"""
        }.joined()
        return M.page(
            title: "Tax Type Breakdown", subtitle: "Total cost: \(F.currency(total, currency)) across \(components.count) categories",
            content: """

      <div class="chart-wrap">\(M.horizontalBars(bars, maxItems: 8))</div>
      <table class="data-table">
        <thead><tr>
          <th>Tax / Fee Type</th>
          <th class="num">Amount</th>
          <th class="num">Share</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    private static let taxAndFeeSeries = [
        M.Series(key: "taxes", color: "hsl(var(--chart-1))", label: "Taxes"),
        M.Series(key: "fees", color: "hsl(var(--chart-2))", label: "Fees"),
    ]

    /// `renderTaxByAssetClass(data, { currency })`.
    static func byAssetClass(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let all = data["byAssetClass"].items.map {
            (label: F.assetClassLabel($0["assetClass"].s, plural: true), taxes: $0["taxes"].n, fees: $0["fees"].n)
        }
        let classes = F.sorted(all.filter { $0.taxes > 0 || $0.fees > 0 }) { a, b in
            F.descending(F.decimalSum([a.taxes, a.fees]), F.decimalSum([b.taxes, b.fees]))
        }
        if classes.isEmpty {
            return M.emptySection(
                title: "Tax by Asset Class", subtitle: "Taxes and fees broken down by asset class",
                message: "No tax or fee data found by asset class for the selected period.", heading: "No data")
        }
        let chart = M.groupedBars(classes.map { ($0.label, ["taxes": $0.taxes, "fees": $0.fees]) }, taxAndFeeSeries)
        let rows = classes.map { c in
            """
<tr>
      <td>\(escape(c.label))</td>
      <td class="num neg">\(F.currency(c.taxes, currency))</td>
      <td class="num neg">\(F.currency(c.fees, currency))</td>
      <td class="num neg">\(F.currency(F.decimalSum([c.taxes, c.fees]), currency))</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Tax by Asset Class",
            subtitle: "Taxes and fees across \(classes.count) asset class\(classes.count == 1 ? "" : "es")",
            content: """

      <div class="chart-wrap">\(chart)</div>
      <table class="data-table">
        <thead><tr>
          <th>Asset Class</th>
          <th class="num">Taxes</th>
          <th class="num">Fees</th>
          <th class="num">Total</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderTaxMonthlyTrend(data, { currency })`.
    static func monthlyTrend(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let byMonth = data["byMonth"].items
        if byMonth.isEmpty {
            return M.emptySection(
                title: "Monthly Tax Trend", subtitle: "Taxes and fees over time",
                message: "No tax transactions found for the selected period.", heading: "No monthly data")
        }
        let sorted = F.sorted(byMonth) { a, b in
            a["year"].n != b["year"].n ? a["year"].n - b["year"].n : a["month"].n - b["month"].n
        }
        func taxes(_ m: JSValue) -> Double { F.decimalSum([m["tob"].n, m["wht"].n, m["sell"].n, m["other"].n]) }
        let chart = M.groupedBars(
            sorted.map { (F.monthLabel($0["year"], $0["month"]), ["taxes": taxes($0), "fees": $0["fees"].n]) }, taxAndFeeSeries)
        let rows = sorted.map { m in
            """
<tr>
      <td>\(F.monthLabel(m["year"], m["month"]))</td>
      <td class="num neg">\(F.currency(taxes(m), currency))</td>
      <td class="num neg">\(F.currency(m["fees"].n, currency))</td>
      <td class="num neg">\(F.currency(F.decimalSum([taxes(m), m["fees"].n]), currency))</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Monthly Tax Trend", subtitle: "Taxes and fees across \(sorted.count) month\(sorted.count == 1 ? "" : "s")",
            content: """

      <div class="chart-wrap">\(chart)</div>
      <table class="data-table">
        <thead><tr>
          <th>Month</th>
          <th class="num">Taxes</th>
          <th class="num">Fees</th>
          <th class="num">Total</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderTopInvestmentsByCost(data, { currency })`.
    static func topInvestmentsByCost(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let byInvestment = data["byInvestment"].items
        if byInvestment.isEmpty {
            return M.emptySection(
                title: "Top Investments by Tax Cost", subtitle: "Investments with the highest tax and fee burden",
                message: "No per-investment tax data found for the selected period.", heading: "No data")
        }
        let sorted = F.sorted(byInvestment) { a, b in F.descending(a["total"].n, b["total"].n) }.prefix(15)
        let rows = sorted.enumerated().map { index, row in
            """
<tr>
      <td style="color:hsl(var(--muted));font-size:10px;">\(index + 1)</td>
      <td>\(escape(row["name"].s))</td>
      <td>\(escape(symbol(row)))</td>
      <td class="num neg">\(F.currency(row["tob"].n, currency))</td>
      <td class="num neg">\(F.currency(row["wht"].n, currency))</td>
      <td class="num neg">\(F.currency(row["sell"].n, currency))</td>
      <td class="num neg">\(F.currency(row["other"].n, currency))</td>
      <td class="num neg">\(F.currency(row["fees"].n, currency))</td>
      <td class="num neg" style="font-weight:600;">\(F.currency(row["total"].n, currency))</td>
    </tr>
"""
        }.joined()
        return M.page(
            title: "Top Investments by Tax Cost",
            subtitle: "Highest tax and fee burden (top \(sorted.count) of \(byInvestment.count))",
            content: """

      <table class="data-table">
        <thead><tr>
          <th>#</th>
          <th>Investment</th>
          <th>Symbol</th>
          <th class="num">TOB</th>
          <th class="num">Div. WHT</th>
          <th class="num">Sell Tax</th>
          <th class="num">Other</th>
          <th class="num">Fees</th>
          <th class="num">Total Cost</th>
        </tr></thead>
        <tbody>\(rows)</tbody>
      </table>
""")
    }

    /// `renderFeeBreakdown(data, { currency })`.
    static func feeBreakdown(_ data: JSValue?, _ context: ReportContext) -> String {
        let currency = context.currency
        let all = data["byAssetClass"].items.map { (label: F.assetClassLabel($0["assetClass"].s, plural: true), fees: $0["fees"].n) }
        let rows = F.sorted(all.filter { $0.fees > 0 }) { a, b in F.descending(a.fees, b.fees) }
        let totalFees = amount(data["feesTotal"])
        if rows.isEmpty && totalFees == 0 {
            return M.emptySection(
                title: "Fee Breakdown", subtitle: "Broker and management fees by asset class",
                message: "No fees found for the selected period.", heading: "No fee data")
        }
        let bars = rows.map { M.Bar(label: $0.label, value: $0.fees, formatted: F.currency($0.fees, currency)) }
        // `toNumber(multiply(divide(fees, totalFees), 100))`, in decimal arithmetic.
        func share(_ fees: Double) -> Double {
            guard totalFees > 0, let part = try? DecimalJS(fees), let whole = try? DecimalJS(totalFees),
                let ratio = try? part.dividedBy(whole)
            else { return 0 }
            return ratio.times(DecimalJS(100)).toNumber
        }
        let tableRows = rows.map { row in
            """
<tr>
      <td>\(escape(row.label))</td>
      <td class="num neg">\(F.currency(row.fees, currency))</td>
      <td class="num">\(F.percent(share(row.fees), raw: true))</td>
    </tr>
"""
        }.joined()
        let chart = bars.isEmpty ? "" : "<div class=\"chart-wrap\">\(M.horizontalBars(bars, maxItems: 8))</div>"
        let table =
            tableRows.isEmpty
            ? "<p style=\"color:hsl(var(--muted));font-size:12px;\">Fee detail by asset class unavailable — total: \(F.currency(totalFees, currency))</p>"
            : """

        <table class="data-table">
          <thead><tr>
            <th>Asset Class</th>
            <th class="num">Fees Paid</th>
            <th class="num">Share</th>
          </tr></thead>
          <tbody>\(tableRows)</tbody>
        </table>
"""
        return M.page(
            title: "Fee Breakdown", subtitle: "Total fees: \(F.currency(totalFees, currency))",
            content: """

      \(chart)
      \(table)
""")
    }

    private static let tobLabels = [
        "bonds": "Bonds", "sharesAndOther": "Shares & Other", "accumulatingFunds": "Accumulating Funds",
        "distributingFunds": "Distributing Funds",
    ]

    /// `renderBelgianRulesSummary(data, { currency })`. The amounts are in EUR whatever the
    /// report's currency.
    static func belgianRules(_ data: JSValue?, _ context: ReportContext) -> String {
        let tables = data["taxTables"]
        let pit = data["precomputedPIT"]
        let taxYear = year(data)
        if !tables.isTruthy && !pit.isTruthy {
            return M.emptySection(
                title: "Belgian Tax Rules", subtitle: "Tax year \(taxYear) bracket reference",
                message: "Belgian tax bracket data unavailable for year \(taxYear).", heading: "No tax table data")
        }
        let tobRows = (tables["tob"]?.objectValue?.entries ?? []).map { key, bracket in
            """
<tr>
      <td>\(escape(tobLabels[key] ?? key))</td>
      <td class="num">\(F.percent(bracket["rate"].n, digits: 2))</td>
      <td class="num">\(F.currency(bracket["cap"].n, "EUR"))</td>
    </tr>
"""
        }.joined()
        let pitBlock =
            pit.isTruthy
            ? incomeTaxBlock(pit, profile: data["taxProfile"])
            : "<p>Annual personal income tax is not included. It requires a full calendar year with its own configured profile or saved snapshot.</p>"
        let exemption = tables["dividendExemption"].isNullish ? "—" : F.currency(tables["dividendExemption"].n, "EUR")
        let rate = tables["dividendWHTRate"].isNullish ? "—" : F.percent(tables["dividendWHTRate"].n)
        return M.page(
            title: "Belgian Tax Rules — \(taxYear)", subtitle: "Reference bracket data for tax year \(taxYear)",
            content: """

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div>
          <div style="\(captionStyle)">Dividend Tax</div>
          <table class="data-table">
            <tbody>
              <tr><td>Exemption (first-year allowance)</td><td class="num">\(exemption)</td></tr>
              <tr><td>Withholding Tax Rate</td><td class="num">\(rate)</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div style="\(captionStyle)">TOB (Beurstaks)</div>
          <table class="data-table">
            <thead><tr><th>Instrument</th><th class="num">Rate</th><th class="num">Cap</th></tr></thead>
            <tbody>\(tobRows)</tbody>
          </table>
        </div>
      </div>
      \(pitBlock)\(householdBlock(data["precomputedHousehold"], household: data["household"]))
""")
    }

    private static func partnerName(_ id: JSValue?, _ household: JSValue?) -> String {
        let label = id == .some(.string("A")) ? "You" : id == .some(.string("B")) ? "Partner" : "undefined"
        let partner = household["partners"].items.first { $0["id"] == id }
        guard case .string(let name)? = partner?["displayName"] else { return label }
        let trimmed = JavaScriptWhitespace.trim(name)
        return trimmed.isEmpty ? label : "\(label) (\(trimmed))"
    }

    /// `renderHouseholdBlock(result, household, 'EUR')`.
    static func householdBlock(_ result: JSValue?, household: JSValue?) -> String {
        let partners = result["partners"].items
        guard result.isTruthy, partners.count >= 2 else { return "" }
        func total(_ key: String) -> Double { F.decimalSum(partners.map { $0[key].n }) }
        let rows = partners.map { p in
            """
<tr>
      <td>\(escape(partnerName(p["partnerId"], household)))</td>
      <td class="num">\(F.currency(p["grossIncome"].n))</td>
      <td class="num">\(F.currency(p["taxableIncome"].n))</td>
      <td class="num neg">\(F.currency(p["totalPIT"].n))</td>
    </tr>
"""
        }.joined()
        let basis = result["legalBasis"].isTruthy ? " (\(escape(result["legalBasis"].s)))" : ""
        let quotient = result["quotient"]
        let quotientStyle = "color:hsl(var(--muted));font-size:11px;margin:4px 0 0;"
        let quotientLine: String
        if result["assessmentMode"] != .some(.string("joint")) {
            quotientLine = ""
        } else if quotient["applied"].isTruthy && quotient["fromPartnerId"].isTruthy && quotient["toPartnerId"].isTruthy {
            quotientLine =
                "<p style=\"\(quotientStyle)\">Marital quotient: \(F.currency(quotient["transfer"].n)) from \(escape(partnerName(quotient["fromPartnerId"], household))) to \(escape(partnerName(quotient["toPartnerId"], household))) · saving \(F.currency(quotient["benefit"].n))</p>"
        } else {
            quotientLine = "<p style=\"\(quotientStyle)\">Marital quotient: not applied</p>"
        }
        let modes = ["single": "Single", "separate": "Separate", "joint": "Joint"]
        let mode = result["assessmentMode"]?.stringValue.flatMap { modes[$0] } ?? "undefined"
        return """

    <div style="margin-top:16px;">
      <div style="\(captionStyle)">Per Partner</div>
      <p style="color:hsl(var(--muted));font-size:11px;margin:0 0 8px;">Assessment: \(mode)\(basis)</p>
      <table class="data-table">
        <thead><tr><th>Partner</th><th class="num">Gross income</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
        <tbody>\(rows)</tbody>
        <tfoot><tr style="font-weight:600;"><td>Household</td><td class="num">\(F.currency(total("grossIncome")))</td><td class="num">\(F.currency(total("taxableIncome")))</td><td class="num neg">\(F.currency(total("totalPIT")))</td></tr></tfoot>
      </table>
      \(quotientLine)
    </div>
"""
    }

    /// `renderPITBlock(pit, profile, 'EUR')`.
    private static func incomeTaxBlock(_ pit: JSValue?, profile: JSValue?) -> String {
        let rows = pit["brackets"].items.map { b in
            """
<tr>
    <td>\(b["label"].isNullish ? "—" : escape(b["label"].s))</td>
    <td class="num">\(b["rate"].isNullish ? "—" : F.percent(b["rate"].n, raw: true))</td>
    <td class="num">\(b["taxableIncome"].isNullish ? "—" : F.currency(b["taxableIncome"].n))</td>
    <td class="num neg">\(b["taxAmount"].isNullish ? "—" : F.currency(b["taxAmount"].n))</td>
  </tr>
"""
        }.joined()
        let profileLine =
            profile.isTruthy
            ? "<p style=\"color:hsl(var(--muted));font-size:11px;margin:0 0 8px;\">Filing status: \(escape(profile["filingStatus"].isNullish ? "—" : profile["filingStatus"].s)) · Taxable income: \(pit["taxableIncome"].isNullish ? "—" : F.currency(pit["taxableIncome"].n))</p>"
            : ""
        let total =
            pit["totalTax"].isNullish
            ? ""
            : "<tfoot><tr style=\"font-weight:600;\"><td colspan=\"3\">Estimated Total PIT</td><td class=\"num neg\">\(F.currency(pit["totalTax"].n))</td></tr></tfoot>"
        let table =
            rows.isEmpty
            ? "<p style=\"color:hsl(var(--muted));font-size:12px;\">Bracket detail not provided.</p>"
            : """
<table class="data-table">
        <thead><tr><th>Bracket</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
        <tbody>\(rows)</tbody>
        \(total)
      </table>
"""
        return """

    <div style="margin-top:16px;">
      <div style="\(captionStyle)">Personal Income Tax Estimate</div>
      \(profileLine)
      \(table)
    </div>
"""
    }
}

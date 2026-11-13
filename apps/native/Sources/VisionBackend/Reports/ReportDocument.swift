import Foundation

/// The three report types of `services/reports/index.ts`.
enum ReportKind: String, Sendable, CaseIterable {
    case financial, portfolio, tax

    var title: String {
        switch self {
        case .financial: return "Financial Report"
        case .portfolio: return "Portfolio Report"
        case .tax: return "Tax Report"
        }
    }

    var subtitle: String {
        switch self {
        case .financial: return "Transactions, cashflow, categories & recipients"
        case .portfolio: return "Holdings, allocation & performance"
        case .tax: return "Tax-year breakdown & deductible transactions"
        }
    }

    /// The section ids in canonical order (`sectionCatalog.ts`); every one is a default.
    var sections: [String] {
        switch self {
        case .financial:
            return [
                "executiveSummary", "cashflowTrend", "categoryBreakdown", "topRecipients", "bankBalances", "rollingAverages",
                "plannedOutlook",
            ]
        case .portfolio:
            return [
                "portfolioExecutiveSummary", "portfolioAllocation", "topHoldings", "performanceTrend", "assetClassDetail",
                "dividendIncome",
            ]
        case .tax:
            return [
                "taxExecutiveSummary", "taxTypeBreakdown", "taxByAssetClass", "taxMonthlyTrend", "topInvestmentsByCost",
                "feeBreakdown", "belgianRulesSummary",
            ]
        }
    }

    /// What goes between two sections.
    var separator: String { self == .financial ? "\n" : "\n<div class=\"page-break\"></div>\n" }

    /// The renderer of a section id, when this report type has one.
    func renderer(_ id: String) -> ((JSValue?, ReportContext) -> String)? {
        switch (self, id) {
        case (.financial, "executiveSummary"): return ReportFinancialSections.executiveSummary
        case (.financial, "cashflowTrend"): return ReportFinancialSections.cashflowTrend
        case (.financial, "categoryBreakdown"): return ReportFinancialSections.categoryBreakdown
        case (.financial, "topRecipients"): return ReportFinancialSections.topRecipients
        case (.financial, "bankBalances"): return ReportFinancialSections.bankBalances
        case (.financial, "rollingAverages"): return ReportFinancialSections.rollingAverages
        case (.financial, "plannedOutlook"): return ReportFinancialSections.plannedOutlook
        case (.portfolio, "portfolioExecutiveSummary"): return ReportPortfolioSections.executiveSummary
        case (.portfolio, "portfolioAllocation"): return ReportPortfolioSections.allocation
        case (.portfolio, "topHoldings"): return ReportPortfolioSections.topHoldings
        case (.portfolio, "performanceTrend"): return ReportPortfolioSections.performanceTrend
        case (.portfolio, "assetClassDetail"): return ReportPortfolioSections.assetClassDetail
        case (.portfolio, "dividendIncome"): return ReportPortfolioSections.dividendIncome
        case (.tax, "taxExecutiveSummary"): return ReportTaxSections.executiveSummary
        case (.tax, "taxTypeBreakdown"): return ReportTaxSections.typeBreakdown
        case (.tax, "taxByAssetClass"): return ReportTaxSections.byAssetClass
        case (.tax, "taxMonthlyTrend"): return ReportTaxSections.monthlyTrend
        case (.tax, "topInvestmentsByCost"): return ReportTaxSections.topInvestmentsByCost
        case (.tax, "feeBreakdown"): return ReportTaxSections.feeBreakdown
        case (.tax, "belgianRulesSummary"): return ReportTaxSections.belgianRules
        default: return nil
        }
    }
}

/// A print-ready report (`ReportDocument`): the document, its footer template and a PDF
/// filename. `services/reports/index.ts` without the data fetching.
struct ReportDocument: Equatable, Sendable {
    var filename: String
    var html: String
    var footerTemplate: String

    private static func escape(_ text: String) -> String { ReportFormat.escape(text) }

    private static let noSections = """

      <div class="page placeholder-notice">
        <strong>No sections selected</strong>
        Select sections in the export dialog to include them in this report.
      </div>
"""

    /// The ids that will be rendered: the requested sections (or all of the type's when none
    /// is requested) that the type has, in the order asked, repeats included.
    static func selectedSections(_ kind: ReportKind, _ sections: [String]) -> [String] {
        (sections.isEmpty ? kind.sections : sections).filter { kind.renderer($0) != nil }
    }

    /// `renderReportSections(type, sections, data, context)`: the body of a report from data
    /// already fetched.
    static func body(_ kind: ReportKind, sections: [String], data: JSValue?, context: ReportContext) -> String {
        let selected = selectedSections(kind, sections).compactMap { kind.renderer($0) }
        if selected.isEmpty { return noSections }
        return selected.map { $0(data, context) }.joined(separator: kind.separator)
    }

    /// `formatPeriod(period)`.
    static func periodText(_ context: ReportContext) -> String {
        switch context.period {
        case .yearToDate:
            return "Year to Date (\(context.zone.parts(atEpochMilliseconds: context.nowMs).year))"
        case .rolling(let months):
            return "Last \(JavaScriptNumber.text(months)) month\(months == 1 ? "" : "s")"
        case .custom(let from, let to):
            return "\(ReportFormat.shortDateUTC(from)) – \(ReportFormat.shortDateUTC(to))"
        case .year(let year):
            return JavaScriptNumber.text(year)
        case .allTime:
            return "All time"
        }
    }

    /// `HSL_COMPONENT_RE`: hue, saturation% and lightness%, the only shape a theme token may take.
    static func isHSLComponents(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        var index = 0
        func digit() -> Bool { index < scalars.count && scalars[index].value >= 0x30 && scalars[index].value <= 0x39 }
        func number() -> Bool {
            var count = 0
            while count < 3, digit() {
                index += 1
                count += 1
            }
            if count == 0 { return false }
            if index + 1 < scalars.count, scalars[index] == ".", scalars[index + 1].value >= 0x30, scalars[index + 1].value <= 0x39 {
                index += 1
                while digit() { index += 1 }
            }
            return true
        }
        func space() -> Bool {
            let start = index
            while index < scalars.count, JavaScriptWhitespace.contains(scalars[index]) { index += 1 }
            return index > start
        }
        func percent() -> Bool {
            guard index < scalars.count, scalars[index] == "%" else { return false }
            index += 1
            return true
        }
        return number() && space() && number() && percent() && space() && number() && percent() && index == scalars.count
    }

    /// `tokenToCssVar(key)`: `chart1` is `--chart-1`, `camelCase` is `--camel-case`.
    static func cssVariable(_ key: String) -> String {
        let scalars = Array(key.unicodeScalars)
        if scalars.count == 6, key.hasPrefix("chart"), scalars[5].value >= 0x30, scalars[5].value <= 0x39 {
            return "--chart-\(scalars[5])"
        }
        var kebab = ""
        for scalar in scalars {
            if scalar.value >= 0x41, scalar.value <= 0x5A { kebab.append("-") }
            kebab.unicodeScalars.append(scalar)
        }
        return "--\(kebab.lowercased())"
    }

    /// The fallback palette (`REPORT_THEME_DEFAULTS` of `packages/types`).
    static func defaultPalette(dark: Bool) -> [(String, String)] {
        dark
            ? [
                ("primary", "160 74% 52%"), ("accent", "42 72% 66%"), ("success", "152 62% 54%"), ("expense", "358 92% 68%"),
                ("surface", "200 20% 7%"), ("text", "42 25% 96%"), ("muted", "42 12% 68%"), ("border", "200 14% 20%"),
                ("chart1", "158 64% 58%"), ("chart2", "42 78% 68%"), ("chart3", "204 78% 62%"), ("chart4", "268 68% 72%"),
                ("chart5", "14 82% 64%"), ("chart6", "182 58% 54%"), ("chart7", "340 68% 66%"), ("chart8", "48 82% 60%"),
            ]
            : [
                ("primary", "164 78% 26%"), ("accent", "38 58% 52%"), ("success", "152 58% 38%"), ("expense", "358 74% 44%"),
                ("surface", "40 36% 96%"), ("text", "200 20% 9%"), ("muted", "200 12% 34%"), ("border", "40 18% 85%"),
                ("chart1", "158 62% 38%"), ("chart2", "38 62% 54%"), ("chart3", "204 68% 48%"), ("chart4", "268 52% 58%"),
                ("chart5", "14 76% 54%"), ("chart6", "182 48% 40%"), ("chart7", "340 58% 54%"), ("chart8", "48 72% 48%"),
            ]
    }

    /// `buildThemeCss(tokens)`: the `:root` block. A token that is not an HSL triple is left
    /// out, so nothing but a colour reaches the style sheet.
    static func themeCSS(_ theme: JSValue?) -> String {
        let dark = theme["mode"] == .string("dark")
        let resolved = (theme?.objectValue?.entries ?? []).compactMap { key, value -> String? in
            guard key != "mode", case .string(let text) = value else { return nil }
            let trimmed = JavaScriptWhitespace.trim(text)
            return isHSLComponents(trimmed) ? "  \(cssVariable(key)): \(trimmed);" : nil
        }
        let defaults = defaultPalette(dark: dark).map { "  \(cssVariable($0.0)): \($0.1);" }
        return ":root {\n  /* defaults (\(dark ? "dark" : "light") mode) */\n\(defaults.joined(separator: "\n"))\n\n  /* resolved theme */\n\(resolved.joined(separator: "\n"))\n}"
    }

    /// `buildFooterTemplate(theme)`: the footer the print engine repeats on every page.
    static func footerTemplate(_ theme: JSValue?) -> String {
        func color(_ key: String, _ fallback: String) -> String { theme[key].isTruthy ? "hsl(\(theme[key].s))" : fallback }
        let primary = color("primary", "#5b7fa6")
        let muted = color("muted", "#8a939f")
        let border = color("border", "#d1d5db")
        let surface = color("surface", "#ffffff")
        return """
<style>html,body{margin:0;padding:0;}</style>
    <div style="
      box-sizing: border-box;
      width: 100%;
      height: 28px;
      padding: 0 52px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: \(muted);
      background-color: \(surface);
      border-top: 1px solid \(border);
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    ">
      <span style="font-weight: 600; color: \(primary);">Vision</span>
      <span>Confidential</span>
      <span>
        <span class="pageNumber"></span>&thinsp;/&thinsp;<span class="totalPages"></span>
      </span>
    </div>
"""
    }

    /// What the cover and the file name are made from.
    struct Request {
        var kind: ReportKind
        var context: ReportContext
        /// The theme tokens of the request body.
        var theme: JSValue?
        /// The instant the report is generated at.
        var generatedAtMs: Int
        /// When the newest price was stored, as ISO 8601 text.
        var pricesAsOf: String?
        var excludedCategoryCount = 0
        var excludedRecipientCount = 0
    }

    private static func metaRow(_ label: String, _ value: String) -> String {
        """
<div class="meta-row">
            <span class="meta-label">\(label)</span>
            <span class="meta-value">\(value)</span>
          </div>
"""
    }

    /// `buildCoverHtml(...)`.
    static func cover(_ request: Request) -> String {
        let zone = request.context.zone
        let generated = Double(request.generatedAtMs)
        var filters: [String] = []
        if request.excludedCategoryCount > 0 {
            filters.append("\(request.excludedCategoryCount) categor\(request.excludedCategoryCount == 1 ? "y" : "ies") excluded")
        }
        if request.excludedRecipientCount > 0 {
            filters.append("\(request.excludedRecipientCount) recipient\(request.excludedRecipientCount == 1 ? "" : "s") excluded")
        }
        let filtersRow = filters.isEmpty ? "" : metaRow("Filters", escape(filters.joined(separator: ", ")))

        var pricesRow = ""
        if let pricesAsOf = request.pricesAsOf, !pricesAsOf.isEmpty {
            var text = "Invalid Date"
            if let time = XLSXWorkbook.isoTime(pricesAsOf), time.isFinite {
                text = ReportFormat.longDate(time, zone: zone, weekday: false)
                let age = ((generated - time) / 86_400_000).rounded(.down)
                if age > 1 { text += " (\(JavaScriptNumber.text(age)) days old)" }
            }
            pricesRow = metaRow("Prices as of", escape(text))
        } else if request.kind != .financial {
            pricesRow = metaRow("Prices as of", "No live prices recorded")
        }

        return """
<div class="cover">
      <div class="cover-band"></div>
      <div class="cover-body">
        <div class="cover-eyebrow">Vision</div>
        <div class="cover-title">\(escape(request.kind.title))</div>
        <div class="cover-subtitle">\(escape(request.kind.subtitle))</div>
        <div class="cover-divider"></div>
        <div class="cover-meta">
          <div class="meta-row">
            <span class="meta-label">Period</span>
            <span class="meta-value">\(escape(periodText(request.context)))</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Currency</span>
            <span class="meta-value">\(escape(request.context.currency))</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Generated</span>
            <span class="meta-value">\(escape(ReportFormat.longDate(generated, zone: zone, weekday: true)))</span>
          </div>
          \(pricesRow)
          \(filtersRow)
        </div>
        <div class="cover-footer">
          <span class="cover-footer-brand">Vision</span>
          <span>Confidential · \(zone.parts(atEpochMilliseconds: request.generatedAtMs).year)</span>
        </div>
      </div>
    </div>
"""
    }

    /// `assembleReportDocument(options, bodyHtml)`: the document around a rendered body.
    static func assemble(_ request: Request, body: String) -> ReportDocument {
        let html = """
<!DOCTYPE html>
<html class="\(request.theme["mode"] == .string("dark") ? "dark" : "")">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
\(themeCSS(request.theme))
\(ReportStyles.base)
  </style>
</head>
<body>
\(cover(request) + "\n" + body)
</body>
</html>
"""
        return ReportDocument(
            filename: "vision-\(request.kind.rawValue)-\(request.context.zone.day(atEpochMilliseconds: request.generatedAtMs)).pdf",
            html: html, footerTemplate: footerTemplate(request.theme))
    }
}

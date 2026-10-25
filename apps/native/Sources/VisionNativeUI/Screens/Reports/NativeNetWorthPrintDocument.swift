import AppKit
import Charts
import SwiftUI
import VisionNativeCore

/// Immutable section blocks for the native paginator; no page loaders, scrolling,
/// interactive chart bindings, table load-more callbacks, or live model references.
public struct NativeNetWorthPrintDocument: View {
    private let presentation: NativeNetWorthPrintPresentation
    private let sections: [NativeNetWorthPrintSection]
    public init(presentation: NativeNetWorthPrintPresentation, sections: [NativeNetWorthPrintSection]? = nil) {
        self.presentation = presentation
        self.sections = sections ?? presentation.snapshot.sections
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(sections) { section in
                NativeNetWorthPrintSectionView(presentation: presentation, section: section)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true).allowsHitTesting(false)
        .environment(\.locale, presentation.snapshot.settings.numberFormat.locale)
        .environment(\.visionTheme, printTheme).preferredColorScheme(.light)
    }
    private var printTheme: VisionTheme {
        VisionTheme(selection: presentation.snapshot.theme, isPrintReport: true)
    }
}


/// Row-aware blocks use only already-captured values. Column measurement sees the
/// whole frozen table before the paginator divides it into pages.
extension NativeNetWorthPrintDocument {
    @MainActor public static func printBlocks(
        presentation: NativeNetWorthPrintPresentation, width: CGFloat
    ) -> [NSView] {
        let snapshot = presentation.snapshot
        return snapshot.sections.map { section in
            switch section {
            case .accounts:
                guard let accounts = snapshot.accounts, !accounts.isEmpty else {
                    return hostedSection(presentation, section: section, width: width)
                }
                let columns = NativeNetWorthPrintTableLayout.accountColumns(presentation, width: width)
                let block = NativePagePrintTableBlock(
                    header: row(presentation, part: .accountsHeader, columns: columns, id: "networth-accounts-header"),
                    rows: accounts.map { account in
                        row(
                            presentation, part: .account(account), columns: columns,
                            id: "networth-account-" + account.id)
                    },
                    footer: snapshot.accountTotal != nil && snapshot.accountDifference != nil
                        ? row(presentation, part: .accountsFooter, columns: columns, id: "networth-accounts-footer")
                        : nil,
                    spacing: 0)
                block.identifier = NSUserInterfaceItemIdentifier("networth-accounts-table")
                return block
            case .table:
                let columns = NativeNetWorthPrintTableLayout.historyColumns(presentation, width: width)
                let rows = snapshot.tableRows.map { value in
                    row(presentation, part: .history(value), columns: columns, id: "networth-history-" + value.id)
                }
                let block = NativePagePrintTableBlock(
                    header: row(presentation, part: .historyHeader, columns: columns, id: "networth-history-header"),
                    rows: rows.isEmpty
                        ? [row(presentation, part: .historyEmpty, columns: columns, id: "networth-history-empty")]
                        : rows,
                    footer: row(presentation, part: .historyFooter, columns: columns, id: "networth-history-footer"),
                    spacing: 0)
                block.identifier = NSUserInterfaceItemIdentifier("networth-history-table")
                return block
            default:
                return hostedSection(presentation, section: section, width: width)
            }
        }
    }

    @MainActor private static func hostedSection(
        _ presentation: NativeNetWorthPrintPresentation, section: NativeNetWorthPrintSection, width: CGFloat
    ) -> NSView {
        let hosted = NativePrintHostingView(
            rootView: NativeNetWorthPrintDocument(presentation: presentation, sections: [section]).frame(width: width))
        hosted.identifier = NSUserInterfaceItemIdentifier("networth-section-" + section.rawValue)
        return hosted
    }

    @MainActor private static func row(
        _ presentation: NativeNetWorthPrintPresentation, part: NativeNetWorthPrintTablePart,
        columns: [CGFloat], id: String
    ) -> NativePagePrintRow {
        NativePagePrintRow { width in
            let snapshot = presentation.snapshot
            let hosted = NativePrintHostingView(
                rootView: NativeNetWorthPrintTablePartView(presentation: presentation, part: part, columns: columns)
                    .frame(width: width, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .allowsHitTesting(false)
                    .environment(\.locale, snapshot.settings.numberFormat.locale)
                    .environment(\.visionTheme, VisionTheme(selection: snapshot.theme, isPrintReport: true))
                    .preferredColorScheme(.light))
            hosted.identifier = NSUserInterfaceItemIdentifier(id)
            return hosted
        }
    }
}

private enum NativeNetWorthPrintTablePart {
    case accountsHeader, account(NativeNetWorthPrintAccount), accountsFooter
    case historyHeader, history(NetWorthTableRow), historyEmpty, historyFooter
}

@MainActor private enum NativeNetWorthPrintTableLayout {
    static let padding: CGFloat = 12
    static let spacing: CGFloat = 8

    static func historyValue(
        _ row: NetWorthTableRow, key: String, presentation: NativeNetWorthPrintPresentation
    ) -> String {
        if key == "date" { return presentation.date(row.snapshot.date) }
        guard case .number(let value) = row.rawValue(key) else { return "—" }
        return presentation.money(value, signed: key == "change")
    }

    static func historyColumns(_ presentation: NativeNetWorthPrintPresentation, width: CGFloat) -> [CGFloat] {
        let snapshot = presentation.snapshot
        let cells = snapshot.tableKeys.map { key in
            [snapshot.strings.t(key == "netWorth" ? "networth.title" : "networth." + key)]
                + snapshot.tableRows.map { historyValue($0, key: key, presentation: presentation) }
        }
        return columns(width: width, cells: cells, minimums: snapshot.tableKeys.map { $0 == "date" ? 72 : 48 })
    }

    static func accountColumns(_ presentation: NativeNetWorthPrintPresentation, width: CGFloat) -> [CGFloat] {
        let snapshot = presentation.snapshot
        let labels =
            (snapshot.accounts ?? []).map { $0.label ?? snapshot.strings.t("networth.byAccount.unassigned") }
            + [snapshot.strings.t("networth.byAccount.displayedTotal")]
        let amounts =
            (snapshot.accounts ?? []).map { presentation.money($0.total) }
            + (snapshot.accountTotal.map { [presentation.money($0)] } ?? [])
        return columns(width: width, cells: [labels, amounts], minimums: [120, 100])
    }

    private static func columns(width: CGFloat, cells: [[String]], minimums: [CGFloat]) -> [CGFloat] {
        guard !cells.isEmpty else { return [] }
        let available = max(CGFloat(cells.count), width - padding * 2 - spacing * CGFloat(cells.count - 1))
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        let desired = cells.map { values in
            values.map { ($0 as NSString).size(withAttributes: [.font: font]).width + 4 }.max() ?? 1
        }
        let scale = min(1, available / max(1, minimums.reduce(0, +)))
        let base = minimums.map { max(1, $0 * scale) }
        let extra = max(0, available - base.reduce(0, +))
        let demand = zip(desired, base).map { max(0, $0 - $1) }
        let totalDemand = demand.reduce(0, +)
        return zip(base, demand).map { minimum, wanted in
            minimum + extra * (totalDemand > 0 ? wanted / totalDemand : 1 / CGFloat(cells.count))
        }
    }
}

private struct NativeNetWorthPrintTablePartView: View {
    let presentation: NativeNetWorthPrintPresentation
    let part: NativeNetWorthPrintTablePart
    let columns: [CGFloat]
    @Environment(\.visionTheme) private var theme
    private var snapshot: NativeNetWorthPrintSnapshot { presentation.snapshot }
    private var strings: any Localizing { snapshot.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) { content }
            .padding(.horizontal, NativeNetWorthPrintTableLayout.padding)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.card)
    }

    @ViewBuilder private var content: some View {
        switch part {
        case .accountsHeader:
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("networth.byAccount.title")).font(.headline)
                Text(strings.t("networth.byAccount.description")).font(.callout).foregroundStyle(theme.secondaryLabel)
                Divider()
            }
        case .account(let row):
            HStack(alignment: .top, spacing: NativeNetWorthPrintTableLayout.spacing) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.label ?? strings.t("networth.byAccount.unassigned")).font(.headline)
                    if row.accountId == nil {
                        Text(strings.t("networth.byAccount.unassignedHint")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    } else if let type = row.type {
                        Text(strings.t("accounts.type." + type)).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                    if abs(row.cash) > Decimal(string: "0.005")!, abs(row.holdings) > Decimal(string: "0.005")! {
                        Text(
                            strings.t("networth.byAccount.cash") + " " + presentation.money(row.cash)
                                + " · " + strings.t("networth.byAccount.holdings") + " "
                                + presentation.money(row.holdings)
                        ).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
                .frame(width: columns[0], alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                Text(presentation.money(row.total)).font(.callout).monospacedDigit()
                    .frame(width: columns[1], alignment: .trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
        case .accountsFooter:
            if let total = snapshot.accountTotal, let difference = snapshot.accountDifference {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: NativeNetWorthPrintTableLayout.spacing) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(strings.t("networth.byAccount.displayedTotal")).font(.headline)
                            Text(
                                abs(difference) < Decimal(string: "0.005")!
                                    ? strings.t("networth.byAccount.matches")
                                    : strings.t(
                                        difference > 0 ? "networth.byAccount.above" : "networth.byAccount.below")
                                        + " " + presentation.money(abs(difference))
                            ).font(.caption).foregroundStyle(
                                abs(difference) < Decimal(string: "0.005")! ? theme.secondaryLabel : theme.warning)
                        }.frame(width: columns[0], alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(presentation.money(total)).font(.callout).monospacedDigit()
                            .frame(width: columns[1], alignment: .trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if abs(difference) >= Decimal(string: "0.005")! {
                        Text(strings.t("networth.byAccount.differenceHint")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                }
            }
        case .historyHeader:
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("networth.dailyBreakdown")).font(.headline)
                historyCells(row: nil)
                Divider()
            }
        case .history(let row):
            historyCells(row: row)
            Divider()
        case .historyEmpty:
            Text(strings.t(snapshot.tableQuery.isNarrowed ? "table.noFilterResults" : "table.noData"))
        case .historyFooter:
            VStack(alignment: .leading, spacing: 6) {
                if snapshot.tableFetchingMore { Text(strings.t("table.loadingMore")).font(.footnote) }
                Text(historyFooter).font(.footnote).foregroundStyle(theme.secondaryLabel)
                if let error = snapshot.tableError { Text(verbatim: error).foregroundStyle(theme.destructive) }
            }
        }
    }

    private func historyCells(row: NetWorthTableRow?) -> some View {
        HStack(alignment: .top, spacing: NativeNetWorthPrintTableLayout.spacing) {
            ForEach(Array(snapshot.tableKeys.enumerated()), id: \.offset) { index, key in
                Text(
                    row.map { NativeNetWorthPrintTableLayout.historyValue($0, key: key, presentation: presentation) }
                        ?? strings.t(key == "netWorth" ? "networth.title" : "networth." + key)
                )
                .font(.caption).monospacedDigit()
                .fontWeight(row == nil ? .semibold : key == "netWorth" ? .bold : .regular)
                .foregroundStyle(historyColor(row, key: key))
                .frame(width: columns[index], alignment: key == "date" ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func historyColor(_ row: NetWorthTableRow?, key: String) -> Color {
        guard key == "change", let change = row?.change else { return theme.foreground }
        return change < 0 ? theme.loss : theme.gain
    }

    private var historyFooter: String {
        var text =
            snapshot.tableRows.count != snapshot.tableLoadedCount
            ? strings.t(
                "table.shownOfFiltered",
                ["shown": String(snapshot.tableRows.count), "total": String(snapshot.tableTotal)])
            : strings.t(
                "table.loadedOf", ["loaded": String(snapshot.tableLoadedCount), "total": String(snapshot.tableTotal)])
        if snapshot.tableHasMore { text += " · " + strings.t("table.scrollForMore") }
        return text
    }
}

public struct NativeNetWorthPrintSectionView: View {
    private let presentation: NativeNetWorthPrintPresentation
    private let section: NativeNetWorthPrintSection
    @Environment(\.visionTheme) private var theme
    public init(presentation: NativeNetWorthPrintPresentation, section: NativeNetWorthPrintSection) {
        self.presentation = presentation
        self.section = section
    }
    private var snapshot: NativeNetWorthPrintSnapshot { presentation.snapshot }
    private var strings: any Localizing { snapshot.strings }
    public var body: some View {
        switch section {
        case .header:
            VisionPageHeader(title: strings.t("networth.title"), subtitle: "", symbol: "chart.line.uptrend.xyaxis") {}
        case .emptyState:
            AdminCard {
                Text(strings.t("networth.emptyTitle")).font(.headline)
                Text(strings.t("networth.emptyDescription")).foregroundStyle(theme.secondaryLabel)
                if !snapshot.isOnline {
                    Text(strings.t("portfolio.refreshPricesOffline")).foregroundStyle(theme.secondaryLabel)
                }
            }
        case .stalePrices:
            AdminCard {
                Label(
                    strings.t("portfolio.stalePricesBanner", ["n": String(snapshot.stalePriceCount)]),
                    systemImage: "exclamationmark.triangle"
                ).foregroundStyle(theme.warning)
                if !snapshot.isOnline {
                    Text(strings.t("portfolio.refreshPricesOffline")).foregroundStyle(theme.secondaryLabel)
                }
            }
        case .hero: hero
        case .accounts: accounts
        case .chart: chart
        case .summaryCards:
            HStack(spacing: 16) {
                stat(
                    "networth.peak", value: snapshot.peak.map { presentation.money($0) } ?? "—",
                    symbol: "arrow.up.right")
                stat(
                    "networth.lowest", value: snapshot.trough.map { presentation.money($0) } ?? "—",
                    symbol: "arrow.down.right")
                stat("networth.daysTracked", value: String(snapshot.displaySnapshots.count), symbol: "calendar")
            }
        case .table: table
        case .pricesError:
            if let error = snapshot.pricesError {
                Text(verbatim: error).font(.callout).foregroundStyle(theme.destructive)
            }
        }
    }
    private var hero: some View {
        AdminCard {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 40) {
                    identity
                    Spacer()
                    assetBars.frame(minWidth: 240)
                }
                VStack(alignment: .leading, spacing: 24) {
                    identity
                    assetBars
                }
            }
        }
    }
    private var identity: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(strings.t("networth.title")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(presentation.money(snapshot.data.current.netWorth)).font(.system(size: 40, weight: .semibold))
                .monospacedDigit()
            HStack {
                Text(presentation.money(snapshot.data.monthlyChange, signed: true)).monospacedDigit()
                Text("(" + presentation.percent(snapshot.data.monthlyChangePercent) + ")")
                Text(strings.t("networth.thisMonth"))
            }.font(.callout).foregroundStyle(tone(snapshot.data.monthlyChange))
            if let stamp = snapshot.priceFreshness {
                Text(
                    stamp.isEmpty
                        ? strings.t("networth.investmentPricesNotFetched")
                        : strings.t(
                            "networth.investmentPricesAsOf",
                            [
                                "date": VisionFormat.appDateTime(
                                    stamp, format: snapshot.settings.dateFormat,
                                    locale: snapshot.settings.numberFormat.locale)
                            ])
                )
                .font(.caption).foregroundStyle(theme.tertiaryLabel)
            }
            Text(strings.t("networth.sinceStart")).font(.caption).foregroundStyle(theme.tertiaryLabel)
            if let change = snapshot.allTimeChange {
                HStack {
                    Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                    Text(presentation.money(change, signed: true)).monospacedDigit()
                    if let percent = snapshot.allTimePercent { Text("(" + presentation.percent(percent) + ")") }
                }.font(.headline).foregroundStyle(tone(change))
            }
        }
    }
    private var assetBars: some View {
        VStack(alignment: .leading, spacing: 20) {
            valueBar("networth.assets", value: snapshot.assets ?? 0, gain: true)
            if (snapshot.assets ?? 0) > Decimal(string: "0.005")! {
                Text(
                    strings.t("networth.liquid") + " " + presentation.money(snapshot.data.current.liquid)
                        + " · " + strings.t("networth.investments") + " "
                        + presentation.money(snapshot.data.current.investments)
                )
                .font(.caption).foregroundStyle(theme.tertiaryLabel)
            }
            valueBar("networth.debt", value: snapshot.debt ?? 0, gain: false)
        }
    }
    private func valueBar(_ key: String, value: Decimal, gain: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(strings.t(key))
                Spacer()
                Text(value <= Decimal(string: "0.005")! ? "—" : presentation.money(value)).monospacedDigit()
            }
            .font(.callout)
            if value > Decimal(string: "0.005")! {
                let scale = max(snapshot.assets ?? 0, snapshot.debt ?? 0, 1)
                GeometryReader { geometry in
                    Capsule().fill(theme.foreground.opacity(0.06))
                    Capsule().fill(gain ? theme.gain : theme.loss)
                        .frame(
                            width: geometry.size.width
                                * CGFloat(NSDecimalNumber(decimal: min(1, value / scale)).doubleValue))
                }.frame(height: 6)
            }
        }
    }
    private var accounts: some View {
        AdminCard {
            Text(strings.t("networth.byAccount.title")).font(.headline)
            Text(strings.t("networth.byAccount.description")).font(.callout).foregroundStyle(theme.secondaryLabel)
            if let rows = snapshot.accounts {
                if rows.isEmpty { Text(strings.t("networth.byAccount.none")) }
                ForEach(rows) { row in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.label ?? strings.t("networth.byAccount.unassigned")).font(.headline)
                            if row.accountId == nil {
                                Text(strings.t("networth.byAccount.unassignedHint")).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            } else if let type = row.type {
                                Text(strings.t("accounts.type." + type)).font(.caption).foregroundStyle(
                                    theme.secondaryLabel)
                            }
                            if abs(row.cash) > Decimal(string: "0.005")!, abs(row.holdings) > Decimal(string: "0.005")!
                            {
                                Text(
                                    strings.t("networth.byAccount.cash") + " " + presentation.money(row.cash)
                                        + " · " + strings.t("networth.byAccount.holdings") + " "
                                        + presentation.money(row.holdings)
                                )
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        Spacer()
                        Text(presentation.money(row.total)).monospacedDigit()
                    }.padding(.vertical, 5)
                    Divider()
                }
                if let total = snapshot.accountTotal, let difference = snapshot.accountDifference {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(strings.t("networth.byAccount.displayedTotal")).font(.headline)
                            Text(
                                abs(difference) < Decimal(string: "0.005")!
                                    ? strings.t("networth.byAccount.matches")
                                    : strings.t(
                                        difference > 0 ? "networth.byAccount.above" : "networth.byAccount.below") + " "
                                        + presentation.money(abs(difference))
                            )
                            .font(.caption).foregroundStyle(
                                abs(difference) < Decimal(string: "0.005")! ? theme.secondaryLabel : theme.warning)
                        }
                        Spacer()
                        Text(presentation.money(total)).monospacedDigit()
                    }
                    if abs(difference) >= Decimal(string: "0.005")! {
                        Text(strings.t("networth.byAccount.differenceHint")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                }
            } else if snapshot.accountsError != nil {
                Text(strings.t("networth.byAccount.unavailable")).foregroundStyle(theme.warning)
            } else {
                ProgressView()
            }
        }
    }
    private var chart: some View {
        // Quantitative index axis: a categorical one labels every snapshot date.
        let dates = snapshot.displaySnapshots.map(\.date)
        let index = Dictionary(dates.enumerated().map { ($1, Double($0)) }, uniquingKeysWith: { first, _ in first })
        return AdminCard {
            Text(strings.t("networth.overTime")).font(.headline)
            Text(strings.t("networth.chartDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
            Chart {
                ForEach(snapshot.series) { line in
                    ForEach(line.points) { point in
                        if let x = index[point.key] {
                            if line.id == "netWorth" {
                                AreaMark(
                                    x: .value("Date", x), y: .value(line.label, coordinate(point.value)),
                                    stacking: .unstacked
                                )
                                .foregroundStyle(by: .value("Series", line.label)).opacity(0.12)
                            }
                            LineMark(
                                x: .value("Date", x), y: .value(line.label, coordinate(point.value)),
                                series: .value("Series", line.id)
                            )
                            .foregroundStyle(by: .value("Series", line.label))
                            .lineStyle(StrokeStyle(lineWidth: line.id == "netWorth" ? 2.5 : 1.5))
                        }
                    }
                }
                if let selection = snapshot.selection, let selectedX = index[selection] {
                    RuleMark(x: .value("Date", selectedX)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                    if let start = snapshot.rangeStart, let startX = index[start] {
                        RectangleMark(
                            xStart: .value("Date", min(startX, selectedX)), xEnd: .value("Date", max(startX, selectedX))
                        )
                        .foregroundStyle(theme.primary.opacity(0.08))
                    }
                }
            }
            .chartForegroundStyleScale(
                domain: snapshot.series.map(\.label), range: snapshot.series.map { chartColor($0.id) }
            )
            .chartXScale(domain: 0...Double(max(dates.count - 1, 1)))
            .chartXAxis {
                AxisMarks(values: ChartAxisTicks.evenlySpaced(dates.indices.map(Double.init))) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let position = value.as(Double.self), dates.indices.contains(Int(position.rounded())) {
                            Text(presentation.tick(dates[Int(position.rounded())]))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let value = value.as(Double.self) {
                            Text(
                                VisionFormat.currency(
                                    Decimal(value), code: snapshot.currency,
                                    locale: snapshot.settings.numberFormat.locale, fractionDigits: 0))
                        }
                    }
                }
            }.frame(height: 380)
            if let selection = snapshot.selection {
                VStack(alignment: .leading, spacing: 3) {
                    Text(
                        snapshot.rangeStart.map { presentation.date($0) + " – " + presentation.date(selection) }
                            ?? presentation.date(selection)
                    ).font(.caption.weight(.medium))
                    ForEach(snapshot.readouts) { row in
                        HStack {
                            Text(row.label).foregroundStyle(theme.secondaryLabel)
                            Spacer()
                            Text(presentation.money(row.value)).monospacedDigit()
                            if let change = row.change {
                                Text("Δ")
                                Text(presentation.money(change, signed: true)).monospacedDigit().foregroundStyle(
                                    change < 0 ? theme.loss : theme.gain)
                            }
                            if let percent = row.percent { Text(presentation.percent(percent)) }
                        }.font(.caption)
                    }
                }.padding(8).background(theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
    private var table: some View {
        VStack(alignment: .leading, spacing: 8) {
            AdminCard {
                Text(strings.t("networth.dailyBreakdown")).font(.headline)
                HStack {
                    ForEach(snapshot.tableKeys, id: \.self) { key in
                        Text(strings.t(key == "netWorth" ? "networth.title" : "networth." + key)).font(
                            .caption.weight(.semibold)
                        ).frame(maxWidth: .infinity, alignment: key == "date" ? .leading : .trailing)
                    }
                }
                Divider()
                if snapshot.tableRows.isEmpty {
                    Text(strings.t(snapshot.tableQuery.isNarrowed ? "table.noFilterResults" : "table.noData"))
                }
                ForEach(snapshot.tableRows) { row in
                    HStack {
                        ForEach(snapshot.tableKeys, id: \.self) { key in
                            Text(tableValue(row, key: key)).font(.caption).monospacedDigit()
                                .fontWeight(key == "netWorth" ? .bold : .regular)
                                .foregroundStyle(tableColor(row, key: key))
                                .frame(maxWidth: .infinity, alignment: key == "date" ? .leading : .trailing)
                        }
                    }
                    Divider()
                }
                if snapshot.tableFetchingMore { Text(strings.t("table.loadingMore")).font(.footnote) }
                Text(tableFooter).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            if let error = snapshot.tableError { Text(verbatim: error).foregroundStyle(theme.destructive) }
        }
    }
    private func tableValue(_ row: NetWorthTableRow, key: String) -> String {
        if key == "date" { return presentation.date(row.snapshot.date) }
        guard case .number(let value) = row.rawValue(key) else { return "—" }
        return presentation.money(value, signed: key == "change")
    }
    private var tableFooter: String {
        var text =
            snapshot.tableRows.count != snapshot.tableLoadedCount
            ? strings.t(
                "table.shownOfFiltered",
                ["shown": String(snapshot.tableRows.count), "total": String(snapshot.tableTotal)])
            : strings.t(
                "table.loadedOf", ["loaded": String(snapshot.tableLoadedCount), "total": String(snapshot.tableTotal)])
        if snapshot.tableHasMore { text += " · " + strings.t("table.scrollForMore") }
        return text
    }
    private func tableColor(_ row: NetWorthTableRow, key: String) -> Color {
        guard key == "change", let change = row.change else { return theme.foreground }
        return change < 0 ? theme.loss : theme.gain
    }
    private func stat(_ key: String, value: String, symbol: String) -> some View {
        AdminCard {
            Label(strings.t(key), systemImage: symbol).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(value).font(.title2).monospacedDigit()
        }
    }
    private func chartColor(_ id: String) -> Color {
        switch id {
        case "liquid": Color(token: theme.palette.chart2)
        case "investments": Color(token: theme.palette.chart4)
        case "liabilities": theme.loss
        default: theme.primary
        }
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func tone(_ value: Decimal) -> Color {
        abs(value) <= Decimal(string: "0.005")! ? theme.secondaryLabel : value > 0 ? theme.gain : theme.loss
    }
}

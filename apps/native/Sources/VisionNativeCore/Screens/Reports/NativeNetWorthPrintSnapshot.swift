import Foundation

public enum NativeNetWorthPrintSection: String, CaseIterable, Identifiable, Sendable {
    case header, emptyState, stalePrices, hero, accounts, chart, summaryCards, table, pricesError
    public var id: String { rawValue }
}

public struct NativeNetWorthPrintAccount: Identifiable, Equatable, Sendable {
    public let id: String
    public let accountId: Int?
    public let label: String?
    public let type: String?
    public let cash: Decimal
    public let holdings: Decimal
    public let total: Decimal
}

public struct NativeNetWorthPrintReadout: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let value: Decimal
    public let change: Decimal?
    public let percent: Decimal?
}

/// Values of the currently rendered page. Capture reads existing display getters once;
/// document layout never queries services, refreshes prices, rebuilds account allocations,
/// re-filters history, or evaluates monetary differences.
public struct NativeNetWorthPrintSnapshot: Sendable {
    public let data: OpenAPI.NetWorthResponse
    public let settings: NativeAppSettings
    public let strings: any Localizing
    public let theme: ThemeSelection
    public let period: NetWorthPeriod
    public let snapshots: [OpenAPI.NetWorthSnapshot]
    public let displaySnapshots: [OpenAPI.NetWorthSnapshot]
    public let accounts: [NativeNetWorthPrintAccount]?
    public let accountTotal: Decimal?
    public let accountDifference: Decimal?
    public let accountsError: String?
    public let tableRows: [NetWorthTableRow]
    public let tableKeys: [String]
    public let tableQuery: LocalTableQuery
    public let tableLoadedCount: Int
    public let tableTotal: Int
    public let tableHasMore: Bool
    public let tableFetchingMore: Bool
    public let tableError: String?
    public let pricesError: String?
    public let stalePriceCount: Int
    public let priceFreshness: String?
    public let isOnline: Bool
    public let assets: Decimal?
    public let debt: Decimal?
    public let peak: Decimal?
    public let trough: Decimal?
    public let allTimeChange: Decimal?
    public let allTimePercent: Decimal?
    public let selection: String?
    public let rangeStart: String?
    public let series: [InsightChartSeries]
    public let readouts: [NativeNetWorthPrintReadout]
    public var currency: String { data.current.currency }
    public var visibleWidgets: Set<String> { Set(sections.map(\.rawValue)) }
    public var sections: [NativeNetWorthPrintSection] {
        var result: [NativeNetWorthPrintSection] = [.header]
        if snapshots.isEmpty {
            result.append(.emptyState)
        } else {
            if stalePriceCount > 0 { result.append(.stalePrices) }
            result += [.hero, .accounts, .chart, .summaryCards, .table]
        }
        if pricesError != nil { result.append(.pricesError) }
        return result
    }

    @MainActor public static func capture(shell: NativeShellModel) throws -> Self {
        guard shell.route.path == "/portfolio/net-worth", let model = shell.portfolio?.netWorth else {
            throw APIError.invalidRequest("Net worth print requires the currently displayed page")
        }
        return try capture(model: model, settings: shell.settings, strings: shell.strings, theme: shell.theme)
    }

    @MainActor public static func capture(
        model: NetWorthModel, settings: NativeAppSettings, strings: any Localizing, theme: ThemeSelection
    ) throws -> Self {
        guard !model.isLoading, model.error == nil, let data = model.data,
            model.currency == settings.defaultCurrency, data.current.currency == settings.defaultCurrency
        else { throw APIError.invalidRequest("Net worth print requires loaded values in the displayed currency") }
        let display = model.displaySnapshots
        let accounts = model.accountRows?.map {
            NativeNetWorthPrintAccount(
                id: $0.id, accountId: $0.accountId, label: $0.label, type: $0.type,
                cash: $0.cash, holdings: $0.holdings, total: $0.total)
        }
        let total = model.accountRows == nil ? nil : model.accountsTotal
        let keys =
            ["liquid", "investments"]
            + (display.contains { abs($0.liabilities) > Decimal(string: "0.005")! } ? ["liabilities"] : [])
            + ["netWorth"]
        let series = keys.map { key in
            InsightChartSeries(
                id: key, label: strings.t(key == "netWorth" ? "networth.seriesTotal" : "networth." + key),
                points: display.map { row in
                    let value: Decimal
                    switch key {
                    case "liquid": value = row.liquid
                    case "investments": value = row.investments
                    case "liabilities": value = row.liabilities
                    default: value = row.netWorth
                    }
                    return InsightChartPoint(key: row.date, value: value)
                })
        }
        let readouts = series.compactMap { line -> NativeNetWorthPrintReadout? in
            guard let selected = model.selection,
                let value = line.points.first(where: { $0.key == selected })?.value
            else { return nil }
            let start = model.rangeStart.flatMap { key in line.points.first { $0.key == key }?.value }
            let change = start.map { value - $0 }
            return NativeNetWorthPrintReadout(
                id: line.id, label: line.label, value: value, change: change,
                percent: start.flatMap { $0 == 0 ? nil : (value - $0) / abs($0) * 100 })
        }
        return Self(
            data: data, settings: settings, strings: strings, theme: theme, period: model.period,
            snapshots: model.snapshots, displaySnapshots: display,
            accounts: accounts, accountTotal: total,
            accountDifference: total.map { NetWorthAccountRow.cents($0 - data.current.netWorth) },
            accountsError: model.accountsError, tableRows: model.tableRows,
            tableKeys: model.tableKeys, tableQuery: model.tableQuery,
            tableLoadedCount: model.tableSnapshots.count, tableTotal: model.tableTotal,
            tableHasMore: model.hasMore, tableFetchingMore: model.isFetchingMore,
            tableError: model.tableError, pricesError: model.pricesError,
            stalePriceCount: model.stalePriceCount, priceFreshness: model.priceFreshness,
            isOnline: model.isOnline,
            assets: model.assets, debt: model.debt, peak: model.peak, trough: model.trough,
            allTimeChange: model.allTimeChange, allTimePercent: model.allTimePercent,
            selection: model.selection, rangeStart: model.rangeStart, series: series, readouts: readouts)
    }
}

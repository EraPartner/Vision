import Foundation

/// Exact repeated-symbol and default-query rules of researchCompareUrlState/useTabParam.
public struct ResearchCompareURLState: Equatable, Sendable {
    public static let maximumSymbols = 6
    public static let ranges = ["1mo", "3mo", "6mo", "1y", "5y"]
    public static let tabs = ["performance", "fundamentals"]
    public let symbols: [String]
    public let range: String
    public let tab: String
    public let sort: String?
    public init(route: NativeRoute) {
        var symbols: [String] = []
        for value in route.query where value.name == "symbol" {
            if let symbol = Self.normalizeSymbol(value.value ?? ""), !symbols.contains(symbol) {
                symbols.append(symbol)
            }
            if symbols.count == Self.maximumSymbols { break }
        }
        self.symbols = symbols
        let range = route.value("range") ?? ""
        self.range = Self.ranges.contains(range) ? range : "1y"
        let tab = route.value("tab") ?? ""
        self.tab = Self.tabs.contains(tab) ? tab : "performance"
        sort = route.value("sort").flatMap { ResearchCompareMetric.keys.contains($0) ? $0 : nil }
    }
    public static func normalizeSymbol(_ raw: String) -> String? {
        // String.trim's ECMAScript WhiteSpace/LineTerminator set. Foundation also
        // trims U+0085, which the existing provider-symbol helper rejects.
        let whitespace = CharacterSet(
            charactersIn:
                "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
        )
        let symbol = raw.trimmingCharacters(in: whitespace).uppercased()
        return symbol.range(of: #"\A[A-Z0-9^][A-Z0-9.^=/_-]{0,31}\z"#, options: .regularExpression) == nil
            ? nil : symbol
    }
    public func writingSymbols(_ symbols: [String], to route: NativeRoute) -> NativeRoute {
        NativeRoute(
            path: route.path,
            query: route.query.filter { $0.name != "symbol" }
                + symbols.prefix(Self.maximumSymbols).map { URLQueryItem(name: "symbol", value: $0) })
    }
    public func adding(_ raw: String, to route: NativeRoute) -> NativeRoute {
        guard let symbol = Self.normalizeSymbol(raw), !symbols.contains(symbol), symbols.count < Self.maximumSymbols
        else { return route }
        return writingSymbols(symbols + [symbol], to: route)
    }
    public func removing(_ symbol: String, from route: NativeRoute) -> NativeRoute {
        writingSymbols(symbols.filter { $0 != symbol }, to: route)
    }
    public func settingRange(_ range: String, in route: NativeRoute) -> NativeRoute {
        range == "1y" ? route.removing("range") : route.setting("range", to: range)
    }
    public func settingTab(_ tab: String, in route: NativeRoute) -> NativeRoute { route.setting("tab", to: tab) }
    public func togglingSort(_ key: String, in route: NativeRoute) -> NativeRoute {
        sort == key ? route.removing("sort") : route.setting("sort", to: key)
    }
    public var sourceKey: String { symbols.joined(separator: "|") + ":" + range }
}

public struct ResearchCompareMetric: Equatable, Sendable, Identifiable {
    public let id: String
    public let labelKey: String
    public let format: String
    public let higherIsBetter: Bool
    public static let all: [Self] = [
        .init(id: "pe", labelKey: "market.pe", format: "ratio", higherIsBetter: false),
        .init(id: "forwardPE", labelKey: "market.forwardPE", format: "ratio", higherIsBetter: false),
        .init(id: "marketCap", labelKey: "market.marketCap", format: "largeNum", higherIsBetter: true),
        .init(id: "dividendYield", labelKey: "market.divYield", format: "pct", higherIsBetter: true),
        .init(id: "eps", labelKey: "market.eps", format: "ratio", higherIsBetter: true),
        .init(id: "beta", labelKey: "market.beta", format: "ratio", higherIsBetter: false),
        .init(id: "priceToBook", labelKey: "market.priceBook", format: "ratio", higherIsBetter: false),
        .init(id: "profitMargin", labelKey: "research.fundamentals.profitMargin", format: "pct", higherIsBetter: true),
        .init(id: "returnOnEquity", labelKey: "research.fundamentals.roe", format: "pct", higherIsBetter: true),
        .init(id: "revenue", labelKey: "research.fundamentals.revenue", format: "largeNum", higherIsBetter: true),
        .init(id: "debtToEquity", labelKey: "research.metric.debtToEquity", format: "ratio", higherIsBetter: false),
        .init(id: "currentRatio", labelKey: "research.metric.currentRatio", format: "ratio", higherIsBetter: true),
        .init(id: "revenueGrowth", labelKey: "research.metric.revenueGrowth", format: "pct", higherIsBetter: true),
        .init(id: "fcfYield", labelKey: "research.metric.fcfYield", format: "pct", higherIsBetter: true),
    ]
    public static var keys: [String] { all.map(\.id) }
}

import Foundation

public struct ResearchMeta: Equatable, Sendable {
    public let raw: JSONValue?
    public let provider: String?
    public let source: String
    public let requestId: String?
    public init(raw: JSONValue? = nil) {
        self.raw = raw
        provider = raw?["provider"]?.stringValue
        source = raw?["source"]?.stringValue ?? "unavailable"
        requestId = raw?["requestId"]?.stringValue
    }
}
public struct ResearchSnapshot<Value: Sendable>: Sendable {
    public let data: Value
    public let meta: ResearchMeta
    public init(data: Value, meta: ResearchMeta = .init()) {
        self.data = data
        self.meta = meta
    }
}
extension ResearchSnapshot: Equatable where Value: Equatable {}
public typealias ResearchResult<Value: Sendable> = ResearchSnapshot<Value>

public struct ResearchRangeOption: Equatable, Sendable, Identifiable {
    public let label: String
    public let range: String
    public let interval: String
    public var id: String { range }
    public init(label: String, range: String, interval: String) {
        self.label = label
        self.range = range
        self.interval = interval
    }
    public static let research: [Self] = [
        .init(label: "1M", range: "1mo", interval: "1d"), .init(label: "3M", range: "3mo", interval: "1d"),
        .init(label: "6M", range: "6mo", interval: "1d"), .init(label: "1Y", range: "1y", interval: "1wk"),
        .init(label: "5Y", range: "5y", interval: "1mo"),
    ]
    public static let lookup: [Self] =
        [.init(label: "1D", range: "1d", interval: "5m"), .init(label: "5D", range: "5d", interval: "15m")] + research
        + [.init(label: "MAX", range: "max", interval: "1mo")]
}

public struct ResearchSearchItem: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let symbol: String?
    public let name: String?
    public let type: String?
    public let exchange: String?
    public var id: String { (symbol ?? "") + "|" + (exchange ?? "") + "|" + (name ?? "") }

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        symbol = try ResearchDecode.optionalString(raw["symbol"])
        name = try ResearchDecode.optionalString(raw["name"])
        type = try ResearchDecode.optionalString(raw["type"])
        exchange = try ResearchDecode.optionalString(raw["exchange"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchSearchData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let items: [ResearchSearchItem]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        items = try ResearchDecode.required(raw["items"], [ResearchSearchItem].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchQuote: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let symbol: String
    public let currency: String
    public let name: String?
    public let exchange: String?
    public let type: String?
    public let price: Decimal?
    public let change: Decimal?
    public let changePercent: Decimal?
    public let open: Decimal?
    public let dayHigh: Decimal?
    public let dayLow: Decimal?
    public let prevClose: Decimal?
    public let volume: Decimal?
    public let avgVolume: Decimal?
    public let high52w: Decimal?
    public let low52w: Decimal?
    public let marketCap: Decimal?
    public let pe: Decimal?
    public let forwardPE: Decimal?
    public let dividendYield: Decimal?
    public let eps: Decimal?
    public let beta: Decimal?
    public let priceToBook: Decimal?
    public var id: String { symbol }

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        symbol = try ResearchDecode.string(raw["symbol"])
        currency = try ResearchDecode.string(raw["currency"])
        name = try ResearchDecode.optionalString(raw["name"])
        exchange = try ResearchDecode.optionalString(raw["exchange"])
        type = try ResearchDecode.optionalString(raw["type"])
        price = try ResearchDecode.optionalDecimal(raw["price"])
        change = try ResearchDecode.optionalDecimal(raw["change"])
        changePercent = try ResearchDecode.optionalDecimal(raw["changePercent"])
        open = try ResearchDecode.optionalDecimal(raw["open"])
        dayHigh = try ResearchDecode.optionalDecimal(raw["dayHigh"])
        dayLow = try ResearchDecode.optionalDecimal(raw["dayLow"])
        prevClose = try ResearchDecode.optionalDecimal(raw["prevClose"])
        volume = try ResearchDecode.optionalDecimal(raw["volume"])
        avgVolume = try ResearchDecode.optionalDecimal(raw["avgVolume"])
        high52w = try ResearchDecode.optionalDecimal(raw["high52w"])
        low52w = try ResearchDecode.optionalDecimal(raw["low52w"])
        marketCap = try ResearchDecode.optionalDecimal(raw["marketCap"])
        pe = try ResearchDecode.optionalDecimal(raw["pe"])
        forwardPE = try ResearchDecode.optionalDecimal(raw["forwardPE"])
        dividendYield = try ResearchDecode.optionalDecimal(raw["dividendYield"])
        eps = try ResearchDecode.optionalDecimal(raw["eps"])
        beta = try ResearchDecode.optionalDecimal(raw["beta"])
        priceToBook = try ResearchDecode.optionalDecimal(raw["priceToBook"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchChartPoint: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let time: Decimal
    public let close: Decimal?
    public let high: Decimal?
    public let low: Decimal?
    public let volume: Decimal?

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        time = try ResearchDecode.decimal(raw["time"])
        close = try ResearchDecode.optionalDecimal(raw["close"])
        high = try ResearchDecode.optionalDecimal(raw["high"])
        low = try ResearchDecode.optionalDecimal(raw["low"])
        volume = try ResearchDecode.optionalDecimal(raw["volume"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchChartData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let symbol: String?
    public let currency: String?
    public let points: [ResearchChartPoint]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        symbol = try ResearchDecode.optionalString(raw["symbol"])
        currency = try ResearchDecode.optionalString(raw["currency"])
        points = try ResearchDecode.required(raw["points"] ?? raw["items"], [ResearchChartPoint].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchNewsArticle: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let title: String?
    public let link: String?
    public let publisher: String?
    public let thumbnail: String?
    public let publishedAt: Decimal?
    public let relatedSymbols: [String]
    public var id: String { link ?? ((title ?? "") + "|" + (publisher ?? "")) }

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        title = try ResearchDecode.optionalString(raw["title"])
        link = try ResearchDecode.optionalString(raw["link"])
        publisher = try ResearchDecode.optionalString(raw["publisher"])
        thumbnail = try ResearchDecode.optionalString(raw["thumbnail"])
        publishedAt = try ResearchDecode.optionalDecimal(raw["publishedAt"])
        relatedSymbols = try ResearchDecode.required(raw["relatedSymbols"], [String].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchNewsData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let articles: [ResearchNewsArticle]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        articles = try ResearchDecode.required(raw["articles"], [ResearchNewsArticle].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchScorecardFlag: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let metric: String
    public let category: String
    public let better: String
    public let value: Decimal
    public let severity: String
    public let code: String
    public let reasonKey: String
    public let reason: String
    public let benchmark: String
    public var id: String { code + "|" + reasonKey + "|" + metric }

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        metric = try ResearchDecode.string(raw["metric"])
        category = try ResearchDecode.string(raw["category"])
        better = try ResearchDecode.string(raw["better"])
        value = try ResearchDecode.decimal(raw["value"])
        severity = try ResearchDecode.string(raw["severity"])
        code = try ResearchDecode.string(raw["code"])
        reasonKey = try ResearchDecode.string(raw["reasonKey"])
        reason = try ResearchDecode.string(raw["reason"])
        benchmark = try ResearchDecode.string(raw["benchmark"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchScorecard: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let score: Decimal?
    public let grade: String
    public let evaluated: Int
    public let counts: [String: Int]
    public let flags: [ResearchScorecardFlag]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        score = try ResearchDecode.optionalDecimal(raw["score"])
        grade = try ResearchDecode.string(raw["grade"])
        evaluated = try ResearchDecode.count(raw["evaluated"])
        counts = try ResearchDecode.required(raw["counts"], [String: Int].self)
        flags = try ResearchDecode.required(raw["flags"], [ResearchScorecardFlag].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchScorecardData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let symbol: String
    public let fundamentals: TaxValue
    public let scorecard: ResearchScorecard

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        symbol = try ResearchDecode.string(raw["symbol"])
        fundamentals = try ResearchDecode.object(raw["fundamentals"])
        scorecard = try ResearchDecode.required(raw["scorecard"], ResearchScorecard.self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchAnalystConsensus: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let strongBuy: Decimal
    public let buy: Decimal
    public let hold: Decimal
    public let sell: Decimal
    public let strongSell: Decimal

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        strongBuy = try ResearchDecode.decimal(raw["strongBuy"])
        buy = try ResearchDecode.decimal(raw["buy"])
        hold = try ResearchDecode.decimal(raw["hold"])
        sell = try ResearchDecode.decimal(raw["sell"])
        strongSell = try ResearchDecode.decimal(raw["strongSell"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchAnalystAction: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let date: TaxValue?
    public let firm: String?
    public let toGrade: String?
    public let fromGrade: String?
    public let action: String?

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        date = raw["date"] == .null ? nil : raw["date"]
        firm = try ResearchDecode.optionalString(raw["firm"])
        toGrade = try ResearchDecode.optionalString(raw["toGrade"])
        fromGrade = try ResearchDecode.optionalString(raw["fromGrade"])
        action = try ResearchDecode.optionalString(raw["action"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchAnalystData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let symbol: String
    public let consensus: ResearchAnalystConsensus?
    public let targetMean: Decimal?
    public let targetHigh: Decimal?
    public let targetLow: Decimal?
    public let numberOfAnalysts: Decimal?
    public let recentActions: [ResearchAnalystAction]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        symbol = try ResearchDecode.string(raw["symbol"])
        consensus = try ResearchDecode.optional(raw["consensus"], ResearchAnalystConsensus.self)
        targetMean = try ResearchDecode.optionalDecimal(raw["targetMean"])
        targetHigh = try ResearchDecode.optionalDecimal(raw["targetHigh"])
        targetLow = try ResearchDecode.optionalDecimal(raw["targetLow"])
        numberOfAnalysts = try ResearchDecode.optionalDecimal(raw["numberOfAnalysts"])
        recentActions = try ResearchDecode.required(raw["recentActions"], [ResearchAnalystAction].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchWatchlistItem: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: WatchlistItemID
    public let name: String
    public let symbol: String?
    public let assetClass: String
    public let targetPrice: Decimal
    public let addedPrice: Decimal?
    public let currency: CurrencyCode
    public let notes: String?
    public let priceProviderId: String?
    public let createdAt: String
    public let updatedAt: String

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = WatchlistItemID(try ResearchDecode.count(raw["id"]))
        name = try ResearchDecode.string(raw["name"])
        symbol = try ResearchDecode.optionalString(raw["symbol"])
        assetClass = try ResearchDecode.string(raw["asset_class"])
        targetPrice = try ResearchDecode.decimal(raw["target_price"])
        addedPrice = try ResearchDecode.optionalDecimal(raw["added_price"])
        guard let code = CurrencyCode(rawValue: try ResearchDecode.string(raw["currency"])) else {
            throw ResearchDecode.failure("Invalid watchlist currency")
        }
        currency = code
        notes = try ResearchDecode.optionalString(raw["notes"])
        priceProviderId = try ResearchDecode.optionalString(raw["price_provider_id"])
        createdAt = try ResearchDecode.string(raw["created_at"])
        updatedAt = try ResearchDecode.string(raw["updated_at"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchWatchlistPage: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let items: [ResearchWatchlistItem]
    public let total: Int
    public let limit: Int
    public let offset: Int

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        items = try ResearchDecode.required(raw["items"], [ResearchWatchlistItem].self)
        total = try ResearchDecode.count(raw["total"])
        limit = try ResearchDecode.count(raw["limit"])
        offset = try ResearchDecode.count(raw["offset"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchPriceHistoryPoint: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let timestampMs: Decimal
    public let price: Decimal

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        timestampMs = try ResearchDecode.decimal(raw["timestampMs"])
        price = try ResearchDecode.decimal(raw["price"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchPriceHistoryData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let investmentId: InvestmentID
    public let provider: String
    public let points: [ResearchPriceHistoryPoint]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        investmentId = InvestmentID(try ResearchDecode.count(raw["investment_id"]))
        provider = try ResearchDecode.string(raw["provider"])
        points = try ResearchDecode.required(raw["points"], [ResearchPriceHistoryPoint].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchMapping: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: InstrumentProviderMappingID
    public let instrumentKey: String
    public let keyType: String
    public let provider: String
    public let providerSymbol: String?
    public let resolvedName: String?
    public let exchange: String?
    public let currency: String?
    public let verifiedAt: String?
    public let status: String
    public let createdAt: String
    public let updatedAt: String

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = InstrumentProviderMappingID(try ResearchDecode.count(raw["id"]))
        instrumentKey = try ResearchDecode.string(raw["instrument_key"])
        keyType = try ResearchDecode.string(raw["key_type"])
        provider = try ResearchDecode.string(raw["provider"])
        providerSymbol = try ResearchDecode.optionalString(raw["provider_symbol"])
        resolvedName = try ResearchDecode.optionalString(raw["resolved_name"])
        exchange = try ResearchDecode.optionalString(raw["exchange"])
        currency = try ResearchDecode.optionalString(raw["currency"])
        verifiedAt = try ResearchDecode.optionalString(raw["verified_at"])
        status = try ResearchDecode.string(raw["status"])
        createdAt = try ResearchDecode.string(raw["created_at"])
        updatedAt = try ResearchDecode.string(raw["updated_at"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchMappingProposal: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let provider: String
    public let status: String
    public let providerSymbol: String?
    public let resolvedName: String?
    public let exchange: String?
    public let currency: String?
    public let reason: String?
    public let error: String?
    public let fromHolding: Bool?
    public let fromStore: Bool?
    public let candidates: [ResearchSearchItem]?
    public var isConfirmable: Bool {
        !(providerSymbol ?? "").isEmpty && fromHolding != true && ["auto", "confirmed"].contains(status)
    }

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        provider = try ResearchDecode.string(raw["provider"])
        status = try ResearchDecode.string(raw["status"])
        providerSymbol = try ResearchDecode.optionalString(raw["providerSymbol"])
        resolvedName = try ResearchDecode.optionalString(raw["resolvedName"])
        exchange = try ResearchDecode.optionalString(raw["exchange"])
        currency = try ResearchDecode.optionalString(raw["currency"])
        reason = try ResearchDecode.optionalString(raw["reason"])
        error = try ResearchDecode.optionalString(raw["error"])
        fromHolding = try ResearchDecode.optionalBool(raw["fromHolding"])
        fromStore = try ResearchDecode.optionalBool(raw["fromStore"])
        candidates = try ResearchDecode.optional(raw["candidates"], [ResearchSearchItem].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchMappingsData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let items: [ResearchMapping]
    public let total: Int

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        items = try ResearchDecode.required(raw["items"], [ResearchMapping].self)
        total = try ResearchDecode.count(raw["total"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchMappingResolveData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let instrumentKey: String
    public let keyType: String
    public let proposals: [ResearchMappingProposal]
    public let existing: [ResearchMapping]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        instrumentKey = try ResearchDecode.string(raw["instrument_key"])
        keyType = try ResearchDecode.string(raw["key_type"])
        proposals = try ResearchDecode.required(raw["proposals"], [ResearchMappingProposal].self)
        existing = try ResearchDecode.required(raw["existing"], [ResearchMapping].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public struct ResearchMappingAuditData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let ok: Bool
    public let quotes: [TaxValue]
    public let discrepancies: [TaxValue]

    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        ok = try ResearchDecode.bool(raw["ok"])
        quotes = try ResearchDecode.required(raw["quotes"], [TaxValue].self)
        discrepancies = try ResearchDecode.required(raw["discrepancies"], [TaxValue].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}

public enum ResearchDecode {
    public static func failure(_ message: String) -> APIError {
        .contract(.init(endpoint: "research", issues: [message]))
    }
    static func requireObject(_ value: TaxValue) throws {
        guard value.objectValue != nil else { throw failure("Expected research object") }
    }
    static func object(_ value: TaxValue?) throws -> TaxValue {
        guard let value, value.objectValue != nil else { throw failure("Expected research object") }
        return value
    }
    static func string(_ value: TaxValue?) throws -> String {
        guard let value = value?.stringValue else { throw failure("Expected research string") }
        return value
    }
    static func optionalString(_ value: TaxValue?) throws -> String? {
        guard let value, value != .null else { return nil }
        return try string(value)
    }
    static func decimal(_ value: TaxValue?) throws -> Decimal {
        guard let value = value?.decimalValue, !value.isNaN else { throw failure("Expected research decimal") }
        return value
    }
    static func optionalDecimal(_ value: TaxValue?) throws -> Decimal? {
        guard let value, value != .null else { return nil }
        return try decimal(value)
    }
    static func count(_ value: TaxValue?) throws -> Int {
        let number = try decimal(value)
        guard number >= 0, number <= 9_007_199_254_740_991 else { throw failure("Invalid research count") }
        let count = NSDecimalNumber(decimal: number).intValue
        guard Decimal(count) == number else { throw failure("Invalid research count") }
        return count
    }
    static func bool(_ value: TaxValue?) throws -> Bool {
        guard let value = value?.boolValue else { throw failure("Expected research boolean") }
        return value
    }
    static func optionalBool(_ value: TaxValue?) throws -> Bool? {
        guard let value, value != .null else { return nil }
        return try bool(value)
    }
    static func required<T: Decodable>(_ value: TaxValue?, _ type: T.Type) throws -> T {
        guard let value else { throw failure("Missing research data") }
        return try value.decode(type)
    }
    static func optional<T: Decodable>(_ value: TaxValue?, _ type: T.Type) throws -> T? {
        guard let value, value != .null else { return nil }
        return try value.decode(type)
    }
}

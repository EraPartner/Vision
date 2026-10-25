import Foundation

public struct ResearchMacroSearchItem: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let provider: String
    public let seriesId: String
    public let title: String
    public let region: String?
    public let units: String?
    public let frequency: String?
    public let source: String?
    public var id: String { provider + "|" + seriesId }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        provider = try ResearchDecode.string(raw["provider"])
        seriesId = try ResearchDecode.string(raw["seriesId"])
        title = try ResearchDecode.string(raw["title"])
        region = try ResearchDecode.optionalString(raw["region"])
        units = try ResearchDecode.optionalString(raw["units"])
        frequency = try ResearchDecode.optionalString(raw["frequency"])
        source = try ResearchDecode.optionalString(raw["source"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchMacroSearchData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let items: [ResearchMacroSearchItem]
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        items = try ResearchDecode.required(raw["items"], [ResearchMacroSearchItem].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchMacroSeriesData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let provider: String
    public let seriesId: String
    public let title: String
    public let units: String?
    public let frequency: String?
    public let points: [ResearchChartPoint]
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        provider = try ResearchDecode.string(raw["provider"])
        seriesId = try ResearchDecode.string(raw["seriesId"])
        title = try ResearchDecode.string(raw["title"])
        units = try ResearchDecode.optionalString(raw["units"])
        frequency = try ResearchDecode.optionalString(raw["frequency"])
        points = try ResearchDecode.required(raw["points"], [ResearchChartPoint].self)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    public var chart: ResearchChartData {
        get throws { try ResearchChartData(raw: raw) }
    }
}
public struct ResearchChartBuilderMacro: Codable, Equatable, Sendable {
    public var provider: String
    public var seriesId: String
    public var title: String
    public init(provider: String, seriesId: String, title: String) {
        self.provider = provider
        self.seriesId = seriesId
        self.title = title
    }
    public var raw: TaxValue {
        .object(["provider": .string(provider), "seriesId": .string(seriesId), "title": .string(title)])
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(raw, required: ["provider", "seriesId", "title"])
        provider = try ResearchChartValidation.choice(raw["provider"], ["fred", "eurostat", "dbnomics"])
        seriesId = try ResearchChartValidation.string(raw["seriesId"], min: 1, max: 128)
        title = try ResearchChartValidation.string(raw["title"], min: 1, max: 256)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchChartBuilderSeries: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var symbol: String
    public var field: String
    public var type: String
    public var axis: String
    public var provider: String
    public var macro: ResearchChartBuilderMacro?
    public init(
        id: String, symbol: String, field: String = "price", type: String = "line", axis: String = "left",
        provider: String = "", macro: ResearchChartBuilderMacro? = nil
    ) {
        self.id = id
        self.symbol = symbol
        self.field = field
        self.type = type
        self.axis = axis
        self.provider = provider
        self.macro = macro
    }
    public var fetchKey: String {
        macro.map { "m|" + $0.provider + "|" + $0.seriesId } ?? "c|" + symbol + "|" + provider
    }
    public var label: String { macro?.title ?? symbol }
    public var raw: TaxValue {
        var value: TaxValue = .object([
            "id": .string(id), "symbol": .string(symbol), "field": .string(field), "type": .string(type),
            "axis": .string(axis), "provider": .string(provider),
        ])
        if let macro { value["macro"] = macro.raw }
        return value
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(
            raw, required: ["id", "symbol", "field", "type", "axis", "provider"], optional: ["macro"])
        id = try ResearchChartValidation.string(raw["id"], min: 1, max: 128)
        symbol = try ResearchChartValidation.string(raw["symbol"], min: 1, max: 64)
        field = try ResearchChartValidation.choice(raw["field"], ["price", "volume"])
        type = try ResearchChartValidation.choice(raw["type"], ["line", "area", "candlestick", "bar"])
        axis = try ResearchChartValidation.choice(raw["axis"], ["left", "right"])
        provider = try ResearchChartValidation.string(raw["provider"], max: 64)
        macro = try raw["macro"].map { try ResearchChartBuilderMacro(raw: $0) }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchChartBuilderIndicator: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var type: String
    public var period: Int
    public var seriesId: String
    public init(id: String, type: String, period: Int, seriesId: String) {
        self.id = id
        self.type = type
        self.period = period
        self.seriesId = seriesId
    }
    public var raw: TaxValue {
        .object([
            "id": .string(id), "type": .string(type), "period": .number(Decimal(period)), "seriesId": .string(seriesId),
        ])
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(raw, required: ["id", "type", "period", "seriesId"])
        id = try ResearchChartValidation.string(raw["id"], min: 1, max: 128)
        type = try ResearchChartValidation.choice(raw["type"], ["sma", "ema", "bollinger"])
        period = try ResearchDecode.count(raw["period"])
        guard (1...500).contains(period) else { throw ResearchDecode.failure("Invalid chart indicator period") }
        seriesId = try ResearchChartValidation.string(raw["seriesId"], min: 1, max: 128)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchChartBuilderState: Codable, Equatable, Sendable {
    public var range: String
    public var logLeft: Bool
    public var rebase: Bool
    public var series: [ResearchChartBuilderSeries]
    public var indicators: [ResearchChartBuilderIndicator]
    public var oscillator: String
    public var oscillatorSeriesId: String?
    public init(
        range: String = "1y", logLeft: Bool = false, rebase: Bool = false, series: [ResearchChartBuilderSeries] = [],
        indicators: [ResearchChartBuilderIndicator] = [], oscillator: String = "none", oscillatorSeriesId: String? = nil
    ) {
        self.range = range
        self.logLeft = logLeft
        self.rebase = rebase
        self.series = series
        self.indicators = indicators
        self.oscillator = oscillator
        self.oscillatorSeriesId = oscillatorSeriesId
    }
    public static let `default` = Self()
    public var raw: TaxValue {
        .object([
            "range": .string(range), "logLeft": .bool(logLeft), "rebase": .bool(rebase),
            "series": .array(series.map(\.raw)), "indicators": .array(indicators.map(\.raw)),
            "oscillator": .string(oscillator), "oscillatorSeriesId": oscillatorSeriesId.map(TaxValue.string) ?? .null,
        ])
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(
            raw, required: ["range", "logLeft", "rebase", "series", "indicators", "oscillator", "oscillatorSeriesId"])
        range = try ResearchChartValidation.choice(
            raw["range"], ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"])
        logLeft = try ResearchDecode.bool(raw["logLeft"])
        rebase = try ResearchDecode.bool(raw["rebase"])
        series = try ResearchDecode.required(raw["series"], [ResearchChartBuilderSeries].self)
        indicators = try ResearchDecode.required(raw["indicators"], [ResearchChartBuilderIndicator].self)
        oscillator = try ResearchChartValidation.choice(raw["oscillator"], ["none", "rsi", "macd"])
        oscillatorSeriesId = try ResearchDecode.optionalString(raw["oscillatorSeriesId"])
        guard series.count <= 5, indicators.count <= 20, Set(series.map(\.id)).count == series.count,
            Set(indicators.map(\.id)).count == indicators.count
        else { throw ResearchDecode.failure("Invalid chart series or indicator identity/count") }
        let ids = Set(series.map(\.id))
        guard indicators.allSatisfy({ ids.contains($0.seriesId) }), oscillatorSeriesId.map({ ids.contains($0) }) ?? true
        else { throw ResearchDecode.failure("Chart source series does not exist") }
        if let oscillatorSeriesId {
            _ = try ResearchChartValidation.string(.string(oscillatorSeriesId), min: 1, max: 128)
        }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    public func validate() throws { _ = try Self(raw: raw) }
}
public struct ResearchChartBuilderLayout: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var state: ResearchChartBuilderState
    public var createdAt: String
    public var updatedAt: String
    public init(id: String, name: String, state: ResearchChartBuilderState, createdAt: String, updatedAt: String) {
        self.id = id
        self.name = name
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
    public var raw: TaxValue {
        .object([
            "id": .string(id), "name": .string(name), "state": state.raw, "createdAt": .string(createdAt),
            "updatedAt": .string(updatedAt),
        ])
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(raw, required: ["id", "name", "state", "createdAt", "updatedAt"])
        id = try ResearchChartValidation.string(raw["id"], min: 1, max: 128)
        name = try ResearchChartValidation.string(raw["name"], min: 1, max: 80, trim: true)
        state = try ResearchDecode.required(raw["state"], ResearchChartBuilderState.self)
        createdAt = try ResearchChartValidation.string(raw["createdAt"], max: 64)
        updatedAt = try ResearchChartValidation.string(raw["updatedAt"], max: 64)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchChartBuilderLibrary: Codable, Equatable, Sendable {
    public var activeLayoutId: String?
    public var draft: ResearchChartBuilderState
    public var layouts: [ResearchChartBuilderLayout]
    public init(
        activeLayoutId: String? = nil, draft: ResearchChartBuilderState = .default,
        layouts: [ResearchChartBuilderLayout] = []
    ) {
        self.activeLayoutId = activeLayoutId
        self.draft = draft
        self.layouts = layouts
    }
    public static let empty = Self()
    public var activeLayout: ResearchChartBuilderLayout? { layouts.first { $0.id == activeLayoutId } }
    public var activeState: ResearchChartBuilderState { activeLayout?.state ?? draft }
    public var raw: TaxValue {
        .object([
            "version": .number(2), "activeLayoutId": activeLayoutId.map(TaxValue.string) ?? .null, "draft": draft.raw,
            "layouts": .array(layouts.map(\.raw)),
        ])
    }
    public init(raw: TaxValue) throws {
        try ResearchChartValidation.keys(raw, required: ["version", "activeLayoutId", "draft", "layouts"])
        guard raw["version"] == .number(2) else {
            throw ResearchDecode.failure("Unsupported chart layout library version")
        }
        activeLayoutId = try ResearchDecode.optionalString(raw["activeLayoutId"])
        draft = try ResearchDecode.required(raw["draft"], ResearchChartBuilderState.self)
        layouts = try ResearchDecode.required(raw["layouts"], [ResearchChartBuilderLayout].self)
        guard layouts.count <= 20, Set(layouts.map(\.id)).count == layouts.count,
            Set(layouts.map { $0.name.lowercased(with: Locale.current) }).count == layouts.count
        else { throw ResearchDecode.failure("Chart layout names and IDs must be unique") }
        if let activeLayoutId {
            guard layouts.contains(where: { $0.id == activeLayoutId }) else {
                throw ResearchDecode.failure("Active chart layout does not exist")
            }
        }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    public func validate() throws { _ = try Self(raw: raw) }
    public mutating func setActiveState(_ state: ResearchChartBuilderState, now: String) throws {
        try state.validate()
        if let activeLayoutId, let index = layouts.firstIndex(where: { $0.id == activeLayoutId }) {
            layouts[index].state = state
            layouts[index].updatedAt = now
        } else {
            draft = state
        }
    }
}
public struct ResearchChartBuilderPresentation: Equatable, Sendable {
    public let raw: TaxValue
    public let rows: [AnalysisRow]
    public let oscillatorRows: [AnalysisRow]
    public init(raw: TaxValue) throws {
        guard raw["kind"] == .string("chart"), let value = raw["result"], value.objectValue != nil else {
            throw ResearchDecode.failure("Invalid chart presentation")
        }
        self.raw = raw
        rows = try ResearchDecode.required(value["rows"], [AnalysisRow].self)
        oscillatorRows = try ResearchDecode.required(value["oscillatorRows"], [AnalysisRow].self)
        for row in rows + oscillatorRows {
            guard row["time"]?.decimalValue != nil, row.values.allSatisfy({ $0 == .null || $0.decimalValue != nil })
            else { throw ResearchDecode.failure("Invalid chart presentation row") }
        }
    }
}
public enum ResearchChartValidation {
    static func keys(_ raw: TaxValue, required: Set<String>, optional: Set<String> = []) throws {
        guard let object = raw.objectValue, required.isSubset(of: Set(object.keys)),
            Set(object.keys).isSubset(of: required.union(optional))
        else { throw ResearchDecode.failure("Invalid chart layout fields") }
    }
    static func string(_ value: TaxValue?, min: Int = 0, max: Int, trim: Bool = false) throws -> String {
        var text = try ResearchDecode.string(value)
        if trim { text = text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard (min...max).contains(text.utf16.count) else {
            throw ResearchDecode.failure("Invalid chart layout string length")
        }
        return text
    }
    static func choice(_ value: TaxValue?, _ allowed: Set<String>) throws -> String {
        let text = try ResearchDecode.string(value)
        guard allowed.contains(text) else { throw ResearchDecode.failure("Invalid chart layout option") }
        return text
    }
}

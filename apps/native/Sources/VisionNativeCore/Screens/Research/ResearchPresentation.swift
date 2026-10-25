import Foundation

/// A rejected research presentation input; the message is shown to the person as is.
public struct ResearchPresentationError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Swift port of packages/shared-utils/src/research/{presentation,compare,indicators,unitMath}.ts and
/// of the Zod input schema of the removed `POST /api/research/presentation` route. The TypeScript does
/// its arithmetic with IEEE-754 doubles (no decimal.js, no banker's rounding; `Math.round` rounds
/// halves toward +Infinity), so this port uses `Double` in the same operation order and renders
/// results as the numbers `JSON.stringify` would print. Pure and deterministic.
public enum ResearchPresentation {
    /// The `{ kind, result }` envelope the route returned for a submitted-data snapshot.
    public static func compute(_ input: TaxValue) throws -> TaxValue {
        let root = Reader(input, path: "input")
        guard root.object != nil else { throw root.fail("must be an object") }
        let kind = try root.required("kind").string()
        let result: TaxValue
        switch ResearchPresentationKind(rawValue: kind) {
        case .compare: result = try compare(root)
        case .chart: result = try chart(root)
        case .watchlist: result = try watchlist(root)
        case .watchlistBatch: result = try watchlistBatch(root)
        case .providerQuote: result = try providerQuote(root)
        case .analyst: result = try analyst(root)
        case .marketAdd: result = try marketAdd(root)
        case .unknown: throw root.fail("kind is not a research presentation kind")
        }
        return .object(["kind": .string(kind), "result": result])
    }

    // MARK: Input validation (the Zod schema)

    struct Reader {
        let value: TaxValue?
        let path: String
        init(_ value: TaxValue?, path: String) {
            self.value = value
            self.path = path
        }
        func fail(_ message: String) -> ResearchPresentationError {
            ResearchPresentationError("Invalid research presentation input: \(path) \(message)")
        }
        var object: [String: TaxValue]? { value?.objectValue }
        var isNull: Bool { value == .null }
        func field(_ key: String) -> Reader { Reader(object?[key], path: path + "." + key) }
        /// The key must be present (a missing key is not `null`).
        func required(_ key: String) throws -> Reader {
            guard let found = object?[key] else { throw Reader(nil, path: path + "." + key).fail("is required") }
            return Reader(found, path: path + "." + key)
        }
        func string(min: Int = 0, max: Int = Int.max) throws -> String {
            guard let text = value?.stringValue else { throw fail("must be a string") }
            let length = text.utf16.count
            guard length >= min, length <= max else { throw fail("must contain \(min) to \(max) characters") }
            return text
        }
        func number() throws -> Double {
            guard let decimal = value?.decimalValue, !decimal.isNaN else { throw fail("must be a number") }
            return NSDecimalNumber(decimal: decimal).doubleValue
        }
        func integer(min: Int, max: Int) throws -> Int {
            let double = try number()
            guard double == double.rounded(), double >= Double(min), double <= Double(max) else {
                throw fail("must be an integer from \(min) to \(max)")
            }
            return Int(double)
        }
        func bool() throws -> Bool {
            guard let flag = value?.boolValue else { throw fail("must be a boolean") }
            return flag
        }
        func array(max: Int = Int.max) throws -> [Reader] {
            guard let items = value?.arrayValue else { throw fail("must be an array") }
            guard items.count <= max else { throw fail("must contain at most \(max) items") }
            return items.enumerated().map { Reader($1, path: path + "[\($0)]") }
        }
        /// `z.number().nullable()`: present, a number or null.
        func nullableNumber() throws -> Double? {
            if isNull { return nil }
            return try number()
        }
        /// `z.number().nullable().optional()` as a point field.
        func pointField() throws -> PointField {
            guard value != nil else { return .absent }
            if isNull { return .null }
            return .value(try number())
        }
    }

    struct PresentationPoint: Equatable {
        var time: Double
        var close: PointField
        var high: PointField
        var low: PointField
        var volume: PointField
    }
    enum PointField: Equatable {
        case absent
        case null
        case value(Double)
        /// `Number.isFinite(x)`: absent and null are not finite.
        var finite: Double? {
            if case .value(let number) = self, number.isFinite { return number }
            return nil
        }
        /// The operand JavaScript arithmetic sees: undefined is NaN and null is 0.
        var coerced: Double {
            switch self {
            case .absent: return .nan
            case .null: return 0
            case .value(let number): return number
            }
        }
        /// The row cell for `p.volume`: undefined leaves the property out of the JSON.
        var cell: RowCell? {
            switch self {
            case .absent: return nil
            case .null: return .null
            case .value(let number): return .number(number)
            }
        }
    }
    enum RowCell: Equatable {
        case null
        case number(Double)
        var value: Double? {
            if case .number(let number) = self { return number }
            return nil
        }
    }

    private static func points(_ reader: Reader) throws -> [PresentationPoint] {
        try reader.array().map { item in
            guard item.object != nil else { throw item.fail("must be an object") }
            return PresentationPoint(
                time: try item.required("time").number(), close: try item.field("close").pointField(),
                high: try item.field("high").pointField(), low: try item.field("low").pointField(),
                volume: try item.field("volume").pointField())
        }
    }

    // MARK: Output helpers

    private static func num(_ value: Double) -> TaxValue { JSNumber.decimal(value).map(TaxValue.number) ?? .null }
    private static func num(_ value: Double?) -> TaxValue { value.map { num($0) } ?? .null }
    private static func cell(_ value: Double?) -> RowCell { value.map { RowCell.number($0) } ?? RowCell.null }
    private static func row(time: Double, cells: [String: RowCell]) -> TaxValue {
        var object: [String: TaxValue] = ["time": num(time)]
        for (key, cell) in cells {
            switch cell {
            case .null: object[key] = .null
            case .number(let number): object[key] = num(number)
            }
        }
        return .object(object)
    }

    // MARK: compare

    private static func compare(_ root: Reader) throws -> TaxValue {
        let series = try root.required("series").array(max: 6).map { item -> (symbol: String, points: [PresentationPoint]) in
            guard item.object != nil else { throw item.fail("must be an object") }
            return (try item.required("symbol").string(min: 1, max: 64), try points(item.required("points")))
        }
        return comparePresentation(series)
    }

    static func comparePresentation(_ series: [(symbol: String, points: [PresentationPoint])]) -> TaxValue {
        struct PerSymbol {
            var symbol: String
            var rebased: [(time: Double, value: Double)]
            var stats: SymbolStats
            var returns: OrderedSeries
        }
        let perSymbol = series.map {
            PerSymbol(
                symbol: $0.symbol, rebased: ResearchMath.rebaseTo100($0.points),
                stats: ResearchMath.computeStats($0.symbol, $0.points),
                returns: ResearchMath.dailyReturnsByTime($0.points))
        }
        let times = Array(Set(perSymbol.flatMap { $0.rebased.map { $0.time } })).sorted()
        let lookups = perSymbol.map { entry -> [Double: Double] in
            var map: [Double: Double] = [:]
            for point in entry.rebased { map[point.time] = point.value }
            return map
        }
        let rows: [TaxValue] = times.map { time in
            var object: [String: TaxValue] = ["time": num(time)]
            for (index, entry) in perSymbol.enumerated() { object[entry.symbol] = num(lookups[index][time]) }
            return .object(object)
        }
        let stats: [TaxValue] = perSymbol.map { entry in
            var object: [String: TaxValue] = [
                "symbol": .string(entry.symbol), "totalReturn": num(entry.stats.totalReturn),
                "volatility": num(entry.stats.volatility), "maxDrawdown": num(entry.stats.maxDrawdown),
            ]
            if let first = entry.rebased.first { object["firstTime"] = num(first.time) }
            if let last = entry.rebased.last { object["lastTime"] = num(last.time) }
            return .object(object)
        }
        let matrix: [TaxValue] = perSymbol.enumerated().map { i, a in
            .array(
                perSymbol.enumerated().map { j, b in
                    i == j ? .number(1) : num(ResearchMath.pearsonOnTime(a.returns, b.returns))
                })
        }
        return .object([
            "rows": .array(rows), "stats": .array(stats),
            "correlation": .object(["symbols": .array(perSymbol.map { .string($0.symbol) }), "matrix": .array(matrix)]),
        ])
    }

    // MARK: chart

    struct ChartSeries {
        var id: String
        var field: String
        var type: String
        var points: [PresentationPoint]
    }
    struct ChartIndicator {
        var id: String
        var type: String
        var period: Int
        var seriesId: String
    }

    private static func chart(_ root: Reader) throws -> TaxValue {
        let series = try root.required("series").array(max: 5).map { item -> ChartSeries in
            guard item.object != nil else { throw item.fail("must be an object") }
            let field = try item.required("field").string()
            guard ["price", "volume"].contains(field) else { throw item.field("field").fail("is not a series field") }
            let type = try item.required("type").string()
            guard ["line", "area", "candlestick", "bar"].contains(type) else {
                throw item.field("type").fail("is not a series type")
            }
            return ChartSeries(
                id: try item.required("id").string(min: 1, max: 128), field: field, type: type,
                points: try points(item.required("points")))
        }
        let indicators = try root.required("indicators").array(max: 20).map { item -> ChartIndicator in
            guard item.object != nil else { throw item.fail("must be an object") }
            let type = try item.required("type").string()
            guard ["sma", "ema", "bollinger"].contains(type) else { throw item.field("type").fail("is not an indicator") }
            return ChartIndicator(
                id: try item.required("id").string(min: 1, max: 128), type: type,
                period: try item.required("period").integer(min: 1, max: 500),
                seriesId: try item.required("seriesId").string(min: 1, max: 128))
        }
        let rebase = try root.required("rebase").bool()
        let oscillator = try root.required("oscillator").string()
        guard ["none", "rsi", "macd"].contains(oscillator) else { throw root.field("oscillator").fail("is not an oscillator") }
        let oscillatorField = try root.required("oscillatorSeriesId")
        let oscillatorSeriesId = try oscillatorField.isNull ? nil : oscillatorField.string(min: 1, max: 128)
        let ids = Set(series.map(\.id))
        if ids.count != series.count { throw root.fail("Series ids must be unique") }
        if Set(indicators.map(\.id)).count != indicators.count { throw root.fail("Indicator ids must be unique") }
        if indicators.contains(where: { !ids.contains($0.seriesId) }) { throw root.fail("Indicator source must exist") }
        return chartPresentation(
            series: series, indicators: indicators, rebase: rebase, oscillator: oscillator,
            oscillatorSeriesId: oscillatorSeriesId)
    }

    static func chartPresentation(
        series: [ChartSeries], indicators: [ChartIndicator], rebase: Bool, oscillator: String,
        oscillatorSeriesId: String?
    ) -> TaxValue {
        var pointsBySeries: [String: [PresentationPoint]] = [:]
        for entry in series { pointsBySeries[entry.id] = entry.points }
        var factor: [String: Double] = [:]
        for entry in series {
            let firstClose = entry.points.lazy.compactMap { point -> Double? in
                if let close = point.close.finite, close > 0 { return close }
                return nil
            }.first
            // `input.rebase && firstClose ? 100 / firstClose : 1`
            factor[entry.id] = rebase && firstClose != nil && firstClose != 0 ? 100 / firstClose! : 1
        }
        let times = Array(Set(series.flatMap { $0.points.map(\.time) })).sorted()
        var byTime: [String: [Double: PresentationPoint]] = [:]
        for entry in series {
            var map: [Double: PresentationPoint] = [:]
            for point in entry.points { map[point.time] = point }
            byTime[entry.id] = map
        }
        var rows: [(time: Double, cells: [String: RowCell])] = times.map { time in
            var cells: [String: RowCell] = [:]
            for entry in series {
                let point = byTime[entry.id]?[time]
                let f = factor[entry.id] ?? 1
                if entry.field == "volume" {
                    // `p ? p.volume : null`; an undefined volume leaves the property out.
                    if let point {
                        cells[entry.id] = point.volume.cell
                    } else {
                        cells[entry.id] = RowCell.null
                    }
                } else {
                    func scaled(_ field: PointField?) -> RowCell {
                        if let field, let value = field.finite { return .number(value * f) }
                        return .null
                    }
                    cells[entry.id] = scaled(point?.close)
                    cells[entry.id + "_o"] = scaled(point?.close)
                    cells[entry.id + "_h"] = scaled(point?.high)
                    cells[entry.id + "_l"] = scaled(point?.low)
                }
            }
            return (time, cells)
        }
        for entry in series where entry.type == "candlestick" {
            var previous: Double?
            for index in rows.indices {
                let close = rows[index].cells[entry.id]?.value
                let opening = previous ?? close
                rows[index].cells[entry.id + "_o"] = cell(opening)
                previous = close ?? previous
            }
        }
        for indicator in indicators {
            let pts = pointsBySeries[indicator.seriesId] ?? []
            let f = factor[indicator.seriesId] ?? 1
            let closes = pts.map { point -> Double in point.close.finite.map { $0 * f } ?? .nan }
            func assign(_ key: String, _ values: [Double?]) {
                var lookup: [Double: RowCell] = [:]
                for (index, point) in pts.enumerated() { lookup[point.time] = cell(index < values.count ? values[index] : nil) }
                for index in rows.indices { rows[index].cells[key] = lookup[rows[index].time] ?? RowCell.null }
            }
            switch indicator.type {
            case "sma": assign(indicator.id, ResearchMath.sma(closes, indicator.period))
            case "ema": assign(indicator.id, ResearchMath.ema(closes, indicator.period))
            default:
                let bands = ResearchMath.bollinger(closes, indicator.period, 2)
                assign(indicator.id, bands.middle)
                assign(indicator.id + "_u", bands.upper)
                assign(indicator.id + "_l", bands.lower)
            }
        }
        return .object([
            "rows": .array(rows.map { row(time: $0.time, cells: $0.cells) }),
            "oscillatorRows": .array(
                chartOscillatorPresentation(series, oscillator: oscillator, oscillatorSeriesId: oscillatorSeriesId)),
        ])
    }

    static func chartOscillatorPresentation(_ series: [ChartSeries], oscillator: String, oscillatorSeriesId: String?)
        -> [TaxValue]
    {
        let sourceID = oscillatorSeriesId ?? series.first?.id
        let source = series.first { $0.id == sourceID }
        let pts = oscillator == "none" || source == nil ? [] : source!.points
        // The source keeps raw-close coercion here, separate from the rebased indicator inputs.
        let closes = pts.map { $0.close.coerced }
        var rows: [[String: RowCell]] = pts.map { _ in [:] }
        if oscillator == "rsi" {
            let values = ResearchMath.rsi(closes, 14)
            for index in rows.indices { rows[index]["rsi"] = cell(values[index]) }
        } else if oscillator == "macd" {
            let values = ResearchMath.macd(closes)
            for index in rows.indices {
                rows[index]["macd"] = cell(values.macd[index])
                rows[index]["signal"] = cell(values.signal[index])
                rows[index]["hist"] = cell(values.histogram[index])
            }
        }
        return zip(pts, rows).map { row(time: $0.time, cells: $1) }
    }

    // MARK: watchlist

    private static func watchlistList(target: Double, current: Double?, added: Double?) -> TaxValue {
        let distance = current.map { (($0 - target) / target) * 100 }
        return .object([
            "distancePercent": num(distance),
            "absoluteDistancePercent": num(distance.map { abs($0) }),
            "isAtOrBelowTarget": .bool(current.map { $0 <= target } ?? false),
            "sinceAddedPercent": num(
                added.flatMap { added in
                    added > 0 ? current.map { (($0 - added) / added) * 100 } : nil
                }),
        ])
    }

    private static func watchlist(_ root: Reader) throws -> TaxValue {
        let target = try root.required("targetPrice").nullableNumber()
        let current = try root.required("currentPrice").nullableNumber()
        let added = try root.required("addedPrice").nullableNumber()
        let pointsReader = root.field("points")
        let pts = try pointsReader.value == nil ? [] : points(pointsReader)
        // Number.isFinite(null) is false, while `targetPrice as number` is 0 in arithmetic.
        let validTarget = target.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let chartDistance = current.flatMap { current in validTarget.map { ((current - $0) / $0) * 100 } }
        var prices = pts.compactMap { point -> Double? in
            if let close = point.close.finite, close > 0 { return close }
            return nil
        }
        if let validTarget { prices.append(validTarget) }
        let domain: [Double] =
            prices.isEmpty ? [0, 1] : [prices.min()! * 0.98, prices.max()! * 1.02]
        var preview: TaxValue = .null
        if let current, current.isFinite, current > 0, let validTarget {
            let below = validTarget < current
            preview = .object([
                "absolutePercent": num(below ? (1 - validTarget / current) * 100 : (validTarget / current - 1) * 100),
                "direction": .string(below ? "below" : "above"),
            ])
        }
        return .object([
            "list": watchlistList(target: target ?? 0, current: current, added: added),
            "chart": .object([
                "distancePercent": num(chartDistance), "absoluteDistancePercent": num(chartDistance.map { abs($0) }),
                "isAtOrBelowTarget": .bool(current.flatMap { current in validTarget.map { current <= $0 } } ?? false),
                "hasValidTarget": .bool(validTarget != nil), "domain": .array(domain.map { num($0) }),
            ]),
            "preview": preview,
        ])
    }

    private static func watchlistBatch(_ root: Reader) throws -> TaxValue {
        let entries = try root.required("entries").array(max: 5000).map { item -> TaxValue in
            guard item.object != nil else { throw item.fail("must be an object") }
            let id = try item.required("id").integer(min: 1, max: 9_007_199_254_740_991)
            let target = try item.required("targetPrice").number()
            let current = try item.required("currentPrice").nullableNumber()
            let added = try item.required("addedPrice").nullableNumber()
            return .object(["id": num(Double(id)), "list": watchlistList(target: target, current: current, added: added)])
        }
        return .object(["entries": .array(entries)])
    }

    // MARK: providerQuote and analyst

    private static func providerQuote(_ root: Reader) throws -> TaxValue {
        let pts = try points(root.required("points"))
        let investment = try root.required("investment")
        guard investment.object != nil else { throw investment.fail("must be an object") }
        func optionalString(_ reader: Reader) throws -> String? {
            guard reader.value != nil, !reader.isNull else { return nil }
            return try reader.string()
        }
        let symbol = try optionalString(investment.field("symbol"))
        let name = try investment.required("name").string()
        let currency = try investment.required("currency").string()
        let provider = try optionalString(investment.field("priceProvider"))
        let selected = try optionalString(root.field("selectedSymbol"))
        guard let firstPoint = pts.first, let lastPoint = pts.last else { return .null }
        // Preserve original provider-history arithmetic, including null coercion and first-zero fallback.
        let last = lastPoint.close.coerced
        let first = firstPoint.close.coerced
        let change = last - first
        var quote: [String: TaxValue] = [
            "symbol": .string(symbol ?? selected ?? ""), "name": .string(name), "change": num(change),
            "changePercent": num(first != 0 && !first.isNaN ? (change / first) * 100 : 0),
            "currency": .string(currency), "exchange": .string(""), "type": .string((provider ?? "").uppercased()),
        ]
        // `price: last` is the raw close: null stays null and an undefined close leaves the key out.
        switch lastPoint.close {
        case .absent: break
        case .null: quote["price"] = .null
        case .value(let price): quote["price"] = num(price)
        }
        return .object(quote)
    }

    private static func analyst(_ root: Reader) throws -> TaxValue {
        let consensus = try root.required("consensus")
        if consensus.isNull { return .null }
        guard consensus.object != nil else { throw consensus.fail("must be an object") }
        let strongBuy = try consensus.required("strongBuy").number()
        let buy = try consensus.required("buy").number()
        let hold = try consensus.required("hold").number()
        let sell = try consensus.required("sell").number()
        let strongSell = try consensus.required("strongSell").number()
        let total = strongBuy + buy + hold + sell + strongSell
        if total == 0 { return .null }
        let bull = (strongBuy + buy) / total
        let bear = (sell + strongSell) / total
        let verdict: String
        if bull >= 0.6 {
            verdict = "market.strongBuy"
        } else if bull >= 0.45 {
            verdict = "market.buy"
        } else if bear >= 0.6 {
            verdict = "market.strongSell"
        } else if bear >= 0.45 {
            verdict = "market.sell"
        } else {
            verdict = "market.hold"
        }
        return .object([
            "total": num(total), "bullFraction": num(bull), "bearFraction": num(bear),
            "verdictKey": .string(verdict), "tone": .string(bull >= 0.45 ? "success" : bear >= 0.45 ? "destructive" : "warning"),
            "fractions": .object([
                "strongBuy": num(strongBuy / total), "buy": num(buy / total), "hold": num(hold / total),
                "sell": num(sell / total), "strongSell": num(strongSell / total),
            ]),
        ])
    }

    // MARK: marketAdd

    private static func marketAdd(_ root: Reader) throws -> TaxValue {
        func positive(_ key: String) throws -> Double? {
            let reader = root.field(key)
            guard reader.value != nil else { return nil }
            let number = try reader.number()
            guard number > 0 else { throw reader.fail("must be positive") }
            return number
        }
        let amount = try positive("amount")
        let units = try positive("units")
        let price = try positive("price")
        let deriveReader = root.field("derive")
        let derive = try deriveReader.value == nil ? true : deriveReader.bool()
        let result = ResearchMath.deriveUnitMath(amount: amount, units: units, price: price, derive: derive)
        var object: [String: TaxValue] = [
            "providedCount": .number(Decimal(result.providedCount)), "isConsistent": .bool(result.isConsistent),
        ]
        for (key, value) in [
            ("derivedAmount", result.derivedAmount), ("derivedUnits", result.derivedUnits),
            ("derivedPrice", result.derivedPrice), ("effectiveAmount", result.effectiveAmount),
            ("effectiveUnits", result.effectiveUnits), ("effectivePrice", result.effectivePrice),
        ] {
            if let value { object[key] = num(value) }
        }
        return .object(object)
    }
}

struct SymbolStats: Equatable {
    var symbol: String
    var totalReturn: Double?
    var volatility: Double?
    var maxDrawdown: Double?
}

/// A `Map<number, number>` that iterates in insertion order and keeps the position of a re-set key.
struct OrderedSeries: Equatable {
    private(set) var keys: [Double] = []
    private(set) var values: [Double: Double] = [:]
    mutating func set(_ key: Double, _ value: Double) {
        if values[key] == nil { keys.append(key) }
        values[key] = value
    }
}

struct UnitMathResult: Equatable {
    var derivedAmount: Double?
    var derivedUnits: Double?
    var derivedPrice: Double?
    var effectiveAmount: Double?
    var effectiveUnits: Double?
    var effectivePrice: Double?
    var providedCount: Int
    var isConsistent: Bool
}

/// compare.ts, indicators.ts and unitMath.ts, operation for operation.
enum ResearchMath {
    // MARK: unitMath.ts

    static let unitMathAmountDP = 4
    static let unitMathUnitsDP = 8
    static let unitMathPriceDP = 6
    static let unitMathTolerance = 0.01

    /// `Math.round`: halves round toward +Infinity (so -2.5 becomes -2).
    static func jsRound(_ value: Double) -> Double {
        guard value.isFinite else { return value }
        let floor = value.rounded(.down)
        return value - floor >= 0.5 ? floor + 1 : floor
    }
    static func roundUnitMath(_ value: Double, _ decimals: Int) -> Double {
        let factor = pow(10.0, Double(decimals))
        return jsRound(value * factor) / factor
    }

    static func deriveUnitMath(amount: Double?, units: Double?, price: Double?, derive: Bool = true) -> UnitMathResult {
        let providedCount = [amount != nil, units != nil, price != nil].filter { $0 }.count
        var derivedAmount: Double?
        var derivedUnits: Double?
        var derivedPrice: Double?
        if derive && providedCount >= 2 {
            if amount == nil, let units, let price { derivedAmount = roundUnitMath(units * price, unitMathAmountDP) }
            if units == nil, let amount, let price { derivedUnits = roundUnitMath(amount / price, unitMathUnitsDP) }
            if price == nil, let amount, let units { derivedPrice = roundUnitMath(amount / units, unitMathPriceDP) }
        }
        let effectiveAmount = amount ?? derivedAmount
        let effectiveUnits = units ?? derivedUnits
        let effectivePrice = price ?? derivedPrice
        var isConsistent = false
        if derive, providedCount >= 2, let effectiveAmount, let effectiveUnits, let effectivePrice {
            // Round the difference before comparing: float subtraction at the exact boundary yields
            // 0.010000000000005 > 0.01, wrongly rejecting the one-cent case.
            isConsistent =
                roundUnitMath(
                    abs(
                        roundUnitMath(effectiveUnits * effectivePrice, unitMathAmountDP)
                            - roundUnitMath(effectiveAmount, unitMathAmountDP)), unitMathAmountDP) <= unitMathTolerance
        }
        return UnitMathResult(
            derivedAmount: derivedAmount, derivedUnits: derivedUnits, derivedPrice: derivedPrice,
            effectiveAmount: effectiveAmount, effectiveUnits: effectiveUnits, effectivePrice: effectivePrice,
            providedCount: providedCount, isConsistent: isConsistent)
    }

    // MARK: compare.ts

    typealias Point = ResearchPresentation.PresentationPoint

    /// Daily log returns keyed by the later point's timestamp.
    static func dailyReturnsByTime(_ points: [Point]) -> OrderedSeries {
        let valid = points.enumerated().filter { _, point in
            if let close = point.close.finite, close > 0, point.time.isFinite { return true }
            return false
        }.sorted { left, right in
            left.element.time != right.element.time ? left.element.time < right.element.time : left.offset < right.offset
        }.map(\.element)
        var out = OrderedSeries()
        var previous: Double?
        for point in valid {
            let close = point.close.finite!
            if let previous { out.set(point.time, log(close / previous)) }
            previous = close
        }
        return out
    }

    /// Annualized stdev of daily log returns (approximate, 252 trading days).
    static func computeStats(_ symbol: String, _ points: [Point]) -> SymbolStats {
        let closes = points.compactMap { point -> Double? in
            if let close = point.close.finite, close > 0 { return close }
            return nil
        }
        guard closes.count >= 2, let first = closes.first, let last = closes.last else {
            return SymbolStats(symbol: symbol, totalReturn: nil, volatility: nil, maxDrawdown: nil)
        }
        let totalReturn = (last - first) / first
        var returns: [Double] = []
        var previous = first
        for close in closes.dropFirst() {
            returns.append(log(close / previous))
            previous = close
        }
        let mean = returns.reduce(0) { $0 + $1 } / Double(returns.count)
        let variance = returns.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(returns.count)
        let volatility = variance.squareRoot() * Double(252).squareRoot()
        var peak = first
        var maxDrawdown = 0.0
        for close in closes {
            if close > peak { peak = close }
            let drawdown = (close - peak) / peak
            if drawdown < maxDrawdown { maxDrawdown = drawdown }
        }
        return SymbolStats(symbol: symbol, totalReturn: totalReturn, volatility: volatility, maxDrawdown: maxDrawdown)
    }

    /// Pearson correlation of two return series on their shared timestamps; nil below two pairs
    /// or without variance on either side.
    static func pearsonOnTime(_ a: OrderedSeries, _ b: OrderedSeries) -> Double? {
        var pairs: [(Double, Double)] = []
        for key in a.keys {
            if let x = a.values[key], let y = b.values[key] { pairs.append((x, y)) }
        }
        let n = Double(pairs.count)
        if pairs.count < 2 { return nil }
        let meanX = pairs.reduce(0) { $0 + $1.0 } / n
        let meanY = pairs.reduce(0) { $0 + $1.1 } / n
        var cov = 0.0
        var varX = 0.0
        var varY = 0.0
        for (x, y) in pairs {
            let dx = x - meanX
            let dy = y - meanY
            cov += dx * dy
            varX += dx * dx
            varY += dy * dy
        }
        if varX == 0 || varY == 0 { return nil }
        return cov / (varX * varY).squareRoot()
    }

    /// Rebase each series' closes to start at 100.
    static func rebaseTo100(_ points: [Point]) -> [(time: Double, value: Double)] {
        let valid = points.compactMap { point -> (time: Double, close: Double)? in
            if let close = point.close.finite, close > 0 { return (point.time, close) }
            return nil
        }
        guard let base = valid.first?.close else { return [] }
        return valid.map { ($0.time, ($0.close / base) * 100) }
    }

    // MARK: indicators.ts

    static func sma(_ values: [Double], _ period: Int) -> [Double?] {
        var out = [Double?](repeating: nil, count: values.count)
        if period <= 0 { return out }
        var sum = 0.0
        for (index, value) in values.enumerated() {
            sum += value
            if index >= period { sum -= values[index - period] }
            if index >= period - 1 { out[index] = sum / Double(period) }
        }
        return out
    }

    static func ema(_ values: [Double], _ period: Int) -> [Double?] {
        var out = [Double?](repeating: nil, count: values.count)
        if period <= 0 || values.count < period { return out }
        let k = 2 / Double(period + 1)
        var seed = 0.0
        for value in values[0..<period] { seed += value }
        var previous = seed / Double(period)
        out[period - 1] = previous
        for index in period..<values.count {
            previous = values[index] * k + previous * (1 - k)
            out[index] = previous
        }
        return out
    }

    static func bollinger(_ values: [Double], _ period: Int = 20, _ mult: Double = 2) -> (
        middle: [Double?], upper: [Double?], lower: [Double?]
    ) {
        let middle = sma(values, period)
        var upper = [Double?](repeating: nil, count: values.count)
        var lower = [Double?](repeating: nil, count: values.count)
        if period >= 1 {
            for index in (period - 1)..<max(values.count, period - 1) {
                guard let mid = middle[index] else { continue }
                var squares = 0.0
                for j in (index - period + 1)...index { squares += (values[j] - mid) * (values[j] - mid) }
                let deviation = (squares / Double(period)).squareRoot()
                upper[index] = mid + mult * deviation
                lower[index] = mid - mult * deviation
            }
        }
        return (middle, upper, lower)
    }

    /// Wilder's Relative Strength Index (0-100).
    static func rsi(_ values: [Double], _ period: Int = 14) -> [Double?] {
        var out = [Double?](repeating: nil, count: values.count)
        if values.count <= period { return out }
        var gain = 0.0
        var loss = 0.0
        for index in 1...period {
            let change = values[index] - values[index - 1]
            if change >= 0 { gain += change } else { loss -= change }
        }
        var averageGain = gain / Double(period)
        var averageLoss = loss / Double(period)
        out[period] = averageLoss == 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
        if values.count > period + 1 {
            for index in (period + 1)..<values.count {
                let change = values[index] - values[index - 1]
                averageGain = (averageGain * Double(period - 1) + (change > 0 ? change : 0)) / Double(period)
                averageLoss = (averageLoss * Double(period - 1) + (change < 0 ? -change : 0)) / Double(period)
                out[index] = averageLoss == 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
            }
        }
        return out
    }

    /// Rebase a series so the first valid positive point is `base` (overlay alignment).
    static func rebase(_ values: [Double], base: Double = 100) -> [Double?] {
        guard let first = values.first(where: { $0.isFinite && $0 > 0 }) else { return values.map { _ in nil } }
        return values.map { $0.isFinite && $0 > 0 ? ($0 / first) * base : nil }
    }

    /// MACD line (EMA fast - EMA slow), its signal EMA and the histogram.
    static func macd(_ values: [Double], _ fast: Int = 12, _ slow: Int = 26, _ signalPeriod: Int = 9) -> (
        macd: [Double?], signal: [Double?], histogram: [Double?]
    ) {
        let emaFast = ema(values, fast)
        let emaSlow = ema(values, slow)
        let line: [Double?] = values.indices.map { index in
            if let f = emaFast[index], let s = emaSlow[index] { return f - s }
            return nil
        }
        var signal = [Double?](repeating: nil, count: values.count)
        if let firstValid = line.firstIndex(where: { $0 != nil }), values.count - firstValid >= signalPeriod {
            let k = 2 / Double(signalPeriod + 1)
            var seed = 0.0
            for index in firstValid..<(firstValid + signalPeriod) { seed += line[index]! }
            var previous = seed / Double(signalPeriod)
            signal[firstValid + signalPeriod - 1] = previous
            if values.count > firstValid + signalPeriod {
                for index in (firstValid + signalPeriod)..<values.count {
                    previous = line[index]! * k + previous * (1 - k)
                    signal[index] = previous
                }
            }
        }
        let histogram: [Double?] = values.indices.map { index in
            if let l = line[index], let s = signal[index] { return l - s }
            return nil
        }
        return (line, signal, histogram)
    }
}

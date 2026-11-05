import SwiftUI
import VisionNativeCore

struct AIChatToolResultCard: View {
    let result: TaxValue
    let presentation: TaxValue?
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var parsed: AIChatToolPresentation? { presentation.flatMap(AIChatToolPresentation.init) }
    private var errorKey: String {
        switch result["error"]?["code"]?.stringValue {
        case "VALIDATION_ERROR": return "aiChat.toolError.validation"
        case "UNKNOWN_TOOL": return "aiChat.toolError.unavailable"
        default: return "aiChat.toolFailed"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if result["ok"]?.boolValue != true {
                Label(strings.t(errorKey), systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(theme.destructive)
            } else {
                if let parsed {
                    switch parsed.renderAs {
                    case .table: table(parsed)
                    case .line, .bar, .pie: AIChatToolChart(presentation: parsed, shell: shell)
                    case .unknown: json(result["data"] ?? .null)
                    }
                    footer(parsed.rowCount)
                } else {
                    // Older servers can omit the additive presentation. Raw JSON remains
                    // available without guessing financial axes or dictionary order.
                    json(result["data"] ?? .null)
                }
            }
        }
    }
    @ViewBuilder private func table(_ data: AIChatToolPresentation) -> some View {
        if data.columns.isEmpty || data.rows.isEmpty {
            Text(strings.t("aiChat.noRows")).font(.caption).foregroundStyle(theme.secondaryLabel)
        } else {
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(data.rows.indices, id: \.self) { index in
                            HStack(alignment: .top, spacing: 0) {
                                ForEach(Array(data.columns.enumerated()), id: \.offset) { _, key in
                                    let value = AIChatToolPresentation.value(data.rows[index], key: key)
                                    Text(
                                        verbatim: AIChatToolDisplay.cell(
                                            value, locale: shell.settings.numberFormat.locale)
                                    )
                                    .textSelection(.enabled).font(.caption).monospacedDigit()
                                    .frame(width: 150, alignment: value?.decimalValue != nil ? .trailing : .leading)
                                    .padding(.horizontal, 8).padding(.vertical, 7)
                                }
                            }.background(index.isMultiple(of: 2) ? theme.muted.opacity(0.25) : .clear)
                            Divider()
                        }
                    } header: {
                        HStack(spacing: 0) {
                            ForEach(Array(data.columns.enumerated()), id: \.offset) { _, key in
                                Text(verbatim: key).font(.caption.weight(.medium)).frame(
                                    width: 150, alignment: .leading
                                )
                                .padding(.horizontal, 8).padding(.vertical, 9)
                            }
                        }.background(theme.card)
                    }
                }
            }.frame(height: min(288, CGFloat(data.rows.count + 1) * 34))
                .background(
                    theme.background.opacity(0.6),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous).stroke(
                        theme.border.opacity(0.5)))
        }
    }
    private func json(_ value: TaxValue) -> some View {
        ScrollView([.horizontal, .vertical]) {
            Text(verbatim: AIChatToolDisplay.json(value, pretty: true)).font(.footnote.monospaced()).textSelection(
                .enabled
            )
            .foregroundStyle(theme.foreground.opacity(0.8))
            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }.frame(maxHeight: 256)
            .background(theme.background.opacity(0.6), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border.opacity(0.5)))
    }
    @ViewBuilder private func footer(_ count: Int) -> some View {
        let total = result["meta"]?["total"]?.decimalValue
        if total != nil || count != 0 {
            Text(
                total != nil && total != Decimal(count)
                    ? strings.t("aiChat.rowsShown", ["shown": String(count), "total": VisionFormat.plain(total!)])
                    : strings.tc("aiChat.rowCount", count)
            )
            .font(.caption).foregroundStyle(theme.tertiaryLabel)
        }
    }
}

struct AIChatToolPresentation: Equatable {
    let renderAs: AIChatToolRender
    let rows: [TaxValue]
    let columns: [String]
    let xKey: String
    let yKeys: [String]
    let rowCount: Int
    let pieRenderable: Bool
    let pieRows: [PieRow]
    struct PieRow: Equatable, Identifiable {
        let id: Int
        let name: String
        let value: Decimal
        let labelPercent: Decimal
        let startAngle: Double
        let endAngle: Double
    }
    init?(_ raw: TaxValue) {
        guard let kind = raw["renderAs"]?.stringValue,
            let rows = raw["rows"]?.arrayValue,
            let columns = raw["columns"]?.arrayValue,
            let x = raw["xKey"]?.stringValue,
            let ys = raw["yKeys"]?.arrayValue,
            let count = raw["rowCount"]?.decimalValue,
            let canRenderPie = raw["pieRenderable"]?.boolValue,
            let pie = raw["pieRows"]?.arrayValue
        else { return nil }
        renderAs = AIChatToolRender(rawValue: kind)
        self.rows = rows
        self.columns = columns.compactMap(\.stringValue)
        xKey = x
        yKeys = ys.compactMap(\.stringValue)
        rowCount = NSDecimalNumber(decimal: count).intValue
        pieRenderable = canRenderPie
        var decoded: [PieRow] = []
        for (index, item) in pie.enumerated() {
            guard let name = item["name"]?.stringValue, let value = item["value"]?.decimalValue,
                let percent = item["labelPercent"]?.decimalValue,
                let start = item["startAngle"]?.decimalValue, let end = item["endAngle"]?.decimalValue
            else { return nil }
            decoded.append(
                .init(
                    id: index, name: name, value: value, labelPercent: percent,
                    startAngle: NSDecimalNumber(decimal: start).doubleValue,
                    endAngle: NSDecimalNumber(decimal: end).doubleValue))
        }
        pieRows = decoded
    }
    static func value(_ row: TaxValue, key: String) -> TaxValue? {
        if let fields = row.objectValue { return fields[key] }
        if let values = row.arrayValue, let index = Int(key), String(index) == key, values.indices.contains(index) {
            return values[index]
        }
        return nil
    }
}

enum AIChatToolDisplay {
    static func cell(_ value: TaxValue?, locale: Locale) -> String {
        guard let value, value != .null else { return "—" }
        switch value {
        case .number(let number):
            return number.formatted(
                Decimal.FormatStyle(locale: locale).precision(.fractionLength(0...2)).rounded(
                    rule: .toNearestOrAwayFromZero))
        case .string(let string): return string
        case .bool(let flag): return flag ? "true" : "false"
        default: return json(value, pretty: false)
        }
    }
    static func json(_ value: TaxValue, pretty: Bool) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting =
            pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "—" }
        return String(decoding: data, as: UTF8.self)
    }
    static func axis(_ value: TaxValue?) -> String {
        guard let value, value != .null else { return "" }
        return AIChatText.javascriptString(value)
    }
}

/// `AiToolPresentation.renderAs`; a value this client does not know falls back to the JSON view.
internal enum AIChatToolRender: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case table
    case line
    case bar
    case pie
    case unknown(String)

    internal static var allCases: [AIChatToolRender] { [.table, .line, .bar, .pie] }

    private static let known: [String: Self] = ["table": .table, "line": .line, "bar": .bar, "pie": .pie]
    internal init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    internal var rawValue: String {
        switch self {
        case .table: return "table"
        case .line: return "line"
        case .bar: return "bar"
        case .pie: return "pie"
        case .unknown(let value): return value
        }
    }

    internal init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    internal func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

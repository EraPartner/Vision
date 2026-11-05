import SwiftUI
import VisionNativeCore

extension VisionSelectOption where Value == String {
    /// `(value, title)` pairs as the options of a `VisionSelect`; the first pair wins a repeated value.
    static func pairs(_ pairs: [(String, String)]) -> [VisionSelectOption<String>] {
        var seen = Set<String>()
        return pairs.filter { seen.insert($0.0).inserted }.map { VisionSelectOption(value: $0.0, title: $0.1) }
    }
}

struct PortfolioImportConfigFields: View {
    @Binding var config: PortfolioImportConfig
    let headers: [String]
    let typeValues: [String]
    let strings: any Localizing
    var showMappings = true
    @Environment(\.visionTheme) private var theme
    private let columns: [(String, WritableKeyPath<PortfolioImportConfig, String>, Bool)] = [
        ("date", \.dateColumn, true), ("type", \.typeColumn, false), ("symbol", \.symbolColumn, false),
        ("name", \.nameColumn, false), ("units", \.unitsColumn, false), ("price", \.priceColumn, false),
        ("amount", \.amountColumn, false), ("currency", \.currencyColumn, false),
    ]
    private let additional: [(String, WritableKeyPath<PortfolioImportConfig, String>, Bool)] = [
        ("fees", \.feesColumn, false), ("taxes", \.taxesColumn, false),
        ("fxRate", \.fxRateColumn, false), ("note", \.noteColumn, false),
    ]
    private let types = ["buy", "sell", "dividend", "fee", "tax", "interest", "gift", "rent_income", "appreciation"]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            DisclosureGroup(strings.t("portfolioImport.formatOptions")) {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 260), alignment: .top)], alignment: .leading, spacing: 16
                ) {
                    field("importPage.separator") {
                        VisionSelect(
                            selection: $config.separator,
                            options: VisionSelectOption<String>.pairs([
                                (",", strings.t("importPage.sep.comma")), (";", strings.t("importPage.sep.semicolon")),
                                ("\t", strings.t("importPage.sep.tab")), ("|", strings.t("importPage.sep.pipe")),
                            ]), accessibilityLabel: strings.t("importPage.separator"), expands: true)
                    }
                    field("importPage.dateFormat") {
                        VisionSelect(
                            selection: $config.dateFormat,
                            options: VisionSelectOption<String>.pairs([
                                ("%Y-%m-%d", "YYYY-MM-DD (2024-12-31)"), ("%d/%m/%Y", "DD/MM/YYYY (31/12/2024)"),
                                ("%m/%d/%Y", "MM/DD/YYYY (12/31/2024)"), ("%d-%m-%Y", "DD-MM-YYYY (31-12-2024)"),
                                ("%Y-%m-%d %H:%M:%S", "YYYY-MM-DD HH:MM:SS"),
                            ]), accessibilityLabel: strings.t("importPage.dateFormat"), expands: true)
                    }
                    field("importPage.encoding") {
                        VisionSelect(
                            selection: Binding(
                                get: {
                                    config.encoding == "latin-1" ? "latin1" : config.encoding
                                }, set: { config.encoding = $0 }),
                            options: VisionSelectOption<String>.pairs([
                                ("utf-8", "UTF-8"), ("latin1", "Latin-1"), ("iso-8859-1", "ISO-8859-1"),
                                ("windows-1252", "Windows-1252"),
                            ]), accessibilityLabel: strings.t("importPage.encoding"), expands: true)
                    }
                    field("importPage.numberFormat.label") {
                        VisionSelect(
                            selection: $config.numberFormat,
                            options: VisionSelectOption<String>.pairs(
                                ["auto", "decimal_dot", "decimal_comma"].map {
                                    ($0, strings.t("importPage.numberFormat." + $0))
                                }), accessibilityLabel: strings.t("importPage.numberFormat.label"), expands: true)
                        Text(strings.t("importPage.numberFormat.hint")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                    field("importPage.skipRows") {
                        TextField(
                            strings.t("importPage.skipRows"), value: $config.skipRows, format: .number.grouping(.never)
                        ).textFieldStyle(.vision)
                    }
                }.padding(.top, 12)
            }
            if showMappings {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 260), alignment: .top)], alignment: .leading, spacing: 16
                ) {
                    field("portfolioImport.defaultAssetClass") {
                        VisionSelect(
                            selection: $config.defaultAssetClass,
                            options: VisionSelectOption<String>.pairs(
                                PortfolioAssetKinds.all.map {
                                    ($0.rawValue, strings.t("portfolio.assetClass." + $0.rawValue))
                                }),
                            accessibilityLabel: strings.t("portfolioImport.defaultAssetClass"), expands: true)
                    }
                    field("portfolioImport.defaultType") {
                        VisionSelect(
                            selection: $config.defaultType,
                            options: VisionSelectOption<String>.pairs(
                                types.map { ($0, strings.t("portfolio.txnType." + $0)) }),
                            accessibilityLabel: strings.t("portfolioImport.defaultType"), expands: true)
                    }
                    ForEach(columns, id: \.0) { key, path, required in mapping(key, path: path, required: required) }
                }
                DisclosureGroup(strings.t("portfolioImport.optionalColumns")) {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 260), alignment: .top)], alignment: .leading, spacing: 16
                    ) {
                        ForEach(additional, id: \.0) { key, path, required in
                            mapping(key, path: path, required: required)
                        }
                    }.padding(.top, 12)
                }
                if !typeValues.isEmpty {
                    DisclosureGroup(strings.t("portfolioImport.typeMappingTitle")) {
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 260), alignment: .top)], alignment: .leading,
                            spacing: 16
                        ) {
                            ForEach(typeValues, id: \.self) { raw in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(verbatim: raw).font(.callout.weight(.medium))
                                    VisionSelect(
                                        selection: Binding(
                                            get: { config.typeMapping[raw] ?? "" },
                                            set: { value in
                                                if value.isEmpty {
                                                    config.typeMapping.removeValue(forKey: raw)
                                                } else {
                                                    config.typeMapping[raw] = value
                                                }
                                            }),
                                        options: VisionSelectOption<String>.pairs(
                                            [("", strings.t("portfolioImport.typeMappingAuto"))]
                                                + types.map { ($0, strings.t("portfolio.txnType." + $0)) }),
                                        accessibilityLabel: raw, expands: true)
                                }
                            }
                        }.padding(.top, 12)
                    }
                }
                if !duplicates.isEmpty {
                    Text(
                        strings.t(
                            "portfolioImport.duplicateColumnsWarning", ["columns": duplicates.joined(separator: ", ")])
                    )
                    .font(.callout).foregroundStyle(theme.warning)
                }
                Text(strings.t("portfolioImport.requiredNote")).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    private var duplicates: [String] {
        let values = (columns + additional).map {
            config[keyPath: $0.1].trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
        var seen = Set<String>()
        return values.filter { value in values.filter { $0 == value }.count > 1 && seen.insert(value).inserted }
    }
    private func mapping(_ key: String, path: WritableKeyPath<PortfolioImportConfig, String>, required: Bool)
        -> some View
    {
        field("portfolioImport.col." + key, required: required) {
            let binding = Binding(get: { config[keyPath: path] }, set: { config[keyPath: path] = $0 })
            if headers.isEmpty {
                TextField(strings.t("portfolioImport.col." + key), text: binding).textFieldStyle(.vision)
            } else {
                VisionSelect(
                    selection: binding, options: mappingOptions(current: binding.wrappedValue),
                    accessibilityLabel: strings.t("portfolioImport.col." + key), expands: true)
            }
        }
    }
    /// No mapping, every header, and the current value when it is no longer one of the headers.
    private func mappingOptions(current: String) -> [VisionSelectOption<String>] {
        var pairs: [(String, String)] = [("", strings.t("importPage.noMapping"))]
        pairs += headers.map { ($0, $0) }
        if !current.isEmpty && !headers.contains(current) { pairs.append((current, current)) }
        return VisionSelectOption<String>.pairs(pairs)
    }
    private func field<Content: View>(_ key: String, required: Bool = false, @ViewBuilder content: () -> Content)
        -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(key) + (required ? " *" : "")).font(.callout.weight(.medium))
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

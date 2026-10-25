import SwiftUI
import VisionNativeCore

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
                        Picker(strings.t("importPage.separator"), selection: $config.separator) {
                            Text(strings.t("importPage.sep.comma")).tag(",")
                            Text(strings.t("importPage.sep.semicolon")).tag(";")
                            Text(strings.t("importPage.sep.tab")).tag("\t")
                            Text(strings.t("importPage.sep.pipe")).tag("|")
                        }.labelsHidden()
                    }
                    field("importPage.dateFormat") {
                        Picker(strings.t("importPage.dateFormat"), selection: $config.dateFormat) {
                            Text("YYYY-MM-DD (2024-12-31)").tag("%Y-%m-%d")
                            Text("DD/MM/YYYY (31/12/2024)").tag("%d/%m/%Y")
                            Text("MM/DD/YYYY (12/31/2024)").tag("%m/%d/%Y")
                            Text("DD-MM-YYYY (31-12-2024)").tag("%d-%m-%Y")
                            Text("YYYY-MM-DD HH:MM:SS").tag("%Y-%m-%d %H:%M:%S")
                        }.labelsHidden()
                    }
                    field("importPage.encoding") {
                        Picker(
                            strings.t("importPage.encoding"),
                            selection: Binding(
                                get: {
                                    config.encoding == "latin-1" ? "latin1" : config.encoding
                                }, set: { config.encoding = $0 })
                        ) {
                            Text("UTF-8").tag("utf-8")
                            Text("Latin-1").tag("latin1")
                            Text("ISO-8859-1").tag("iso-8859-1")
                            Text("Windows-1252").tag("windows-1252")
                        }.labelsHidden()
                    }
                    field("importPage.numberFormat.label") {
                        Picker(strings.t("importPage.numberFormat.label"), selection: $config.numberFormat) {
                            ForEach(["auto", "decimal_dot", "decimal_comma"], id: \.self) { value in
                                Text(strings.t("importPage.numberFormat." + value)).tag(value)
                            }
                        }.labelsHidden()
                        Text(strings.t("importPage.numberFormat.hint")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                    }
                    field("importPage.skipRows") {
                        TextField(
                            strings.t("importPage.skipRows"), value: $config.skipRows, format: .number.grouping(.never))
                    }
                }.padding(.top, 12)
            }
            if showMappings {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 260), alignment: .top)], alignment: .leading, spacing: 16
                ) {
                    field("portfolioImport.defaultAssetClass") {
                        Picker(strings.t("portfolioImport.defaultAssetClass"), selection: $config.defaultAssetClass) {
                            ForEach(PortfolioAssetKinds.all, id: \.self) { kind in
                                Text(strings.t("portfolio.assetClass." + kind)).tag(kind)
                            }
                        }.labelsHidden()
                    }
                    field("portfolioImport.defaultType") {
                        Picker(strings.t("portfolioImport.defaultType"), selection: $config.defaultType) {
                            ForEach(types, id: \.self) { type in Text(strings.t("portfolio.txnType." + type)).tag(type)
                            }
                        }.labelsHidden()
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
                                    Picker(
                                        raw,
                                        selection: Binding(
                                            get: { config.typeMapping[raw] ?? "" },
                                            set: { value in
                                                if value.isEmpty {
                                                    config.typeMapping.removeValue(forKey: raw)
                                                } else {
                                                    config.typeMapping[raw] = value
                                                }
                                            })
                                    ) {
                                        Text(strings.t("portfolioImport.typeMappingAuto")).tag("")
                                        ForEach(types, id: \.self) { type in
                                            Text(strings.t("portfolio.txnType." + type)).tag(type)
                                        }
                                    }.labelsHidden()
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
                TextField(strings.t("portfolioImport.col." + key), text: binding)
            } else {
                Picker(strings.t("portfolioImport.col." + key), selection: binding) {
                    Text(strings.t("importPage.noMapping")).tag("")
                    ForEach(headers.indices, id: \.self) { index in Text(verbatim: headers[index]).tag(headers[index]) }
                    if !binding.wrappedValue.isEmpty && !headers.contains(binding.wrappedValue) {
                        Text(verbatim: binding.wrappedValue).tag(binding.wrappedValue)
                    }
                }.labelsHidden()
            }
        }
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

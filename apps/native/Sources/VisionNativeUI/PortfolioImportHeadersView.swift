import SwiftUI
import VisionNativeCore

struct PortfolioImportHeadersView: View {
    let headers: [String]
    let rows: [[String]]
    let config: PortfolioImportConfig
    let strings: any Localizing
    var isLoading = false
    var error: String? = nil
    var detectedSeparator: String? = nil
    @State private var sampleOpen = false
    @Environment(\.visionTheme) private var theme
    private var highlighted: Set<String> {
        Set(
            [
                config.dateColumn, config.typeColumn, config.symbolColumn, config.nameColumn, config.unitsColumn,
                config.priceColumn, config.amountColumn, config.currencyColumn, config.feesColumn, config.taxesColumn,
                config.fxRateColumn, config.noteColumn,
            ].filter { !$0.isEmpty })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isLoading {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(strings.t("importPage.csvParsing"))
                }
            } else if error != nil || headers.isEmpty {
                Label(strings.t("csvHeaders.unreadable"), systemImage: "exclamationmark.circle")
                    .foregroundStyle(theme.secondaryLabel)
            } else {
                HStack {
                    Label(strings.t("csvHeaders.title"), systemImage: "tablecells").font(.callout.weight(.medium))
                    Text(strings.t("csvHeaders.columns", ["n": String(headers.count)])).foregroundStyle(
                        theme.secondaryLabel)
                    if let separator = detectedSeparator {
                        Text(strings.t("csvHeaders.delimiterDetected", ["sep": separatorLabel(separator)]))
                            .foregroundStyle(theme.secondaryLabel)
                    }
                }.font(.caption)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 160), alignment: .leading)], alignment: .leading, spacing: 6
                ) {
                    ForEach(headers.indices, id: \.self) { index in
                        VisionBadge(
                            text: headers[index].isEmpty ? "—" : headers[index],
                            tone: highlighted.contains(headers[index]) ? .primary : .secondary)
                    }
                }
                if !rows.isEmpty {
                    DisclosureGroup(strings.t("csvHeaders.sampleRows"), isExpanded: $sampleOpen) {
                        ScrollView(.horizontal) {
                            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
                                GridRow {
                                    ForEach(0..<columnCount, id: \.self) { index in
                                        Text(index < headers.count ? headers[index] : "—").font(
                                            .caption.weight(.semibold)
                                        )
                                        .foregroundStyle(
                                            index < headers.count && highlighted.contains(headers[index])
                                                ? theme.primary : theme.secondaryLabel
                                        )
                                        .frame(minWidth: 120, maxWidth: 220, alignment: .leading)
                                    }
                                }
                                ForEach(Array(rows.prefix(5).indices), id: \.self) { index in
                                    GridRow {
                                        ForEach(0..<columnCount, id: \.self) { column in
                                            Text(column < rows[index].count ? rows[index][column] : "").font(.caption)
                                                .textSelection(.enabled).frame(
                                                    minWidth: 120, maxWidth: 220, alignment: .leading)
                                        }
                                    }
                                }
                            }.padding(.vertical, 10)
                        }
                    }
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.foreground.opacity(0.03), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control))
    }
    private var columnCount: Int { max(headers.count, rows.prefix(5).map(\.count).max() ?? 0) }
    private func separatorLabel(_ value: String) -> String {
        switch value {
        case ",": strings.t("importPage.sep.comma")
        case ";": strings.t("importPage.sep.semicolon")
        case "\t": strings.t("importPage.sep.tab")
        case "|": strings.t("importPage.sep.pipe")
        default: value
        }
    }
}

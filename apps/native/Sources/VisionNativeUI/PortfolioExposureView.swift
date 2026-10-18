import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore

struct PortfolioExposureView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var dimension = "issuer"
    @State private var importing = false
    @State private var importError: String?
    @Environment(\.visionTheme) private var theme
    private var data: PortfolioExposureData? {
        guard model.exposure?.currency == shell.settings.defaultCurrency else { return nil }
        return model.exposure
    }
    private var selected: PortfolioExposureDimension? {
        guard let data else { return nil }
        return dimension == "sector" ? data.sector : dimension == "issuerCountry" ? data.issuerCountry : data.issuer
    }

    var body: some View {
        PortfolioCard(
            title: shell.strings.t("portfolio.exposure.title"),
            description: shell.strings.t("portfolio.exposure.description"), large: true
        ) {
            Picker(shell.strings.t("portfolio.exposure.dimensionLabel"), selection: $dimension) {
                ForEach(["issuer", "sector", "issuerCountry"], id: \.self) { key in
                    Text(shell.strings.t("portfolio.exposure." + key)).tag(key)
                }
            }.pickerStyle(.segmented).frame(maxWidth: 600)
            if let error = importError ?? model.errors["exposure"] {
                Text(error).foregroundStyle(theme.destructive)
                Button(shell.strings.t("common.retry")) { Task { await model.loadExposure(force: true) } }
                    .disabled(model.isExposureLoading)
            }
            if let data, let selected {
                Text(shell.strings.t("portfolio.exposure.coverage")).font(.subheadline.weight(.medium))
                Text(shell.strings.t("portfolio.exposure.partialCoverageHint"))
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
                let segments = coverage(data, selected)
                if data.totalValue > 0 && segments.allSatisfy({ (0...100).contains($0.percent) })
                    && abs(segments.reduce(0) { $0 + $1.percent } - 100) <= Decimal(5) / 100
                {
                    GeometryReader { geometry in
                        HStack(spacing: 0) {
                            ForEach(segments, id: \.key) { item in
                                Rectangle().fill(item.color)
                                    .frame(
                                        width: geometry.size.width
                                            * CGFloat(NSDecimalNumber(decimal: item.percent / 100).doubleValue))
                            }
                        }
                    }.frame(height: 12).clipShape(Capsule()).accessibilityHidden(true)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), alignment: .leading)], alignment: .leading) {
                    ForEach(segments, id: \.key) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Label(shell.strings.t("portfolio.exposure." + item.key), systemImage: "circle.fill")
                                .font(.caption).foregroundStyle(item.color)
                            MoneyText(
                                amount: item.amount, currency: data.currency, settings: shell.settings, signed: false,
                                colored: false)
                            Text(percent(item.percent)).font(.caption).monospacedDigit().foregroundStyle(
                                theme.secondaryLabel)
                            Text(shell.strings.t("portfolio.exposure." + item.key + "Hint"))
                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !data.warnings.isEmpty {
                    Label(
                        shell.strings.t("portfolio.exposure.warnings", ["count": String(data.warnings.count)]),
                        systemImage: "exclamationmark.triangle"
                    ).font(.footnote).foregroundStyle(theme.warning)
                }
                let stale = data.fundSources.filter(\.stale)
                if !stale.isEmpty {
                    Text(
                        shell.strings.t("portfolio.exposure.stale") + ": "
                            + stale.map(\.investmentName).joined(separator: ", ")
                    )
                    .font(.footnote).foregroundStyle(theme.warning)
                }
                ForEach(selected.rows) { row in
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(row.contributions.enumerated()), id: \.offset) { _, item in
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(
                                            (item.sourceType == "direct"
                                                ? shell.strings.t("portfolio.exposure.direct")
                                                : shell.strings.t(
                                                    "portfolio.exposure.fundContribution",
                                                    ["fund": item.sourceFundName ?? "—"]))
                                                + ": " + item.investmentName)
                                        if let date = item.sourceAsOfDate {
                                            Text(shell.strings.t("portfolio.exposure.sourceAsOf", ["date": date]))
                                                .font(.caption).foregroundStyle(theme.secondaryLabel)
                                        }
                                        if item.stale {
                                            Text(shell.strings.t("portfolio.exposure.stale")).font(.caption)
                                                .foregroundStyle(theme.warning)
                                        }
                                    }
                                    Spacer()
                                    MoneyText(
                                        amount: item.amount, currency: data.currency, settings: shell.settings,
                                        signed: false, colored: false)
                                }.font(.footnote)
                            }
                        }.padding(.vertical, 10)
                    } label: {
                        HStack {
                            Text(row.label)
                            Spacer()
                            MoneyText(
                                amount: row.amount, currency: data.currency, settings: shell.settings, signed: false,
                                colored: false)
                            Text(percent(row.weightPercent)).font(.caption).monospacedDigit().foregroundStyle(
                                theme.secondaryLabel)
                        }
                    }.padding(.vertical, 4)
                }
                if selected.rows.isEmpty {
                    Text(shell.strings.t("portfolio.exposure.noneClassified")).foregroundStyle(theme.secondaryLabel)
                }
                Text(shell.strings.t("portfolio.exposure.fxBoundary")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            } else if model.errors["exposure"] == nil {
                ProgressView().frame(maxWidth: .infinity).padding(24)
            }
            DisclosureGroup(shell.strings.t("portfolio.exposure.sourcesAndImport")) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(shell.strings.t("portfolio.exposure.sourceBoundary")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                    ForEach(data?.fundSources ?? [], id: \.investmentId) { source in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(source.investmentName).font(.callout.weight(.medium))
                            Text(
                                shell.strings.t(
                                    "portfolio.exposure.sourceStatus",
                                    [
                                        "date": source.asOfDate,
                                        "age": String(source.ageDays), "maximum": String(source.maximumAgeDays),
                                    ])
                            )
                            .font(.footnote).foregroundStyle(theme.secondaryLabel)
                            Text(
                                shell.strings.t(source.stale ? "portfolio.exposure.stale" : "portfolio.exposure.fresh")
                            )
                            .font(.caption).foregroundStyle(source.stale ? theme.warning : theme.secondaryLabel)
                        }
                    }
                    Button(shell.strings.t("portfolio.exposure.importSources"), systemImage: "square.and.arrow.up") {
                        importing = true
                    }
                    .buttonStyle(.visionOutline).disabled(editing.isMutating)
                    Text(shell.strings.t("portfolio.exposure.importHint")).font(.caption).foregroundStyle(
                        theme.secondaryLabel)
                }.padding(.top, 12)
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            Task {
                do {
                    let url = try result.get()
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 1_000_000 else {
                        throw APIError.invalidRequest(shell.strings.t("portfolio.exposure.invalidSource"))
                    }
                    let bytes = try Data(contentsOf: url)
                    guard bytes.count <= 1_000_000 else {
                        throw APIError.invalidRequest(shell.strings.t("portfolio.exposure.invalidSource"))
                    }
                    _ = try JSONSerialization.jsonObject(with: bytes)
                    importError = nil
                    if await editing.importExposure(data: bytes) {
                        await model.loadExposure(force: true)
                    } else {
                        importError = editing.error
                    }
                } catch {
                    if (error as? CocoaError)?.code != .userCancelled { importError = error.localizedDescription }
                }
            }
        }
    }
    private struct Coverage {
        let key: String
        let amount: Decimal
        let percent: Decimal
        let color: Color
    }
    private func coverage(_ data: PortfolioExposureData, _ selected: PortfolioExposureDimension) -> [Coverage] {
        [
            Coverage(
                key: "classified", amount: selected.classifiedValue, percent: selected.classifiedWeightPercent,
                color: theme.primary),
            Coverage(
                key: "unclassified", amount: selected.unclassifiedValue, percent: selected.unclassifiedWeightPercent,
                color: theme.tertiaryLabel),
            Coverage(
                key: "uncovered", amount: data.uncoveredValue, percent: data.uncoveredWeightPercent,
                color: theme.warning),
            Coverage(
                key: "cash", amount: data.coveredCashValue, percent: data.coveredCashWeightPercent, color: theme.info),
        ]
    }
    private func percent(_ value: Decimal) -> String {
        VisionFormat.percent(value, digits: 2, locale: shell.settings.numberFormat.locale)
    }
}

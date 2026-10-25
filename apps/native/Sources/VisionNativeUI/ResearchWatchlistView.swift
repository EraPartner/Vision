import SwiftUI
import VisionNativeCore

public struct ResearchWatchlistView: View {
    let model: ResearchWatchlistModel
    let shell: NativeShellModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchWatchlistModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(
                    title: strings.t("watchlist.title"), subtitle: strings.t("watchlist.subtitle"), symbol: "scope"
                ) {
                    addButton
                }
                if model.quotesUnavailable, !(model.page?.items.isEmpty ?? true) {
                    Label(strings.t("watchlist.quotesOffline"), systemImage: "wifi.slash")
                        .font(.callout).foregroundStyle(theme.warning)
                }
                if model.error != nil {
                    ResearchCard {
                        HStack {
                            Text(strings.t("common.loadFailedRetry")).foregroundStyle(theme.destructive)
                            Spacer()
                            Button(strings.t("common.retry")) { Task { await model.load(force: true) } }
                                .buttonStyle(.vision(.outline, size: .sm)).disabled(model.isLoading)
                        }
                    }
                }
                if model.isLoading && model.page == nil {
                    ForEach(0..<3) { _ in ResearchCard { ProgressView().frame(maxWidth: .infinity).padding(20) } }
                } else if let page = model.page {
                    if page.items.isEmpty {
                        ResearchCard {
                            let lines = strings.t("watchlist.empty").components(separatedBy: "\n")
                            VisionEmptyState(
                                symbol: "scope", title: lines.first ?? "",
                                description: lines.dropFirst().joined(separator: "\n")
                            ) { addButton }
                        }
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(page.items.enumerated()), id: \.element.id) { index, item in
                                ResearchWatchlistRow(item: item, model: model, shell: shell)
                                if index < page.items.count - 1 { Divider() }
                            }
                        }.clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                            .visionCardBackground()
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .visionDialog(
            isPresented: Binding(get: { model.add.isPresented }, set: { if !$0 { model.add.close() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0),
            accessibilityTitle: strings.t("addWatchlist.title")
        ) {
            ResearchWatchlistAddSheet(model: model.add, shell: shell)
        }
        .visionDialog(
            item: Binding(get: { model.selectedItem }, set: { if $0 == nil { model.closeChart() } }),
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0)
        ) { item in
            ResearchWatchlistChartSheet(model: model, item: item, shell: shell)
        }
        // The buttons decide: `deleteConfirmed()` reads `deletingItem`, so a dismissal must not
        // clear it before the confirming task runs.
        .visionConfirmationDialog(
            title: strings.t("watchlist.removeTitle"),
            message: { item in
                strings.t("watchlist.removeDesc", ["name": ResearchWatchlistUI.name(item)])
            },
            item: Binding(get: { model.deletingItem }, set: { _ in })
        ) { _ in
            VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.deletingItem = nil }
            VisionDialogAction(strings.t("watchlist.removeConfirm"), role: .destructive) {
                Task { await model.deleteConfirmed() }
            }
        }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: model.add.notice ?? model.notice, strings: strings) { id in
                model.add.clearNotice(id)
                model.clearNotice(id)
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { break }
                if scenePhase == .active && model.isOnline { await model.poll() }
            }
        }
    }
    private var addButton: some View {
        Button(strings.t("watchlist.addButton"), systemImage: "plus") {
            model.add.begin(numberFormat: shell.settings.numberFormat)
        }.buttonStyle(.visionPrimary)
    }
}

private struct ResearchWatchlistRow: View {
    let item: ResearchWatchlistItem
    let model: ResearchWatchlistModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var metric: ResearchWatchlistMetrics? { model.metrics[item.id.rawValue] }
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(
                systemName: item.assetClass == "crypto"
                    ? "bitcoinsign.circle" : item.assetClass == "metals" ? "diamond" : "chart.line.uptrend.xyaxis"
            )
            .foregroundStyle(theme.secondaryLabel).frame(width: 24).padding(.top, 4).accessibilityHidden(true)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 20) {
                    identity.frame(minWidth: 240, maxWidth: .infinity, alignment: .leading)
                    prices
                }
                VStack(alignment: .leading, spacing: 12) {
                    identity
                    prices
                }
            }
            HStack(spacing: 5) {
                Button {
                    Task { await model.openChart(id: item.id) }
                } label: {
                    Image(systemName: "chart.xyaxis.line")
                }
                .buttonStyle(.vision(.ghost, size: .iconSm)).accessibilityLabel(
                    strings.t("watchlist.openChart") + ": " + ResearchWatchlistUI.name(item)
                )
                .visionTooltip(strings.t("watchlist.openChart"))
                Menu {
                    Button(strings.t("watchlist.openChart"), systemImage: "chart.xyaxis.line") {
                        Task { await model.openChart(id: item.id) }
                    }
                    Button(strings.t("watchlist.openLookup"), systemImage: "magnifyingglass", action: lookup).disabled(
                        item.symbol?.isEmpty ?? true)
                    Divider()
                    Button(strings.t("aria.removeFromWatchlist"), systemImage: "trash", role: .destructive) {
                        model.deletingItem = item
                    }
                    .disabled(model.isMutating)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuIndicator(.hidden)
                .menuStyle(.borderlessButton).fixedSize()
                .accessibilityLabel(strings.t("watchlist.rowMenu", ["name": ResearchWatchlistUI.name(item)]))
            }.padding(.top, 4)
        }.padding(18).background(metric?.isAtOrBelowTarget == true ? theme.success.opacity(0.06) : .clear)
    }
    private var identity: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let symbol = item.symbol, !symbol.isEmpty {
                    Button(ResearchWatchlistUI.name(item), action: lookup).buttonStyle(.visionLink).font(.headline)
                        .multilineTextAlignment(.leading)
                    VisionBadge(text: symbol, tone: .outline, small: true, monospaced: true)
                } else {
                    Text(ResearchWatchlistUI.name(item)).font(.headline)
                }
            }
            Text(assetClassLabel(item.assetClass)).font(.caption).foregroundStyle(theme.secondaryLabel)
            if let value = metric?.sinceAddedPercent {
                HStack(spacing: 6) {
                    Text(
                        strings.t(
                            "watchlist.sinceAdded",
                            ["date": VisionFormat.appDate(item.createdAt, format: shell.settings.dateFormat)]))
                    DeltaPill(
                        value, label: (value > 0 ? "+" : "") + ResearchWatchlistUI.percent(value, digits: 1, shell: shell))
                }.font(.caption)
            }
            if let notes = item.notes, !notes.isEmpty {
                Text(notes).font(.caption).foregroundStyle(theme.secondaryLabel).fixedSize(
                    horizontal: false, vertical: true)
            }
        }
    }
    private var prices: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let price = item.symbol.flatMap({ model.quotes[$0]?.price }) {
                Text(ResearchWatchlistUI.money(price, currency: item.currency, shell: shell)).monospacedDigit()
            } else {
                Text(strings.t("watchlist.quoteUnavailable")).font(.callout).foregroundStyle(theme.secondaryLabel)
            }
            Text(
                strings.t("watchlist.targetPrice") + " "
                    + ResearchWatchlistUI.money(item.targetPrice, currency: item.currency, shell: shell)
            )
            .font(.footnote).monospacedDigit()
            if metric?.isAtOrBelowTarget == true {
                Label(strings.t("watchlist.atTargetShort"), systemImage: "checkmark").font(.caption2.weight(.medium))
                    .foregroundStyle(theme.success).padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(theme.success.opacity(0.15)))
                    .overlay(Capsule().strokeBorder(theme.success.opacity(0.3), lineWidth: 1))
                    .visionTooltip(strings.t("watchlist.atTarget"))
            } else if let percent = metric?.absoluteDistancePercent, let signed = metric?.distancePercent, signed > 0 {
                DeltaPill(
                    signed,
                    label: ResearchWatchlistUI.percent(percent, digits: 1, shell: shell) + " "
                        + strings.t("watchlist.aboveTarget"), invert: true)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
    /// `addWatchlist.<class>` covers the four classes the add form offers; a row may also carry
    /// another portfolio asset class (bond, savings, real_estate).
    private func assetClassLabel(_ value: String) -> String {
        for key in ["addWatchlist." + value, "portfolio.assetClass." + value] where strings.t(key) != key {
            return strings.t(key)
        }
        return value
    }
    private func lookup() {
        guard let symbol = item.symbol else { return }
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        shell.navigate(to: "/research/market?" + (components.percentEncodedQuery ?? ""))
    }
}

enum ResearchWatchlistUI {
    static func name(_ item: ResearchWatchlistItem) -> String { item.name.isEmpty ? item.symbol ?? "" : item.name }
    @MainActor static func money(_ value: Decimal, currency: CurrencyCode, shell: NativeShellModel) -> String {
        VisionFormat.currency(
            value, code: currency, locale: shell.settings.numberFormat.locale,
            fractionDigits: shell.settings.showDecimalPlaces)
    }
    @MainActor static func percent(_ value: Decimal, digits: Int, shell: NativeShellModel) -> String {
        VisionFormat.percent(value, digits: digits, locale: shell.settings.numberFormat.locale)
    }
}

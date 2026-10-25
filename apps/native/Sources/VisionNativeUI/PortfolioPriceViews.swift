import SwiftUI
import VisionNativeCore

enum PortfolioPricePresentation {
    static func isStale(_ holding: PortfolioHolding, now: Date = Date()) -> Bool {
        guard (holding.priceProvider ?? .manual) != .manual else { return false }
        guard let stamp = holding.priceUpdatedAt, let date = VisionFormat.parseTimestamp(stamp) else { return true }
        return now.timeIntervalSince(date) > 86_400
    }
    @MainActor static func freshness(_ holdings: [PortfolioHolding], shell: NativeShellModel) -> String? {
        let live = holdings.filter { $0.isActive && ($0.priceProvider ?? .manual) != .manual }
        guard !live.isEmpty else { return nil }
        let dates = live.compactMap { $0.priceUpdatedAt.flatMap { VisionFormat.parseTimestamp($0) } }
        guard dates.count == live.count, let oldest = dates.min() else {
            return shell.strings.t("portfolio.livePricesNotFetched")
        }
        let stamp = oldest.formatted(.iso8601)
        return shell.strings.t(
            "portfolio.pricesAsOf",
            [
                "date": VisionFormat.appDateTime(
                    stamp,
                    format: shell.settings.dateFormat, locale: shell.settings.numberFormat.locale)
            ])
    }
}

struct PortfolioPriceFreshnessCaption: View {
    let holdings: [PortfolioHolding]
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if let label = PortfolioPricePresentation.freshness(holdings, shell: shell) {
            Label(label, systemImage: "clock").font(.caption).foregroundStyle(theme.secondaryLabel)
        }
    }
}

struct PortfolioStalePricesBanner: View {
    let model: PortfolioModel
    let holdings: [PortfolioHolding]
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    var body: some View {
        let count = holdings.filter { PortfolioPricePresentation.isStale($0) }.count
        if count > 0 {
            AdminCard {
                HStack(alignment: .top, spacing: 16) {
                    Label(
                        shell.strings.t("portfolio.stalePricesBanner", ["n": String(count)]),
                        systemImage: "exclamationmark.triangle"
                    ).foregroundStyle(theme.warning)
                    if !model.isOnline {
                        Text(shell.strings.t("portfolio.refreshPricesOffline")).font(.callout).foregroundStyle(
                            theme.secondaryLabel)
                    }
                    Spacer()
                    Button(shell.strings.t("portfolio.refreshPrices"), systemImage: "arrow.clockwise") {
                        Task { await model.refreshPrices() }
                    }.disabled(model.isRefreshingPrices || !model.isOnline)
                }
                if let error = model.priceError { Text(error).font(.callout).foregroundStyle(theme.destructive) }
            }
        }
    }
}

struct PortfolioStalePriceIndicator: View {
    let holding: PortfolioHolding
    let shell: NativeShellModel
    @State private var presented = false
    @Environment(\.visionTheme) private var theme
    private var message: String {
        let stamp =
            holding.priceUpdatedAt.map {
                VisionFormat.appDateTime(
                    $0, format: shell.settings.dateFormat, locale: shell.settings.numberFormat.locale)
            } ?? shell.strings.t("portfolio.staleNeverFetched")
        return shell.strings.t("portfolio.stalePriceTooltip", ["date": stamp])
    }
    var body: some View {
        if PortfolioPricePresentation.isStale(holding) {
            Button {
                presented.toggle()
            } label: {
                Image(systemName: "clock").foregroundStyle(theme.warning)
            }
            .buttonStyle(.borderless).help(message).accessibilityLabel(message)
            .popover(isPresented: $presented) { Text(message).padding(16).frame(maxWidth: 300) }
        }
    }
}

/// Hover help, keyboard focus and activation expose the same complete explanation.
struct PortfolioPriceDisclosure: View {
    let label: String
    let explanation: String
    var symbol = "info.circle"
    @State private var presented = false
    @FocusState private var focused: Bool
    var body: some View {
        Button {
            presented.toggle()
        } label: {
            if label.isEmpty { Image(systemName: symbol) } else { Label(label, systemImage: symbol) }
        }.buttonStyle(.borderless).focused($focused).help(explanation)
            .accessibilityLabel(label.isEmpty ? explanation : label + ". " + explanation)
            .popover(isPresented: $presented) { Text(explanation).padding(16).frame(maxWidth: 320) }
            .onChange(of: focused) { _, value in if value { presented = true } }
    }
}

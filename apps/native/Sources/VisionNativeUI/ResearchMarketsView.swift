import SwiftUI
import VisionNativeCore

public struct ResearchMarketsView: View {
    let model: ResearchMarketsModel
    let shell: NativeShellModel
    @State private var visible = false
    @State private var width: CGFloat = 0
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchMarketsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var selection: String { model.region.rawValue + "|" + model.sector }
    private var polling: String { visible && scenePhase == .active && model.isOnline ? selection : "paused" }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VisionPageHeader(
                    title: shell.strings.t("research.markets.title"),
                    subtitle: shell.strings.t("research.markets.subtitle"),
                    symbol: "globe")
                filters
                ForEach(Array(model.groups.enumerated()), id: \.offset) { _, group in
                    VStack(alignment: .leading, spacing: 12) {
                        if model.groups.count > 1, let key = group.titleKey {
                            Text(shell.strings.t(key)).font(.headline).foregroundStyle(theme.secondaryLabel)
                                .accessibilityAddTraits(.isHeader)
                        }
                        if group.entries.isEmpty {
                            ResearchCard {
                                VisionEmptyState(symbol: "globe", title: shell.strings.t("research.markets.empty")) {}
                                    .padding(.vertical, 24)
                            }
                        } else {
                            LazyVGrid(columns: columns, spacing: 10) {
                                ForEach(group.entries, id: \.symbol) { entry in tile(entry) }
                            }
                        }
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .onGeometryChange(for: CGFloat.self) {
            $0.size.width
        } action: {
            width = $0
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: polling) {
            guard polling != "paused" else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                await model.refreshQuotes()
            }
        }
    }
    private var columns: [GridItem] {
        Array(
            repeating: GridItem(.flexible(), spacing: 10),
            count: width >= 1024 ? 6 : width >= 768 ? 4 : width >= 640 ? 3 : 2)
    }
    private var filters: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                region
                sector
            }
            VStack(alignment: .leading, spacing: 12) {
                region
                sector
            }
        }
    }
    private var region: some View {
        Picker(
            shell.strings.t("research.markets.regions"),
            selection: Binding(get: { model.region }, set: { model.region = $0 })
        ) {
            ForEach(ResearchMarketCatalog.regionOptions, id: \.id) { option in
                Text(shell.strings.t(option.labelKey)).tag(ResearchMarketRegion(rawValue: option.id) ?? .worldwide)
            }
        }.pickerStyle(.segmented).labelsHidden().accessibilityLabel(shell.strings.t("research.markets.regions"))
    }
    private var sector: some View {
        Picker(
            shell.strings.t("research.markets.sectors"),
            selection: Binding(get: { model.sector }, set: { model.sector = $0 })
        ) {
            ForEach(ResearchMarketCatalog.sectorOptions, id: \.id) { option in
                Text(shell.strings.t(option.labelKey)).tag(option.id)
            }
        }.labelsHidden().frame(width: 220).accessibilityLabel(shell.strings.t("research.markets.sectors"))
    }
    private func tile(_ entry: ResearchMarketEntry) -> some View {
        let percent = model.quotes.first { $0.symbol == entry.symbol }?.changePercent
        let held = model.isHeld(entry.symbol)
        let color = (percent ?? 0) >= 0 ? theme.gain : theme.loss
        // The percentage only controls drawing opacity; raw Decimal stays in the readout.
        let intensity = min(abs(NSDecimalNumber(decimal: percent ?? 0).doubleValue) / 3, 1)
        let alpha = 0.14 + intensity * 0.52
        return Button {
            shell.navigate(to: ResearchURLs.market(entry.symbol))
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(entry.label).font(.caption).lineLimit(1).foregroundStyle(theme.foreground.opacity(0.7))
                    Spacer(minLength: 0)
                    if held {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(
                            Color(token: theme.palette.accent)
                        ).accessibilityHidden(
                            true)
                    }
                }
                if let percent {
                    Text(
                        (percent >= 0 ? "+" : "−")
                            + VisionFormat.percent(abs(percent), digits: 2, locale: shell.settings.numberFormat.locale)
                    )
                    .font(.title.weight(.semibold)).monospacedDigit()
                } else {
                    Text("—").font(.title.weight(.semibold)).foregroundStyle(theme.tertiaryLabel)
                }
                Text(entry.symbol).font(.caption.monospaced()).foregroundStyle(theme.foreground.opacity(0.5)).lineLimit(
                    1)
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if percent != nil {
                        LinearGradient(
                            colors: [color.opacity(alpha), color.opacity(alpha * 0.45)], startPoint: .topLeading,
                            endPoint: .bottomTrailing)
                    } else {
                        theme.foreground.opacity(0.03)
                    }
                }.clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(
                        held ? Color(token: theme.palette.accent).opacity(0.7) : theme.border.opacity(0.4)))
        }.buttonStyle(.plain)
            .accessibilityLabel(entry.label + (held ? ", " + shell.strings.t("research.markets.held") : ""))
            .accessibilityValue(
                percent.map { VisionFormat.percent($0, digits: 2, locale: shell.settings.numberFormat.locale) } ?? "—")
    }
}

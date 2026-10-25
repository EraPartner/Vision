import SwiftUI
import VisionNativeCore

struct PortfolioTickerView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var manager = false
    @State private var hovered = false
    @State private var visible = false
    @State private var elapsed: TimeInterval = 0
    @State private var startedAt: Date?
    @State private var overrides: [InvestmentID: Bool] = [:]
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Environment(\.visionTheme) private var theme
    private var quotable: [PortfolioInvestment] {
        model.investments.filter { $0.isActive && $0.priceProvider == .yahoo && !symbol($0).isEmpty }
    }
    private var included: [PortfolioInvestment] { quotable.filter { overrides[$0.id] ?? ($0.showInTicker != false) } }
    private var active: Bool { visible && scenePhase == .active && model.isOnline }
    private var moving: Bool { active && !hovered && !reducedMotion }
    private var quoted: [(PortfolioInvestment, PortfolioQuote)] {
        included.compactMap { investment in
            guard let quote = model.quotes.first(where: { $0.symbol.uppercased() == symbol(investment) }),
                quote.price != nil
            else { return nil }
            return (investment, quote)
        }
    }

    var body: some View {
        if !quotable.isEmpty {
            HStack(spacing: 0) {
                if quoted.isEmpty {
                    Text(shell.strings.t(model.isOnline ? "portfolio.ticker.allHidden" : "portfolio.ticker.offline"))
                        .font(.callout).foregroundStyle(theme.secondaryLabel).padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if reducedMotion {
                    ScrollView(.horizontal) { tape }.scrollIndicators(.hidden)
                } else {
                    GeometryReader { geometry in
                        TimelineView(.animation(minimumInterval: 1 / 30, paused: !moving)) { timeline in
                            let width = CGFloat(quoted.count) * 250
                            let duration = max(24, Double(quoted.count) * 4.5)
                            let time = elapsed + (startedAt.map { timeline.date.timeIntervalSince($0) } ?? 0)
                            HStack(spacing: 0) {
                                ForEach(0..<max(2, Int((geometry.size.width / width).rounded(.up)) + 1), id: \.self) {
                                    index in
                                    tape.accessibilityHidden(index > 0)
                                }
                            }
                            .offset(x: -width * CGFloat(time.truncatingRemainder(dividingBy: duration) / duration))
                            .frame(width: max(geometry.size.width, width * 2), alignment: .leading)
                        }
                    }.frame(height: 54).clipped()
                }
                Button {
                    manager = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .buttonStyle(.plain).padding(16)
                .accessibilityLabel(shell.strings.t("portfolio.ticker.manage"))
                .popover(isPresented: $manager) { management }
            }
            .visionCardBackground()
            .accessibilityLabel(shell.strings.t("portfolio.ticker.aria"))
            .onHover { hovered = $0 }
            .onScrollVisibilityChange(threshold: 0.1) { visible = $0 }
            .onChange(of: moving, initial: true) { _, moving in
                if moving {
                    startedAt = Date()
                } else if let startedAt {
                    elapsed += Date().timeIntervalSince(startedAt)
                    self.startedAt = nil
                }
            }
            .onChange(of: model.investments) { _, _ in overrides = [:] }
            .task(id: String(active) + included.map(symbol).sorted().joined(separator: ",")) {
                guard active else { return }
                while !Task.isCancelled {
                    await model.refreshQuotes()
                    do { try await Task.sleep(for: .seconds(60)) } catch { return }
                }
            }
        }
    }

    private var tape: some View {
        HStack(spacing: 0) {
            ForEach(quoted, id: \.0.id) { investment, quote in
                HStack(spacing: 8) {
                    PortfolioInlineDisclosure(label: investment.symbol ?? quote.symbol, explanation: investment.name)
                        .font(.callout.monospaced().weight(.medium))
                    if let price = quote.price {
                        Text(
                            ResearchMoney.text(
                                price, currency: quote.currency, locale: shell.settings.numberFormat.locale,
                                fractionDigits: shell.settings.showDecimalPlaces))
                            .font(.callout).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    }
                    if let change = quote.changePercent {
                        Label(signedPercent(change), systemImage: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.caption.weight(.medium)).monospacedDigit()
                            .foregroundStyle(change >= 0 ? theme.gain : theme.loss)
                    }
                }.padding(.horizontal, 14).frame(width: 250, height: 54)
                    .accessibilityElement(children: .combine)
            }
        }
    }
    private var management: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(shell.strings.t("portfolio.ticker.manageTitle")).font(.headline)
            Text(
                shell.strings.t(
                    "portfolio.ticker.manageCount", ["shown": String(included.count), "total": String(quotable.count)])
            )
            .font(.caption).foregroundStyle(theme.secondaryLabel)
            ForEach(quotable) { investment in
                Toggle(
                    isOn: Binding(
                        get: { overrides[investment.id] ?? (investment.showInTicker != false) },
                        set: { value in
                            overrides[investment.id] = value
                            Task {
                                let saved = await editing.setTicker(id: investment.id, visible: value)
                                if !saved { overrides.removeValue(forKey: investment.id) }
                            }
                        })
                ) {
                    HStack(spacing: 8) {
                        if let symbol = investment.symbol, !symbol.isEmpty {
                            Text(symbol).font(.caption.monospaced().weight(.medium))
                        }
                        Text(investment.name).font(.footnote).foregroundStyle(theme.secondaryLabel)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }
                .toggleStyle(.switch)
                .accessibilityLabel(investment.name)
                .disabled(editing.isMutating)
            }
        }.padding(20).frame(width: 340)
    }
    private func symbol(_ investment: PortfolioInvestment) -> String {
        (investment.priceProviderId ?? investment.symbol ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
    }
    private func signedPercent(_ value: Decimal) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, digits: 2, locale: shell.settings.numberFormat.locale)
    }
}

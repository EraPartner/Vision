import SwiftUI
import VisionNativeCore

struct PortfolioTickerView: View {
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var manager = false
    @State private var hovered = false
    /// On screen until the scroll view says otherwise (the web starts active too).
    @State private var visible = true
    /// The measured width of one pass of the tape.
    @State private var tapeWidth: CGFloat = 0
    @State private var elapsed: TimeInterval = 0
    @State private var startedAt: Date?
    @State private var overrides: [InvestmentID: Bool] = [:]
    /// The window is key and shown (`fx-idle-atmosphere .ticker-track`, ADR-257 I3).
    @State private var windowLive = true
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Environment(\.visionTheme) private var theme
    private var quotable: [PortfolioInvestment] {
        model.investments.filter { $0.isActive && $0.priceProvider == .yahoo && !symbol($0).isEmpty }
    }
    private var included: [PortfolioInvestment] { quotable.filter { overrides[$0.id] ?? ($0.showInTicker != false) } }
    private var active: Bool {
        visible && scenePhase == .active && model.isOnline && !UserPresence.shared.isAway
    }
    /// The tape holds with the aurora: on an idle window and behind an open modal
    /// (`fx-idle-atmosphere` and `fx-modal-open .ticker-track`, ADR-255, ADR-257), and resumes in place.
    private var moving: Bool {
        active && !hovered && !reducedMotion && windowLive && !VisionModalRegistry.shared.isOpen
    }
    private var quoted: [(PortfolioInvestment, PortfolioQuote)] {
        included.compactMap { investment in
            guard let quote = model.quotes.first(where: { $0.symbol.uppercased() == symbol(investment) }),
                quote.price != nil
            else { return nil }
            return (investment, quote)
        }
    }

    /// The bar's text when the tape is empty for a reason worth saying: every holding hidden
    /// (the manage menu fixes that) or offline. While quotes load the bar stays quiet.
    private var placeholder: String? {
        if included.isEmpty { return shell.strings.t("portfolio.ticker.allHidden") }
        if !model.isOnline { return shell.strings.t("portfolio.ticker.offline") }
        return nil
    }

    var body: some View {
        if !quotable.isEmpty {
            HStack(spacing: 0) {
                Group {
                    if quoted.isEmpty {
                        Text(placeholder ?? "")
                            .font(.footnote).foregroundStyle(theme.secondaryLabel).padding(.horizontal, 20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if reducedMotion {
                        ScrollView(.horizontal) { tape }.scrollIndicators(.hidden)
                    } else {
                        marquee
                    }
                }
                // `min-h-[2.625rem]`.
                .frame(minHeight: 42)
                // `.ticker-mask:hover .ticker-track`: hover-to-read pauses the tape, not the manage button.
                .onHover { hovered = $0 }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(shell.strings.t("portfolio.ticker.aria"))
                // `border-l border-border/40 px-1`.
                Rectangle().fill(theme.border.opacity(0.4)).frame(width: 1)
                Button {
                    manager = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .buttonStyle(.vision(.ghost, size: .iconSm)).padding(.horizontal, 4)
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityLabel(shell.strings.t("portfolio.ticker.manage"))
                .visionTooltip(shell.strings.t("portfolio.ticker.manage"))
                .popover(isPresented: $manager) { management }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            // `card-material material-host … border border-border/60 liquid-glass`: the regular glass
            // material with its elevation-2 shadows, not a Card. In dark mode `.dark .liquid-glass`
            // (two classes) outranks the `border-border/60` utility; in light mode the utility's
            // frame is used (inference: the cascade order of the two single-class rules).
            .background(
                VisionGlassBoxBackground(
                    material: .regular, frame: theme.isDark ? nil : theme.border.opacity(0.6)))
            .background { WindowLivenessProbe { windowLive = $0 } }
            .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
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

    /// `.ticker-track`: the tape and enough copies of it to cover the bar, sliding left by one
    /// tape width every `max(24, 4.5 × tiles)` seconds, so the speed does not depend on the
    /// number of holdings. The tiles keep their natural widths, as on the web; the tape's width
    /// is measured once per set of quotes and only the offset changes per frame.
    private var marquee: some View {
        GeometryReader { geometry in
            let duration = max(24, Double(quoted.count) * 4.5)
            let copies = tapeWidth > 0 ? max(2, Int((geometry.size.width / tapeWidth).rounded(.up)) + 1) : 2
            let strip = HStack(spacing: 0) {
                ForEach(0..<copies, id: \.self) { index in
                    tape
                        .accessibilityHidden(index > 0)
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                            if index == 0, tapeWidth != width { tapeWidth = width }
                        }
                }
            }
            .fixedSize()
            TimelineView(.animation(minimumInterval: 1 / 30, paused: !moving)) { timeline in
                let time = elapsed + (startedAt.map { timeline.date.timeIntervalSince($0) } ?? 0)
                strip
                    .offset(x: -tapeWidth * CGFloat(time.truncatingRemainder(dividingBy: duration) / duration))
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
            }
        }
        .clipped()
        // `.ticker-mask`: the tiles fade in and out over the outer 4 % at each edge.
        .mask {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0), .init(color: .black, location: 0.04),
                    .init(color: .black, location: 0.96), .init(color: .clear, location: 1),
                ], startPoint: .leading, endPoint: .trailing)
        }
    }

    /// One pass of the tape: `border-r border-border/40 px-5 py-2.5` tiles of symbol, price and
    /// the day's change.
    private var tape: some View {
        HStack(spacing: 0) {
            ForEach(quoted, id: \.0.id) { investment, quote in
                HStack(spacing: 8) {
                    PortfolioInlineDisclosure(label: investment.symbol ?? quote.symbol, explanation: investment.name)
                        .font(.body.monospaced().weight(.medium))
                    if let price = quote.price {
                        Text(
                            ResearchMoney.text(
                                price, currency: quote.currency, locale: shell.settings.numberFormat.locale,
                                fractionDigits: shell.settings.showDecimalPlaces))
                            .monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    }
                    // A quote without a change counts as flat and up, as on the web.
                    let change = quote.changePercent ?? 0
                    HStack(spacing: 2) {
                        Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 11, weight: .medium)).accessibilityHidden(true)
                        Text(signedPercent(change)).fontWeight(.medium).monospacedDigit()
                    }
                    .foregroundStyle(change >= 0 ? theme.gain : theme.loss)
                }
                .font(.body)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 20).padding(.vertical, 10)
                .overlay(alignment: .trailing) { Rectangle().fill(theme.border.opacity(0.4)).frame(width: 1) }
                .accessibilityElement(children: .combine)
            }
        }
    }
    /// `TickerManager`: a `w-72` popover with a bordered header and one switch per holding.
    private var management: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(shell.strings.t("portfolio.ticker.manageTitle")).font(.body.weight(.medium))
                Text(
                    shell.strings.t(
                        "portfolio.ticker.manageCount",
                        ["shown": String(included.count), "total": String(quotable.count)])
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            Rectangle().fill(theme.border.opacity(0.6)).frame(height: 1)
            // `max-h-72 overflow-y-auto`: a long list scrolls inside the popover.
            if quotable.count > 7 {
                ScrollView { managementRows }.frame(height: 288)
            } else {
                managementRows
            }
        }
        .frame(width: 288)
    }
    private var managementRows: some View {
        VStack(spacing: 0) {
            ForEach(quotable) { investment in
                HStack(spacing: 12) {
                    HStack(spacing: 8) {
                        if let symbol = investment.symbol, !symbol.isEmpty {
                            Text(symbol).font(.caption.monospaced().weight(.medium))
                        }
                        Text(investment.name).font(.footnote).foregroundStyle(theme.secondaryLabel)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
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
                    ) { EmptyView() }
                    .labelsHidden()
                    .toggleStyle(.visionSwitch)
                    .accessibilityLabel(investment.name)
                    .disabled(editing.isMutating)
                }
                .padding(8)
            }
        }
        .padding(6)
    }

    private func symbol(_ investment: PortfolioInvestment) -> String {
        // `price_provider_id || symbol`: an empty provider id falls back to the symbol, as in
        // `PortfolioModel.quoteSymbols`, so the tiles find the quotes the model fetched.
        (investment.priceProviderId.flatMap { $0.isEmpty ? nil : $0 } ?? investment.symbol ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }
    private func signedPercent(_ value: Decimal) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, digits: 2, locale: shell.settings.numberFormat.locale)
    }
}

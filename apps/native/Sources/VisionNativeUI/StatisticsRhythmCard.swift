import SwiftUI
import VisionNativeCore

/// `MonthlyRhythm` (apps/frontend/src/features/statistics/MonthlyRhythm.tsx): the scrubbed
/// month's net beside a strip of one net bar per month, then best month, worst month and
/// months in the black. Hovering or arrowing through the strip picks the month.
struct StatisticsRhythmCard: View {
    let snapshot: StatisticsSnapshot
    let currentPeriod: String
    let currency: String
    let settings: NativeAppSettings
    let strings: any Localizing
    let isPrinting: Bool
    @Binding var selection: String?
    let periodLabel: (String) -> String
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme

    private func net(_ month: InsightMonth) -> Decimal { month.total_income - abs(month.total_spending) }
    private func label(_ period: String) -> String {
        periodLabel(period) + (period == currentPeriod ? " " + strings.t("statsPage.rhythm.soFar") : "")
    }

    var body: some View {
        let months = snapshot.monthly.orderedMonths
        if let latest = months.last, let extremes = snapshot.extremes(currentPeriod: currentPeriod) {
            let scrubIndex = selection.flatMap { id in months.firstIndex { $0.id == id } }
            let shownIndex = scrubIndex ?? months.count - 1
            let shown = months[shownIndex]
            let previous = shownIndex > 0 ? months[shownIndex - 1] : nil
            AdminCard(padding: VisionPageLayout.padding) {
                HStack(alignment: .top, spacing: 40) {
                    headline(shown: shown, previous: previous, months: months)
                        .frame(minWidth: 240, maxWidth: 304, alignment: .leading)
                    strip(months: months, scrubIndex: scrubIndex, first: months[0], latest: latest)
                        .frame(maxWidth: .infinity)
                }
                Divider().opacity(0.5).padding(.top, 8)
                HStack(alignment: .top, spacing: 16) {
                    fact(
                        strings.t("statsPage.rhythm.strongest"), value: signedMoney(net(extremes.best)),
                        color: net(extremes.best) >= 0 ? theme.gain : theme.loss, hint: label(extremes.best.id))
                    fact(
                        strings.t("statsPage.rhythm.toughest"), value: signedMoney(net(extremes.worst)),
                        color: net(extremes.worst) >= 0 ? theme.gain : theme.loss, hint: label(extremes.worst.id))
                    fact(
                        strings.t("statsPage.rhythm.inTheBlack"), value: "\(extremes.positive)/\(months.count)",
                        color: theme.primary, hint: strings.t("statsPage.rhythm.inTheBlackHint"))
                }
            }
        }
    }

    private func headline(shown: InsightMonth, previous: InsightMonth?, months: [InsightMonth]) -> some View {
        let value = net(shown)
        return VStack(alignment: .leading, spacing: 0) {
            Text(strings.t("statsPage.rhythm.title"))
                .font(.callout.weight(.semibold))
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isHeader)
            HStack(alignment: .lastTextBaseline, spacing: 12) {
                heroValue(value)
                if let previous {
                    let delta = value - net(previous)
                    DeltaPill(delta, label: MoneyText.text(delta, currency: currency, settings: settings))
                }
            }
            .padding(.top, 12)
            (Text(strings.t("statsPage.rhythm.netIn", ["month": label(shown.id)]))
                + Text(previous == nil ? "" : " · " + strings.t("statsPage.rhythm.vsPrevious"))
                .foregroundStyle(theme.tertiaryLabel))
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
                .padding(.top, 6)
            Divider().opacity(0.5).padding(.top, 20)
            HStack(alignment: .firstTextBaseline, spacing: 32) {
                figure(
                    strings.t("statsPage.rhythm.typicalIn"),
                    value: money(snapshot.totalIncome / Decimal(max(1, months.count))), color: theme.gain)
                figure(strings.t("statsPage.rhythm.typicalOut"), value: money(snapshot.averageSpending), color: theme.loss)
            }
            .padding(.top, 16)
        }
    }

    private func strip(months: [InsightMonth], scrubIndex: Int?, first: InsightMonth, latest: InsightMonth)
        -> some View
    {
        let maxAbs = max(months.map { abs(NSDecimalNumber(decimal: net($0)).doubleValue) }.max() ?? 1, 1)
        let scrubbing = scrubIndex != nil
        return VStack(spacing: 8) {
            GeometryReader { geometry in
                let half = geometry.size.height / 2
                ZStack(alignment: .topLeading) {
                    Rectangle().fill(theme.foreground.opacity(0.15)).frame(height: 1).offset(y: half)
                    HStack(alignment: .center, spacing: 3) {
                        ForEach(Array(months.enumerated()), id: \.element.id) { index, month in
                            let amount = NSDecimalNumber(decimal: net(month)).doubleValue
                            let height = max(abs(amount) / maxAbs * half, half * 0.03)
                            let active = scrubIndex == index
                            let opacity = active || (!scrubbing && index == months.count - 1) ? 1 : scrubbing ? 0.35 : 0.7
                            ZStack {
                                VStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    if amount >= 0 {
                                        UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3)
                                            .fill(theme.gain).frame(height: height)
                                    }
                                }
                                .frame(height: half)
                                .frame(maxHeight: .infinity, alignment: .top)
                                VStack(spacing: 0) {
                                    if amount < 0 {
                                        UnevenRoundedRectangle(bottomLeadingRadius: 3, bottomTrailingRadius: 3)
                                            .fill(theme.loss).frame(height: height)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .frame(height: half)
                                .frame(maxHeight: .infinity, alignment: .bottom)
                            }
                            .opacity(opacity)
                            .overlay {
                                if active {
                                    RoundedRectangle(cornerRadius: 4)
                                        .strokeBorder(theme.primary.opacity(0.45), lineWidth: 1)
                                        .padding(.horizontal, -1)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                            .onHover { inside in
                                if inside, !isPrinting { selection = month.id }
                            }
                            .animation(.easeOut(duration: 0.12), value: opacity)
                        }
                    }
                }
            }
            .frame(height: 128)
            .onHover { inside in
                if !inside, !focused { selection = nil }
            }
            HStack {
                Text(label(first.id))
                Spacer()
                Text(scrubIndex.map { label(months[$0].id) } ?? strings.t("statsPage.rhythm.scrubHint"))
                    .fontWeight(.medium)
                    .foregroundStyle(scrubbing ? theme.foreground : theme.secondaryLabel)
                Spacer()
                Text(label(latest.id))
            }
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(theme.tertiaryLabel)
        }
        .focusable(!isPrinting)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(phases: .down) { press in step(press, months: months) }
        .onChange(of: focused) { _, isFocused in
            if !isFocused { selection = nil }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(strings.t("statsPage.rhythm.stripAria", ["n": String(months.count)]))
        .accessibilityValue(scrubIndex.map { label(months[$0].id) } ?? label(latest.id))
    }

    private func step(_ press: KeyPress, months: [InsightMonth]) -> KeyPress.Result {
        guard !months.isEmpty else { return .ignored }
        let current = selection.flatMap { id in months.firstIndex { $0.id == id } } ?? months.count - 1
        switch press.key {
        case .leftArrow: selection = months[max(0, current - 1)].id
        case .rightArrow: selection = months[min(months.count - 1, current + 1)].id
        case .home: selection = months[0].id
        case .end: selection = months[months.count - 1].id
        case .escape: selection = nil
        default: return .ignored
        }
        return .handled
    }

    @ViewBuilder private func heroValue(_ value: Decimal) -> some View {
        let text = MoneyText.text(value, currency: currency, settings: settings, signed: false)
        let separator = settings.numberFormat.locale.decimalSeparator?.first
        let color = value >= 0 ? theme.gain : theme.loss
        Group {
            if isPrinting {
                MoneyText.styled(text, decimalSeparator: separator, color: color).monospacedDigit()
            } else {
                RollingNumber(value: text, decimalSeparator: separator)
            }
        }
        .font(.visionLargeTitle)
        .foregroundStyle(color)
        .lineLimit(1)
    }

    private func eyebrow(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .tracking(1.3)
            .textCase(.uppercase)
            .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
    }

    private func figure(_ title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            eyebrow(title)
            MoneyText.styled(value, decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: color)
                .font(.headline)
                .monospacedDigit()
        }
    }

    private func fact(_ title: String, value: String, color: Color, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            eyebrow(title)
            MoneyText.styled(value, decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: color)
                .font(.visionTitle3)
                .monospacedDigit()
            Text(hint)
                .font(.caption)
                .foregroundStyle(theme.tertiaryLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: currency, settings: settings, signed: false)
    }
    private func signedMoney(_ value: Decimal) -> String {
        MoneyText.text(value, currency: currency, settings: settings, signed: true)
    }
}

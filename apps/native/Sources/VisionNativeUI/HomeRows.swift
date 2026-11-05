import SwiftUI
import VisionNativeCore

/// `ListRow` (components/ui/list.tsx) for Home's inset lists: an optional leading glyph, the
/// title with its footnote subtitle, a signed amount at the trailing edge and, for a row that
/// leads somewhere, a disclosure chevron. A row with an `action` is a button with the faint
/// hover fill; without one it is plain content.
struct HomeInsetRow<Leading: View>: View {
    let title: String
    var subtitle: String?
    var amount: (Decimal, CurrencyCode)?
    let settings: NativeAppSettings
    var chevron = false
    var action: (() -> Void)?
    @ViewBuilder var leading: () -> Leading
    @Environment(\.visionTheme) private var theme
    @State private var hovering = false

    var body: some View {
        if let action {
            Button(action: action) { rowContent }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
        } else {
            rowContent
        }
    }

    private var rowContent: some View {
        HStack(alignment: .center, spacing: 12) {
            leading()
            VStack(alignment: .leading, spacing: 0) {
                Text(title).lineLimit(1).foregroundStyle(theme.foreground)
                if let subtitle {
                    Text(subtitle).font(.footnote).lineLimit(1).foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer(minLength: 8)
            if let amount {
                MoneyText(amount: amount.0, currency: amount.1, settings: settings, signed: true, colored: true)
                    .fontWeight(.medium)
            }
            if chevron {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.tertiaryLabel).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(theme.foreground.opacity(action != nil && hovering ? 0.04 : 0))
        .contentShape(Rectangle())
    }
}

extension HomeInsetRow where Leading == EmptyView {
    init(
        title: String, subtitle: String? = nil, amount: (Decimal, CurrencyCode)? = nil, settings: NativeAppSettings,
        chevron: Bool = false, action: (() -> Void)? = nil
    ) {
        self.init(
            title: title, subtitle: subtitle, amount: amount, settings: settings, chevron: chevron, action: action,
            leading: { EmptyView() })
    }
}

/// The 28 pt glyph slot of a `ListRow` (`text-label-secondary`, 18 pt icon).
struct HomeInsetGlyph: View {
    let symbol: String
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15))
            .foregroundStyle(theme.secondaryLabel)
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }
}

/// Recent transactions' leading dot: the category's chart colour (`getCategoryChartColor`), or
/// the muted grey for an uncategorised row.
struct HomeCategoryDot: View {
    let category: String
    let isCategorised: Bool
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }

    private var color: Color {
        guard isCategorised else { return Color(token: theme.palette.mutedForeground).opacity(0.4) }
        guard let index = CategoryColor.index(category) else { return Color(token: theme.palette.mutedForeground) }
        let colors = theme.chartColors
        return colors[index % max(colors.count, 1)]
    }
}

/// MonthlyTrendsChart's two total tiles: a tinted rounded surface with a dot, the label and the
/// figure in the gain or loss colour (`bg-gain/10`, `bg-loss/10`).
struct HomeTotalTile: View {
    let label: String
    let amount: Decimal
    let currency: CurrencyCode
    let settings: NativeAppSettings
    let tint: Color
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(tint).frame(width: 10, height: 10).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(label).font(.footnote).foregroundStyle(theme.secondaryLabel)
                MoneyText.styled(
                    MoneyText.text(amount, currency: currency, settings: settings, signed: false),
                    decimalSeparator: settings.numberFormat.locale.decimalSeparator?.first, color: tint
                )
                .font(.headline).monospacedDigit().lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous).fill(tint.opacity(0.1))
        )
        .accessibilityElement(children: .combine)
    }
}

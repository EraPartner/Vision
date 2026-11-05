import SwiftUI
import VisionNativeCore

/// The Home-only presentation; the shared model also maintains the app-wide dock count.
public struct ShellUpcomingPaymentsBanner: View {
    let model: ShellUpcomingPaymentsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: ShellUpcomingPaymentsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    /// `UpcomingPaymentsNotification`: an `Alert` with `border-primary/30 bg-primary/5`, the
    /// calendar glyph at the leading edge, the count as a ghost button with a turning chevron,
    /// the rows indented under the title and the dismiss-all button in the top-right corner.
    public var body: some View {
        if model.shouldShow {
            let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "calendar.badge.clock")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.primary)
                    .frame(width: 16, height: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        withAnimation(.easeOut(duration: DesignTokens.Duration.fast)) { model.expanded.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            Text(shell.strings.tc("upcoming.count", model.visibleUpcoming.count))
                                .font(.headline)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .rotationEffect(.degrees(model.expanded ? 180 : 0))
                                .accessibilityHidden(true)
                        }
                        .foregroundStyle(theme.primary)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if model.expanded {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(model.displayedUpcoming, id: \.id) { row in payment(row) }
                            if model.visibleUpcoming.count > 5 {
                                Text(shell.strings.t("upcoming.more", ["n": String(model.visibleUpcoming.count - 5)]))
                                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
                            }
                            Button(shell.strings.t("upcoming.viewAllLink")) { shell.navigate(to: "/planned") }
                                .buttonStyle(.visionLink).font(.footnote.weight(.medium)).padding(.top, 6)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                closeButton(label: shell.strings.t("upcoming.dismissAll")) { model.dismissAll() }
            }
            .padding(.leading, 16)
            .padding(.trailing, 10)
            .padding(.vertical, 10)
            .background(shape.fill(theme.primary.opacity(0.05)))
            .overlay(shape.strokeBorder(theme.primary.opacity(0.3), lineWidth: 1))
            .accessibilityElement(children: .contain)
        }
    }

    /// The web's ghost `icon-sm` button: 28 pt, secondary glyph, a faint hover fill.
    private func closeButton(label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.secondaryLabel)
        .help(label)
        .accessibilityLabel(label)
    }

    private func payment(_ row: OpenAPI.PlannedTransaction) -> some View {
        let title =
            [row.memo, row.recipientName].compactMap { $0 }.first { !$0.isEmpty }
            ?? shell.strings.t("upcoming.unnamed")
        let currency = row.currency ?? shell.settings.defaultCurrency
        return HStack(spacing: 8) {
            Text(verbatim: title).fontWeight(.medium)
            Spacer(minLength: 0)
            Text(VisionFormat.appDate(row.plannedDate, format: shell.settings.dateFormat))
                .foregroundStyle(theme.secondaryLabel)
            Text(
                VisionFormat.currency(
                    abs(row.amount), code: currency, locale: shell.settings.numberFormat.locale,
                    fractionDigits: shell.settings.showDecimalPlaces)
            )
            .fontWeight(.medium).monospacedDigit()
            closeButton(label: shell.strings.t("upcoming.dismissPayment", ["name": title])) { model.dismiss(row) }
        }
    }
}

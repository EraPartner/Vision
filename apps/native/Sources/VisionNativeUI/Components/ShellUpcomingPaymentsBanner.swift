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

    public var body: some View {
        if model.shouldShow {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "calendar.badge.clock").foregroundStyle(theme.accent).accessibilityHidden(true)
                DisclosureGroup(
                    isExpanded: Binding(get: { model.expanded }, set: { model.expanded = $0 })
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(model.displayedUpcoming, id: \.id) { row in payment(row) }
                        if model.visibleUpcoming.count > 5 {
                            Text(shell.strings.t("upcoming.more", ["n": String(model.visibleUpcoming.count - 5)]))
                                .font(.footnote).foregroundStyle(theme.secondaryLabel)
                        }
                        Button(shell.strings.t("upcoming.viewAllLink")) { shell.navigate(to: "/planned") }
                            .buttonStyle(.borderless).font(.footnote).padding(.top, 4)
                    }.padding(.top, 8)
                } label: {
                    Text(shell.strings.tc("upcoming.count", model.visibleUpcoming.count))
                        .font(.headline).foregroundStyle(theme.accent)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    model.dismissAll()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless).foregroundStyle(theme.secondaryLabel)
                .accessibilityLabel(shell.strings.t("upcoming.dismissAll"))
            }
            .padding(14)
            .background(theme.accent.opacity(0.05), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(theme.accent.opacity(0.3)))
            .accessibilityElement(children: .contain)
        }
    }

    private func payment(_ row: OpenAPI.PlannedTransaction) -> some View {
        let title =
            [row.memo, row.recipientName].compactMap { $0 }.first { !$0.isEmpty }
            ?? shell.strings.t("upcoming.unnamed")
        let currency = row.currency.flatMap { $0.isEmpty ? nil : $0 } ?? shell.settings.defaultCurrency
        return HStack(spacing: 12) {
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
            Button {
                model.dismiss(row)
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless).foregroundStyle(theme.secondaryLabel)
            .help(shell.strings.t("upcoming.dismissPayment", ["name": title]))
            .accessibilityLabel(shell.strings.t("upcoming.dismissPayment", ["name": title]))
        }
    }
}

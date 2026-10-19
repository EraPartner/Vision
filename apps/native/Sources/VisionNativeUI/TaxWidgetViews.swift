import SwiftUI
import VisionNativeCore

struct TaxCard<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    /// `CardTitle variant="sm"` (type-title-3).
    var small = false
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title).font(small ? Font.visionTitle3 : .visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
            }
            if let description { Text(description).foregroundStyle(theme.secondaryLabel) }
            content()
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
}

struct TaxMoneyRow: View {
    let title: String
    let amount: Decimal?
    let shell: NativeShellModel
    var signed = false
    var strong = false
    var tone: Color? = nil
    /// TaxComputationFlow stages roll their figures.
    var rolling = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let text =
            amount.map {
                MoneyText.text($0, currency: shell.settings.defaultCurrency, settings: shell.settings, signed: signed)
            } ?? "—"
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if rolling {
                    RollingNumber(
                        value: text, decimalSeparator: shell.settings.numberFormat.locale.decimalSeparator?.first)
                } else {
                    MoneyText.styled(
                        text, decimalSeparator: shell.settings.numberFormat.locale.decimalSeparator?.first,
                        color: tone ?? theme.foreground
                    ).monospacedDigit()
                }
            }
            .foregroundStyle(tone ?? theme.foreground)
        }.font(strong ? .headline : .body).padding(.vertical, 3)
            .accessibilityElement(children: .combine)
    }
}

struct TaxWidgetsSheet: View {
    let model: TaxWidgetsModel
    let strings: any Localizing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: strings.t("widgets.title"), description: strings.t("widgets.description"),
                closeLabel: strings.t("common.close"), onClose: { dismiss() }
            )
            .keyboardShortcut(.cancelAction)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(TaxWidgetsModel.definitions) { widget in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(strings.t(widget.labelKey)).foregroundStyle(theme.foreground)
                            if let key = widget.descriptionKey {
                                Text(strings.t(key)).font(.footnote).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                        Spacer(minLength: 8)
                        Toggle(
                            strings.t(widget.labelKey),
                            isOn: Binding(
                                get: { model.isVisible(widget.id) },
                                set: { value in Task { await model.setVisible(widget.id, value) } })
                        )
                        .labelsHidden().toggleStyle(.switch).controlSize(.small)
                        .disabled(model.isSaving || !model.isLoaded)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    if widget.id != TaxWidgetsModel.definitions.last?.id { Divider().padding(.leading, 16) }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous).fill(theme.card))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                    .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
            if let error = model.error {
                Text(error).foregroundStyle(theme.destructive)
                if !model.isLoaded {
                    Button(strings.t("common.retry")) { Task { await model.load() } }.buttonStyle(.visionOutline)
                }
            }
            HStack(spacing: 8) {
                Group {
                    Button(strings.t("widgets.showAll")) { Task { await model.setAll(true) } }
                    Button(strings.t("widgets.hideAll")) { Task { await model.setAll(false) } }
                }.disabled(model.isSaving || !model.isLoaded)
                Spacer(minLength: 0)
                Button(strings.t("widgets.reset"), systemImage: "arrow.counterclockwise") {
                    Task { await model.reset() }
                }.disabled(model.isSaving || !model.isLoaded)
            }
            .buttonStyle(.visionOutline)
        }.visionDialogPadding().frame(width: 448)
    }
}

struct TaxRulesView: View {
    let strings: any Localizing
    @State private var expanded: Bool
    private let onExpandedChange: ((Bool) -> Void)?
    init(strings: any Localizing, initiallyExpanded: Bool = false, onExpandedChange: ((Bool) -> Void)? = nil) {
        self.strings = strings
        self._expanded = State(initialValue: initiallyExpanded)
        self.onExpandedChange = onExpandedChange
    }
    @Environment(\.visionTheme) private var theme
    private let sections: [(String, [String])] = [
        ("federalBracketsTitle", ["federalBrackets.1", "federalBrackets.2", "federalBrackets.3", "federalBrackets.4"]),
        ("socialSecurityTitle", ["ss.employee", "ss.special", "ss.employer", "ss.selfEmployed"]),
        ("investmentTitle", ["investment.savings", "investment.dividends", "investment.foreign"]),
        ("otherTaxesTitle", ["other.vat", "other.tob", "other.property"]),
    ]
    var body: some View {
        TaxCard {
            VisionDisclosure(
                title: strings.t("tax.rules.title"),
                isExpanded: Binding(
                    get: { expanded },
                    set: { value in
                        expanded = value
                        onExpandedChange?(value)
                    })
            ) {
                VStack(alignment: .leading, spacing: 14) {
                    Text(strings.t("tax.rules.description")).foregroundStyle(theme.secondaryLabel)
                    ForEach(sections, id: \.0) { title, keys in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(strings.t("tax.rules." + title)).font(.headline)
                            ForEach(keys, id: \.self) { key in Text("• " + strings.t("tax.rules." + key)) }
                        }
                    }
                }.padding(.top, 12)
            }
        }.onAppear { onExpandedChange?(expanded) }
            .onDisappear { onExpandedChange?(false) }
    }
}

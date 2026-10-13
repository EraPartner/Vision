import SwiftUI
import VisionNativeCore

struct TaxCard<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title { Text(title).font(.headline).accessibilityAddTraits(.isHeader) }
            if let description { Text(description).font(.callout).foregroundStyle(theme.secondaryLabel) }
            content()
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.card).stroke(theme.border.opacity(0.6)))
    }
}

struct TaxMoneyRow: View {
    let title: String
    let amount: Decimal?
    let shell: NativeShellModel
    var signed = false
    var strong = false
    var tone: Color? = nil
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
            Text(
                amount.map {
                    MoneyText.text(
                        $0, currency: shell.settings.defaultCurrency,
                        settings: shell.settings, signed: signed)
                } ?? "—"
            )
            .monospacedDigit().foregroundStyle(tone ?? theme.foreground)
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
        VStack(alignment: .leading, spacing: 16) {
            Text(strings.t("widgets.title")).font(.title2).accessibilityAddTraits(.isHeader)
            Text(strings.t("widgets.description")).foregroundStyle(theme.secondaryLabel)
            ForEach(TaxWidgetsModel.definitions) { widget in
                Toggle(
                    strings.t(widget.labelKey),
                    isOn: Binding(
                        get: { model.isVisible(widget.id) },
                        set: { value in Task { await model.setVisible(widget.id, value) } })
                )
                .disabled(model.isSaving || !model.isLoaded)
            }
            if let error = model.error {
                Text(error).foregroundStyle(theme.destructive)
                if !model.isLoaded { Button(strings.t("common.retry")) { Task { await model.load() } } }
            }
            HStack {
                Group {
                    Button(strings.t("widgets.showAll")) { Task { await model.setAll(true) } }
                    Button(strings.t("widgets.hideAll")) { Task { await model.setAll(false) } }
                    Button(strings.t("widgets.reset")) { Task { await model.reset() } }
                }.disabled(model.isSaving || !model.isLoaded)
                Spacer()
                Button(strings.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }.padding(24).frame(width: 540)
    }
}

struct TaxRulesView: View {
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    private let sections: [(String, [String])] = [
        ("federalBracketsTitle", ["federalBrackets.1", "federalBrackets.2", "federalBrackets.3", "federalBrackets.4"]),
        ("socialSecurityTitle", ["ss.employee", "ss.special", "ss.employer", "ss.selfEmployed"]),
        ("investmentTitle", ["investment.savings", "investment.dividends", "investment.foreign"]),
        ("otherTaxesTitle", ["other.vat", "other.tob", "other.property"]),
    ]
    var body: some View {
        TaxCard {
            DisclosureGroup(strings.t("tax.rules.title")) {
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
        }
    }
}

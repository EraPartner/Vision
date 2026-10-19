import SwiftUI
import VisionNativeCore

struct PortfolioTaxAdjustmentsSheet: View {
    let model: PortfolioTaxModel
    let shell: NativeShellModel
    @FocusState private var interestFocused: Int?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 20) {
                VisionDialogHeader(
                    title: strings.t(
                        "tax.manualAdjustmentsTitle", ["year": model.adjustmentYear.map(String.init) ?? "—"]),
                    description: strings.t("tax.manualAdjustmentsDesc"),
                    closeLabel: strings.t("common.close"), onClose: { model.closeAdjustments() }
                )
                .keyboardShortcut(.cancelAction)
                HStack(alignment: .top, spacing: 24) {
                    total("tax.totalTaxesPaid", value: model.draftTotals.taxes)
                    total("tax.totalFeesPaid", value: model.draftTotals.fees)
                }
            }.padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 20)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(model.draftRows) { row in
                                investment(row).padding(.horizontal, 16).padding(.vertical, 12).id(row.id)
                                if row.id != model.draftRows.last?.id { Divider().padding(.leading, 16) }
                            }
                        }
                        .background(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                                .fill(theme.card))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                                .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
                        if let error = model.adjustmentsError {
                            Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 24)
                }
                .onChange(of: model.focusInvestmentID) { _, id in
                    guard let id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    interestFocused = id
                }
            }
            Divider()
            VisionDialogFooter {
                if model.isSavingAdjustments { ProgressView().controlSize(.small) }
                Button(strings.t("common.cancel")) { model.closeAdjustments() }.buttonStyle(.visionOutline)
                Button(strings.t("tax.manualAdjustmentsSave")) { save() }
                    .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 24).padding(.vertical, 16)
        }
        .frame(width: 768, height: 720)
        .disabled(model.isSavingAdjustments)
        .interactiveDismissDisabled(model.isSavingAdjustments)
        .onSubmit { save() }
    }

    private func investment(_ row: PortfolioTaxAdjustmentDraft) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(row.name).fontWeight(.medium).foregroundStyle(theme.foreground)
                if let symbol = row.symbol {
                    Text(symbol).font(.footnote.monospaced()).foregroundStyle(theme.secondaryLabel)
                }
                VisionBadge(text: strings.t("portfolio.assetClass." + row.assetClass), small: true)
            }
            HStack(alignment: .top, spacing: 12) {
                amount("tax.taxes", row: row, path: \.taxes)
                amount("tax.fees", row: row, path: \.fees)
            }
            if row.showsETFStructure || row.showsReynders {
                DisclosureGroup(
                    strings.t("tax.treatmentOptions"), isExpanded: binding(row.id, \.treatmentExpanded, default: false)
                ) {
                    VStack(alignment: .leading, spacing: 14) {
                        if row.showsETFStructure {
                            fieldLabel("tax.etfStructure")
                            Picker(
                                strings.t("tax.etfStructure"),
                                selection: Binding(
                                    get: { draft(row.id)?.etfStructure ?? .accumulating },
                                    set: { value in model.updateDraft(id: row.id) { $0.etfStructure = value } })
                            ) {
                                ForEach(PortfolioTaxETFStructure.allCases, id: \.self) { value in
                                    Text(strings.t("tax.etfStructure." + value.rawValue)).tag(value)
                                }
                            }.labelsHidden().frame(maxWidth: 320, alignment: .leading)
                            .accessibilityLabel(strings.t("tax.etfStructure") + ": " + row.name)
                            Text(strings.t("tax.etfStructure.desc")).font(.footnote).foregroundStyle(
                                theme.secondaryLabel)
                        }
                        if row.showsReynders {
                            fieldLabel("tax.subjectToReynders")
                            Picker(
                                strings.t("tax.subjectToReynders"),
                                selection: binding(row.id, \.reynders, default: .auto)
                            ) {
                                ForEach(PortfolioTaxReyndersChoice.allCases, id: \.self) { value in
                                    Text(strings.t("tax.subjectToReynders." + value.rawValue)).tag(value)
                                }
                            }.labelsHidden().frame(maxWidth: 320, alignment: .leading)
                            .accessibilityLabel(strings.t("tax.subjectToReynders") + ": " + row.name)
                            Text(strings.t("tax.subjectToReynders.desc")).font(.footnote).foregroundStyle(
                                theme.secondaryLabel)
                            if row.reyndersResolved {
                                VStack(alignment: .leading, spacing: 6) {
                                    fieldLabel("tax.reyndersInterestPortion")
                                    TextField("100", text: binding(row.id, \.interestPortion, default: ""))
                                        .textFieldStyle(.vision).focused($interestFocused, equals: row.id)
                                        .accessibilityLabel(strings.t("tax.reyndersInterestPortion") + ": " + row.name)
                                    if row.hasInvalidInterestPortion {
                                        Text(strings.t("addInv.error.numberInvalid") + " (0–100)")
                                            .font(.footnote).foregroundStyle(theme.destructive)
                                    }
                                    Text(strings.t("tax.reyndersInterestPortion.desc")).font(.footnote).foregroundStyle(
                                        theme.secondaryLabel)
                                }
                            }
                        }
                    }.padding(.top, 12)
                }.accessibilityLabel(strings.t("tax.treatmentOptions") + ": " + row.name)
            }
        }
        .accessibilityElement(children: .contain)
    }
    private func amount(
        _ title: String, row: PortfolioTaxAdjustmentDraft, path: WritableKeyPath<PortfolioTaxAdjustmentDraft, String>
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(title)
            TextField(
                LocaleNumber.editable(0, format: shell.settings.numberFormat), text: binding(row.id, path, default: "")
            )
            .textFieldStyle(.vision).accessibilityLabel(strings.t(title) + ": " + row.name)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    /// The web `Label` above an input: subheadline, medium weight, foreground.
    private func fieldLabel(_ key: String) -> some View {
        Text(strings.t(key)).font(.subheadline.weight(.medium)).foregroundStyle(theme.foreground)
    }
    private func total(_ title: String, value: Decimal) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(title)).font(.caption).foregroundStyle(theme.tertiaryLabel)
            Text(MoneyText.text(value, currency: shell.settings.defaultCurrency, settings: shell.settings))
                .font(.visionCardTitle).monospacedDigit().foregroundStyle(theme.loss)
        }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
    }
    private func draft(_ id: Int) -> PortfolioTaxAdjustmentDraft? { model.draftRows.first { $0.id == id } }
    private func binding<Value>(
        _ id: Int, _ path: WritableKeyPath<PortfolioTaxAdjustmentDraft, Value>, default fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: { draft(id)?[keyPath: path] ?? fallback },
            set: { value in
                model.updateDraft(id: id) { $0[keyPath: path] = value }
            })
    }
    private func save() { Task { await model.saveAdjustments() } }
}

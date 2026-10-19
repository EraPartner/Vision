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
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(
                        strings.t("tax.manualAdjustmentsTitle", ["year": model.adjustmentYear.map(String.init) ?? "—"])
                    )
                    .font(.title2).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button {
                        model.closeAdjustments()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.borderless).accessibilityLabel(strings.t("common.close"))
                    .keyboardShortcut(.cancelAction)
                }
                Text(strings.t("tax.manualAdjustmentsDesc")).font(.callout).foregroundStyle(theme.secondaryLabel)
                HStack(spacing: 40) {
                    total("tax.totalTaxesPaid", value: model.draftTotals.taxes)
                    total("tax.totalFeesPaid", value: model.draftTotals.fees)
                    Spacer()
                }.padding(.top, 6)
            }.padding(24)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(model.draftRows) { row in
                            investment(row).id(row.id)
                            if row.id != model.draftRows.last?.id { Divider() }
                        }
                        if let error = model.adjustmentsError {
                            Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 20)
                }
                .onChange(of: model.focusInvestmentID) { _, id in
                    guard let id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    interestFocused = id
                }
            }
            Divider()
            HStack {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeAdjustments() }.buttonStyle(.visionOutline)
                Button(strings.t("tax.manualAdjustmentsSave")) { save() }
                    .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
                if model.isSavingAdjustments { ProgressView().controlSize(.small) }
            }.padding(20)
        }
        .frame(width: 760, height: 720)
        .disabled(model.isSavingAdjustments)
        .interactiveDismissDisabled(model.isSavingAdjustments)
        .onSubmit { save() }
    }

    private func investment(_ row: PortfolioTaxAdjustmentDraft) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(row.name).fontWeight(.medium)
                if let symbol = row.symbol {
                    Text(symbol).font(.caption.monospaced()).foregroundStyle(theme.secondaryLabel)
                }
                VisionBadge(text: strings.t("portfolio.assetClass." + row.assetClass))
            }
            HStack(spacing: 16) {
                amount("tax.taxes", row: row, path: \.taxes)
                amount("tax.fees", row: row, path: \.fees)
            }
            if row.showsETFStructure || row.showsReynders {
                DisclosureGroup(
                    strings.t("tax.treatmentOptions"), isExpanded: binding(row.id, \.treatmentExpanded, default: false)
                ) {
                    VStack(alignment: .leading, spacing: 14) {
                        if row.showsETFStructure {
                            Picker(
                                strings.t("tax.etfStructure"),
                                selection: Binding(
                                    get: { draft(row.id)?.etfStructure ?? .accumulating },
                                    set: { value in model.updateDraft(id: row.id) { $0.etfStructure = value } })
                            ) {
                                ForEach(PortfolioTaxETFStructure.allCases, id: \.self) { value in
                                    Text(strings.t("tax.etfStructure." + value.rawValue)).tag(value)
                                }
                            }.accessibilityLabel(strings.t("tax.etfStructure") + ": " + row.name)
                            Text(strings.t("tax.etfStructure.desc")).font(.footnote).foregroundStyle(
                                theme.secondaryLabel)
                        }
                        if row.showsReynders {
                            Picker(
                                strings.t("tax.subjectToReynders"),
                                selection: binding(row.id, \.reynders, default: .auto)
                            ) {
                                ForEach(PortfolioTaxReyndersChoice.allCases, id: \.self) { value in
                                    Text(strings.t("tax.subjectToReynders." + value.rawValue)).tag(value)
                                }
                            }.accessibilityLabel(strings.t("tax.subjectToReynders") + ": " + row.name)
                            Text(strings.t("tax.subjectToReynders.desc")).font(.footnote).foregroundStyle(
                                theme.secondaryLabel)
                            if row.reyndersResolved {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(strings.t("tax.reyndersInterestPortion")).font(.callout)
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
            Text(strings.t(title)).font(.callout)
            TextField(
                LocaleNumber.editable(0, format: shell.settings.numberFormat), text: binding(row.id, path, default: "")
            )
            .textFieldStyle(.vision).accessibilityLabel(strings.t(title) + ": " + row.name)
        }
    }
    private func total(_ title: String, value: Decimal) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(title)).font(.caption).foregroundStyle(theme.secondaryLabel)
            Text(MoneyText.text(value, currency: shell.settings.defaultCurrency, settings: shell.settings))
                .font(.title2).monospacedDigit().foregroundStyle(theme.loss)
        }.accessibilityElement(children: .combine)
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

import SwiftUI
import VisionNativeCore

struct PortfolioInvestmentForm: View {
    let model: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var selectingType = false
    @FocusState private var focused: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var draft: PortfolioInvestmentDraft? { model.investmentDraft }
    private var isEditing: Bool { draft?.isEditing ?? false }
    private var typeSelection: Bool { !isEditing && (selectingType || draft?.assetClass.isEmpty == true) }
    private var unitBased: Bool { PortfolioAssetKinds.unitBased(draft?.assetClass ?? "") }
    private var currencies: [String] {
        let choices = ["EUR", "USD", "GBP", "CHF", "SAR", "BTC"]
        guard let current = draft?.currency, !choices.contains(current) else { return choices }
        return choices + [current]
    }
    private func text(_ path: WritableKeyPath<PortfolioInvestmentDraft, String>, field: String = "") -> Binding<
        String
    > {
        Binding(
            get: { draft?[keyPath: path] ?? "" },
            set: {
                model.investmentDraft?[keyPath: path] = PortfolioInvestmentDraft.input($0, field: field)
                model.clearIssue()
            })
    }
    var body: some View {
        VStack(spacing: 0) {
            VisionDialogHeader(
                title: isEditing
                    ? strings.t("invEdit.title")
                    : (typeSelection
                        ? strings.t("addInv.chooseType")
                        : strings.t(
                            "addInv.assetTitle",
                            ["assetClass": strings.t("portfolio.assetClass." + (draft?.assetClass ?? ""))])),
                description: typeSelection ? strings.t("addInv.chooseTypeDesc") : nil,
                closeLabel: strings.t("common.close"), onClose: { model.dismissEditor() }
            )
            .keyboardShortcut(.cancelAction)
            .padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 20)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if typeSelection {
                            ForEach(draft?.allowedAssetClasses ?? [], id: \.self) { value in
                                Button {
                                    model.investmentDraft?.selectAssetClass(value)
                                    selectingType = false
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(strings.t("portfolio.assetClass." + value)).font(.headline)
                                        Text(strings.t("addInv.desc." + value)).font(.callout).foregroundStyle(
                                            theme.secondaryLabel)
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                }.buttonStyle(.visionOutline)
                            }
                        } else {
                            fields
                        }
                        if let error = model.error {
                            Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 24)
                }
                .onChange(of: model.issue) {
                    if let issue = model.issue {
                        withAnimation { proxy.scrollTo(issue.field, anchor: .center) }
                        focused = issue.field
                    }
                }
            }
            Divider()
            HStack(spacing: 8) {
                if !isEditing && !typeSelection && (draft?.allowedAssetClasses.count ?? 0) > 1 {
                    Button(strings.t("addInv.back")) { selectingType = true }.buttonStyle(.visionOutline)
                }
                Spacer(minLength: 0)
                if model.isSaving { ProgressView().controlSize(.small) }
                Button(strings.t("common.cancel")) { model.cancelEditor() }.buttonStyle(.visionOutline)
                if !typeSelection {
                    Button(strings.t(isEditing ? "common.save" : "addInv.create")) { save() }
                        .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
                }
            }
            .controlSize(.large).padding(.horizontal, 24).padding(.vertical, 16)
        }.frame(width: 512, height: 700).disabled(model.isSaving).interactiveDismissDisabled(model.isSaving)
            .task { await model.loadOptions() }
    }
    private var fixedIncome: Bool { PortfolioAssetKinds.fixedIncome(draft?.assetClass ?? "") }
    private var realEstate: Bool { draft?.assetClass == "real_estate" }
    /// `InvestmentFormFields` order: identity, class fields, initial purchase, price source, notes.
    @ViewBuilder private var fields: some View {
        field("addInv.label.name", \.name, "name")
        if unitBased { field("addInv.label.ticker", \.symbol, "symbol", monospaced: true) }
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("addInv.label.currency")
            Picker(strings.t("addInv.label.currency"), selection: text(\.currency)) {
                ForEach(currencies, id: \.self) { Text($0).tag($0) }
            }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
        if !isEditing {
            if fixedIncome {
                field("addInv.label.interestRate", \.interestRate, "interestRate")
                dateField("addInv.label.maturityDate", \.maturityDate, "maturityDate", allowClear: true)
            }
            if realEstate {
                field("addInv.label.location", \.location, "location")
                field("addInv.label.municipality", \.municipality, "municipality")
                field("addInv.label.cadastralIncome", \.cadastralIncome, "cadastralIncome")
                field("addInv.label.municipalityTaxRate", \.municipalityTaxRate, "municipalityTaxRate")
            }
            initialPurchase
        }
        if isEditing || unitBased {
            Divider()
            PortfolioProviderFields(model: model, shell: shell)
            if unitBased && draft?.provider.provider == "manual" {
                field("addInv.label.currentPrice", \.currentPrice, "currentPrice")
            }
        }
        if !isEditing {
            VStack(alignment: .leading, spacing: 5) {
                fieldLabel("addInv.label.notes")
                TextEditor(text: text(\.notes, field: "notes")).frame(minHeight: 64).focused($focused, equals: "notes")
                    .scrollContentBackground(.hidden).padding(6)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            .fill(Color(token: theme.palette.background, opacity: 0.8)))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            .strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
                    .accessibilityLabel(strings.t("addInv.label.notes"))
            }.id("notes")
        }
    }
    @ViewBuilder private var initialPurchase: some View {
        Toggle(
            strings.t(
                "addInv.initial.label",
                [
                    "txType": strings.t(
                        realEstate
                            ? "addInv.initial.purchase"
                            : (fixedIncome ? "addInv.initial.deposit" : "addInv.initial.buy"))
                ]),
            isOn: Binding(
                get: { draft?.addInitialPurchase ?? false }, set: { model.investmentDraft?.addInitialPurchase = $0 }
            )
        ).toggleStyle(.switch)
        Text(
            strings.t(
                "addInv.initial.desc",
                [
                    "txWord": strings.t(
                        realEstate
                            ? "addInv.initial.purchaseWord"
                            : (fixedIncome ? "addInv.initial.depositWord" : "addInv.initial.transactionWord"))
                ])
        ).font(.footnote).foregroundStyle(theme.secondaryLabel)
        if draft?.addInitialPurchase == true {
            if unitBased {
                Text(strings.t("addInv.initial.unitHelp")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            dateField("addInv.label.date", \.initialDate, "initialDate", allowClear: false)
            field(
                realEstate
                    ? "addInv.label.purchasePrice"
                    : (fixedIncome ? "addInv.label.depositAmount" : "addInv.label.totalCost"), \.initialAmount,
                "initialAmount")
            if unitBased {
                field("addInv.label.units", \.initialUnits, "initialUnits")
                VStack(alignment: .leading, spacing: 5) {
                    fieldLabel("addInv.label.pricePerUnit")
                    Text(computedPricePerUnit ?? "—")
                        .font(.body.monospaced()).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10)
                        .frame(minHeight: 30)
                        .background(
                            theme.secondaryLabel.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous))
                        .accessibilityLabel(strings.t("addInv.label.pricePerUnit"))
                        .accessibilityValue(computedPricePerUnit ?? "—")
                        .textSelection(.enabled)
                }
            }
            field("addInv.label.fees", \.initialFees, "initialFees")
            PortfolioBrokerField(
                model: model, shell: shell, selected: draft?.initialAccountId,
                wasChosen: draft?.brokerWasChosen ?? false,
                onChoose: {
                    model.investmentDraft?.initialAccountId = $0
                    model.investmentDraft?.brokerWasChosen = true
                }, compact: true)
        }
    }
    private var computedPricePerUnit: String? {
        let format = shell.settings.numberFormat
        guard let amount = PortfolioTradeDraft.positive(draft?.initialAmount ?? "", format: format),
            let units = PortfolioTradeDraft.positive(draft?.initialUnits ?? "", format: format), units > 0
        else { return nil }
        return LocaleNumber.editable(amount / units, format: format)
    }
    private func field(
        _ key: String, _ path: WritableKeyPath<PortfolioInvestmentDraft, String>, _ id: String, monospaced: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(key)
            TextField("", text: text(path, field: id)).textFieldStyle(.vision)
                .font(monospaced ? .body.monospaced() : .body)
                .focused($focused, equals: id).onSubmit(save)
                .accessibilityLabel(strings.t(key))
            if model.issue?.field == id {
                Text(strings.t(model.issue!.key)).font(.footnote).foregroundStyle(theme.destructive)
            }
        }.id(id)
    }
    private func dateField(
        _ key: String, _ path: WritableKeyPath<PortfolioInvestmentDraft, String>, _ id: String, allowClear: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(key)
            VisionDateField(
                day: PlannedDay(ymd: draft?[keyPath: path], calendar: .current), placeholder: strings.t(key),
                allowClear: allowClear,
                invalid: model.issue?.field == id, settings: shell.settings, strings: strings, calendar: .current,
                onChange: {
                    model.investmentDraft?[keyPath: path] = $0?.ymd ?? ""
                    model.clearIssue()
                })
            if model.issue?.field == id {
                Text(strings.t(model.issue!.key)).font(.footnote).foregroundStyle(theme.destructive)
            }
        }.id(id)
    }
    /// The web `Label` above an input: subheadline, medium weight, foreground.
    private func fieldLabel(_ key: String) -> some View {
        Text(strings.t(key)).font(.subheadline.weight(.medium)).foregroundStyle(theme.foreground)
    }
    private func save() { Task { await model.saveEditor(strings: strings) } }
}

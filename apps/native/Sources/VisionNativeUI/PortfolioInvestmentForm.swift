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
    private func text(_ path: WritableKeyPath<PortfolioInvestmentDraft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: path] ?? "" },
            set: {
                model.investmentDraft?[keyPath: path] = $0
                model.clearIssue()
            })
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(
                    isEditing
                        ? strings.t("invEdit.title")
                        : (typeSelection
                            ? strings.t("addInv.chooseType")
                            : strings.t(
                                "addInv.assetTitle",
                                ["assetClass": strings.t("portfolio.assetClass." + (draft?.assetClass ?? ""))]))
                )
                .font(.title2).accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.dismissEditor()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless).accessibilityLabel(strings.t("common.close")).keyboardShortcut(.cancelAction)
            }.padding(24)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if typeSelection {
                            Text(strings.t("addInv.chooseTypeDesc")).foregroundStyle(theme.secondaryLabel)
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
                                }.buttonStyle(.bordered)
                            }
                        } else {
                            fields
                        }
                        if let error = model.error {
                            Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 20)
                }
                .onChange(of: model.issue) {
                    if let issue = model.issue {
                        withAnimation { proxy.scrollTo(issue.field, anchor: .center) }
                        focused = issue.field
                    }
                }
            }
            Divider()
            HStack {
                if !isEditing && !typeSelection && (draft?.allowedAssetClasses.count ?? 0) > 1 {
                    Button(strings.t("addInv.back")) { selectingType = true }
                }
                Spacer()
                Button(strings.t("common.cancel")) { model.cancelEditor() }
                if !typeSelection {
                    Button(strings.t(isEditing ? "common.save" : "addInv.create")) { save() }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                }
                if model.isSaving { ProgressView().controlSize(.small) }
            }.padding(20)
        }.frame(width: 550, height: 700).disabled(model.isSaving).interactiveDismissDisabled(model.isSaving)
            .task { await model.loadOptions() }
    }
    @ViewBuilder private var fields: some View {
        field("addInv.label.name", \.name, "name")
        if unitBased { field("addInv.label.ticker", \.symbol, "symbol") }
        Picker(strings.t("addInv.label.currency"), selection: text(\.currency)) {
            ForEach(currencies, id: \.self) { Text($0).tag($0) }
        }
        if !isEditing {
            if PortfolioAssetKinds.fixedIncome(draft?.assetClass ?? "") {
                field("addInv.label.interestRate", \.interestRate, "interestRate")
                dateField("addInv.label.maturityDate", \.maturityDate, "maturityDate", allowClear: true)
            }
            if draft?.assetClass == "real_estate" {
                field("addInv.label.location", \.location, "location")
                field("addInv.label.municipality", \.municipality, "municipality")
                field("addInv.label.cadastralIncome", \.cadastralIncome, "cadastralIncome")
                field("addInv.label.municipalityTaxRate", \.municipalityTaxRate, "municipalityTaxRate")
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("addInv.label.notes")).font(.callout)
                TextEditor(text: text(\.notes)).frame(minHeight: 64).focused($focused, equals: "notes")
                    .accessibilityLabel(strings.t("addInv.label.notes"))
            }.id("notes")
            Toggle(
                strings.t(
                    "addInv.initial.label",
                    [
                        "txType": strings.t(
                            PortfolioAssetKinds.fixedIncome(draft?.assetClass ?? "")
                                ? "addInv.initial.deposit"
                                : (draft?.assetClass == "real_estate"
                                    ? "addInv.initial.purchase" : "addInv.initial.buy"))
                    ]),
                isOn: Binding(
                    get: { draft?.addInitialPurchase ?? false }, set: { model.investmentDraft?.addInitialPurchase = $0 }
                ))
            Text(
                strings.t(
                    "addInv.initial.desc",
                    [
                        "txWord": strings.t(
                            PortfolioAssetKinds.fixedIncome(draft?.assetClass ?? "")
                                ? "addInv.initial.depositWord"
                                : (draft?.assetClass == "real_estate"
                                    ? "addInv.initial.purchaseWord" : "addInv.initial.transactionWord"))
                    ])
            ).font(.footnote).foregroundStyle(theme.secondaryLabel)
            if draft?.addInitialPurchase == true {
                field(
                    PortfolioAssetKinds.fixedIncome(draft?.assetClass ?? "")
                        ? "addInv.label.depositAmount"
                        : (draft?.assetClass == "real_estate"
                            ? "addInv.label.purchasePrice" : "addInv.label.totalCost"), \.initialAmount, "initialAmount"
                )
                if unitBased {
                    field("addInv.label.units", \.initialUnits, "initialUnits")
                    Text(strings.t("addInv.initial.unitHelp")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    if let amount = PortfolioTradeDraft.positive(
                        draft?.initialAmount ?? "", format: shell.settings.numberFormat),
                        let units = PortfolioTradeDraft.positive(
                            draft?.initialUnits ?? "", format: shell.settings.numberFormat), units > 0
                    {
                        Text(
                            strings.t("addInv.label.pricePerUnit") + ": "
                                + LocaleNumber.editable(amount / units, format: shell.settings.numberFormat)
                        )
                        .font(.footnote).monospacedDigit().foregroundStyle(theme.secondaryLabel)
                    }
                }
                dateField("addInv.label.date", \.initialDate, "initialDate", allowClear: false)
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
        if isEditing || unitBased {
            Divider()
            PortfolioProviderFields(model: model, shell: shell)
            if unitBased && draft?.provider.provider == "manual" {
                field("addInv.label.currentPrice", \.currentPrice, "currentPrice")
            }
        }
    }
    private func field(_ key: String, _ path: WritableKeyPath<PortfolioInvestmentDraft, String>, _ id: String)
        -> some View
    {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key)).font(.callout)
            TextField("", text: text(path)).textFieldStyle(.roundedBorder).focused($focused, equals: id).onSubmit(save)
                .accessibilityLabel(strings.t(key))
            if model.issue?.field == id {
                Text(strings.t(model.issue!.key)).font(.footnote).foregroundStyle(theme.destructive)
            }
        }.id(id)
    }
    private func dateField(
        _ key: String, _ path: WritableKeyPath<PortfolioInvestmentDraft, String>, _ id: String, allowClear: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key)).font(.callout)
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
    private func save() { Task { await model.saveEditor(strings: strings) } }
}

import SwiftUI
import VisionNativeCore

struct ResearchMarketActionSheet: View {
    @Bindable var model: ResearchMarketActionModel
    let shell: NativeShellModel
    @State private var showsBrokerPicker = false
    @FocusState private var editorFocus: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // The web `DialogDescription` is `sr-only`, so no visible description here.
            VisionDialogHeader(
                title: strings.t(
                    model.step == "choose"
                        ? "addInvFromMarket.title.add"
                        : model.step == "new"
                            ? "addInvFromMarket.title.create" : "addInvFromMarket.title.transaction",
                    ["symbol": model.quote?.symbol ?? ""]),
                closeLabel: strings.t("common.close"), onClose: { model.close() }
            )
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.step == "choose" {
                        choices
                    } else if model.step == "new" {
                        newInvestment
                    } else {
                        transaction
                    }
                    if let key = model.errorKey {
                        Text(strings.t(key)).font(.callout).foregroundStyle(theme.destructive)
                    }
                    if model.hasUncertainWrite {
                        HStack(spacing: 8) {
                            Button(strings.t("nav.portfolio")) { shell.navigate(to: "/portfolio") }
                                .buttonStyle(.visionOutline)
                            Button(strings.t("common.retry")) { Task { await model.acknowledgeUncertainWrite() } }
                                .buttonStyle(.visionOutline)
                        }
                    }
                    if let error = model.error {
                        Text(error).font(.callout).foregroundStyle(theme.destructive).textSelection(.enabled)
                    }
                }.padding(.horizontal, 1)
            }
            if model.step != "choose" {
                // `DialogFooter sm:justify-between`: Back on the left, the submit action on the right.
                HStack(spacing: 8) {
                    Button(strings.t("addInv.back")) { model.step = "choose" }.buttonStyle(.visionOutline)
                    Spacer(minLength: 0)
                    Button(strings.t(model.step == "new" ? "addInv.create" : "addPortTxn.record")) {
                        Task {
                            if model.step == "new" {
                                await model.createInvestment()
                            } else {
                                await model.recordTransaction()
                            }
                        }
                    }.buttonStyle(.visionPrimary).disabled(
                        model.isSubmitting || model.hasUncertainWrite
                            || (model.step == "new"
                                && model.investment.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    )
                }.controlSize(.large)
            }
        }.visionDialogPadding().frame(width: 448).frame(maxHeight: 760)
            .onSubmit {
                if model.step != "choose" {
                    Task {
                        if model.step == "new" {
                            await model.createInvestment()
                        } else {
                            await model.recordTransaction()
                        }
                    }
                }
            }
    }
    private var choices: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(strings.t("addInvFromMarket.prompt", ["symbol": model.quote?.symbol ?? ""]))
                .font(.footnote).foregroundStyle(theme.secondaryLabel)
            if let holding = model.holding {
                Button {
                    model.step = "transaction"
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(strings.t("form.addTransaction.title")).font(.body.weight(.medium))
                        Text(strings.t("addInvFromMarket.option.addTxnDesc", ["name": holding.name])).font(.caption)
                            .foregroundStyle(theme.secondaryLabel)
                    }.lineLimit(nil).fixedSize(horizontal: false, vertical: true).padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.visionOutline)
            }
            Button {
                model.step = "new"
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(strings.t("addInvFromMarket.option.createNew")).font(.body.weight(.medium))
                    Text(
                        strings.t(
                            model.holding == nil
                                ? "addInvFromMarket.option.createDescNew" : "addInvFromMarket.option.createDescExisting"
                        )
                    ).font(.caption).foregroundStyle(theme.secondaryLabel)
                }.lineLimit(nil).fixedSize(horizontal: false, vertical: true).padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.visionOutline)
        }
    }
    private var newInvestment: some View {
        VStack(alignment: .leading, spacing: 16) {
            newField("addInv.label.name", \.name, limit: 100)
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    fieldLabel(strings.t("addInv.label.ticker"))
                    TextField("", text: .constant(model.quote?.symbol ?? "")).textFieldStyle(.vision).disabled(true)
                        .accessibilityLabel(strings.t("addInv.label.ticker"))
                }
                VStack(alignment: .leading, spacing: 8) {
                    fieldLabel(strings.t("addInv.label.currency"))
                    VisionSelect(
                        selection: $model.investment.currency, options: currencyOptions,
                        accessibilityLabel: strings.t("addInv.label.currency"), expands: true)
                }
            }
            newField("addInv.label.currentPrice", \.currentPrice)
            newField("addInv.label.notes", \.notes, limit: 500)
        }
    }
    private var transaction: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel(strings.t("addPortTxn.type"))
                VisionSelect(
                    selection: $model.trade.type,
                    options: ["buy", "sell", "dividend", "fee", "tax"].map {
                        VisionSelectOption(value: $0, title: strings.t("portfolio.txnType." + $0))
                    }, accessibilityLabel: strings.t("addPortTxn.type"), expands: true)
            }
            dateField("addPortTxn.date", \.date)
            if ["buy", "sell"].contains(model.trade.type) {
                tradeField("addPortTxn.units", \.units)
                tradeField("addPortTxn.pricePerUnit", \.price)
            }
            tradeField("addPortTxn.totalAmount", \.amount, variables: ["currency": model.holding?.currency.rawValue ?? ReportingFallbackCurrency.euro.rawValue])
            if model.deriveUnits, model.unitMath?["isConsistent"] == .bool(false) {
                Text(strings.t("addPortTxn.error.twoOfThreeRequired")).font(.caption).foregroundStyle(theme.destructive)
            }
            if let amount = model.unitMath?["derivedAmount"]?.decimalValue {
                Text(ResearchMarketDisplay.money(amount, currency: model.holding?.currency.rawValue ?? ReportingFallbackCurrency.euro.rawValue, shell: shell))
                    .font(.caption).foregroundStyle(theme.secondaryLabel)
            }
            if ["buy", "sell", "dividend"].contains(model.trade.type) {
                HStack(alignment: .top, spacing: 12) {
                    tradeField("addPortTxn.fees", \.fees)
                    tradeField("addPortTxn.taxes", \.taxes)
                }
                if model.trade.type == "dividend" {
                    VStack(alignment: .leading, spacing: 8) {
                        fieldLabel(strings.t("addPortTxn.dividendAmountConvention"))
                        VisionSelect(
                            selection: $model.trade.dividendConvention,
                            options: ["unknown", "gross", "net"].map {
                                VisionSelectOption(value: $0, title: strings.t("addPortTxn.dividendConvention." + $0))
                            }, accessibilityLabel: strings.t("addPortTxn.dividendAmountConvention"), expands: true)
                        Text(strings.t("addPortTxn.dividendConvention.help")).font(.footnote).foregroundStyle(
                            theme.secondaryLabel)
                    }
                }
                Toggle(strings.t("addPortTxn.recurring"), isOn: $model.trade.isRecurring).toggleStyle(.visionSwitch)
                if model.trade.isRecurring {
                    VStack(alignment: .leading, spacing: 8) {
                        fieldLabel(strings.t("addPortTxn.interval"))
                        VisionSelect(
                            selection: $model.trade.recurrenceInterval,
                            options: ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"].map {
                                VisionSelectOption(value: $0, title: strings.t("addPortTxn.recurrence." + $0))
                            }, accessibilityLabel: strings.t("addPortTxn.interval"), expands: true)
                    }
                    dateField("addPortTxn.endDate", \.recurrenceEndDate)
                }
            }
            tradeField("addPortTxn.fxRate", \.fx)
            broker
            tradeField("addPortTxn.note", \.note, limit: 300)
        }
    }
    private var broker: some View {
        VStack(alignment: .leading, spacing: 8) {
            let selected = model.brokers.first { $0.id == model.effectiveBrokerId }
            if selected != nil && !showsBrokerPicker {
                HStack {
                    Text(selected?.name ?? "")
                    Spacer()
                    Button(strings.t("addPortTxn.broker.change")) { showsBrokerPicker = true }
                        .buttonStyle(.visionOutline)
                }
            } else {
                fieldLabel(strings.t("addPortTxn.broker"))
                VisionSelect(
                    selection: Binding(
                        get: { model.effectiveBrokerId },
                        set: { model.trade.broker = $0.map { .account($0) } ?? .unassigned }),
                    options: brokerOptions, accessibilityLabel: strings.t("addPortTxn.broker"), expands: true)
            }
        }
    }
    private var currencyOptions: [VisionSelectOption<String>] {
        let known = ["EUR", "USD", "GBP", "CHF"]
        let codes = known + (known.contains(model.investment.currency) ? [] : [model.investment.currency])
        return codes.map { VisionSelectOption(value: $0, title: $0) }
    }
    private var brokerOptions: [VisionSelectOption<AccountID?>] {
        var options = [VisionSelectOption<AccountID?>(value: nil, title: strings.t("addPortTxn.broker.unassigned"))]
        options += model.brokers.map { VisionSelectOption<AccountID?>(value: Optional($0.id), title: $0.name) }
        return options
    }
    private func dateField(_ key: String, _ path: WritableKeyPath<ResearchMarketTradeDraft, String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldLabel(strings.t(key))
            VisionDateField(
                day: PlannedDay(ymd: model.trade[keyPath: path], calendar: .current), placeholder: strings.t(key),
                allowClear: true,
                invalid: model.errorKey == "addPortTxn.error.dateRequired" && path == \.date, settings: shell.settings,
                strings: strings, calendar: .current,
                onChange: { model.trade[keyPath: path] = $0?.ymd ?? "" })
        }
    }
    private func newField(
        _ key: String, _ path: WritableKeyPath<ResearchMarketInvestmentDraft, String>, limit: Int? = nil
    ) -> some View {
        let binding = Binding(
            get: { model.investment[keyPath: path] },
            set: { value in model.investment[keyPath: path] = limit.map { String(value.prefix($0)) } ?? value })
        return VStack(alignment: .leading, spacing: 8) {
            fieldLabel(strings.t(key))
            if path == \.notes {
                TextEditor(text: binding).focused($editorFocus, equals: key)
                    .visionTextEditor(isFocused: editorFocus == key, minHeight: 75).frame(height: 75)
                    .accessibilityLabel(strings.t(key))
            } else {
                TextField("", text: binding).textFieldStyle(.vision).accessibilityLabel(strings.t(key))
            }
        }
    }
    private func tradeField(
        _ key: String, _ path: WritableKeyPath<ResearchMarketTradeDraft, String>, variables: [String: String] = [:],
        limit: Int? = nil
    ) -> some View {
        let binding = Binding(
            get: { model.trade[keyPath: path] },
            set: { value in model.trade[keyPath: path] = limit.map { String(value.prefix($0)) } ?? value })
        return VStack(alignment: .leading, spacing: 8) {
            fieldLabel(strings.t(key, variables))
            if path == \.note {
                TextEditor(text: binding).focused($editorFocus, equals: key)
                    .visionTextEditor(isFocused: editorFocus == key, minHeight: 75).frame(height: 75)
                    .accessibilityLabel(strings.t(key, variables))
            } else {
                TextField("", text: binding).textFieldStyle(.vision).accessibilityLabel(
                    strings.t(key, variables))
            }
        }
    }
    /// The web `Label`: `type-body font-medium text-label-primary` above its input.
    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.body.weight(.medium)).foregroundStyle(theme.foreground)
    }
}

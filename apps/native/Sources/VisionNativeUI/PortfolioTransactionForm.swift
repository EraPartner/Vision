import SwiftUI
import VisionNativeCore

struct PortfolioTransactionForm: View {
    /// The focus and scroll id of the free-text field, which issues can target.
    private static let noteField = "note"
    /// `AddPortfolioTransactionDialog`'s panel: the form lays out its own header, scroll area and footer.
    static let metrics = VisionDialogMetrics(
        maxWidth: 480, height: .fraction(DesignTokens.Overlay.dialogMaxHeightFraction), padding: 0, spacing: 0)
    let model: PortfolioEditingModel
    let shell: NativeShellModel
    @FocusState private var focused: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var draft: PortfolioTradeDraft? { model.tradeDraft }
    private var isEditing: Bool { draft?.isEditing ?? false }
    private var investmentLabel: String {
        if let symbol = draft?.investment.symbol, !symbol.isEmpty { return symbol }
        return draft?.investment.name ?? ""
    }
    private func text(_ path: WritableKeyPath<PortfolioTradeDraft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: path] ?? "" },
            set: {
                model.tradeDraft?[keyPath: path] = $0
                model.clearIssue()
            })
    }
    private func choice<Value>(_ path: WritableKeyPath<PortfolioTradeDraft, Value>, fallback: Value) -> Binding<
        Value
    > {
        Binding(
            get: { draft?[keyPath: path] ?? fallback },
            set: {
                model.tradeDraft?[keyPath: path] = $0
                model.clearIssue()
            })
    }
    var body: some View {
        VStack(spacing: 0) {
            VisionDialogHeader(
                title: strings.t(isEditing ? "txnEdit.title" : "addPortTxn.title", ["symbol": investmentLabel]),
                closeLabel: strings.t("common.close"), onClose: { model.dismissEditor() }
            )
            .keyboardShortcut(.cancelAction)
            .padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 20)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        fields
                        if let error = model.error {
                            Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 24)
                }.onChange(of: model.issue) {
                    if let issue = model.issue {
                        withAnimation { proxy.scrollTo(issue.field, anchor: .center) }
                        focused = issue.field
                    }
                }
            }
            Divider()
            VisionDialogFooter {
                if model.isSaving { ProgressView().controlSize(.small) }
                Button(strings.t("addPortTxn.cancel")) { model.cancelEditor() }.buttonStyle(.visionOutline)
                Button(strings.t(isEditing ? "common.save" : "addPortTxn.record")) { save() }
                    .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 24).padding(.vertical, 16)
        }.disabled(model.isSaving).visionInteractiveDismissDisabled(model.isSaving)
            .task { await model.loadOptions() }
    }
    @ViewBuilder private var fields: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("addPortTxn.type")
            if isEditing {
                // EditPortfolioTxnDialog shows the type as a disabled input.
                TextField("", text: .constant(typeLabel(draft?.type.rawValue ?? ""))).textFieldStyle(.vision).disabled(true)
                    .accessibilityLabel(strings.t("addPortTxn.type"))
            } else {
                VisionSelect(
                    selection: choice(\.type, fallback: .buy),
                    options: PortfolioAssetKinds.tradeTypes(draft?.investment.assetClass ?? .unknown("")).map {
                        VisionSelectOption(value: $0, title: strings.t("portfolio.txnType." + $0.rawValue))
                    }, accessibilityLabel: strings.t("addPortTxn.type"), expands: true)
            }
        }
        dateField("addPortTxn.date", \.date, "date", allowClear: false)
        if draft?.showUnits == true {
            field("addPortTxn.units", \.units, "units")
            field("addPortTxn.pricePerUnit", \.pricePerUnit, "pricePerUnit")
        }
        field(
            "addPortTxn.totalAmount", \.amount, "amount", variables: ["currency": draft?.currency.rawValue ?? "EUR"],
            lockGift: !isEditing && draft?.isGift == true)
        if let draft, draft.isBuySell {
            let input = draft.unitInput(format: shell.settings.numberFormat)
            if input.consistent, draft.amount.isEmpty, let amount = input.amount {
                Text(LocaleNumber.editable(amount, format: shell.settings.numberFormat)).font(.footnote)
                    .monospacedDigit()
            } else if !input.consistent {
                Text(strings.t("addPortTxn.error.twoOfThreeRequired")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
            }
        }
        if draft?.showFeesTaxes == true {
            field("addPortTxn.fees", \.fees, "fees")
            field("addPortTxn.taxes", \.taxes, "taxes")
        }
        if draft?.type == .dividend {
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("addPortTxn.dividendAmountConvention")
                VisionSelect(
                    selection: choice(\.dividendAmountConvention, fallback: .unknownValue),
                    options: OpenAPI.PortfolioTransaction.DividendAmountConvention.allKnownCases.map {
                        VisionSelectOption(
                            value: $0, title: strings.t("addPortTxn.dividendConvention." + $0.rawValue))
                    }, accessibilityLabel: strings.t("addPortTxn.dividendAmountConvention"), expands: true)
                Text(strings.t("addPortTxn.dividendConvention.help")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
            }
        }
        field("addPortTxn.fxRate", \.fxRateToEur, "fxRateToEur")
        PortfolioBrokerField(
            model: model, shell: shell, selected: draft?.accountId, wasChosen: draft?.brokerWasChosen ?? false,
            onChoose: {
                model.tradeDraft?.accountId = $0
                model.tradeDraft?.brokerWasChosen = true
            }, compact: !isEditing)
        if draft?.showRecurring == true {
            Toggle(
                strings.t("addPortTxn.recurring"),
                isOn: Binding(get: { draft?.isRecurring ?? false }, set: { model.tradeDraft?.isRecurring = $0 })
            ).toggleStyle(.visionSwitch)
            if draft?.isRecurring == true {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("addPortTxn.interval")
                    VisionSelect(
                        selection: choice(\.recurrenceInterval, fallback: .monthly),
                        options: [OpenAPI.RecurrenceInterval.daily, .weekly, .biweekly, .monthly, .quarterly, .yearly]
                            .map {
                                VisionSelectOption(
                                    value: $0, title: strings.t("addPortTxn.recurrence." + $0.rawValue))
                            }, accessibilityLabel: strings.t("addPortTxn.interval"), expands: true)
                }
                dateField("addPortTxn.endDate", \.recurrenceEndDate, "recurrenceEndDate", allowClear: true)
            }
        }
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("addPortTxn.note")
            TextEditor(text: text(\.note)).focused($focused, equals: Self.noteField)
                .visionTextEditor(isFocused: focused == Self.noteField)
                .accessibilityLabel(strings.t("addPortTxn.note"))
        }.id("note")
    }
    private func field(
        _ key: String, _ path: WritableKeyPath<PortfolioTradeDraft, String>, _ id: String,
        variables: [String: String] = [:], lockGift: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(key, variables)).font(.subheadline.weight(.medium)).foregroundStyle(theme.foreground)
            TextField("", text: lockGift ? .constant("0") : text(path)).textFieldStyle(.vision)
                .disabled(lockGift).focused($focused, equals: id).onSubmit(save).accessibilityLabel(
                    strings.t(key, variables))
            if model.issue?.field == id {
                Text(strings.t(model.issue!.key)).font(.footnote).foregroundStyle(theme.destructive)
            }
        }.id(id)
    }
    private func dateField(
        _ key: String, _ path: WritableKeyPath<PortfolioTradeDraft, String>, _ id: String, allowClear: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(key)
            VisionDateField(
                day: PlannedDay(ymd: draft?[keyPath: path], calendar: .current), placeholder: strings.t(key),
                allowClear: allowClear,
                invalid: model.issue?.field == id, settings: shell.settings, strings: strings, calendar: .current,
                onChange: {
                    model.tradeDraft?[keyPath: path] = $0?.ymd ?? ""
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
    /// `getTxnTypeLabel`: the raw type when no `portfolio.txnType.*` label exists.
    private func typeLabel(_ type: String) -> String {
        let key = "portfolio.txnType." + type
        let text = strings.t(key)
        return text == key ? type : text
    }
    private func save() { Task { await model.saveEditor(strings: strings) } }
}

extension View {
    public func portfolioEditingPresentation(
        model: PortfolioEditingModel, shell: NativeShellModel, enabled: Bool = true
    ) -> some View {
        modifier(PortfolioEditingPresenter(model: model, shell: shell, enabled: enabled))
    }
}
private struct PortfolioEditingPresenter: ViewModifier {
    let model: PortfolioEditingModel
    let shell: NativeShellModel
    let enabled: Bool
    private var strings: any Localizing { shell.strings }
    func body(content: Content) -> some View {
        content.visionDialog(
            isPresented: Binding(
                get: { enabled && model.presentation != nil }, set: { if !$0 && enabled { model.dismissEditor() } }),
            metrics: editorMetrics
        ) {
            if model.presentation == .investment {
                PortfolioInvestmentForm(model: model, shell: shell)
            } else {
                PortfolioTransactionForm(model: model, shell: shell)
            }
        }
        .visionConfirmationDialog(
            title: confirmationTitle, message: confirmationDescription,
            isPresented: Binding(
                get: { enabled && model.confirmation != nil }, set: { if !$0 && enabled { model.confirmation = nil } })
        ) {
            VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.confirmation = nil }
            if let pending = model.confirmation {
                VisionDialogAction(confirmLabel, role: destructive ? .destructive : nil) {
                    model.confirmation = nil
                    Task { await model.performConfirmation(pending) }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if enabled { NoticeToast(notice: model.notice, strings: strings, clear: model.clearNotice) }
        }
    }
    private var editorMetrics: VisionDialogMetrics {
        model.presentation == .investment ? PortfolioInvestmentForm.metrics : PortfolioTransactionForm.metrics
    }
    private var confirmationTitle: String {
        switch model.confirmation {
        case .archive: strings.t("portfolio.archiveInvestment")
        case .deleteInvestment(_, let key, _): strings.t(key)
        case .deleteTransaction: strings.t("invDetail.delete.title")
        case nil: ""
        }
    }
    private var confirmationDescription: String {
        switch model.confirmation {
        case .archive(let investment): strings.t("portfolio.archiveInvestmentDesc", ["name": investment.name])
        case .deleteInvestment(let investment, _, let key): strings.t(key, ["name": investment.name])
        case .deleteTransaction(let transaction):
            strings.t("invDetail.delete.desc", ["txType": txnTypeLabel(transaction.type.rawValue)])
        case nil: ""
        }
    }
    private var confirmLabel: String {
        switch model.confirmation {
        case .archive: strings.t("portfolio.archiveInvestment")
        case .deleteInvestment: strings.t("common.delete")
        case .deleteTransaction, nil: strings.t("invDetail.delete.confirm")
        }
    }
    private func txnTypeLabel(_ type: String) -> String {
        let key = "portfolio.txnType." + type
        let text = strings.t(key)
        return text == key ? type : text
    }
    private var destructive: Bool {
        if case .archive = model.confirmation { return false }
        return true
    }
}

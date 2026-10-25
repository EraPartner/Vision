import SwiftUI
import VisionNativeCore

/// Every dialog of `/accounts` and `/accounts/:id`, attached once per screen: the Add / Edit
/// account sheet, Reconcile balance, Set opening balance, Merge account, Close account,
/// Transfer portfolio lots and the Delete account? alert. Only one is up at a time (Delete's
/// 409 opens Close once the alert is gone).
struct AccountDialogs: ViewModifier {
    let model: AccountsModel
    let shell: NativeShellModel
    let theme: VisionTheme

    private var strings: any Localizing { shell.strings }

    func body(content: Content) -> some View {
        content
            // `useConfirmDialog`. The buttons decide; the binding only reads.
            .alert(
                model.deleteText()?.title ?? "",
                isPresented: Binding(get: { model.pendingDelete != nil }, set: { _ in })
            ) {
                Button(strings.t("common.cancel"), role: .cancel) { model.cancelDelete() }
                Button(model.deleteText()?.action ?? "", role: .destructive) {
                    Task { await model.confirmDelete() }
                }
            } message: {
                Text(model.deleteText()?.message ?? "")
            }
            .sheet(
                isPresented: Binding(
                    get: { model.form != nil },
                    set: { presented in
                        if !presented { model.closeForm() }
                    })
            ) {
                themed(AccountFormSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.reconcile != nil },
                    set: { presented in
                        if !presented { model.closeReconcile() }
                    })
            ) {
                themed(ReconcileSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.opening != nil },
                    set: { presented in
                        if !presented { model.closeOpeningBalance() }
                    })
            ) {
                themed(OpeningBalanceSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.merge != nil },
                    set: { presented in
                        if !presented { model.closeMerge() }
                    })
            ) {
                themed(MergeAccountSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.close != nil },
                    set: { presented in
                        if !presented { model.closeCloseDialog() }
                    })
            ) {
                themed(CloseAccountSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.transfer != nil },
                    set: { presented in
                        if !presented { model.closeTransfer() }
                    })
            ) {
                themed(BrokerTransferSheet(model: model, shell: shell))
            }
    }

    private func themed(_ sheet: some View) -> some View {
        sheet
            .environment(\.visionTheme, theme)
            .environment(\.colorScheme, theme.colorScheme)
    }
}

/// The `DialogContent` frame the account, category and recipient dialogs share: the web
/// header (title, description, close X), a scrolling body and a right-aligned footer, with
/// `p-6` padding and the `gap-5` rhythm. Footer buttons default to the outline style; the
/// primary action sets `.visionPrimary` itself.
struct AccountDialogFrame<Content: View, Footer: View>: View {
    let title: String
    var description: String?
    let closeLabel: String
    /// `sm:max-w-md`.
    var width: CGFloat = 448
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VisionDialogHeader(title: title, description: description, closeLabel: closeLabel)
                .padding([.horizontal, .top], 24)
                .padding(.bottom, 20)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content()
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                footer()
            }
            .buttonStyle(.visionOutline)
            .controlSize(.large)
            .padding([.horizontal, .bottom], 24)
            .padding(.top, 20)
        }
        .frame(minWidth: width, idealWidth: width, minHeight: 240)
        .foregroundStyle(theme.foreground)
    }
}

/// A label over a control, with an optional hint.
struct AccountField<Control: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder var control: () -> Control
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.callout.weight(.medium))
                .foregroundStyle(theme.foreground)
            control()
            if let hint {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A tinted callout (`Alert`).
struct AccountCallout<Content: View>: View {
    let tint: Color
    var symbol = "exclamationmark.triangle"
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .fill(tint.opacity(0.08)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Add / Edit account

/// `AddAccountDialog`: Name, Display name, Institution, Currency, Type, the create-only
/// Opening balance with its As of date, and the Advanced section (Owner, Liquidity,
/// Spendable, Include in net worth).
struct AccountFormSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @FocusState private var focus: Field?
    @Environment(\.visionTheme) private var theme

    private enum Field: Hashable {
        case name
        case openingBalance
        case openingDate
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        if let form = model.form {
            AccountDialogFrame(title: strings.t(form.titleKey), closeLabel: strings.t("common.close"), width: 470) {
                fields(form)
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeForm() }
                    .keyboardShortcut(.cancelAction)
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if model.isSavingForm { ProgressView().controlSize(.small) }
                        Text(strings.t(form.submitKey))
                    }
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(model.isSavingForm || !form.canSubmit)
            }
            .frame(minHeight: 560)
            .onAppear { focus = .name }
            .onChange(of: model.formFocusRequest) { _, _ in
                switch model.formFocus {
                case .openingBalance?: focus = .openingBalance
                case .openingDate?: focus = .openingDate
                case nil: break
                }
            }
        }
    }

    private func submit() {
        Task { await model.submitForm() }
    }

    @ViewBuilder
    private func fields(_ form: AccountFormDraft) -> some View {
        AccountField(label: strings.t("accounts.field.name"), hint: strings.t("accounts.field.nameHint")) {
            TextField(
                strings.t("accounts.field.namePlaceholder"),
                text: Binding(get: { model.form?.name ?? "" }, set: { model.form?.setName($0) })
            )
            .textFieldStyle(.vision)
            .focused($focus, equals: .name)
            .onSubmit(submit)
            .accessibilityLabel(strings.t("accounts.field.name"))
        }
        AccountField(label: strings.t("accounts.field.displayName")) {
            TextField(
                strings.t("accounts.field.displayNamePlaceholder"),
                text: Binding(get: { model.form?.displayName ?? "" }, set: { model.form?.setDisplayName($0) })
            )
            .textFieldStyle(.vision)
            .onSubmit(submit)
            .accessibilityLabel(strings.t("accounts.field.displayName"))
        }
        HStack(alignment: .top, spacing: 12) {
            AccountField(label: strings.t("accounts.field.institution")) {
                TextField(
                    "",
                    text: Binding(get: { model.form?.institution ?? "" }, set: { model.form?.setInstitution($0) })
                )
                .textFieldStyle(.vision)
                .onSubmit(submit)
                .accessibilityLabel(strings.t("accounts.field.institution"))
            }
            AccountField(label: strings.t("accounts.field.currency")) {
                Picker(
                    strings.t("accounts.field.currency"),
                    selection: Binding(get: { model.form?.currency ?? "EUR" }, set: { model.form?.currency = $0 })
                ) {
                    ForEach(AccountOptions.currencies(including: form.currency), id: \.self) { code in
                        Text(verbatim: code).tag(code)
                    }
                }
                .labelsHidden()
                .frame(width: 110)
            }
        }
        AccountField(label: strings.t("accounts.field.type")) {
            Picker(
                strings.t("accounts.field.type"),
                selection: Binding(get: { model.form?.type ?? AccountKind.checking.rawValue }, set: { model.form?.setType($0) })
            ) {
                ForEach(AccountKind.allCases, id: \.self) { kind in
                    Label(strings.t(kind.labelKey), systemImage: kind.symbol).tag(kind.rawValue)
                }
            }
            .labelsHidden()
        }
        if form.showsOpeningBalance {
            openingFields(form)
        }
        DisclosureGroup(
            isExpanded: Binding(get: { model.form?.showAdvanced ?? false }, set: { model.form?.showAdvanced = $0 })
        ) {
            advanced(form)
                .padding(.top, 8)
        } label: {
            Text(strings.t("accounts.advanced"))
                .font(.callout.weight(.medium))
        }
    }

    @ViewBuilder
    private func openingFields(_ form: AccountFormDraft) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AccountField(label: strings.t(form.openingLabelKey)) {
                TextField(
                    strings.t("accounts.openingBalance.createPlaceholder"),
                    text: Binding(get: { model.form?.openingBalance ?? "" }, set: { model.form?.setOpeningBalance($0) })
                )
                .textFieldStyle(.vision)
                .focused($focus, equals: .openingBalance)
                .onSubmit(submit)
                .accessibilityLabel(strings.t(form.openingLabelKey))
                if form.showsOpeningError {
                    Text(strings.t("accounts.openingBalance.invalid"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
            }
            AccountField(label: strings.t("accounts.openingBalance.dateLabel")) {
                VisionDateField(
                    day: form.openingDate, placeholder: strings.t("accounts.openingBalance.dateLabel"), allowClear: true,
                    invalid: form.showsOpeningDateError, settings: settings, strings: strings,
                    calendar: model.calendar
                ) { day in
                    model.form?.openingDate = day
                }
                .focused($focus, equals: .openingDate)
                if form.showsOpeningDateError {
                    Text(strings.t("validation.required"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
            }
            .frame(width: 170)
        }
        Text(strings.t("accounts.openingBalance.createHint"))
            .font(.footnote)
            .foregroundStyle(theme.secondaryLabel)
    }

    @ViewBuilder
    private func advanced(_ form: AccountFormDraft) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            AccountField(label: strings.t("accounts.field.owner"), hint: strings.t("accounts.field.ownerHint")) {
                Picker(
                    strings.t("accounts.field.owner"),
                    selection: Binding(get: { model.form?.owner ?? "me" }, set: { model.form?.owner = $0 })
                ) {
                    ForEach(AccountOptions.owners, id: \.self) { owner in
                        Text(strings.t("accounts.owner.\(owner)")).tag(owner)
                    }
                }
                .labelsHidden()
            }
            AccountField(label: strings.t("accounts.field.liquidityClass"), hint: strings.t("accounts.field.liquidityHint")) {
                Picker(
                    strings.t("accounts.field.liquidityClass"),
                    selection: Binding(
                        get: { model.form?.liquidityClass ?? "liquid" }, set: { model.form?.setLiquidityClass($0) })
                ) {
                    ForEach(AccountOptions.liquidityClasses, id: \.self) { value in
                        Text(strings.t("accounts.liquidity.\(value)")).tag(value)
                    }
                }
                .labelsHidden()
            }
            Toggle(
                isOn: Binding(get: { model.form?.spendable ?? false }, set: { model.form?.setSpendable($0) })
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(strings.t("accounts.field.spendable"))
                    Text(strings.t("accounts.field.spendableHint"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            .toggleStyle(.switch)
            Toggle(
                strings.t("accounts.field.inNetWorth"),
                isOn: Binding(get: { model.form?.inNetWorth ?? true }, set: { model.form?.inNetWorth = $0 })
            )
            .toggleStyle(.switch)
        }
    }
}

// MARK: - Reconcile balance

/// `ReconcileDialog`: the statement and computed figures, a new statement reading with its
/// date and Save reading, the live Difference, the backdated warning, the three resolutions
/// and Show transactions since.
struct ReconcileSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        if let draft = model.reconcile {
            let busy = draft.pendingAction != nil
            let todayYmd = model.today.ymd
            let backdated = draft.isBackdated(today: todayYmd)
            AccountDialogFrame(
                title: strings.t("accounts.reconcile.title"),
                description: strings.t("accounts.reconcile.description", ["name": AccountKinds.label(draft.account)]),
                closeLabel: strings.t("common.close"),
                width: 448
            ) {
                figures(draft, busy: busy)
                if backdated, let readingDate = draft.readingDate {
                    AccountCallout(tint: theme.warning) {
                        Text(
                            strings.t(
                                "accounts.reconcile.backdatedWarning",
                                ["date": readingDate.text(format: settings.dateFormat)])
                        )
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                        sinceButton(draft, emphasized: true, busy: busy)
                    }
                }
                resolutions(draft, busy: busy)
            } footer: {
                if draft.sinceDate != nil && !backdated {
                    sinceButton(draft, emphasized: false, busy: busy)
                }
                Spacer()
                Button(strings.t("common.cancel")) { model.closeReconcile() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
            }
            .frame(minHeight: 620)
        }
    }

    private func money(_ amount: Decimal, _ currency: String, signed: Bool = false) -> String {
        model.money(amount, currency: currency, signed: signed)
    }

    @ViewBuilder
    private func figures(_ draft: ReconcileDraft, busy: Bool) -> some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 8) {
                if draft.showsCurrencyPicker {
                    AccountField(label: strings.t("accounts.reconcile.currencyLabel")) {
                        Picker(
                            strings.t("accounts.reconcile.currencyLabel"),
                            selection: Binding(
                                get: { model.reconcile?.selectedCurrency ?? draft.defaultCurrency },
                                set: { model.reconcile?.selectCurrency($0) })
                        ) {
                            ForEach(draft.availableCurrencies, id: \.self) { code in
                                Text(verbatim: code).tag(code)
                            }
                        }
                        .labelsHidden()
                        .disabled(busy)
                    }
                }
                row(strings.t("accounts.reconcile.statementLabel"), money(draft.statement, draft.selectedCurrency))
                row(strings.t("accounts.reconcile.computedLabel"), money(draft.computed, draft.account.currency))
                if !draft.baseIsComputed {
                    row(
                        strings.t("accounts.reconcile.reconcilableLabel", ["currency": draft.selectedCurrency]),
                        money(draft.base, draft.selectedCurrency))
                }
                if let provenance = model.provenance(draft.account) {
                    Text(provenance)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if !draft.baseIsComputed {
                    Text(strings.t("accounts.reconcile.reconcilableHint", ["currency": draft.selectedCurrency]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Divider()
                HStack(alignment: .top, spacing: 12) {
                    AccountField(label: strings.t("accounts.reconcile.readingLabel")) {
                        TextField(
                            money(draft.statement, draft.selectedCurrency),
                            text: Binding(get: { model.reconcile?.reading ?? "" }, set: { model.reconcile?.setReading($0) })
                        )
                        .textFieldStyle(.vision)
                        .disabled(busy)
                        .accessibilityLabel(strings.t("accounts.reconcile.readingLabel"))
                    }
                    AccountField(label: strings.t("accounts.reconcile.readingDateLabel")) {
                        VisionDateField(
                            day: draft.readingDate, placeholder: strings.t("accounts.reconcile.readingDateLabel"),
                            allowClear: true, disabled: busy, settings: settings, strings: strings,
                            calendar: model.calendar
                        ) { day in
                            model.reconcile?.readingDate = day
                        }
                    }
                    .frame(width: 170)
                }
                Text(strings.t("accounts.reconcile.readingHint"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    Task { await model.saveReading() }
                } label: {
                    HStack(spacing: 6) {
                        if draft.pendingAction == .saveReading { ProgressView().controlSize(.small) }
                        Text(strings.t("accounts.reconcile.readingSubmit"))
                    }
                }
                .buttonStyle(.visionOutline)
                .disabled(busy || !draft.canSaveReading)
                Divider()
                HStack {
                    Text(strings.t("accounts.reconcile.deltaLabel"))
                        .fontWeight(.medium)
                    Spacer()
                    Text(money(draft.previewDrift, draft.selectedCurrency, signed: true))
                        .font(.headline)
                        .monospacedDigit()
                        .foregroundStyle(draft.previewIsZero ? theme.secondaryLabel : theme.destructive)
                }
                if draft.hasReading {
                    Text(strings.t("accounts.reconcile.deltaPreview"))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                if draft.readingInvalid {
                    Text(strings.t("accounts.reconcile.readingInvalid"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
                if draft.readingNeedsDate {
                    Text(strings.t("accounts.reconcile.readingNeedsDate"))
                        .font(.footnote)
                        .foregroundStyle(theme.warning)
                }
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(theme.secondaryLabel)
            Spacer()
            Text(value)
                .fontWeight(.medium)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func resolutions(_ draft: ReconcileDraft, busy: Bool) -> some View {
        let blocked = busy || draft.readingNeedsDate
        resolution(
            title: "accounts.reconcile.acceptTitle", description: strings.t("accounts.reconcile.acceptDescription"),
            button: "accounts.reconcile.acceptSubmit", pending: draft.pendingAction == .resolve(.accept),
            disabled: blocked, prominent: true
        ) {
            Task { await model.resolve(.accept) }
        }
        resolution(
            title: "accounts.reconcile.adjustTitle", description: strings.t("accounts.reconcile.adjustDescription"),
            button: "accounts.reconcile.adjustSubmit", pending: draft.pendingAction == .resolve(.adjustment),
            disabled: blocked, prominent: false
        ) {
            Task { await model.resolve(.adjustment) }
        }
        if draft.canBackfill {
            resolution(
                title: "accounts.reconcile.backfillTitle",
                description: strings.t(
                    "accounts.reconcile.backfillDescription",
                    ["balance": money(draft.backfillBalance, draft.selectedCurrency)]),
                button: "accounts.reconcile.backfillSubmit", pending: draft.pendingAction == .backfill,
                disabled: busy, prominent: false
            ) {
                Task { await model.backfillOpening() }
            }
        }
    }

    private func resolution(
        title: String, description: String, button: String, pending: Bool, disabled: Bool, prominent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(title))
                .font(.headline)
            Text(description)
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: action) {
                HStack(spacing: 6) {
                    if pending { ProgressView().controlSize(.small) }
                    Text(strings.t(button))
                }
                .frame(maxWidth: .infinity)
            }
            .modifier(ResolutionButtonStyle(prominent: prominent))
            .disabled(disabled)
            .padding(.top, 4)
        }
    }

    private func sinceButton(_ draft: ReconcileDraft, emphasized: Bool, busy: Bool) -> some View {
        Button {
            model.showSince()
        } label: {
            Label(
                strings.t(
                    "accounts.reconcile.showSince",
                    ["date": VisionFormat.appDate(draft.sinceDate ?? "", format: settings.dateFormat)]),
                systemImage: "line.3.horizontal.decrease")
        }
        .modifier(SinceButtonStyle(emphasized: emphasized))
        .disabled(busy)
    }
}

/// Accept is the prominent resolution; the others are bordered.
private struct ResolutionButtonStyle: ViewModifier {
    let prominent: Bool

    func body(content: Content) -> some View {
        if prominent {
            content.buttonStyle(.visionPrimary)
        } else {
            content.buttonStyle(.visionOutline)
        }
    }
}

/// Show transactions since: emphasized inside the backdated warning, quiet in the footer.
private struct SinceButtonStyle: ViewModifier {
    let emphasized: Bool

    func body(content: Content) -> some View {
        if emphasized {
            content.buttonStyle(.visionOutline)
        } else {
            content.buttonStyle(.borderless)
        }
    }
}

// MARK: - Set opening balance

/// `OpeningBalanceDialog`: the amount in the anchor currency and its As of date.
struct OpeningBalanceSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @FocusState private var amountFocused: Bool

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        if let draft = model.opening {
            AccountDialogFrame(
                title: strings.t("accounts.openingBalance.title"),
                description: strings.t("accounts.openingBalance.description", ["name": draft.accountName]),
                closeLabel: strings.t("common.close")
            ) {
                AccountField(label: "\(strings.t("accounts.openingBalance.balanceLabel")) (\(draft.currency))") {
                    TextField(
                        LocaleNumber.placeholder(format: settings.numberFormat),
                        text: Binding(get: { model.opening?.balance ?? "" }, set: { model.opening?.balance = $0 })
                    )
                    .textFieldStyle(.vision)
                    .focused($amountFocused)
                    .onSubmit(submit)
                    .accessibilityLabel(strings.t("accounts.openingBalance.balanceLabel"))
                }
                AccountField(label: strings.t("accounts.openingBalance.dateLabel")) {
                    VisionDateField(
                        day: draft.date, placeholder: strings.t("accounts.openingBalance.dateLabel"), allowClear: true,
                        settings: settings, strings: strings, calendar: model.calendar
                    ) { day in
                        model.opening?.date = day
                    }
                }
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeOpeningBalance() }
                    .keyboardShortcut(.cancelAction)
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if draft.isSaving { ProgressView().controlSize(.small) }
                        Text(strings.t("accounts.openingBalance.submit"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canSubmit)
            }
            .onAppear { amountFocused = true }
        }
    }

    private func submit() {
        Task { await model.submitOpeningBalance() }
    }
}

// MARK: - Merge account

/// `MergeAccountDialog`: the survivor select over every other account, the merge preview,
/// the irreversible warning, the type mismatch note and the acknowledgement.
struct MergeAccountSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        if let draft = model.merge {
            let candidates = model.mergeCandidates
            let target = candidates.first { $0.id == draft.targetId }
            AccountDialogFrame(
                title: strings.t("accounts.mergeTitle"),
                description: strings.t("accounts.mergeDescription", ["source": AccountKinds.label(draft.source)]),
                closeLabel: strings.t("common.close")
            ) {
                AccountField(label: strings.t("accounts.mergeTargetLabel")) {
                    Picker(
                        strings.t("accounts.mergeTargetLabel"),
                        selection: Binding<Int?>(
                            get: { model.merge?.targetId },
                            set: { id in
                                guard let id else { return }
                                Task { await model.selectMergeTarget(id) }
                            })
                    ) {
                        if draft.targetId == nil {
                            Text(strings.t("accounts.mergeTargetPlaceholder")).tag(Int?.none)
                        }
                        ForEach(candidates, id: \.id) { account in
                            Text(verbatim: candidateLabel(account)).tag(Int?.some(account.id))
                        }
                    }
                    .labelsHidden()
                }
                if let target {
                    preview(draft, target: target)
                }
                AccountCallout(tint: theme.destructive) {
                    Text(
                        target.map { target in
                            strings.t(
                                "accounts.mergeWarning",
                                ["source": AccountKinds.label(draft.source), "target": AccountKinds.label(target)])
                        } ?? strings.t("accounts.mergeIrreversible")
                    )
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let target, target.type != draft.source.type {
                    Text(
                        strings.t(
                            "accounts.mergeTypeMismatch",
                            [
                                "sourceType": strings.t("accounts.type.\(draft.source.type)"),
                                "targetType": strings.t("accounts.type.\(target.type)"),
                            ])
                    )
                    .font(.callout)
                    .foregroundStyle(theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Toggle(
                    isOn: Binding(get: { model.merge?.acknowledged ?? false }, set: { model.setMergeAcknowledged($0) })
                ) {
                    Text(strings.t("accounts.mergeAcknowledge"))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .toggleStyle(.checkbox)
                .disabled(!draft.canAcknowledge)
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeMerge() }
                    .keyboardShortcut(.cancelAction)
                Button(role: .destructive) {
                    Task { await model.confirmMerge() }
                } label: {
                    HStack(spacing: 6) {
                        if draft.isMerging { ProgressView().controlSize(.small) }
                        Text(strings.t("accounts.mergeConfirm"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .tint(theme.destructive)
                .disabled(!draft.canMerge)
            }
        }
    }

    private func candidateLabel(_ account: OpenAPI.Account) -> String {
        let label = AccountKinds.label(account)
        return account.isActive ? label : "\(label) (\(strings.t("accounts.archived")))"
    }

    @ViewBuilder
    private func preview(_ draft: MergeDraft, target: OpenAPI.Account) -> some View {
        AdminCard(padding: 12) {
            switch draft.preview {
            case .failed?:
                VStack(alignment: .leading, spacing: 8) {
                    Text(strings.t("accounts.mergePreview.failed"))
                        .foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await model.retryMergePreview() } }
                        .buttonStyle(.visionOutline)
                        .controlSize(.small)
                }
            case .loaded(let data)?:
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.mergeSummary(data, target: target))
                        .fixedSize(horizontal: false, vertical: true)
                    if data.projectedBalanceIncomplete {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(strings.t("accounts.mergePreview.incomplete"))
                            ForEach(data.excludedParts, id: \.currency) { part in
                                Text(verbatim: "\(model.money(part.balance, currency: part.currency)) \(strings.t("accounts.balanceExcluded"))")
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(theme.warning)
                    }
                    if data.stampsInterleaved {
                        Label(strings.t("accounts.mergePreview.interleaved"), systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(theme.warning)
                    }
                }
            case .loading?, nil:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(strings.t("accounts.mergePreview.loading"))
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
        }
    }
}

// MARK: - Portfolio lot destination

/// `PortfolioLotRetagChoice`: Portfolio lots with the count and the destination select
/// (Keep on the closed account, Move to Unassigned, each other active broker account).
struct LotDestinationChoice: View {
    let eligibleCount: Int
    let destinations: [OpenAPI.Account]
    let selection: LotDestination?
    let allowKeep: Bool
    var placeholder: String?
    var disabled = false
    let strings: any Localizing
    let onChange: (LotDestination) -> Void
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.t("accounts.close.portfolioLots"))
                    .fontWeight(.medium)
                Text(strings.t("accounts.close.portfolioLotsCount", ["count": String(eligibleCount)]))
                    .font(.caption)
                    .foregroundStyle(theme.secondaryLabel)
            }
            Picker(
                strings.t("accounts.close.portfolioDestination"),
                selection: Binding<LotDestination?>(
                    get: { selection },
                    set: { next in
                        if let next { onChange(next) }
                    })
            ) {
                if selection == nil {
                    Text(placeholder ?? "").tag(LotDestination?.none)
                }
                if allowKeep {
                    Text(strings.t("accounts.close.portfolioKeep")).tag(LotDestination?.some(.keep))
                }
                Text(strings.t("accounts.close.portfolioUnassigned")).tag(LotDestination?.some(.unassigned))
                ForEach(destinations, id: \.id) { account in
                    Text(verbatim: AccountKinds.label(account)).tag(LotDestination?.some(.account(account.id)))
                }
            }
            .labelsHidden()
            .disabled(disabled)
            .accessibilityLabel(strings.t("accounts.close.portfolioDestination"))
        }
    }
}

// MARK: - Close account

/// `CloseAccountDialog`: the portfolio lot choice of a broker account, the residual warning
/// with Zero the account balance, and Close account.
struct CloseAccountSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let draft = model.close {
            AccountDialogFrame(
                title: strings.t("accounts.close.title", ["name": AccountKinds.label(draft.account)]),
                description: strings.t("accounts.close.description"),
                closeLabel: strings.t("common.close")
            ) {
                if draft.isPortfolio {
                    lots(draft)
                }
                if !draft.residualParts.isEmpty {
                    AccountCallout(tint: theme.warning) {
                        Text(strings.t("accounts.close.residual", ["balance": model.residualLabel(draft)]))
                            .fixedSize(horizontal: false, vertical: true)
                        Toggle(isOn: Binding(get: { model.close?.zeroOut ?? true }, set: { model.close?.zeroOut = $0 })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(strings.t("accounts.close.zeroOut"))
                                Text(strings.t("accounts.close.zeroOutHint"))
                                    .font(.footnote)
                                    .foregroundStyle(theme.secondaryLabel)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .toggleStyle(.checkbox)
                        .accessibilityLabel(strings.t("accounts.close.zeroOut"))
                    }
                }
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeCloseDialog() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await model.confirmClose() }
                } label: {
                    HStack(spacing: 6) {
                        if draft.isClosing { ProgressView().controlSize(.small) }
                        Text(strings.t("accounts.close.confirm"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canClose)
            }
        }
    }

    @ViewBuilder
    private func lots(_ draft: CloseDraft) -> some View {
        switch draft.lotPreview {
        case .loading?:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(strings.t("accounts.close.portfolioLoading"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        case .failed?:
            Text(strings.t("accounts.close.portfolioUnavailable"))
                .font(.footnote)
                .foregroundStyle(theme.warning)
        case .loaded(let preview)?:
            if preview.eligibleCount > 0 {
                AdminCard(padding: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        LotDestinationChoice(
                            eligibleCount: preview.eligibleCount, destinations: draft.destinations,
                            selection: draft.lotChoice, allowKeep: true, strings: strings
                        ) { choice in
                            model.setCloseLotChoice(choice)
                        }
                        if preview.isOverLimit {
                            Text(strings.t("accounts.close.portfolioOverLimit", ["limit": String(preview.limit)]))
                                .font(.footnote)
                                .foregroundStyle(theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        case nil:
            EmptyView()
        }
    }
}

// MARK: - Transfer portfolio lots

/// `BrokerTransferDialog`: the lot preview, the destination accounts, the destination
/// select and Transfer lots; after a transfer, the receipt and Close.
struct BrokerTransferSheet: View {
    let model: AccountsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let draft = model.transfer {
            AccountDialogFrame(
                title: strings.t("portfolio.brokerTransfer.title", ["name": AccountKinds.label(draft.account)]),
                description: strings.t("portfolio.brokerTransfer.description"),
                closeLabel: strings.t("common.close")
            ) {
                content(draft)
            } footer: {
                Spacer()
                if draft.receipt != nil {
                    Button(strings.t("common.close")) { model.closeTransfer() }
                        .buttonStyle(.visionPrimary)
                        .keyboardShortcut(.defaultAction)
                } else {
                    Button(strings.t("common.cancel")) { model.closeTransfer() }
                        .keyboardShortcut(.cancelAction)
                    Button {
                        Task { await model.confirmTransfer() }
                    } label: {
                        HStack(spacing: 6) {
                            if draft.isTransferring {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.left.arrow.right")
                            }
                            Text(strings.t("portfolio.brokerTransfer.confirm"))
                        }
                    }
                    .buttonStyle(.visionPrimary)
                    .disabled(!draft.canTransfer)
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ draft: BrokerTransferDraft) -> some View {
        if let receipt = draft.receipt {
            AccountCallout(tint: theme.success, symbol: "checkmark.circle") {
                Text(strings.t("portfolio.brokerTransfer.receipt"))
                    .fontWeight(.medium)
                Text(strings.t("portfolio.brokerTransfer.receiptCount", ["count": String(receipt.movedCount)]))
            }
        } else if draft.preview.isLoading {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(strings.t("portfolio.brokerTransfer.loading"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
        } else if draft.preview.isFailed {
            AccountCallout(tint: theme.warning) {
                Text(strings.t("portfolio.brokerTransfer.unavailable"))
                Button(strings.t("common.retry")) { Task { await model.loadTransferPreview() } }
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
            }
        } else if draft.preview.value?.eligibleCount == 0 {
            Text(strings.t("portfolio.brokerTransfer.empty"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
        } else if draft.accounts.isLoading {
            Text(strings.t("portfolio.brokerTransfer.accountsLoading"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
        } else if draft.accounts.isFailed {
            AccountCallout(tint: theme.warning) {
                Text(strings.t("portfolio.brokerTransfer.accountsFailed"))
                    .fixedSize(horizontal: false, vertical: true)
                Button(strings.t("common.retry")) { Task { await model.loadTransferAccounts() } }
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
            }
        } else if let preview = draft.preview.value {
            LotDestinationChoice(
                eligibleCount: preview.eligibleCount, destinations: draft.destinations, selection: draft.destination,
                allowKeep: false, placeholder: strings.t("portfolio.brokerTransfer.chooseDestination"),
                disabled: draft.isOverLimit, strings: strings
            ) { destination in
                model.setTransferDestination(destination)
            }
            if draft.isOverLimit {
                Text(strings.t("portfolio.brokerTransfer.overLimit", ["limit": String(preview.limit)]))
                    .font(.caption)
                    .foregroundStyle(theme.warning)
            }
        }
    }
}

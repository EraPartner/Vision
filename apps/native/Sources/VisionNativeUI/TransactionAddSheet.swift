import SwiftUI
import VisionNativeCore

/// `AddTransactionSheet` (ADR-181) as a sheet: the Expense / Income / Transfer control, the
/// large amount with its sign and currency, the payee (with "Add {name}"), category and
/// account, or the From and To accounts of a transfer, the Today / Yesterday / Other date
/// control, the description and the comment. A blocked submit reveals the field errors and
/// focuses the first; Return or ⌘Return adds, Escape or Cancel closes and keeps the form.
struct TransactionAddSheet: View {
    let model: TransactionsModel
    let form: AddTransactionModel
    let shell: NativeShellModel
    @FocusState private var focused: AddTransactionField?
    @FocusState private var amountFocused: Bool
    @Environment(\.visionTheme) private var theme

    init(model: TransactionsModel, form: AddTransactionModel, shell: NativeShellModel) {
        self.model = model
        self.form = form
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var pickers: PickerDataModel { model.pickers }
    private var draft: AddTransactionDraft { form.draft }
    private var errors: [AddTransactionField: String] { form.visibleErrors(format: settings.numberFormat) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(strings.t("form.addTransaction.title"))
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.dismissAdd()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(strings.t("common.close"))
                .help(strings.t("common.close"))
            }
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 8)
            ScrollViewReader { proxy in
                ScrollView {
                    fields
                        .padding(.horizontal, 24)
                        .padding(.vertical, 16)
                }
                .onChange(of: form.focusRequest) { _, request in
                    guard let request else { return }
                    withAnimation { proxy.scrollTo(Optional(request), anchor: .center) }
                    if request == .amount {
                        amountFocused = true
                    } else {
                        focused = request
                    }
                    form.focusHandled()
                }
            }
            Divider()
            footer
        }
        .frame(minWidth: 440, idealWidth: 470, minHeight: 560, idealHeight: 720)
        .foregroundStyle(theme.foreground)
        .task { await model.pickers.load() }
        .onAppear { amountFocused = true }
    }

    // MARK: Fields

    private var fields: some View {
        VStack(alignment: .leading, spacing: 18) {
            Picker(
                strings.t("addTxn.kind"),
                selection: Binding(get: { draft.kind }, set: { form.setKind($0) })
            ) {
                ForEach(TransactionKind.allCases, id: \.self) { kind in
                    Text(strings.t(kind.labelKey)).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 320)
            .frame(maxWidth: .infinity)
            .accessibilityLabel(strings.t("addTxn.kind"))
            amountRow
            if draft.kind == .transfer {
                field("addTxn.fromAccount", error: .account) {
                    AccountPicker(
                        pickers: pickers, value: draft.accountName,
                        placeholder: strings.t("addTxn.bankAccountPlaceholder"), invalid: errors[.account] != nil,
                        strings: strings
                    ) { name, id in form.pickAccount(name: name, id: id) }
                }
                field("addTxn.toAccount", error: .toAccount) {
                    AccountPicker(
                        pickers: pickers, value: draft.toAccountName,
                        placeholder: strings.t("addTxn.bankAccountPlaceholder"), invalid: errors[.toAccount] != nil,
                        strings: strings
                    ) { name, id in form.pickToAccount(name: name, id: id) }
                }
            } else {
                field(form.recipientLabelKey, error: .recipient) {
                    RecipientPicker(
                        pickers: pickers, value: draft.recipientId, invalid: errors[.recipient] != nil,
                        activeOnly: true, strings: strings,
                        onSelect: { id in Task { await form.selectRecipient(id) } },
                        onCreate: { name in Task { await model.createRecipientForAdd(named: name) } })
                }
                field("addTxn.categoryOptional") {
                    CategoryPicker(pickers: pickers, value: draft.categoryId, strings: strings) { id in
                        form.selectCategory(id)
                    }
                    if form.categoryAuto, let source = form.usualCategorySource {
                        Text(
                            strings.t(
                                "addTxn.usualCategory",
                                ["name": source.name, "category": source.defaultCategoryName ?? ""])
                        )
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                    }
                }
                field("addTxn.bankAccount", error: .account) {
                    AccountPicker(
                        pickers: pickers, value: draft.accountName,
                        placeholder: strings.t("addTxn.bankAccountPlaceholder"), invalid: errors[.account] != nil,
                        strings: strings
                    ) { name, id in form.pickAccount(name: name, id: id) }
                }
            }
            dateField
            field("addTxn.descMemo") {
                TextField(
                    strings.t("addTxn.descPlaceholder"), text: Binding(get: { draft.memo }, set: { form.setMemo($0) })
                )
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
            }
            field("addTxn.commentOptional") {
                TextEditor(text: Binding(get: { draft.comment }, set: { form.setComment($0) }))
                    .font(.body)
                    .frame(height: 64)
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                            .strokeBorder(theme.border.opacity(0.7), lineWidth: 1))
                    .overlay(alignment: .topLeading) {
                        if draft.comment.isEmpty {
                            Text(strings.t("addTxn.commentPlaceholder"))
                                .foregroundStyle(theme.tertiaryLabel)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .allowsHitTesting(false)
                        }
                    }
                    .accessibilityLabel(strings.t("addTxn.commentOptional"))
            }
            if form.duplicateDetected {
                duplicatePrompt
            }
        }
    }

    /// The sign, the large amount and the currency code.
    private var amountRow: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if !draft.kind.signGlyph.isEmpty {
                    Text(verbatim: draft.kind.signGlyph)
                        .font(.visionLargeTitle)
                        .foregroundStyle(theme.tertiaryLabel)
                        .accessibilityHidden(true)
                }
                TextField(
                    LocaleNumber.placeholder(format: settings.numberFormat),
                    text: Binding(get: { draft.amount }, set: { form.setAmount($0) })
                )
                .textFieldStyle(.plain)
                .font(.visionLargeTitle.monospacedDigit())
                .multilineTextAlignment(.center)
                .frame(width: 200)
                .focused($amountFocused)
                .onSubmit(submit)
                .accessibilityLabel(strings.t("form.addTransaction.amount"))
                TextField(
                    strings.t("addTxn.currencyPlaceholder"),
                    text: Binding(get: { draft.currency }, set: { form.setCurrency($0) })
                )
                .textFieldStyle(.roundedBorder)
                .frame(width: 64)
                .onSubmit(submit)
                .accessibilityLabel(strings.t("accounts.field.currency"))
            }
            .frame(maxWidth: .infinity)
            if let key = errors[.amount] {
                Text(strings.t(key))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
        }
        .id(Optional(AddTransactionField.amount))
    }

    private var dateField: some View {
        field("form.addTransaction.date", error: .date) {
            HStack(spacing: 8) {
                Picker(
                    strings.t("form.addTransaction.date"),
                    selection: Binding(get: { form.dateChoice }, set: { form.setDateChoice($0) })
                ) {
                    ForEach(AddTransactionDateChoice.allCases, id: \.self) { choice in
                        Text(strings.t(choice.labelKey)).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .focused($focused, equals: .date)
                if form.dateChoice == .other {
                    VisionDateField(
                        day: form.day, placeholder: strings.t("plannedPage.link.pickDate"),
                        invalid: errors[.date] != nil, settings: settings, strings: strings, calendar: model.calendar
                    ) { day in form.setCustomDay(day) }
                }
            }
            if let anchor = form.backdatedAnchorDate {
                Text(
                    strings.t(
                        "addTxn.backdatedBeforeAnchor",
                        ["date": VisionFormat.appDate(anchor, format: settings.dateFormat)])
                )
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var duplicatePrompt: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(theme.destructive)
                .accessibilityHidden(true)
            Text(strings.t("addTxn.duplicatePrompt"))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(strings.t("addTxn.addAnyway")) {
                Task { await model.submitAdd(allowDuplicate: true) }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(form.isPending)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.destructive.opacity(0.08)))
    }

    private func field<Content: View>(
        _ labelKey: String, error: AddTransactionField? = nil, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(labelKey))
                .font(.callout.weight(.medium))
            content()
            if let error, let key = errors[error] {
                Text(strings.t(key))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
        }
        .id(error)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 12) {
            Text(strings.t(form.hintKey))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.updatesFrequently)
            Button(strings.t("common.cancel")) {
                model.dismissAdd()
            }
            .keyboardShortcut(.cancelAction)
            Button(action: submit) {
                HStack(spacing: 6) {
                    if form.isPending {
                        ProgressView().controlSize(.small)
                    }
                    Text(strings.t(draft.kind.submitKey))
                }
            }
            .buttonStyle(.visionPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(form.isPending)
            // ⌘Return adds from any field, the comment included.
            Button("", action: submit)
                .keyboardShortcut(SwiftUI.KeyEquivalent.return, modifiers: .command)
                .frame(width: 0, height: 0)
                .opacity(0)
                .accessibilityHidden(true)
                .disabled(form.isPending)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    private func submit() {
        Task { await model.submitAdd() }
    }
}

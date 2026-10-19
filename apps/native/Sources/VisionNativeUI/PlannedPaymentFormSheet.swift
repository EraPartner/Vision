import SwiftUI
import VisionNativeCore

/// `PlannedPaymentForm` (apps/frontend/src/features/planned/PlannedPaymentForm.tsx) as a
/// sheet: New payment or Edit payment with every field of the web form. A blocked submit
/// shows the field errors and scrolls to and focuses the first invalid field; Return in a
/// text field submits; Cancel, the close button or Escape close without saving.
struct PlannedPaymentFormSheet: View {
    let model: PlannedPaymentsModel
    @Bindable var form: PlannedPaymentFormModel
    let shell: NativeShellModel
    @FocusState private var focused: PlannedFormField?
    @Environment(\.visionTheme) var theme

    init(model: PlannedPaymentsModel, form: PlannedPaymentFormModel, shell: NativeShellModel) {
        self.model = model
        _form = Bindable(wrappedValue: form)
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var pickers: PickerDataModel { model.pickers }
    private var saving: Bool { model.actionLoading }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(strings.t(form.titleKey))
                    .font(.visionCardTitle)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.dismissEditor()
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
                .onChange(of: form.focusToken) {
                    guard let field = form.focusField else { return }
                    withAnimation { proxy.scrollTo(Optional(field), anchor: .center) }
                    focused = field
                }
            }
            Divider()
            footer
        }
        .frame(minWidth: 460, idealWidth: 500, minHeight: 520, idealHeight: 720)
        .foregroundStyle(theme.foreground)
        .task { await model.pickers.load() }
    }

    // MARK: Fields

    private var fields: some View {
        VStack(alignment: .leading, spacing: 18) {
            field("plannedForm.nameRequired2", error: .name) {
                TextField(strings.t("plannedForm.namePlaceholder"), text: $form.name)
                    .textFieldStyle(.vision)
                    .focused($focused, equals: .name)
                    .onSubmit(save)
            }
            HStack(alignment: .top, spacing: 12) {
                field("plannedForm.amountRequired2", error: .amount) {
                    TextField(form.amountPlaceholder, text: $form.amount)
                        .textFieldStyle(.vision)
                        .focused($focused, equals: .amount)
                        .onSubmit(save)
                }
                .frame(maxWidth: .infinity)
                field("plannedForm.currency") {
                    Picker(strings.t("plannedForm.currency"), selection: $form.currency) {
                        ForEach(currencyOptions, id: \.self) { code in
                            Text(verbatim: code).tag(code)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
                .frame(width: 140)
            }
            directionField
            field("plannedForm.dueDate", error: .dueDate) {
                VisionDateField(
                    day: form.dueDate, placeholder: strings.t("plannedForm.pickDate"),
                    invalid: form.visibleErrorKey(.dueDate) != nil, settings: settings, strings: strings,
                    calendar: model.calendar
                ) { day in form.setDueDate(day) }
            }
            field("plannedForm.recipient") {
                RecipientPicker(pickers: pickers, value: form.recipientId, disabled: saving, strings: strings) { id in
                    form.recipientId = id
                }
            }
            field("plannedForm.category") {
                CategoryPicker(pickers: pickers, value: form.categoryId, disabled: saving, strings: strings) { id in
                    form.categoryId = id
                }
            }
            field("txPage.field.tags") {
                TagField(
                    pickers: pickers, selected: form.tags, label: strings.t("txPage.field.tags"), strings: strings
                ) { tags in form.tags = tags }
            }
            field("plannedForm.bankAccountRequired", error: .bank) {
                AccountPicker(
                    pickers: pickers, value: form.bankAccount, placeholder: strings.t("plannedForm.bankPlaceholder"),
                    invalid: form.visibleErrorKey(.bank) != nil, strings: strings
                ) { name, id in form.pickAccount(name: name, id: id) }
            }
            switchGroup(
                "plannedForm.loan", help: "plannedForm.loanDesc", isOn: $form.isLoan, disabled: false)
            if form.isLoan { loanFields }
            switchGroup(
                "plannedForm.recurring", help: "plannedForm.recurringDesc",
                isOn: Binding(get: { form.effectiveRecurring }, set: { form.isRecurring = $0 }), disabled: form.isLoan)
            if form.showsRecurrenceFields { recurrenceFields }
            field("plannedForm.notes") {
                TextEditor(text: $form.notes)
                    .font(.body)
                    .frame(height: 48)
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                            .strokeBorder(theme.border.opacity(0.7), lineWidth: 1))
                    .overlay(alignment: .topLeading) {
                        if form.notes.isEmpty {
                            Text(strings.t("plannedForm.notesPlaceholder2"))
                                .foregroundStyle(theme.tertiaryLabel)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityLabel(strings.t("plannedForm.notes"))
            }
            field("plannedForm.link") {
                TextField(strings.t("plannedForm.linkPlaceholder"), text: $form.url)
                    .textFieldStyle(.vision)
                    .onSubmit(save)
                helpText("plannedForm.linkDesc")
            }
        }
    }

    /// The six offered currencies, plus a stored one outside them so an edit still shows it.
    private var currencyOptions: [String] {
        let offered = PlannedPaymentFormModel.currencies
        return offered.contains(form.currency) ? offered : offered + [form.currency]
    }

    private var directionField: some View {
        field("plannedForm.direction") {
            Picker(
                strings.t("plannedForm.direction"),
                selection: Binding(get: { form.effectiveDirection }, set: { form.direction = $0 })
            ) {
                Label(strings.t(PlannedDirection.expense.labelKey), systemImage: "arrow.down.right")
                    .tag(PlannedDirection.expense)
                Label(strings.t(PlannedDirection.income.labelKey), systemImage: "arrow.up.right")
                    .tag(PlannedDirection.income)
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .disabled(form.isLoan)
            helpText(form.directionHelpKey)
        }
    }

    private var loanFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("plannedForm.loanType") {
                Picker(strings.t("plannedForm.loanType"), selection: $form.loanType) {
                    Text(strings.t("plannedForm.loanType.amortizing")).tag(OpenAPI.PlannedLoanType.amortizing)
                    Text(strings.t("plannedForm.loanType.fixedPrincipal")).tag(OpenAPI.PlannedLoanType.fixedPrincipal)
                    Text(strings.t("plannedForm.loanType.interestOnly")).tag(OpenAPI.PlannedLoanType.interestOnly)
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
            HStack(alignment: .top, spacing: 12) {
                field("plannedForm.loanPrincipal", error: .loanPrincipal) {
                    TextField("", text: $form.loanPrincipal)
                        .textFieldStyle(.vision)
                        .focused($focused, equals: .loanPrincipal)
                        .onSubmit(save)
                }
                field("plannedForm.loanRate", error: .loanRate) {
                    TextField("", text: $form.loanRate)
                        .textFieldStyle(.vision)
                        .focused($focused, equals: .loanRate)
                        .onSubmit(save)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                field("plannedForm.loanTermMonths", error: .loanTerm) {
                    TextField("", text: $form.loanTermMonths)
                        .textFieldStyle(.vision)
                        .focused($focused, equals: .loanTerm)
                        .onSubmit(save)
                }
                field("plannedForm.loanPaymentDay") {
                    TextField(form.loanPaymentDayPlaceholder, text: $form.loanPaymentDay)
                        .textFieldStyle(.vision)
                        .onSubmit(save)
                }
            }
        }
        .padding(12)
        .background(groupBackground)
    }

    private var recurrenceFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("plannedForm.frequency") {
                Picker(strings.t("plannedForm.frequency"), selection: $form.frequency) {
                    ForEach(PlannedPaymentFormModel.frequencies, id: \.self) { frequency in
                        Text(strings.t("plannedForm.freq.\(frequency.rawValue)")).tag(frequency)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
            if form.showsCustomDays {
                field("plannedForm.repeatEvery", error: .customDays) {
                    TextField(strings.t("plannedForm.customDaysPlaceholder"), text: $form.customDays)
                        .textFieldStyle(.vision)
                        .focused($focused, equals: .customDays)
                        .onSubmit(save)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                field("plannedForm.endDate") {
                    VisionDateField(
                        day: form.endDate, placeholder: strings.t("plannedForm.freq.none"), allowClear: true,
                        clearLabel: strings.t("common.clear"), settings: settings, strings: strings,
                        calendar: model.calendar
                    ) { day in form.endDate = day }
                }
                field("plannedForm.maxOccurrences") {
                    TextField(String("∞"), text: $form.maxOccurrences)
                        .textFieldStyle(.vision)
                        .onSubmit(save)
                }
            }
        }
        .padding(12)
        .background(groupBackground)
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
                form.resetErrors()
                model.dismissEditor()
            }
            .keyboardShortcut(.cancelAction)
            Button(action: save) {
                HStack(spacing: 6) {
                    if saving {
                        ProgressView().controlSize(.small)
                    }
                    Text(strings.t(form.submitKey))
                }
            }
            .buttonStyle(.visionPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(saving)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
    }

    private func save() {
        Task { await model.saveEditor(strings: strings) }
    }

    // MARK: Pieces

    private var groupBackground: some View {
        RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
            .fill(theme.foreground.opacity(0.04))
    }

    private func field<Content: View>(
        _ labelKey: String, error: PlannedFormField? = nil, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(labelKey))
                .font(.callout.weight(.medium))
            content()
            if let error, let key = form.visibleErrorKey(error) {
                Text(strings.t(key))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
        }
        .id(error)
    }

    private func helpText(_ key: String) -> some View {
        Text(strings.t(key))
            .font(.footnote)
            .foregroundStyle(theme.secondaryLabel)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func switchGroup(_ labelKey: String, help: String, isOn: Binding<Bool>, disabled: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.t(labelKey))
                    .font(.body.weight(.medium))
                helpText(help)
            }
            Spacer(minLength: 0)
            Toggle(strings.t(labelKey), isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(disabled)
        }
        .padding(12)
        .background(groupBackground)
    }
}

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
            VisionDialogHeader(
                title: strings.t(form.titleKey), closeLabel: strings.t("common.close"),
                onClose: { model.dismissEditor() })
            .padding(.horizontal, 24)
            .padding(.top, 24)
            ScrollViewReader { proxy in
                ScrollView {
                    fields
                        .padding(.horizontal, 24)
                        .padding(.vertical, 20)
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(theme.foreground)
        .task { await model.pickers.load() }
    }

    // MARK: Fields

    private var fields: some View {
        VStack(alignment: .leading, spacing: 20) {
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
                    VisionSelect(
                        selection: $form.currency,
                        options: currencyOptions.map { code in VisionSelectOption(value: code, title: code.rawValue) },
                        accessibilityLabel: strings.t("plannedForm.currency"), expands: true)
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
                    .visionTextEditor(minHeight: 48)
                    .overlay(alignment: .topLeading) {
                        if form.notes.isEmpty {
                            Text(strings.t("plannedForm.notesPlaceholder2"))
                                .font(VisionControlMetrics.fieldFont)
                                .foregroundStyle(theme.tertiaryLabel)
                                .padding(.horizontal, VisionControlMetrics.fieldHorizontalPadding)
                                .padding(.vertical, VisionControlMetrics.textAreaVerticalPadding)
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
    private var currencyOptions: [CurrencyCode] {
        let offered = PlannedPaymentFormModel.currencies
        return offered.contains(form.currency) ? offered : offered + [form.currency]
    }

    private var directionField: some View {
        field("plannedForm.direction") {
            VisionSegmentedControl(
                selection: Binding(get: { form.effectiveDirection }, set: { form.direction = $0 }),
                options: [
                    VisionSegmentOption(
                        value: PlannedDirection.expense, title: strings.t(PlannedDirection.expense.labelKey),
                        systemImage: "arrow.down.right"),
                    VisionSegmentOption(
                        value: PlannedDirection.income, title: strings.t(PlannedDirection.income.labelKey),
                        systemImage: "arrow.up.right"),
                ]
            )
            .accessibilityLabel(strings.t("plannedForm.direction"))
            .disabled(form.isLoan)
            helpText(form.directionHelpKey)
        }
    }

    private var loanFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("plannedForm.loanType") {
                VisionSelect(
                    selection: $form.loanType,
                    options: [
                        VisionSelectOption(
                            value: OpenAPI.PlannedLoanType.amortizing,
                            title: strings.t("plannedForm.loanType.amortizing")),
                        VisionSelectOption(
                            value: OpenAPI.PlannedLoanType.fixedPrincipal,
                            title: strings.t("plannedForm.loanType.fixedPrincipal")),
                        VisionSelectOption(
                            value: OpenAPI.PlannedLoanType.interestOnly,
                            title: strings.t("plannedForm.loanType.interestOnly")),
                    ],
                    accessibilityLabel: strings.t("plannedForm.loanType"), expands: true)
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
                VisionSelect(
                    selection: $form.frequency,
                    options: PlannedPaymentFormModel.frequencies.map { frequency in
                        VisionSelectOption(
                            value: frequency, title: strings.t("plannedForm.freq.\(frequency.rawValue)"))
                    },
                    accessibilityLabel: strings.t("plannedForm.frequency"), expands: true)
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
            .buttonStyle(.visionOutline)
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
        .controlSize(.large)
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
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
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(labelKey))
                .font(.callout.weight(.medium))
                .foregroundStyle(theme.foreground)
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
                .toggleStyle(.visionSwitch)
                .disabled(disabled)
        }
        .padding(12)
        .background(groupBackground)
    }
}

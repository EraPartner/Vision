import SwiftUI
import VisionNativeCore

/// `DatePicker` (apps/frontend/src/components/shared/DatePicker.tsx): a button showing the
/// day in the app date format (or the placeholder) that opens a popover with a typed-date
/// field (`datePicker.inputLabel`), a calendar and, when allowed and set, Clear.
struct VisionDateField: View {
    let day: PlannedDay?
    let placeholder: String
    var allowClear = false
    var clearLabel: String?
    var invalid = false
    var disabled = false
    let settings: NativeAppSettings
    let strings: any Localizing
    let calendar: Calendar
    let onChange: (PlannedDay?) -> Void
    @State var isOpen = false
    @Environment(\.visionTheme) var theme

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "calendar")
                    .foregroundStyle(theme.secondaryLabel)
                    .accessibilityHidden(true)
                Text(day.map { $0.text(format: settings.dateFormat) } ?? placeholder)
                    .foregroundStyle(day == nil ? theme.tertiaryLabel : theme.foreground)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.visionOutline)
        .disabled(disabled)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                .strokeBorder(invalid ? theme.destructive : Color.clear, lineWidth: 1)
        )
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            VisionDatePopover(
                day: day, allowClear: allowClear, clearLabel: clearLabel ?? strings.t("common.clear"),
                settings: settings, strings: strings, calendar: calendar,
                onChange: { next in
                    onChange(next)
                },
                close: { isOpen = false }
            )
            .environment(\.visionTheme, theme)
        }
    }
}

/// The popover of `VisionDateField`: Return or leaving the typed field commits a day in
/// exactly the app format, else shows `datePicker.invalidFormat`.
struct VisionDatePopover: View {
    let day: PlannedDay?
    let allowClear: Bool
    let clearLabel: String
    let settings: NativeAppSettings
    let strings: any Localizing
    let calendar: Calendar
    let onChange: (PlannedDay?) -> Void
    let close: () -> Void
    @State var draft: String
    @State var inputError = false
    @FocusState private var inputFocused: Bool
    @Environment(\.visionTheme) var theme

    init(
        day: PlannedDay?, allowClear: Bool, clearLabel: String, settings: NativeAppSettings, strings: any Localizing,
        calendar: Calendar, onChange: @escaping (PlannedDay?) -> Void, close: @escaping () -> Void
    ) {
        self.day = day
        self.allowClear = allowClear
        self.clearLabel = clearLabel
        self.settings = settings
        self.strings = strings
        self.calendar = calendar
        self.onChange = onChange
        self.close = close
        _draft = State(initialValue: day.map { $0.text(format: settings.dateFormat) } ?? "")
    }

    private var format: AppDateFormat { settings.dateFormat }

    private var formatted: String { day.map { $0.text(format: format) } ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("datePicker.inputLabel", ["format": format.rawValue]))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                TextField(format.rawValue, text: $draft)
                    .textFieldStyle(.vision)
                    .focused($inputFocused)
                    .onSubmit(commitDraft)
                    .onChange(of: draft) {
                        if inputError { inputError = false }
                    }
                    .onChange(of: inputFocused) { _, focused in
                        if !focused { commitDraft() }
                    }
                    .accessibilityLabel(strings.t("datePicker.inputLabel", ["format": format.rawValue]))
                if inputError {
                    Text(strings.t("datePicker.invalidFormat", ["format": format.rawValue]))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .padding(12)
            Divider()
            DatePicker(
                "",
                selection: Binding(
                    get: { day?.date(calendar: calendar) ?? calendar.startOfDay(for: Date()) },
                    set: { picked in select(PlannedDay(picked, calendar: calendar)) }),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .labelsHidden()
            .environment(\.calendar, calendar)
            .environment(\.locale, LanguageLocale.locale(strings.language))
            .padding(12)
            if allowClear && day != nil {
                Divider()
                Button {
                    inputError = false
                    draft = ""
                    onChange(nil)
                    close()
                } label: {
                    Label(clearLabel, systemImage: "xmark")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .padding(10)
            }
        }
        .frame(width: 280)
        .onDisappear {
            // Closing the popover leaves the typed field like a blur.
            if draft != formatted && !draft.isEmpty { commitDraft() }
        }
    }

    private func commitDraft() {
        switch AppDateInput.commit(draft, current: day, format: format, allowClear: allowClear) {
        case .keep:
            inputError = false
            draft = formatted
        case .clear:
            inputError = false
            draft = ""
            onChange(nil)
        case .set(let parsed):
            inputError = false
            draft = parsed.text(format: format)
            onChange(parsed)
        case .invalid:
            inputError = true
        }
    }

    private func select(_ picked: PlannedDay) {
        inputError = false
        draft = picked.text(format: format)
        onChange(picked)
        close()
    }
}

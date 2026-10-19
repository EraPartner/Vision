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
            // The web Calendar (react-day-picker): month caption with chevrons, weekday row,
            // 32 pt day cells, primary fill for the chosen day, a tint for today. The system
            // graphical DatePicker drew a small boxed grid that read as an AppKit control.
            VisionCalendarGrid(
                selected: day, calendar: calendar, locale: LanguageLocale.locale(strings.language),
                previousLabel: strings.t("common.previous"), nextLabel: strings.t("common.next"),
                onSelect: select
            )
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

/// A month grid of day buttons in the page theme, starting on `calendar.firstWeekday`.
struct VisionCalendarGrid: View {
    let selected: PlannedDay?
    let calendar: Calendar
    let locale: Locale
    let previousLabel: String
    let nextLabel: String
    let onSelect: (PlannedDay) -> Void
    @State private var month: Date
    @Environment(\.visionTheme) private var theme

    init(
        selected: PlannedDay?, calendar: Calendar, locale: Locale, previousLabel: String, nextLabel: String,
        onSelect: @escaping (PlannedDay) -> Void
    ) {
        self.selected = selected
        self.calendar = calendar
        self.locale = locale
        self.previousLabel = previousLabel
        self.nextLabel = nextLabel
        self.onSelect = onSelect
        let anchor = selected?.date(calendar: calendar) ?? Date()
        let start = calendar.date(from: calendar.dateComponents([.year, .month], from: anchor)) ?? anchor
        _month = State(initialValue: start)
    }

    private static let cell: CGFloat = 32

    var body: some View {
        let days = gridDays
        let today = PlannedDay(Date(), calendar: calendar)
        VStack(spacing: 6) {
            HStack {
                Text(monthTitle).font(.body.weight(.semibold)).foregroundStyle(theme.foreground)
                Spacer()
                stepButton("chevron.left", label: previousLabel, by: -1)
                stepButton("chevron.right", label: nextLabel, by: 1)
            }
            .padding(.bottom, 4)
            HStack(spacing: 0) {
                ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol).font(.caption.weight(.medium)).foregroundStyle(theme.tertiaryLabel)
                        .frame(width: Self.cell, height: 22)
                }
            }
            ForEach(0..<(days.count / 7), id: \.self) { week in
                HStack(spacing: 0) {
                    ForEach(0..<7, id: \.self) { weekday in
                        let date = days[week * 7 + weekday]
                        dayButton(date, today: today)
                    }
                }
            }
        }
        .fixedSize()
    }

    private func dayButton(_ date: Date, today: PlannedDay) -> some View {
        let day = PlannedDay(date, calendar: calendar)
        let isSelected = day == selected
        let isToday = day == today
        let inMonth = calendar.isDate(date, equalTo: month, toGranularity: .month)
        return Button {
            onSelect(day)
        } label: {
            Text(String(day.day))
                .font(.callout.weight(isSelected || isToday ? .semibold : .regular))
                .monospacedDigit()
                .foregroundStyle(
                    isSelected ? theme.primaryForeground : inMonth ? theme.foreground : theme.tertiaryLabel
                )
                .frame(width: Self.cell, height: Self.cell)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip + 2, style: .continuous)
                        .fill(isSelected ? theme.primary : isToday ? theme.primary.opacity(0.14) : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(date.formatted(Date.FormatStyle(date: .complete, time: .omitted, locale: locale)))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func stepButton(_ symbol: String, label: String, by months: Int) -> some View {
        Button {
            if let next = calendar.date(byAdding: .month, value: months, to: month) { month = next }
        } label: {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.secondaryLabel)
                .frame(width: 26, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                        .strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    private var monthTitle: String {
        month.formatted(Date.FormatStyle(locale: locale).month(.wide).year())
    }

    /// Short weekday names rotated so the row starts on the calendar's first weekday.
    private var weekdaySymbols: [String] {
        var formatter = calendar
        formatter.locale = locale
        let symbols = formatter.shortWeekdaySymbols
        let first = calendar.firstWeekday - 1
        return Array(symbols[first...] + symbols[..<first]).map { String($0.prefix(2)) }
    }

    /// Six weeks from the first-weekday on or before the 1st, so the grid never jumps height.
    private var gridDays: [Date] {
        let weekday = calendar.component(.weekday, from: month)
        let lead = (weekday - calendar.firstWeekday + 7) % 7
        guard let start = calendar.date(byAdding: .day, value: -lead, to: month) else { return [] }
        return (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }
}

import SwiftUI
import VisionNativeCore

/// The search field's dropdown (`TransactionSearchSuggestions`): All income, All expenses,
/// the amount and date quick filters, and Free search; the amount, year and date-range
/// suggestions open a small form with Back and Apply.
struct TransactionSearchSuggestionsView: View {
    @Binding var state: TransactionSearchSuggestions
    let query: String
    let strings: any Localizing
    let settings: NativeAppSettings
    let calendar: Calendar
    let apply: ([QuickFilterParameter]) -> Void
    let close: () -> Void
    @Environment(\.visionTheme) private var theme

    private var currency: String { LedgerCurrency.display(settings).rawValue }

    var body: some View {
        Group {
            switch state.mode {
            case .list: list
            case .amountExact, .amountRange: amountForm
            case .year: yearForm
            case .dateRange: dateForm
            }
        }
        .frame(width: 340, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.card)
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
        .onExitCommand(perform: close)
    }

    // MARK: List

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(strings.t("search.suggest.header"))
                .font(.caption.weight(.medium))
                .foregroundStyle(theme.secondaryLabel)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 4)
            row(strings.t("search.suggest.allIncome"), symbol: "arrow.up.right") {
                apply(TransactionSearchSuggestions.type(.income))
            }
            row(strings.t("search.suggest.allExpense"), symbol: "arrow.down.right") {
                apply(TransactionSearchSuggestions.type(.expense))
            }
            row(strings.t("search.suggest.amountExact", ["currency": currency]), symbol: "eurosign.circle") {
                state.mode = .amountExact
            }
            row(strings.t("search.suggest.amountRange", ["currency": currency]), symbol: "eurosign.circle") {
                state.mode = .amountRange
            }
            row(strings.t("search.suggest.ofYear", ["year": String(state.thisYear)]), symbol: "calendar") {
                apply(TransactionSearchSuggestions.yearRange(state.thisYear))
            }
            row(strings.t("search.suggest.ofYear", ["year": String(state.lastYear)]), symbol: "calendar") {
                apply(TransactionSearchSuggestions.yearRange(state.lastYear))
            }
            row(strings.t("search.suggest.year"), symbol: "calendar") {
                state.mode = .year
            }
            row(strings.t("search.suggest.dateRange"), symbol: "calendar.badge.clock") {
                state.mode = .dateRange
            }
            Divider()
            row(
                query.isEmpty
                    ? strings.t("search.suggest.freeSearch")
                    : strings.t("search.suggest.freeSearchFor", ["query": query]),
                symbol: "magnifyingglass", action: close)
        }
        .padding(.bottom, 4)
    }

    private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(width: 16)
                    .accessibilityHidden(true)
                Text(title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func formHeader(_ title: String) -> some View {
        HStack(spacing: 6) {
            Button {
                state.mode = .list
            } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.borderless)
            .help(strings.t("common.back"))
            .accessibilityLabel(strings.t("common.back"))
            Text(title)
                .font(.callout.weight(.medium))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }

    // MARK: Forms

    private var amountForm: some View {
        let isRange = state.mode == .amountRange
        let format = settings.numberFormat
        let parameters = state.amountParameters(format: format)
        return VStack(alignment: .leading, spacing: 8) {
            formHeader(
                isRange
                    ? strings.t("search.suggest.amountRange.title", ["currency": currency])
                    : strings.t("search.suggest.amountExact.title", ["currency": currency]))
            HStack(spacing: 6) {
                TextField(isRange ? strings.t("search.suggest.amount.min") : currency, text: $state.amountA)
                    .textFieldStyle(.vision)
                    .accessibilityLabel(
                        isRange
                            ? strings.t("search.suggest.amount.min")
                            : strings.t("search.suggest.amountExact.title", ["currency": currency]))
                    .onSubmit { if let parameters { apply(parameters) } }
                if isRange {
                    TextField(strings.t("search.suggest.amount.max"), text: $state.amountB)
                        .textFieldStyle(.vision)
                        .accessibilityLabel(strings.t("search.suggest.amount.max"))
                        .onSubmit { if let parameters { apply(parameters) } }
                }
                Button(strings.t("search.suggest.apply")) {
                    if let parameters { apply(parameters) }
                }
                .buttonStyle(.visionPrimary)
                .controlSize(.small)
                .disabled(parameters == nil)
            }
            if state.amountInvalid(format: format) {
                Text(strings.t("search.suggest.amount.invalid"))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
            Text(strings.t("search.suggest.amount.hint"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
        }
        .padding(12)
    }

    private var yearForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            formHeader(strings.t("search.suggest.year.title"))
            HStack(spacing: 6) {
                TextField(String(state.thisYear), text: $state.yearInput)
                    .textFieldStyle(.vision)
                    .accessibilityLabel(strings.t("search.suggest.year.title"))
                    .onSubmit { applyYear() }
                Button(strings.t("search.suggest.apply"), action: applyYear)
                    .buttonStyle(.visionPrimary)
                    .controlSize(.small)
                    .disabled(state.yearValue == nil)
            }
        }
        .padding(12)
    }

    private func applyYear() {
        guard let year = state.yearValue else { return }
        apply(TransactionSearchSuggestions.yearRange(year))
    }

    private var dateForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            formHeader(strings.t("search.suggest.dateRange.title"))
            HStack(spacing: 6) {
                VisionDateField(
                    day: state.dateStart, placeholder: strings.t("search.suggest.date.from"), allowClear: true,
                    invalid: state.datesReversed, settings: settings, strings: strings, calendar: calendar
                ) { day in
                    state.dateStart = day
                }
                VisionDateField(
                    day: state.dateEnd, placeholder: strings.t("search.suggest.date.to"), allowClear: true,
                    invalid: state.datesReversed, settings: settings, strings: strings, calendar: calendar
                ) { day in
                    state.dateEnd = day
                }
            }
            if state.datesReversed {
                Text(strings.t("search.suggest.date.invalidOrder"))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
            HStack {
                Spacer()
                Button(strings.t("search.suggest.apply")) {
                    if let parameters = state.dateParameters { apply(parameters) }
                }
                .buttonStyle(.visionPrimary)
                .controlSize(.small)
                .disabled(state.dateParameters == nil)
            }
        }
        .padding(12)
    }
}

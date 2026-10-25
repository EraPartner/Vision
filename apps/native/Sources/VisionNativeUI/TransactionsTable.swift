import AppKit
import SwiftUI
import VisionNativeCore

/// `TransactionsTable` in server mode (`VirtualDataTable`): the search field with its
/// suggestions, Clear all and the column-filter chips, the sortable, filterable and
/// resizable header, the rows with their editors and menus, the infinite scroll and the
/// footer count.
struct TransactionsTableCard: View {
    let model: TransactionsModel
    let shell: NativeShellModel
    @State private var widths: [String: CGFloat] = [:]
    @State private var openFilter: String?
    @State private var hoveredHeader: String?
    @State private var tableWidth: CGFloat = 1000
    @State private var suggestionsOpen = false
    @State private var suggestions = TransactionSearchSuggestions(thisYear: 2026)
    @FocusState private var searchFocused: Bool
    @FocusState private var focusedRow: TransactionID?
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    /// The stacked layout below `TransactionsModel.compactWidth`.
    private var isCompact: Bool { Double(tableWidth) < TransactionsModel.compactWidth }

    var body: some View {
        // Measures the width the page offers: a sibling takes the proposal as is, while the
        // card's own size would follow rows that overflow it.
        VStack(spacing: 0) {
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: 0)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { width in
                    tableWidth = width
                }
                .accessibilityHidden(true)
            card
        }
    }

    private var card: some View {
        AdminCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                searchBar
                    .zIndex(1)
                if !model.columnFilters.isEmpty { chips }
                headerRow
                Divider()
                rowsList
                if model.isFetchingMore {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(strings.t("table.loadingMore"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                Divider()
                Text(model.footer())
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        }
        .onChange(of: model.focusRequest) { _, request in
            guard let request else { return }
            focusedRow = request
        }
        .onChange(of: focusedRow) { _, id in
            guard let id else { return }
            model.rowFocused(id)
        }
    }

    // MARK: Search

    private var searchBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
                TextField(
                    strings.t("txPage.searchPlaceholder"),
                    text: Binding(get: { model.searchText }, set: { model.searchText = $0 })
                )
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .accessibilityLabel(strings.t("txPage.searchPlaceholder"))
                .onExitCommand { suggestionsOpen = false }
                .onSubmit { suggestionsOpen = false }
                if !model.searchText.isEmpty {
                    Button {
                        Task { await model.clearSearch() }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(theme.tertiaryLabel)
                    .help(strings.t("aria.clearSearch"))
                    .accessibilityLabel(strings.t("aria.clearSearch"))
                }
            }
            // The web search input: full width, `h-9`, `border-input/70` on `bg-background/80`.
            .font(.callout)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 32)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                    .fill(Color(token: theme.palette.background, opacity: 0.8)))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                    .strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if suggestionsOpen {
                    TransactionSearchSuggestionsView(
                        state: $suggestions, query: model.searchText, strings: strings, settings: settings,
                        calendar: model.calendar,
                        apply: { parameters in
                            model.applyQuickFilter(parameters)
                            closeSuggestions()
                        },
                        close: closeSuggestions
                    )
                    .offset(y: 40)
                }
            }
            if model.canClearAll {
                Button {
                    Task { await model.clearAll() }
                } label: {
                    HStack(spacing: 6) {
                        Text(strings.t("table.clearAll"))
                        if model.columnFilters.count > 0 {
                            VisionBadge(text: String(model.columnFilters.count), tone: .primary, small: true)
                        }
                    }
                }
                .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
            if model.showsBulkBar {
                TransactionBulkBar(model: model, shell: shell)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .onChange(of: searchFocused) { _, focused in
            if focused {
                suggestions = TransactionSearchSuggestions(thisYear: model.today.year)
                suggestionsOpen = true
            } else if suggestions.mode == .list {
                suggestionsOpen = false
            }
        }
    }

    private func closeSuggestions() {
        suggestionsOpen = false
        suggestions.mode = .list
    }

    private var chips: some View {
        HStack(spacing: 6) {
            ForEach(model.columnFilters.filters) { filter in
                let name = TransactionColumn(rawValue: filter.key).map { strings.t($0.headerKey) } ?? filter.key
                HStack(spacing: 4) {
                    Image(systemName: "line.3.horizontal.decrease")
                        .imageScale(.small)
                        .accessibilityHidden(true)
                    Text(verbatim: "\(name): \(filter.value)")
                        .lineLimit(1)
                    Button {
                        model.columnFilters.set(filter.key, to: "")
                    } label: {
                        Image(systemName: "xmark")
                            .imageScale(.small)
                    }
                    .buttonStyle(.borderless)
                    .help(strings.t("aria.clearNamedFilter", ["name": name]))
                    .accessibilityLabel(strings.t("aria.clearNamedFilter", ["name": name]))
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(theme.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                        .fill(theme.primary.opacity(0.1)))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    // MARK: Columns

    /// The data columns: every column, or the stacked summary in place of Date, Payee,
    /// Category and Account.
    private var dataColumns: [TransactionColumn] {
        let shown = model.columns
        guard isCompact else { return shown }
        return shown.filter { ![.date, .recipient, .category, .bank].contains($0) }
    }

    /// The column widths that fit `tableWidth` (resized ones kept).
    private var fittedWidths: [String: CGFloat] {
        TransactionColumn.fittedWidths(
            dataColumns, resized: widths.mapValues(Double.init), available: Double(tableWidth),
            chrome: Double(Self.selectWidth + Self.editWidth + 32) + (isCompact ? Double(Self.summaryWidth) : 0)
        ).mapValues { CGFloat($0) }
    }

    private func width(_ column: TransactionColumn) -> CGFloat {
        fittedWidths[column.rawValue] ?? CGFloat(column.width)
    }

    private func widthBinding(_ column: TransactionColumn) -> Binding<CGFloat> {
        Binding(
            get: { width(column) },
            set: { widths[column.rawValue] = min(LocalDataTableMetrics.maximumWidth, max(CGFloat(column.minWidth), $0)) })
    }

    /// The category column takes the remaining width.
    private func isFlexible(_ column: TransactionColumn) -> Bool { column == .category }

    static let selectWidth: CGFloat = 32
    static let editWidth: CGFloat = 64
    static let summaryWidth: CGFloat = 280

    // MARK: Header

    private var headerRow: some View {
        HStack(spacing: 0) {
            selectAllBox
                .frame(width: Self.selectWidth, alignment: .leading)
            if isCompact {
                Text(strings.t("txPage.col.recipient"))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(theme.secondaryLabel)
                    .padding(.vertical, 11)
                    .frame(minWidth: Self.summaryWidth, maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(dataColumns, id: \.self) { column in
                headerCell(column)
                    .frame(width: isFlexible(column) ? nil : width(column), alignment: .leading)
                    .frame(
                        minWidth: isFlexible(column) ? width(column) : nil,
                        maxWidth: isFlexible(column) ? .infinity : nil, alignment: .leading)
            }
            Text(strings.t("table.edit"))
                .font(.callout.weight(.medium))
                .foregroundStyle(theme.secondaryLabel)
                .frame(width: Self.editWidth, alignment: .center)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 16)
        .background(theme.foreground.opacity(0.03))
    }

    private var selectAllBox: some View {
        let symbol = model.allSelected ? "checkmark.square.fill" : model.someSelected ? "minus.square.fill" : "square"
        return Button {
            model.toggleSelectAll()
        } label: {
            Image(systemName: symbol)
                .foregroundStyle(model.allSelected || model.someSelected ? theme.primary : theme.tertiaryLabel)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(strings.t("aria.selectAll"))
        .accessibilityValue(Text(verbatim: model.allSelected ? "1" : model.someSelected ? "mixed" : "0"))
    }

    @ViewBuilder
    private func headerCell(_ column: TransactionColumn) -> some View {
        let title = strings.t(column.headerKey)
        HStack(spacing: 4) {
            if column.sortable {
                sortButton(column, title: title)
                filterButton(column, title: title)
            } else {
                Text(title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(theme.secondaryLabel)
                    .lineLimit(1)
                    .padding(.vertical, 11)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            ColumnResizeHandle(label: title, width: widthBinding(column))
        }
        .onHover { inside in
            if inside {
                hoveredHeader = column.rawValue
            } else if hoveredHeader == column.rawValue {
                hoveredHeader = nil
            }
        }
    }

    private func sortButton(_ column: TransactionColumn, title: String) -> some View {
        let active = model.sort?.key == column.rawValue ? model.sort : nil
        return Button {
            Task { await model.toggleSort(column) }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Image(systemName: active.map { $0.ascending ? "arrow.up" : "arrow.down" } ?? "arrow.up.arrow.down")
                    .imageScale(.small)
                    .foregroundStyle(active == nil ? theme.tertiaryLabel : theme.primary)
                    .opacity(active == nil && hoveredHeader != column.rawValue ? 0.5 : 1)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(theme.secondaryLabel)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(Text(verbatim: active.map { $0.ascending ? "ascending" : "descending" } ?? ""))
    }

    private func filterButton(_ column: TransactionColumn, title: String) -> some View {
        let key = column.rawValue
        let hasFilter = !model.columnFilters.value(for: key).isEmpty
        let label = strings.t("aria.filterColumn", ["header": title])
        return Button {
            openFilter = key
        } label: {
            Image(systemName: hasFilter ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .imageScale(.small)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(hasFilter ? theme.primary : theme.tertiaryLabel)
        .opacity(hasFilter || hoveredHeader == key || openFilter == key ? 1 : 0)
        .help(label)
        .accessibilityLabel(label)
        .popover(
            isPresented: Binding(
                get: { openFilter == key },
                set: { presented in
                    if presented {
                        openFilter = key
                    } else if openFilter == key {
                        openFilter = nil
                    }
                }),
            arrowEdge: .bottom
        ) {
            ColumnFilterPopover(
                header: title,
                value: Binding(
                    get: { model.columnFilters.value(for: key) }, set: { model.columnFilters.set(key, to: $0) }),
                uniqueValues: openFilter == key ? model.filterValues(column) : [], strings: strings,
                close: { openFilter = nil }
            )
            .environment(\.visionTheme, theme)
        }
    }

    // MARK: Rows

    @ViewBuilder
    private var rowsList: some View {
        let rows = model.visibleRows
        if rows.isEmpty {
            emptyState
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
        } else {
            let fitted = fittedWidths
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    TransactionRowView(
                        model: model, shell: shell, row: row, columns: dataColumns, compact: isCompact,
                        widths: fitted, focusedRow: $focusedRow)
                    Divider()
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch model.emptyState {
        case .noFilterResults:
            VisionEmptyState(symbol: "line.3.horizontal.decrease", title: strings.t("table.noFilterResults")) {
                EmptyView()
            }
        case .noSearchResults:
            VisionEmptyState(
                symbol: "magnifyingglass", title: strings.t("txPage.empty"),
                description: strings.t("txPage.emptySearch")
            ) {
                EmptyView()
            }
        case .noTransactions:
            VisionEmptyState(
                symbol: "tray", title: strings.t("txPage.empty"), description: strings.t("transactions.noTransactions")
            ) {
                Button(strings.t("txPage.importLink")) {
                    shell.navigate(to: "/import")
                }
                .buttonStyle(.visionOutline)
            }
        }
    }
}

/// One row: the select box, the cells (or the stacked summary), the Edit column, and while
/// editing the Date, Amount, Payee and Category editors with Save and Cancel.
struct TransactionRowView: View {
    let model: TransactionsModel
    let shell: NativeShellModel
    let row: TransactionRow
    let columns: [TransactionColumn]
    let compact: Bool
    let widths: [String: CGFloat]
    var focusedRow: FocusState<TransactionID?>.Binding
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }
    private var labels: TransactionLabels { model.labels }
    private var isEditing: Bool { model.rowEditor?.id == row.id }
    private var isSelected: Bool { model.selectedId == row.id }

    var body: some View {
        HStack(spacing: 0) {
            checkbox
                .frame(width: TransactionsTableCard.selectWidth, alignment: .leading)
            if compact {
                summaryCell
                    .padding(.trailing, 8)
                    .frame(minWidth: TransactionsTableCard.summaryWidth, maxWidth: .infinity, alignment: .leading)
            }
            ForEach(columns, id: \.self) { column in
                cell(column)
                    .padding(.trailing, 8)
                    .frame(width: column == .category ? nil : width(column), alignment: alignment(column))
                    .frame(
                        minWidth: column == .category ? width(column) : nil,
                        maxWidth: column == .category ? .infinity : nil, alignment: alignment(column))
            }
            editCell
                .frame(width: TransactionsTableCard.editWidth, alignment: .center)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: compact ? 128 : 52)
        .background(isSelected ? theme.primary.opacity(0.1) : Color.clear)
        .contentShape(Rectangle())
        .opacity(row.isActive ? 1 : 0.55)
        .onTapGesture(count: 2) {
            guard !isEditing else { return }
            model.startEditing(row)
        }
        .onTapGesture {
            click()
        }
        .focusable(!isEditing)
        .focusEffectDisabled()
        .focused(focusedRow, equals: row.id)
        .onKeyPress(phases: .down) { press in
            guard !isEditing, let key = Self.rowKey(press.key) else { return .ignored }
            if let next = model.handleRowKey(key, from: row.id) { focusedRow.wrappedValue = next }
            return .handled
        }
        .contextMenu { contextMenu }
        .task { await model.rowAppeared(row.id) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel(labels, settings: settings))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    static func rowKey(_ key: SwiftUI.KeyEquivalent) -> TransactionRowKey? {
        if key == .upArrow { return .up }
        if key == .downArrow { return .down }
        if key == .return { return .open }
        if key == .space { return .quickLook }
        if key == .escape { return .close }
        return nil
    }

    /// A click selects the row for the inspector; Command toggles its box and Shift extends
    /// the box selection from the last toggled row.
    private func click() {
        guard !isEditing else { return }
        let flags = NSEvent.modifierFlags
        if flags.contains(.shift) {
            model.extendSelection(to: row.id)
        } else if flags.contains(.command) {
            model.toggleSelection(row.id)
        } else {
            model.select(row.id)
        }
    }

    private func width(_ column: TransactionColumn) -> CGFloat {
        widths[column.rawValue] ?? CGFloat(column.width)
    }

    private func alignment(_ column: TransactionColumn) -> Alignment {
        switch column {
        case .amount, .runningBalance: return .trailing
        default: return .leading
        }
    }

    private var checkbox: some View {
        let checked = model.selection.contains(row.id)
        return Button {
            model.toggleSelection(row.id)
        } label: {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? theme.primary : theme.tertiaryLabel)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(
            "\(strings.t("aria.selectTransaction")): \(row.accessibilityLabel(labels, settings: settings))")
        .accessibilityValue(Text(verbatim: checked ? "1" : "0"))
    }

    // MARK: Cells

    @ViewBuilder
    private func cell(_ column: TransactionColumn) -> some View {
        switch column {
        case .date: dateCell
        case .recipient: recipientCell
        case .category: categoryCell
        case .bank:
            Text(row.accountLabel(model.accountNames))
                .lineLimit(1)
                .foregroundStyle(theme.secondaryLabel)
                .strikethrough(!row.isActive)
        case .tags: tagsCell
        case .currency:
            Text(row.displayCurrency.rawValue)
                .foregroundStyle(theme.secondaryLabel)
        case .amount: amountCell
        case .runningBalance:
            if let balance = row.runningBalance {
                MoneyText(amount: balance, currency: row.displayCurrency, settings: settings, signed: false, colored: false)
                    .foregroundStyle(theme.secondaryLabel)
            } else {
                Text(verbatim: "—").foregroundStyle(theme.tertiaryLabel)
            }
        case .isActive: statusCell
        }
    }

    @ViewBuilder
    private var dateCell: some View {
        if isEditing {
            VisionDateField(
                day: model.rowEditor?.day, placeholder: strings.t("txPage.col.date"), settings: settings,
                strings: strings, calendar: model.calendar
            ) { day in
                model.rowEditor?.day = day
            }
        } else {
            Text(VisionFormat.appDate(row.date, format: settings.dateFormat))
                .monospacedDigit()
                .foregroundStyle(theme.secondaryLabel)
                .strikethrough(!row.isActive)
        }
    }

    @ViewBuilder
    private var recipientCell: some View {
        if isEditing {
            RecipientPicker(pickers: model.pickers, value: row.recipientId, strings: strings) { id in
                Task { await model.selectRecipient(row, recipientId: id) }
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.recipient(labels))
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .strikethrough(!row.isActive)
                if let memo = row.memo, !memo.isEmpty {
                    Text(memo)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private var categoryCell: some View {
        if isEditing {
            CategoryPicker(pickers: model.pickers, value: row.categoryId, strings: strings) { id in
                Task { await model.selectCategory(row, categoryId: id) }
            }
        } else {
            let uncategorised = row.isUncategorised(labels)
            HStack(spacing: 6) {
                TransactionCategoryDot(category: row.category(labels), uncategorised: uncategorised)
                Text(uncategorised ? strings.t("txPage.needsCategory") : row.category(labels))
                    .lineLimit(1)
                    .foregroundStyle(uncategorised ? theme.secondaryLabel : theme.foreground)
            }
        }
    }

    private var tagsCell: some View {
        HStack(spacing: 4) {
            ForEach(row.tags.prefix(3), id: \.id) { tag in
                TagChip(slug: tag.slug, color: tag.color)
            }
            if row.tags.count > 3 {
                Text(verbatim: "+\(row.tags.count - 3)")
                    .font(.caption)
                    .foregroundStyle(theme.secondaryLabel)
            }
        }
    }

    @ViewBuilder
    private var amountCell: some View {
        if isEditing {
            let invalid = model.rowEditor?.amountInvalid(format: settings.numberFormat) ?? false
            TextField(
                LocaleNumber.placeholder(format: settings.numberFormat),
                text: Binding(
                    get: { model.rowEditor?.amountText ?? "" },
                    set: { model.rowEditor?.amountText = $0 })
            )
            .textFieldStyle(.vision)
            .multilineTextAlignment(.trailing)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(invalid ? theme.destructive : Color.clear, lineWidth: 1))
            .accessibilityLabel(strings.t("txPage.col.amount"))
            .accessibilityValue(Text(verbatim: invalid ? strings.t("addTxn.invalidAmount") : ""))
            .onSubmit { Task { await model.saveEditing() } }
            .onExitCommand { model.cancelEditing() }
        } else {
            MoneyText(amount: row.amount, currency: row.displayCurrency, settings: settings)
                .fontWeight(.medium)
                .strikethrough(!row.isActive)
        }
    }

    private var statusCell: some View {
        Button {
            Task { await model.toggleActive(row) }
        } label: {
            Text(row.isActive ? strings.t("txPage.statusActive") : strings.t("txPage.statusInactive"))
                .font(.footnote.weight(.medium))
        }
        .buttonStyle(.visionOutline)
        .controlSize(.small)
        .disabled(model.updatesInFlight > 0)
        .accessibilityAddTraits(row.isActive ? .isSelected : [])
    }

    /// The stacked cell of the compact layout: date, payee, account, category and memo.
    private var summaryCell: some View {
        let uncategorised = row.isUncategorised(labels)
        return VStack(alignment: .leading, spacing: 4) {
            Text(
                verbatim: [VisionFormat.appDate(row.date, format: settings.dateFormat), row.accountLabel(model.accountNames)]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
            )
            .font(.footnote)
            .foregroundStyle(theme.secondaryLabel)
            if isEditing {
                VisionDateField(
                    day: model.rowEditor?.day, placeholder: strings.t("txPage.col.date"), settings: settings,
                    strings: strings, calendar: model.calendar
                ) { day in
                    model.rowEditor?.day = day
                }
                RecipientPicker(pickers: model.pickers, value: row.recipientId, strings: strings) { id in
                    Task { await model.selectRecipient(row, recipientId: id) }
                }
                CategoryPicker(pickers: model.pickers, value: row.categoryId, strings: strings) { id in
                    Task { await model.selectCategory(row, categoryId: id) }
                }
            } else {
                Text(row.recipient(labels))
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .strikethrough(!row.isActive)
                HStack(spacing: 6) {
                    TransactionCategoryDot(category: row.category(labels), uncategorised: uncategorised)
                    Text(uncategorised ? strings.t("txPage.needsCategory") : row.category(labels))
                        .lineLimit(1)
                }
                if let memo = row.memo, !memo.isEmpty {
                    Text(memo)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var editCell: some View {
        let label = row.accessibilityLabel(labels, settings: settings)
        if isEditing {
            HStack(spacing: 4) {
                Button {
                    Task { await model.saveEditing() }
                } label: {
                    Image(systemName: "checkmark")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.primary)
                .disabled(model.rowEditor?.amountInvalid(format: settings.numberFormat) ?? false)
                .help("\(strings.t("aria.save")): \(label)")
                .accessibilityLabel("\(strings.t("aria.save")): \(label)")
                Button {
                    model.cancelEditing()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .help("\(strings.t("aria.cancel")): \(label)")
                .accessibilityLabel("\(strings.t("aria.cancel")): \(label)")
            }
        } else {
            Button {
                model.startEditing(row)
            } label: {
                Image(systemName: "pencil")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme.tertiaryLabel)
            .help("\(strings.t("aria.edit")): \(label)")
            .accessibilityLabel("\(strings.t("aria.edit")): \(label)")
        }
    }

    // MARK: Context menu

    /// The row menu, in the web's order.
    @ViewBuilder
    private var contextMenu: some View {
        Button {
            model.select(row.id)
        } label: {
            Label(strings.t("contextMenu.info"), systemImage: "info.circle")
        }
        Button {
            model.toggleQuickLook(row.id)
        } label: {
            Label(strings.t("contextMenu.quickLook"), systemImage: "eye")
        }
        Button {
            model.startEditing(row)
        } label: {
            Label(strings.t("contextMenu.editInline"), systemImage: "pencil")
        }
        if TransactionsModel.splitIsNative {
            Button {
                model.requestSplit(row)
            } label: {
                Label(strings.t("splitDialog.buttonTitle"), systemImage: "person.2")
            }
        }
        if row.canDuplicate {
            Button {
                Task { await model.duplicate(row) }
            } label: {
                Label(strings.t("contextMenu.duplicate"), systemImage: "plus.square.on.square")
            }
        }
        if row.recipientId != nil {
            Button {
                model.showAllFrom(row)
            } label: {
                Label(
                    strings.t("contextMenu.showAllFromRecipient", ["name": row.recipient(labels)]),
                    systemImage: "line.3.horizontal.decrease")
            }
        }
        Button {
            Task { await model.toggleActive(row) }
        } label: {
            Label(
                row.isActive ? strings.t("contextMenu.markInactive") : strings.t("contextMenu.markActive"),
                systemImage: row.isActive ? "eye.slash" : "eye")
        }
        .disabled(model.updatesInFlight > 0)
        Divider()
        Button(role: .destructive) {
            model.requestDelete(row)
        } label: {
            Label(strings.t("contextMenu.delete"), systemImage: "trash")
        }
    }
}

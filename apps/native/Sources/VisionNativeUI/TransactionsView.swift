import SwiftUI
import VisionNativeCore

/// `/transactions` (apps/frontend/src/pages/TransactionsPage.tsx, ADR-181) in SwiftUI: the
/// header with Import and Add transaction, the filter toolbar, the filter banner with its
/// exports, the server-paged table with search, sort, column filters, inline editing and row
/// menus, and the inspector docked beside the table on a wide window or in a sheet. Delete
/// asks in an alert and offers Undo in a toast; Quick Look opens as a sheet.
public struct TransactionsView: View {
    private let model: TransactionsModel
    private let shell: NativeShellModel
    @State private var pageWidth: CGFloat = 1100
    @Environment(\.visionTheme) private var theme

    public init(model: TransactionsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    /// What the list depends on: the route and the page size.
    private struct LoadKey: Equatable {
        let route: NativeRoute
        let pageSize: Int
    }

    /// The inspector docks beside the list from the `lg` width.
    private var isDocked: Bool { Double(pageWidth) >= TransactionsModel.dockedInspectorWidth }

    /// Below the `lg` width the selected row's inspector is a sheet.
    private var inspectorIsSheet: Bool { model.inspectorIsSheet(pageWidth: Double(pageWidth)) }

    public var body: some View {
        AdminPage(
            restoration: NativeScrollRestoration(
                target: { shell.restorableScrollOffset() }, record: { shell.recordScrollOffset($0) },
                isLoading: { model.isLoading || model.isFetchingMore }, canGrow: { model.hasMore },
                grow: { await model.loadMore() })
        ) {
            content
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            pageWidth = width
        }
        .task(id: LoadKey(route: shell.route, pageSize: settings.defaultPageSize)) { await model.sync() }
        .task { await model.pickers.load() }
        .task { await model.loadAllAccounts() }
        .task { await model.refreshNeedsCategoryCount() }
        .task { await model.loadColumnVisibility() }
        // `useDebounce(search, SEARCH_DEBOUNCE_MS)`.
        .task(id: model.searchText) {
            try? await Task.sleep(for: PickerDataModel.searchDebounce)
            guard !Task.isCancelled else { return }
            await model.commitSearch()
        }
        .onAppear { shell.setLeaveGuard(model.leaveGuard) }
        .onDisappear {
            model.disappear()
            shell.removeLeaveGuard(id: TransactionsRoutes.path)
        }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings,
                actionTitle: model.notice.flatMap { model.actionTitle(for: $0) },
                duration: model.notice.map { model.duration(of: $0) } ?? TransactionsModel.noticeDuration,
                action: { Task { await model.performPendingAction() } },
                clear: { model.clearNotice($0) },
                bindsUndoShortcut: model.actionIsUndo)
        }
        // The Delete alert, the Add sheet and the Split dialog present from here, or from
        // inside the inspector sheet while it is open (one sheet per presenter).
        .modifier(TransactionDialogs(model: model, shell: shell, theme: theme, hosts: !inspectorIsSheet))
        .sheet(
            item: Binding(
                get: { model.quickLookRow },
                set: { row in
                    if row == nil { model.closeQuickLook() }
                })
        ) { row in
            TransactionQuickLookSheet(row: row, model: model, shell: shell)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
        }
        // Below the `lg` width the inspector is a sheet.
        .sheet(
            isPresented: Binding(
                get: { inspectorIsSheet },
                set: { presented in
                    if !presented { model.closeInspector() }
                })
        ) {
            if let row = model.selectedRow, let inspector = model.inspector {
                TransactionInspectorView(model: model, inspector: inspector, row: row, shell: shell, docked: false)
                    .frame(minWidth: 380, idealWidth: 420, minHeight: 520)
                    .modifier(TransactionDialogs(model: model, shell: shell, theme: theme, hosts: true))
                    .environment(\.visionTheme, theme)
                    .environment(\.colorScheme, theme.colorScheme)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            header(subtitle: "")
            loadingState
        } else if let error = model.error {
            VisionPageHeader(title: strings.t("txPage.title"), subtitle: "", symbol: symbol)
            AdminCard {
                errorState(error)
            }
        } else {
            header(subtitle: model.subtitle())
            TransactionsToolbar(model: model, strings: strings)
            if model.filters.showsBanner {
                TransactionFilterBanner(model: model, strings: strings)
            }
            HStack(alignment: .top, spacing: 16) {
                TransactionsTableCard(model: model, shell: shell)
                    .frame(maxWidth: .infinity)
                if isDocked, let row = model.selectedRow, let inspector = model.inspector {
                    TransactionInspectorView(model: model, inspector: inspector, row: row, shell: shell, docked: true)
                        .frame(width: TransactionsModel.inspectorWidth)
                }
            }
        }
    }

    // MARK: Header

    private var symbol: String {
        NavigationRegistry.matchItem(path: TransactionsRoutes.path)?.symbol ?? "list.bullet.rectangle"
    }

    private func header(subtitle: String) -> some View {
        VisionPageHeader(title: strings.t("txPage.title"), subtitle: subtitle, symbol: symbol) {
            HStack(spacing: 8) {
                Button {
                    shell.navigate(to: "/import")
                } label: {
                    Label(strings.t("txPage.importLink"), systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.visionOutline)
                Button {
                    model.requestAdd()
                } label: {
                    Label(strings.t("form.addTransaction.title"), systemImage: "plus")
                }
                .buttonStyle(.visionPrimary)
            }
        }
    }

    // MARK: Loading and error

    private var loadingState: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBar(width: 176, height: 24)
                SkeletonBar(width: 112, height: 16)
                    .padding(.bottom, 8)
                ForEach(0..<8, id: \.self) { _ in
                    SkeletonBar(width: nil, height: 48)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(strings.t("common.loading"))
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// `PageError`: `txPage.error` with the reason, and Retry.
    private func errorState(_ error: APIError) -> some View {
        let message = strings.t("txPage.error", ["msg": APIErrorMessage.text(error, strings: strings)])
        return VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(theme.destructive)
                .accessibilityHidden(true)
            Text(strings.t("common.error"))
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
                .multilineTextAlignment(.center)
            Button(strings.t("common.retry")) {
                Task { await model.reload() }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .accessibilityElement(children: .contain)
        .task(id: message) {
            AccessibilityNotification.Announcement("\(strings.t("common.error")). \(message)").post()
        }
    }
}

/// The Delete transaction alert (`useConfirmDialog`, destructive), the Add transaction sheet
/// and the Split transaction dialog. Only the presenter that `hosts` them binds the model's
/// state: the page, or the inspector sheet while it is open, since macOS presents nothing
/// from a view that already presents a sheet.
private struct TransactionDialogs: ViewModifier {
    let model: TransactionsModel
    let shell: NativeShellModel
    let theme: VisionTheme
    let hosts: Bool

    private var strings: any Localizing { shell.strings }

    func body(content: Content) -> some View {
        content
            // The buttons decide; the binding only reads.
            .alert(
                strings.t("txPage.delete.title"),
                isPresented: Binding(get: { hosts && model.pendingDelete != nil }, set: { _ in })
            ) {
                Button(strings.t("common.cancel"), role: .cancel) { model.cancelDelete() }
                Button(strings.t("txPage.delete.confirm"), role: .destructive) {
                    Task { await model.confirmDelete() }
                }
            } message: {
                Text(strings.t("txPage.delete.desc", ["desc": model.pendingDelete?.deleteDescription(model.labels) ?? ""]))
            }
            .sheet(
                isPresented: Binding(
                    get: { hosts && model.isAddPresented },
                    set: { presented in
                        if !presented { model.dismissAdd() }
                    })
            ) {
                if let form = model.addForm {
                    TransactionAddSheet(model: model, form: form, shell: shell)
                        .environment(\.visionTheme, theme)
                        .environment(\.colorScheme, theme.colorScheme)
                }
            }
            .sheet(
                item: Binding(
                    get: { hosts ? model.splitForm.map { SplitSheetItem(form: $0) } : nil },
                    set: { item in
                        if item == nil { model.dismissSplit() }
                    })
            ) { item in
                TransactionSplitSheet(model: model, form: item.form, shell: shell)
                    .environment(\.visionTheme, theme)
                    .environment(\.colorScheme, theme.colorScheme)
            }
    }
}

// MARK: - Toolbar

/// `TransactionsToolbar`: the Account, Category, Date and Type chips, Needs category with
/// its count, and the View menu.
struct TransactionsToolbar: View {
    let model: TransactionsModel
    let strings: any Localizing
    @State private var accountsOpen = false
    @State private var categoriesOpen = false
    @State private var accountSearch = ""
    @State private var categorySearch = ""
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let filters = model.filters
        HStack(spacing: 8) {
            accountChip(filters)
            categoryChip(filters)
            dateMenu(filters)
            typeMenu(filters)
            needsCategoryChip(filters)
            Spacer(minLength: 0)
            viewMenu
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(strings.t("txPage.filter.toolbar"))
    }

    private func chipLabel(_ text: String, symbol: String, active: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .imageScale(.small)
                .accessibilityHidden(true)
            // Sized to the label up to 180 pt, like the web chips; a bare flexible frame
            // stretched every chip to the full 180 pt.
            Text(text)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 180, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
            Image(systemName: "chevron.down")
                .imageScale(.small)
                .foregroundStyle(theme.tertiaryLabel)
                .accessibilityHidden(true)
        }
        .foregroundStyle(active ? theme.primary : theme.foreground)
        .visionChipChrome(active: active)
    }

    private func accountChip(_ filters: TransactionFilters) -> some View {
        Button {
            accountsOpen.toggle()
        } label: {
            chipLabel(model.accountChipLabel(), symbol: "building.columns", active: filters.accountId != nil)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(strings.t("txPage.filter.accountAria"))
        .accessibilityValue(model.accountChipLabel())
        .popover(isPresented: $accountsOpen, arrowEdge: .bottom) {
            PickerList(
                search: $accountSearch, searchPlaceholder: strings.t("combobox.account.search"),
                emptyText: strings.t("combobox.account.empty"), options: accountOptions(filters)
            )
            .environment(\.visionTheme, theme)
        }
        .onChange(of: accountsOpen) { _, open in
            if !open { accountSearch = "" }
        }
    }

    private func accountOptions(_ filters: TransactionFilters) -> [PickerOption] {
        let query = accountSearch.trimmingCharacters(in: .whitespaces).lowercased()
        var options: [PickerOption] = []
        if query.isEmpty {
            options.append(
                PickerOption(
                    id: "all", title: strings.t("txPage.filter.allAccounts"), isSelected: filters.accountId == nil
                ) {
                    model.setAccountFilter(nil)
                    accountsOpen = false
                })
        }
        for account in model.allAccounts {
            let label = TransactionsModel.accountLabel(account)
            guard query.isEmpty || "\(account.displayName ?? "") \(account.name) \(account.id)".lowercased().contains(query)
            else { continue }
            options.append(
                PickerOption(
                    id: String(account.id.rawValue), title: label,
                    detail: account.isActive ? nil : strings.t("accounts.archived"),
                    isSelected: filters.accountId == account.id
                ) {
                    model.setAccountFilter(account)
                    accountsOpen = false
                })
        }
        return options
    }

    private func categoryChip(_ filters: TransactionFilters) -> some View {
        Button {
            categoriesOpen.toggle()
        } label: {
            chipLabel(model.categoryChipLabel(), symbol: "tag", active: filters.categoryId != nil)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(strings.t("txPage.filter.categoryAria"))
        .accessibilityValue(model.categoryChipLabel())
        .popover(isPresented: $categoriesOpen, arrowEdge: .bottom) {
            PickerList(
                search: $categorySearch, searchPlaceholder: strings.t("combobox.category.search"),
                emptyText: strings.t("combobox.category.empty"), options: categoryOptions(filters)
            )
            .environment(\.visionTheme, theme)
        }
        .onChange(of: categoriesOpen) { _, open in
            if !open { categorySearch = "" }
        }
    }

    private func categoryOptions(_ filters: TransactionFilters) -> [PickerOption] {
        let query = categorySearch.trimmingCharacters(in: .whitespaces).lowercased()
        var options: [PickerOption] = []
        if query.isEmpty {
            options.append(
                PickerOption(
                    id: "all", title: strings.t("txPage.filter.allCategories"), isSelected: filters.categoryId == nil
                ) {
                    model.setCategoryFilter(nil)
                    categoriesOpen = false
                })
        }
        for node in model.pickers.activeCategories {
            let label = PickerDataModel.label(node)
            guard query.isEmpty || "\(label) \(node.id)".lowercased().contains(query) else { continue }
            options.append(
                PickerOption(id: String(node.id.rawValue), title: label, isSelected: filters.categoryId == node.id) {
                    model.setCategoryFilter(node.id)
                    categoriesOpen = false
                })
        }
        return options
    }

    private func dateMenu(_ filters: TransactionFilters) -> some View {
        let preset = filters.datePreset(today: model.today, calendar: model.calendar)
        return Menu {
            ForEach(TransactionDatePreset.allCases, id: \.self) { option in
                Toggle(
                    strings.t(option.labelKey),
                    isOn: Binding(get: { preset == option }, set: { _ in model.setDatePreset(option) }))
            }
            if preset == nil {
                // The current custom range; choosing it does nothing.
                Toggle(strings.t("txPage.filter.date.custom"), isOn: .constant(true))
            }
        } label: {
            chipLabel(model.dateChipLabel(), symbol: "calendar", active: preset != TransactionDatePreset.any)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.filter.dateAria"))
        .accessibilityValue(model.dateChipLabel())
    }

    private func typeMenu(_ filters: TransactionFilters) -> some View {
        Menu {
            Toggle(
                strings.t("txPage.filter.type.all"),
                isOn: Binding(get: { filters.transactionType == nil }, set: { _ in model.setType(nil) }))
            ForEach(TransactionTypeFilter.allCases, id: \.self) { type in
                Toggle(
                    strings.t(type.labelKey),
                    isOn: Binding(get: { filters.transactionType == type }, set: { _ in model.setType(type) }))
            }
        } label: {
            chipLabel(model.typeChipLabel(), symbol: "arrow.up.arrow.down", active: filters.transactionType != nil)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.filter.typeAria"))
        .accessibilityValue(model.typeChipLabel())
    }

    private func needsCategoryChip(_ filters: TransactionFilters) -> some View {
        Toggle(isOn: Binding(get: { filters.uncategorised }, set: { model.setNeedsCategory($0) })) {
            HStack(spacing: 6) {
                Text(strings.t("txPage.filter.needsCategory"))
                    .foregroundStyle(filters.uncategorised ? theme.primary : theme.foreground)
                if let count = model.needsCategoryCount, count > 0 {
                    VisionBadge(text: String(count), tone: filters.uncategorised ? .primary : .muted, small: true)
                }
            }
            .visionChipChrome(active: filters.uncategorised)
        }
        .toggleStyle(.button)
        .buttonStyle(.plain)
    }

    /// `txPage.view.menu`: Show excluded, the optional columns and Reset columns.
    private var viewMenu: some View {
        Menu {
            Toggle(
                strings.t("txPage.view.showExcluded"),
                isOn: Binding(get: { model.showAll }, set: { value in Task { await model.setShowAll(value) } }))
            Section(strings.t("txPage.view.columns")) {
                ForEach(OptionalTransactionColumn.allCases, id: \.self) { column in
                    Toggle(
                        strings.t(column.labelKey),
                        isOn: Binding(
                            get: { model.columnVisibility.isVisible(column) },
                            set: { model.setColumn(column, visible: $0) }))
                }
            }
            Divider()
            Button(strings.t("txPage.view.resetColumns")) { model.resetColumns() }
        } label: {
            chipLabel(strings.t("txPage.view.menu"), symbol: "slider.horizontal.3", active: model.showAll)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.view.menu"))
    }
}

// MARK: - Filter banner

/// `FilterBanner`: Filtered by the descriptor, the tag badges with their clear, Export CSV
/// and Export JSON, and the clear button.
struct TransactionFilterBanner: View {
    let model: TransactionsModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let filters = model.filters
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .foregroundStyle(theme.primary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                if filters.hasMainFilter {
                    Text(strings.t("txPage.filteredBy", ["label": model.bannerLabel()]))
                        .font(.callout.weight(.medium))
                        .lineLimit(2)
                }
                if let tags = filters.tags {
                    HStack(spacing: 6) {
                        Text(strings.t("filter.tags.label"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                        ForEach(tags, id: \.self) { slug in
                            TagChip(slug: slug, color: model.pickers.tag(slug)?.color)
                        }
                        Button {
                            model.clearTags()
                        } label: {
                            Image(systemName: "xmark")
                                .imageScale(.small)
                        }
                        .buttonStyle(.borderless)
                        .help(strings.t("filter.tags.clearAll"))
                        .accessibilityLabel(strings.t("filter.tags.clearAll"))
                    }
                }
            }
            Spacer(minLength: 8)
            if filters.hasMainFilter {
                exportButton(.csv, key: "txPage.export.csv")
                exportButton(.json, key: "txPage.export.json")
                Button {
                    model.clearFilters()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .help(strings.t("aria.clearFilter"))
                .accessibilityLabel(strings.t("aria.clearFilter"))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.primary.opacity(0.08)))
        .accessibilityElement(children: .contain)
    }

    private func exportButton(_ format: ExportFormat, key: String) -> some View {
        let running = model.exportingFormat == format
        return Button {
            Task { await model.export(format) }
        } label: {
            HStack(spacing: 6) {
                if running {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.down.doc")
                        .accessibilityHidden(true)
                }
                Text(running ? strings.t("txPage.export.downloading") : strings.t(key))
            }
        }
        .buttonStyle(.visionOutline)
        .controlSize(.small)
        .disabled(model.exportingFormat != nil)
    }
}

// MARK: - Sheets

/// The Split transaction dialog's sheet item: one per opened dialog.
struct SplitSheetItem: Identifiable {
    let form: SplitDialogModel
    var id: ObjectIdentifier { ObjectIdentifier(form) }
}

/// `TransactionQuickLook`: the amount, payee, date and account, the category, the status,
/// the tags, and the memo and comment. Space closes it, like Escape.
struct TransactionQuickLookSheet: View {
    let row: TransactionRow
    let model: TransactionsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }
    private var settings: NativeAppSettings { shell.settings }

    var body: some View {
        let labels = model.labels
        VStack(alignment: .leading, spacing: 16) {
            VisionDialogHeader(
                title: strings.t("quickLook.title"), closeLabel: strings.t("common.close"),
                onClose: { model.closeQuickLook() })
            .keyboardShortcut(.cancelAction)
            VStack(alignment: .leading, spacing: 6) {
                MoneyText(amount: row.amount, currency: row.displayCurrency, settings: settings)
                    .font(.visionLargeTitle)
                    .strikethrough(!row.isActive)
                    .opacity(row.isActive ? 1 : 0.5)
                Text(row.recipient(labels))
                    .font(.headline)
                Text(
                    verbatim: [VisionFormat.appDate(row.date, format: settings.dateFormat), row.accountLabel(model.accountNames)]
                        .filter { !$0.isEmpty }
                        .joined(separator: " · ")
                )
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
            }
            HStack(spacing: 8) {
                TransactionCategoryDot(category: row.category(labels), uncategorised: row.isUncategorised(labels))
                Text(row.category(labels))
                if !row.isActive {
                    VisionBadge(text: strings.t("txPage.statusInactive"), tone: .muted, small: true)
                }
                ForEach(row.tags, id: \.id) { tag in
                    TagChip(slug: tag.slug, color: tag.color)
                }
            }
            if (row.memo ?? "").isEmpty == false || (row.comment ?? "").isEmpty == false {
                VStack(alignment: .leading, spacing: 4) {
                    if let memo = row.memo, !memo.isEmpty { Text(memo) }
                    if let comment = row.comment, !comment.isEmpty {
                        Text(comment).foregroundStyle(theme.secondaryLabel)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                        .fill(theme.foreground.opacity(0.04)))
            }
            Text(strings.t("quickLook.hint"))
                .font(.caption.weight(.medium))
                .foregroundStyle(theme.tertiaryLabel)
                .frame(maxWidth: .infinity)
        }
        .visionDialogPadding()
        .frame(minWidth: 384, idealWidth: 384)
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(.space) {
            model.closeQuickLook()
            return .handled
        }
    }
}

/// The category's colour dot: its root's chart token, or a dashed ring without a category.
struct TransactionCategoryDot: View {
    let category: String
    let uncategorised: Bool
    @Environment(\.visionTheme) private var theme

    var body: some View {
        Group {
            if uncategorised {
                Circle()
                    .strokeBorder(theme.tertiaryLabel, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
            } else {
                Circle().fill(color)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }

    private var color: Color {
        guard let index = CategoryColor.index(category) else { return theme.muted }
        let palette = theme.palette
        let tokens = [
            palette.chart1, palette.chart2, palette.chart3, palette.chart4, palette.chart5, palette.chart6,
            palette.chart7, palette.chart8,
        ]
        return Color(token: tokens[index % tokens.count])
    }
}

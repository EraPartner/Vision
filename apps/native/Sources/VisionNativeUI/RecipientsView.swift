import SwiftUI
import VisionNativeCore

/// `/recipients` (apps/frontend/src/pages/RecipientsPage.tsx) in SwiftUI: the server-paged
/// payees table with its search, sort, column filters and infinite scroll, the inline edit
/// (double-click or Edit: name, notes and the default category), each row's ••• menu (Edit,
/// Match rules, Unmerge, Mark inactive / active with Undo, Delete), the View menu (Show
/// inactive, Uncategorized only), the More actions menu (Merge payees) and Add payee.
public struct RecipientsView: View {
    private let model: RecipientsModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: RecipientsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    static var symbol: String {
        NavigationRegistry.matchItem(path: RecipientsRoutes.path)?.symbol ?? "person.2"
    }

    public var body: some View {
        AdminPage {
            VisionPageHeader(
                title: strings.t("recipientsPage.tableTitle"),
                subtitle: strings.t("recipientsPage.tableSubtitle", ["n": String(model.total)]),
                symbol: Self.symbol
            ) {
                if model.error == nil {
                    viewMenu
                    moreMenu
                    Button {
                        model.openAdd()
                    } label: {
                        Label(strings.t("recipients.createButton"), systemImage: "plus")
                    }
                    .buttonStyle(.visionPrimary)
                }
            }
            content
        }
        .task { await model.appear() }
        // The inline category picker names categories from the shared tree.
        .task { await shell.transactions.pickers.load() }
        // The typed search reaches the URL (and the server) after the debounce.
        .task(id: model.searchText) {
            try? await Task.sleep(for: PickerDataModel.searchDebounce)
            guard !Task.isCancelled else { return }
            await model.commitSearch()
        }
        // Back, forward or a link changed the route's view, search or sort.
        .onChange(of: model.tableKey) { _, _ in
            Task { await model.load() }
        }
        .onAppear { shell.setLeaveGuard(model.leaveGuard) }
        .onDisappear {
            shell.removeLeaveGuard(id: RecipientsRoutes.path)
            model.disappear()
        }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings,
                actionTitle: model.notice.flatMap { model.actionTitle(for: $0) },
                duration: model.notice.map { model.duration(of: $0) } ?? RecipientsModel.noticeDuration,
                action: { Task { await model.performPendingAction() } },
                clear: { model.clearNotice($0) },
                bindsUndoShortcut: model.actionIsUndo)
        }
        .modifier(RecipientDialogs(model: model, shell: shell, theme: theme))
    }

    // MARK: Header

    /// The View menu: Show inactive and Uncategorized only.
    private var viewMenu: some View {
        Menu {
            Toggle(
                strings.t("common.includeInactive"),
                isOn: Binding(get: { model.showAll }, set: { on in Task { await model.setShowAll(on) } }))
            Toggle(
                strings.t("recipients.uncategorizedOnly"),
                isOn: Binding(
                    get: { model.uncategorizedOnly }, set: { on in Task { await model.setUncategorizedOnly(on) } }))
        } label: {
            Label(strings.t("txPage.view.menu"), systemImage: "slider.horizontal.3")
        }
        .menuStyle(.button)
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.view.menu"))
    }

    /// More actions: Merge payees.
    private var moreMenu: some View {
        Menu {
            Button {
                Task { await model.openMerge() }
            } label: {
                Label(strings.t("merge.title"), systemImage: "link")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .menuStyle(.button)
        .fixedSize()
        .help(strings.t("recipientsPage.menu"))
        .accessibilityLabel(strings.t("recipientsPage.menu"))
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            AdminCard {
                VStack(alignment: .leading, spacing: 8) {
                    SkeletonBar(width: 240, height: 28)
                    ForEach(0..<8, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 40)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else if let error = model.error {
            AccountsErrorCard(
                message: strings.t("recipientsPage.error", ["msg": APIErrorMessage.text(error, strings: strings)]),
                strings: strings
            ) {
                Task { await model.retry() }
            }
        } else {
            AdminCard(padding: 0) {
                table
            }
            if model.loadMoreFailed {
                loadMoreAlert
            }
        }
    }

    /// The table chrome's query: search and column filters change at once (the search
    /// reaches the server after the debounce); a sort or Clear all goes through the model.
    private var queryBinding: Binding<LocalTableQuery> {
        Binding(
            get: { model.tableQuery },
            set: { next in
                let current = model.tableQuery
                guard next != current else { return }
                let clearsAll = current.showsClearAll && !next.showsClearAll
                guard next.sort == current.sort, !clearsAll else {
                    Task { await model.apply(next) }
                    return
                }
                if next.filters != current.filters {
                    for filter in current.filters where next.filter(for: filter.key).isEmpty {
                        model.setColumnFilter(filter.key, to: "")
                    }
                    for filter in next.filters {
                        model.setColumnFilter(filter.key, to: filter.value)
                    }
                }
                if next.search != current.search {
                    model.searchText = next.search
                    // The × clears at once; typing waits for the debounce.
                    if next.search.isEmpty { Task { await model.commitSearch() } }
                }
            })
    }

    private var table: some View {
        LocalDataTable(
            title: "", subtitle: "", columns: columns, rows: model.shownRows, totalCount: model.rows?.count ?? 0,
            query: queryBinding, filterValues: { model.filterValues($0) }, strings: strings,
            serverTotal: model.total, isFetchingMore: model.isFetchingMore, hasMore: model.hasMore
        ) {
            VisionEmptyState(
                symbol: Self.symbol, title: strings.t("recipientsPage.empty"),
                description: strings.t("recipientsPage.tableSubtitle", ["n": "0"])
            ) {
                EmptyView()
            }
        }
        .rowAppeared { id in Task { await model.rowAppeared(id) } }
        .rowDoubleClicked { payee in
            if model.editing?.id != payee.id { model.startEditing(payee) }
        }
        .searchPlaceholder(strings.t("table.searchDatabase"))
    }

    /// `recipientsPage.loadMoreFailed` with Retry.
    private var loadMoreAlert: some View {
        AdminCard(ring: theme.destructive) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(theme.destructive)
                    .accessibilityHidden(true)
                Text(strings.t("recipientsPage.loadMoreFailed"))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button(strings.t("common.retry")) {
                    Task { await model.loadMore() }
                }
                .disabled(model.isFetchingMore)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Columns

    private var columns: [LocalDataColumn<OpenAPI.Recipient>] {
        [
            LocalDataColumn(
                key: PayeeColumns.name, title: strings.t("recipientsPage.col.recipient"), width: 260, minWidth: 200,
                flexible: true
            ) { payee in AnyView(nameCell(payee)) },
            LocalDataColumn(
                key: PayeeColumns.account, title: strings.t("recipientsPage.col.account"), width: 200, minWidth: 120
            ) { payee in AnyView(accountCell(payee)) },
            LocalDataColumn(
                key: PayeeColumns.category, title: strings.t("recipientsPage.col.category"), width: 200, minWidth: 160
            ) { payee in AnyView(categoryCell(payee)) },
            LocalDataColumn(
                key: PayeeColumns.notes, title: strings.t("recipientsPage.col.notes"), width: 220, minWidth: 120
            ) { payee in AnyView(notesCell(payee)) },
            LocalDataColumn(
                key: PayeeColumns.status, title: strings.t("recipientsPage.col.status"), width: 110, minWidth: 90
            ) { payee in
                AnyView(
                    VisionBadge(
                        text: strings.t(
                            payee.isActive ? "recipientsPage.statusActive" : "recipientsPage.statusInactive"),
                        tone: .muted, small: true))
            },
            LocalDataColumn(key: "actions", title: "", width: 72, minWidth: 72, alignment: .trailing) { payee in
                AnyView(actionsCell(payee))
            },
        ]
    }

    private func isEditing(_ payee: OpenAPI.Recipient) -> Bool {
        model.editing?.id == payee.id
    }

    @ViewBuilder
    private func nameCell(_ payee: OpenAPI.Recipient) -> some View {
        if isEditing(payee) {
            TextField(
                strings.t("recipientsPage.col.recipient"),
                text: Binding(get: { model.editing?.name ?? "" }, set: { model.editing?.name = $0 })
            )
            .textFieldStyle(.vision)
            .onSubmit { Task { await model.saveEditing() } }
            .onExitCommand { model.cancelEditing() }
            .accessibilityLabel("\(strings.t("recipientsPage.col.recipient")): \(payee.name)")
        } else {
            HStack(spacing: 6) {
                Button {
                    model.openTransactions(payee)
                } label: {
                    Text(payee.name)
                        .fontWeight(.medium)
                        .foregroundStyle(payee.isActive ? theme.foreground : theme.secondaryLabel)
                        .strikethrough(!payee.isActive)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .buttonStyle(.plain)
                .pointerStyle(.link)
                .help(payee.name)
                .accessibilityAddTraits(.isLink)
                if let count = payee.aliasCount, count > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2")
                            .imageScale(.small)
                            .accessibilityHidden(true)
                        VisionBadge(text: String(count), tone: .secondary, small: true)
                    }
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize()
                }
                if payee.primaryRecipientId != nil {
                    VisionBadge(text: "→ \(payee.primaryRecipientName ?? "")", tone: .outline, small: true)
                        .help(payee.primaryRecipientName ?? "")
                        .layoutPriority(-1)
                }
            }
        }
    }

    private func accountCell(_ payee: OpenAPI.Recipient) -> some View {
        Text(payee.primaryBankAccount ?? "")
            .font(.callout.monospaced())
            .foregroundStyle(theme.secondaryLabel)
            .strikethrough(!payee.isActive)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private func categoryCell(_ payee: OpenAPI.Recipient) -> some View {
        if isEditing(payee) {
            CategoryPicker(
                pickers: shell.transactions.pickers, value: payee.defaultCategoryId, strings: strings
            ) { categoryId in
                Task { await model.setDefaultCategory(payee, to: categoryId) }
            }
            .accessibilityLabel("\(strings.t("recipientsPage.col.category")): \(payee.name)")
        } else {
            VisionBadge(text: model.categoryText(payee), tone: .outline)
                .opacity(payee.defaultCategoryName == nil ? 0.7 : 1)
        }
    }

    @ViewBuilder
    private func notesCell(_ payee: OpenAPI.Recipient) -> some View {
        if isEditing(payee) {
            TextField(
                strings.t("recipientsPage.col.notes"),
                text: Binding(get: { model.editing?.notes ?? "" }, set: { model.editing?.notes = $0 })
            )
            .textFieldStyle(.vision)
            .onSubmit { Task { await model.saveEditing() } }
            .onExitCommand { model.cancelEditing() }
            .accessibilityLabel("\(strings.t("recipientsPage.col.notes")): \(payee.name)")
        } else {
            let notes = payee.notes ?? ""
            Text(notes.isEmpty ? "—" : notes)
                .font(.callout)
                .foregroundStyle(theme.secondaryLabel)
                .strikethrough(!payee.isActive)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(notes)
        }
    }

    @ViewBuilder
    private func actionsCell(_ payee: OpenAPI.Recipient) -> some View {
        if isEditing(payee) {
            HStack(spacing: 4) {
                Button {
                    Task { await model.saveEditing() }
                } label: {
                    Image(systemName: "checkmark")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.primary)
                .help(strings.t("aria.save"))
                .accessibilityLabel(strings.t("aria.save"))
                Button {
                    model.cancelEditing()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .help(strings.t("aria.cancel"))
                .accessibilityLabel(strings.t("aria.cancel"))
            }
        } else {
            rowMenu(payee)
        }
    }

    /// The ••• menu: Edit, Match rules, Unmerge (aliases), Mark inactive / active, Delete.
    private func rowMenu(_ payee: OpenAPI.Recipient) -> some View {
        Menu {
            Button {
                model.startEditing(payee)
            } label: {
                Label(strings.t("common.edit"), systemImage: "pencil")
            }
            Divider()
            Button {
                Task { await model.openRules(payee) }
            } label: {
                Label(strings.t("recipientPatterns.title"), systemImage: "text.magnifyingglass")
            }
            if payee.primaryRecipientId != nil {
                Button {
                    Task { await model.unmerge(payee) }
                } label: {
                    Label(strings.t("recipientsPage.unmerge"), systemImage: "arrow.triangle.branch")
                }
                .disabled(model.isUnmerging)
            }
            Button {
                Task { await model.toggleStatus(payee) }
            } label: {
                Label(
                    strings.t(payee.isActive ? "recipientsPage.markInactive" : "recipientsPage.markActive"),
                    systemImage: payee.isActive ? "eye.slash" : "eye")
            }
            .disabled(model.isTogglingStatus)
            Divider()
            Button(role: .destructive) {
                model.requestDelete(payee)
            } label: {
                Label(strings.t("common.delete"), systemImage: "trash")
            }
            .disabled(model.isDeleting)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(strings.t("recipientsPage.rowMenu", ["name": payee.name]))
        .accessibilityLabel(strings.t("recipientsPage.rowMenu", ["name": payee.name]))
    }
}

/// The dialogs of `/recipients`: the Delete payee alert and the Add payee, Merge payees and
/// Match rules sheets.
struct RecipientDialogs: ViewModifier {
    let model: RecipientsModel
    let shell: NativeShellModel
    let theme: VisionTheme

    private var strings: any Localizing { shell.strings }

    func body(content: Content) -> some View {
        content
            // `useConfirmDialog`, destructive. The buttons decide; the binding only reads.
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
                    get: { model.add != nil },
                    set: { presented in
                        if !presented { model.closeAdd() }
                    })
            ) {
                themed(PayeeAddSheet(model: model, shell: shell))
            }
            // Escape and a click outside keep the selection; only Cancel resets it.
            .sheet(
                isPresented: Binding(
                    get: { model.merge.isOpen },
                    set: { presented in
                        if !presented { model.merge.dismiss() }
                    })
            ) {
                themed(PayeeMergeSheet(merge: model.merge, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.rules != nil },
                    set: { presented in
                        if !presented { model.closeRules() }
                    })
            ) {
                themed(MatchRulesSheet(model: model, shell: shell))
            }
    }

    private func themed(_ sheet: some View) -> some View {
        sheet
            .environment(\.visionTheme, theme)
            .environment(\.colorScheme, theme.colorScheme)
    }
}

/// `AddRecipientDialog`: Name and Notes (optional).
struct PayeeAddSheet: View {
    let model: RecipientsModel
    let shell: NativeShellModel
    @FocusState private var nameFocused: Bool
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let draft = model.add {
            AccountDialogFrame(
                title: strings.t("form.addRecipient.title"), closeLabel: strings.t("common.close"), width: 448
            ) {
                AccountField(label: strings.t("form.addRecipient.name")) {
                    TextField(
                        strings.t("addRec.namePlaceholder"),
                        text: Binding(get: { model.add?.name ?? "" }, set: { model.add?.setName($0) })
                    )
                    .textFieldStyle(.vision)
                    .focused($nameFocused)
                    .onSubmit(submit)
                    .accessibilityLabel(strings.t("form.addRecipient.name"))
                    if draft.showsNameError {
                        Text(strings.t("form.nameRequired"))
                            .font(.footnote)
                            .foregroundStyle(theme.destructive)
                    }
                }
                AccountField(label: strings.t("addRec.notesOptional")) {
                    TextEditor(text: Binding(get: { model.add?.notes ?? "" }, set: { model.add?.setNotes($0) }))
                        .font(.body)
                        .frame(minHeight: 64, maxHeight: 120)
                        .scrollContentBackground(.hidden)
                        .padding(6)
                        .background(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                                .fill(Color(token: theme.palette.background, opacity: 0.8)))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                                .strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
                        .accessibilityLabel(strings.t("addRec.notesOptional"))
                }
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeAdd() }
                    .keyboardShortcut(.cancelAction)
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if draft.isSaving { ProgressView().controlSize(.small) }
                        Text(strings.t("recipients.createButton"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(draft.isSaving)
            }
            .onAppear { nameFocused = true }
            .onChange(of: model.addFocusRequest) { _, _ in nameFocused = true }
        }
    }

    private func submit() {
        Task { await model.submitAdd() }
    }
}

/// `MergeRecipientsDialog`: 1. the payee to keep, 2. the payees to merge into it.
struct PayeeMergeSheet: View {
    let merge: PayeeMergeState
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        AccountDialogFrame(
            title: strings.t("merge.title"), description: strings.t("merge.description"),
            closeLabel: strings.t("common.close"), width: 512
        ) {
            if merge.loadFailed {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(theme.destructive)
                        .accessibilityHidden(true)
                    Text(strings.t("merge.loadFailed"))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button(strings.t("common.retry")) {
                        Task { await merge.retryList() }
                    }
                    .buttonStyle(.visionOutline)
                    .controlSize(.small)
                    .disabled(merge.isLoadingList)
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                        .fill(theme.destructive.opacity(0.08)))
            }
            AccountField(label: strings.t("merge.primaryRecipient")) {
                primaryStep
            }
            if merge.primaryId != nil {
                AccountField(label: strings.t("merge.selectAliases", ["n": String(merge.aliasIds.count)])) {
                    aliasStep
                }
            }
        } footer: {
            Spacer()
            Button(strings.t("merge.cancel")) { merge.cancel() }
            Button {
                Task { await merge.confirm() }
            } label: {
                HStack(spacing: 6) {
                    if merge.isMerging { ProgressView().controlSize(.small) }
                    Text(merge.confirmTitle(strings))
                }
            }
            .buttonStyle(.visionPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(!merge.canMerge)
        }
        .frame(minHeight: 420)
        .onExitCommand { merge.dismiss() }
        .task { await merge.loadList() }
    }

    @ViewBuilder
    private var primaryStep: some View {
        if merge.showsLoading {
            SkeletonBar(width: nil, height: 36)
                .accessibilityLabel(strings.t("common.loading"))
        }
        if let primary = merge.primary {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .foregroundStyle(theme.gain)
                    .accessibilityHidden(true)
                Text(primary.name)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    merge.clearPrimary()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .help(strings.t("aria.clearSelection"))
                .accessibilityLabel(strings.t("aria.clearSelection"))
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                    .strokeBorder(theme.border, lineWidth: 1))
        } else if merge.payees != nil && !merge.loadFailed {
            PayeeSearchList(
                search: Binding(get: { merge.primarySearch }, set: { merge.primarySearch = $0 }),
                placeholder: strings.t("merge.searchPrimary"), emptyText: strings.t("merge.noResults"),
                payees: merge.primaryOptions, maxHeight: 140, strings: strings,
                isChecked: nil, select: { merge.selectPrimary($0.id) })
        }
    }

    @ViewBuilder
    private var aliasStep: some View {
        let selected = merge.selectedAliases
        if !selected.isEmpty {
            FlowLayout(spacing: 4) {
                ForEach(selected) { payee in
                    Button {
                        merge.toggleAlias(payee.id)
                    } label: {
                        HStack(spacing: 4) {
                            Text(payee.name)
                                .lineLimit(1)
                            Image(systemName: "xmark")
                                .imageScale(.small)
                                .accessibilityHidden(true)
                        }
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(theme.foreground.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(strings.t("merge.removeAlias", ["name": payee.name]))
                }
            }
        }
        PayeeSearchList(
            search: Binding(get: { merge.aliasSearch }, set: { merge.aliasSearch = $0 }),
            placeholder: strings.t("merge.searchAliases"), emptyText: strings.t("merge.noResults"),
            payees: merge.aliasOptions, maxHeight: 180, strings: strings,
            isChecked: { merge.aliasIds.contains($0.id) }, select: { merge.toggleAlias($0.id) })
    }
}

/// A search field over a scrolling list of payees (`Command` with `CommandInput`): aliases
/// read `merge.aliasOf`; with `isChecked`, each row shows its check.
struct PayeeSearchList: View {
    @Binding var search: String
    let placeholder: String
    let emptyText: String
    let payees: [OpenAPI.Recipient]
    let maxHeight: CGFloat
    let strings: any Localizing
    let isChecked: ((OpenAPI.Recipient) -> Bool)?
    let select: (OpenAPI.Recipient) -> Void
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
                TextField(placeholder, text: $search)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(placeholder)
            }
            .padding(8)
            Divider()
            if payees.isEmpty {
                Text(emptyText)
                    .font(.callout)
                    .foregroundStyle(theme.secondaryLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(payees) { payee in
                            row(payee)
                        }
                    }
                    .padding(4)
                }
                .frame(maxHeight: maxHeight)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.border, lineWidth: 1))
    }

    private func row(_ payee: OpenAPI.Recipient) -> some View {
        let checked = isChecked?(payee) ?? false
        return Button {
            select(payee)
        } label: {
            HStack(spacing: 6) {
                if isChecked != nil {
                    Image(systemName: "checkmark")
                        .imageScale(.small)
                        .opacity(checked ? 1 : 0)
                        .accessibilityHidden(true)
                }
                Text(payee.name)
                    .foregroundStyle(payee.primaryRecipientId != nil ? theme.secondaryLabel : theme.foreground)
                    .lineLimit(1)
                if payee.primaryRecipientId != nil {
                    Text(strings.t("merge.aliasOf", ["name": payee.primaryRecipientName ?? ""]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(checked ? AccessibilityTraits.isSelected : [])
    }
}

/// `RecipientPatternsDialog`: the payee's rules with their Active switch and ••• menu (Edit,
/// Delete), the inline add / edit form with Preview, and Add pattern. The Delete pattern
/// alert is attached inside the sheet.
struct MatchRulesSheet: View {
    let model: RecipientsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let state = model.rules {
            AccountDialogFrame(
                title: strings.t("recipientPatterns.title"),
                description: "\(state.recipientName) — \(strings.t("recipientPatterns.subtitle"))",
                closeLabel: strings.t("common.close"), width: 672
            ) {
                if let patterns = state.patterns {
                    if state.showsEmpty {
                        VisionEmptyState(symbol: "text.magnifyingglass", title: strings.t("recipientPatterns.empty")) {
                            EmptyView()
                        }
                        .padding(.vertical, 12)
                    } else if !patterns.isEmpty {
                        AdminCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(patterns.enumerated()), id: \.element.id) { index, rule in
                                    if index > 0 { Divider() }
                                    ruleRow(rule, state: state)
                                }
                            }
                        }
                    }
                    if let form = state.form {
                        MatchRuleFormCard(model: model, form: form, state: state, strings: strings)
                    } else {
                        Button {
                            model.startNewRule()
                        } label: {
                            Label(strings.t("recipientPatterns.addBtn"), systemImage: "plus")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.visionOutline)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .accessibilityLabel(strings.t("common.loading"))
                }
            } footer: {
                Spacer()
                Button(strings.t("common.close")) { model.closeRules() }
                    .keyboardShortcut(.cancelAction)
            }
            .frame(minHeight: 360)
            // Attached inside the sheet so it presents over it.
            .alert(
                strings.t("recipientPatterns.deleteTitle"),
                isPresented: Binding(get: { model.rules?.pendingDelete != nil }, set: { _ in })
            ) {
                Button(strings.t("common.cancel"), role: .cancel) { model.cancelRuleDelete() }
                Button(strings.t("recipientPatterns.deleteConfirm"), role: .destructive) {
                    Task { await model.confirmRuleDelete() }
                }
            } message: {
                Text(strings.t("recipientPatterns.deleteDesc"))
            }
        }
    }

    private func ruleRow(_ rule: OpenAPI.RecipientPattern, state: MatchRulesState) -> some View {
        let kindLabel = MatchRuleKind(rawValue: rule.patternKind).map { strings.t($0.labelKey) } ?? rule.patternKind
        return HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(rule.pattern)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    VisionBadge(text: kindLabel, tone: .outline, small: true)
                    if rule.caseSensitive {
                        VisionBadge(text: "Aa", tone: .outline, small: true)
                            .help(strings.t("recipientPatterns.caseSensitive"))
                            .accessibilityLabel(strings.t("recipientPatterns.caseSensitive"))
                    }
                    if rule.source != "user" {
                        VisionBadge(text: rule.source, tone: .secondary, small: true)
                    }
                }
                if let notes = rule.notes, !notes.isEmpty {
                    Text(notes)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer(minLength: 8)
            Toggle(
                strings.t("recipientPatterns.activeFor", ["pattern": rule.pattern]),
                isOn: Binding(get: { rule.isActive }, set: { _ in Task { await model.toggleRule(rule) } })
            )
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
            .disabled(state.isSaving)
            .accessibilityLabel(strings.t("recipientPatterns.activeFor", ["pattern": rule.pattern]))
            Menu {
                Button {
                    model.editRule(rule)
                } label: {
                    Label(strings.t("common.edit"), systemImage: "pencil")
                }
                Divider()
                Button(role: .destructive) {
                    model.requestRuleDelete(rule)
                } label: {
                    Label(strings.t("common.delete"), systemImage: "trash")
                }
                .disabled(state.isDeleting)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help(strings.t("recipientPatterns.rowMenu", ["pattern": rule.pattern]))
            .accessibilityLabel(strings.t("recipientPatterns.rowMenu", ["pattern": rule.pattern]))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(state.editingId == rule.id ? theme.primary.opacity(0.12) : Color.clear)
        .opacity(rule.isActive ? 1 : 0.6)
        .accessibilityElement(children: .contain)
    }
}

/// The inline add / edit form of Match rules: Pattern with Preview, Kind, Priority, Notes and
/// Case sensitive, then Cancel and Save.
struct MatchRuleFormCard: View {
    let model: RecipientsModel
    let form: MatchRuleForm
    let state: MatchRulesState
    let strings: any Localizing
    @FocusState private var patternFocused: Bool
    @Environment(\.visionTheme) private var theme

    var body: some View {
        AdminCard(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                AccountField(label: strings.t("recipientPatterns.patternLabel")) {
                    HStack(spacing: 8) {
                        TextField(
                            strings.t("recipientPatterns.patternPlaceholder"),
                            text: Binding(
                                get: { model.rules?.form?.pattern ?? "" }, set: { model.rules?.setPattern($0) })
                        )
                        .textFieldStyle(.vision)
                        .font(.body.monospaced())
                        .focused($patternFocused)
                        .onSubmit(save)
                        .accessibilityLabel(strings.t("recipientPatterns.patternLabel"))
                        Button {
                            Task { await model.previewRule() }
                        } label: {
                            HStack(spacing: 6) {
                                if state.isPreviewing {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "eye")
                                }
                                Text(strings.t("recipientPatterns.previewBtn"))
                            }
                        }
                        .buttonStyle(.visionOutline)
                        .disabled(!form.canSave || state.isPreviewing)
                    }
                    if let count = state.previewCount {
                        Text(
                            count > 0
                                ? strings.t("recipientPatterns.previewCount", ["n": String(count)])
                                : strings.t("recipientPatterns.previewZero")
                        )
                        .font(.footnote)
                        .foregroundStyle(count > 0 ? theme.primary : theme.secondaryLabel)
                    }
                }
                HStack(alignment: .top, spacing: 12) {
                    AccountField(label: strings.t("recipientPatterns.kindLabel")) {
                        Picker(
                            strings.t("recipientPatterns.kindLabel"),
                            selection: Binding(
                                get: { model.rules?.form?.kind ?? .literalPrefix }, set: { model.rules?.setKind($0) })
                        ) {
                            ForEach(MatchRuleKind.allCases, id: \.self) { kind in
                                Text(strings.t(kind.labelKey)).tag(kind)
                            }
                        }
                        .labelsHidden()
                    }
                    AccountField(label: strings.t("recipientPatterns.priorityLabel")) {
                        TextField(
                            "",
                            text: Binding(
                                get: { model.rules?.form?.priorityText ?? "" }, set: { model.rules?.setPriority($0) })
                        )
                        .textFieldStyle(.vision)
                        .frame(width: 90)
                        .onSubmit(save)
                        .accessibilityLabel(strings.t("recipientPatterns.priorityLabel"))
                    }
                }
                AccountField(label: strings.t("recipientPatterns.notesLabel")) {
                    TextField(
                        strings.t("recipientPatterns.notesPlaceholder"),
                        text: Binding(get: { model.rules?.form?.notes ?? "" }, set: { model.rules?.setNotes($0) })
                    )
                    .textFieldStyle(.vision)
                    .onSubmit(save)
                    .accessibilityLabel(strings.t("recipientPatterns.notesLabel"))
                }
                Toggle(
                    strings.t("recipientPatterns.caseSensitive"),
                    isOn: Binding(
                        get: { model.rules?.form?.caseSensitive ?? false }, set: { model.rules?.setCaseSensitive($0) })
                )
                .toggleStyle(.switch)
                .controlSize(.small)
                HStack(spacing: 8) {
                    Spacer()
                    Button(strings.t("common.cancel")) { model.cancelRuleForm() }
                        .buttonStyle(.visionOutline)
                    Button(action: save) {
                        HStack(spacing: 6) {
                            if state.isSaving { ProgressView().controlSize(.small) }
                            Text(strings.t("recipientPatterns.saveBtn"))
                        }
                    }
                    .buttonStyle(.visionPrimary)
                    .disabled(!form.canSave || !form.priorityIsValid || state.isSaving)
                }
            }
        }
        .onAppear { patternFocused = true }
    }

    private func save() {
        Task { await model.saveRule() }
    }
}

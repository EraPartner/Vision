import SwiftUI
import VisionNativeCore

/// `/categories` (apps/frontend/src/pages/CategoriesPage.tsx) in SwiftUI: the category tree
/// as one list of rows with a disclosure chevron, the name linking to its transactions, the
/// subtree count, the Inactive badge, the description and a ••• menu (Edit, Merge category,
/// Mark inactive / active with an Undo toast, Delete). The View menu holds Show inactive and
/// Expand all / Collapse all; Add category is the one primary action.
public struct CategoriesView: View {
    private let model: CategoriesModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: CategoriesModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    static var symbol: String {
        NavigationRegistry.matchItem(path: CategoriesRoutes.path)?.symbol ?? "tag"
    }

    public var body: some View {
        AdminPage {
            VisionPageHeader(
                title: strings.t("categories.title"), subtitle: model.nodes == nil ? "" : model.subtitle,
                symbol: Self.symbol
            ) {
                if model.nodes != nil && model.error == nil {
                    viewMenu
                    Button {
                        model.openCreate()
                    } label: {
                        Label(strings.t("form.addCategory.title"), systemImage: "plus")
                    }
                    .buttonStyle(.visionPrimary)
                }
            }
            content
        }
        .task { await model.appear() }
        .onDisappear { model.disappear() }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings,
                actionTitle: model.notice.flatMap { model.actionTitle(for: $0) },
                duration: model.notice.map { model.duration(of: $0) } ?? CategoriesModel.noticeDuration,
                action: { Task { await model.undo() } },
                clear: { model.clearNotice($0) },
                bindsUndoShortcut: model.hasUndo)
        }
        .modifier(CategoryDialogs(model: model, shell: shell, theme: theme))
    }

    /// The View menu: Show inactive, then Expand all / Collapse all.
    private var viewMenu: some View {
        let tree = model.tree
        let allExpanded = tree.allExpanded(model.expanded)
        return Menu {
            Toggle(
                strings.t("common.includeInactive"),
                isOn: Binding(get: { model.showAll }, set: { model.setShowAll($0) }))
            Divider()
            Button {
                model.toggleExpandAll()
            } label: {
                Label(
                    strings.t(allExpanded ? "categoriesPage.collapseAll" : "categoriesPage.expandAll"),
                    systemImage: allExpanded ? "folder" : "folder.badge.plus")
            }
            .disabled(tree.branchIds.isEmpty)
        } label: {
            Label(strings.t("txPage.view.menu"), systemImage: "slider.horizontal.3")
        }
        .menuStyle(.button)
        .fixedSize()
        .accessibilityLabel(strings.t("txPage.view.menu"))
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            AdminCard {
                VStack(alignment: .leading, spacing: 8) {
                    SkeletonBar(width: 176, height: 22)
                    ForEach(0..<6, id: \.self) { _ in
                        SkeletonBar(width: nil, height: 40)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(strings.t("common.loading"))
        } else if let error = model.error {
            AccountsErrorCard(
                message: strings.t("categoriesPage.error", ["msg": APIErrorMessage.text(error, strings: strings)]),
                strings: strings
            ) {
                Task { await model.retry() }
            }
        } else {
            let rows = model.rows
            AdminCard(padding: 0) {
                if rows.isEmpty {
                    VisionEmptyState(symbol: Self.symbol, title: strings.t("categoriesPage.empty")) { EmptyView() }
                        .padding(.vertical, 32)
                        .padding(.horizontal, 16)
                } else {
                    let tree = model.tree
                    let expanded = model.expanded
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider().opacity(0.5) }
                            CategoryTreeRowView(
                                model: model, row: row, tree: tree, isExpanded: expanded.contains(row.id),
                                strings: strings)
                        }
                    }
                }
            }
        }
    }
}

/// One row of the tree: indentation, the chevron on branches, the name link (bold for roots,
/// secondary for children, struck through when inactive), the subtree count, the Inactive
/// badge, the description and the ••• menu.
struct CategoryTreeRowView: View {
    let model: CategoriesModel
    let row: CategoryTreeRow
    let tree: CategoryTree
    let isExpanded: Bool
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme

    private var node: OpenAPI.CategoryNode { row.node }
    private var label: String { CategoryTree.pathLabel(node) }

    var body: some View {
        HStack(spacing: 8) {
            if row.isBranch {
                Button {
                    withAnimation(.snappy) { model.toggleExpanded(node.id) }
                } label: {
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityLabel(
                    "\(strings.t(isExpanded ? "categoriesPage.collapseAll" : "categoriesPage.expandAll")): \(label)")
                .accessibilityValue(Text(verbatim: isExpanded ? "expanded" : "collapsed"))
            } else {
                Color.clear
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
            }
            Button {
                model.openTransactions(node)
            } label: {
                Text(node.name)
                    .fontWeight(row.level == 0 ? .semibold : .regular)
                    .foregroundStyle(nameColor)
                    .strikethrough(!node.isActive)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .buttonStyle(.plain)
            .pointerStyle(.link)
            .help(label)
            .accessibilityAddTraits(.isLink)
            if row.isBranch {
                VisionBadge(text: String(tree.subtreeCount(node.id)), tone: .secondary, small: true)
            }
            if !node.isActive {
                VisionBadge(text: strings.t("categoriesPage.statusInactive"), tone: .muted, small: true)
            }
            if let description = node.description, !description.isEmpty {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 200, alignment: .leading)
            }
            Spacer(minLength: 8)
            rowMenu
        }
        .padding(.leading, CGFloat(row.level) * 20 + 12)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
    }

    private var nameColor: Color {
        if !node.isActive { return theme.secondaryLabel }
        return row.level == 0 ? theme.foreground : theme.secondaryLabel
    }

    /// The ••• menu: Edit, Merge category, Mark inactive / active, then Delete.
    private var rowMenu: some View {
        Menu {
            Button {
                model.openEdit(node)
            } label: {
                Label(strings.t("common.edit"), systemImage: "pencil")
            }
            Button {
                model.openMerge(node)
            } label: {
                Label(strings.t("categoriesPage.mergeTitle"), systemImage: "arrow.triangle.merge")
            }
            .disabled(!tree.canMerge(node))
            Button {
                Task { await model.toggleStatus(node) }
            } label: {
                Label(
                    strings.t(node.isActive ? "categoriesPage.markInactive" : "categoriesPage.markActive"),
                    systemImage: node.isActive ? "eye.slash" : "eye")
            }
            .disabled(model.isTogglingStatus)
            Divider()
            Button(role: .destructive) {
                model.requestDelete(node)
            } label: {
                Label {
                    Text(strings.t("common.delete"))
                    if row.isBranch {
                        Text(strings.t("categoriesPage.deleteChildrenFirst"))
                    }
                } icon: {
                    Image(systemName: "trash")
                }
            }
            .disabled(model.isDeleting || row.isBranch)
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuIndicator(.hidden)
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(strings.t("categoriesPage.rowMenu", ["name": label]))
        .accessibilityLabel(strings.t("categoriesPage.rowMenu", ["name": label]))
    }
}

/// The dialogs of `/categories`: Add / Edit category, Merge category and the Delete category
/// alert.
struct CategoryDialogs: ViewModifier {
    let model: CategoriesModel
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
                themed(CategoryNodeSheet(model: model, shell: shell))
            }
            .sheet(
                isPresented: Binding(
                    get: { model.merge != nil },
                    set: { presented in
                        if !presented { model.closeMerge() }
                    })
            ) {
                themed(CategoryMergeSheet(model: model, shell: shell))
            }
    }

    private func themed(_ sheet: some View) -> some View {
        sheet
            .environment(\.visionTheme, theme)
            .environment(\.colorScheme, theme.colorScheme)
    }
}

/// `CategoryNodeDialog`: Name, Parent category and Description.
struct CategoryNodeSheet: View {
    let model: CategoriesModel
    let shell: NativeShellModel
    @FocusState private var nameFocused: Bool
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let form = model.form {
            AccountDialogFrame(title: strings.t(form.titleKey), closeLabel: strings.t("common.close"), width: 448) {
                AccountField(label: strings.t("categoriesPage.nodeName")) {
                    TextField(
                        "", text: Binding(get: { model.form?.name ?? "" }, set: { model.form?.setName($0) })
                    )
                    .textFieldStyle(.vision)
                    .focused($nameFocused)
                    .onSubmit(submit)
                    .accessibilityLabel(strings.t("categoriesPage.nodeName"))
                    if form.showsNameError {
                        Text(strings.t("validation.required"))
                            .font(.footnote)
                            .foregroundStyle(theme.destructive)
                    }
                }
                AccountField(label: strings.t("categoriesPage.parent")) {
                    Picker(
                        strings.t("categoriesPage.parent"),
                        selection: Binding<Int?>(get: { model.form?.parentId }, set: { model.form?.parentId = $0 })
                    ) {
                        Text(strings.t("categoriesPage.root")).tag(Int?.none)
                        ForEach(model.parentOptions, id: \.id) { node in
                            Text(verbatim: CategoryTree.pathLabel(node)).tag(Int?.some(node.id))
                        }
                    }
                    .labelsHidden()
                }
                AccountField(label: strings.t("addCat.descriptionOptional")) {
                    TextEditor(
                        text: Binding(get: { model.form?.description ?? "" }, set: { model.form?.setDescription($0) })
                    )
                    .font(.body)
                    .frame(minHeight: 64, maxHeight: 120)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            .fill(Color(token: theme.palette.background, opacity: 0.8)))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            .strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
                    .accessibilityLabel(strings.t("addCat.descriptionOptional"))
                }
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
                .disabled(model.isSavingForm)
            }
            .onAppear { nameFocused = true }
            .onChange(of: model.nameFocusRequest) { _, _ in nameFocused = true }
        }
    }

    private func submit() {
        Task { await model.submitForm() }
    }
}

/// `CategoryMergeDialog`: the source card, Merge into, and the selection summary.
struct CategoryMergeSheet: View {
    let model: CategoriesModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    private var strings: any Localizing { shell.strings }

    var body: some View {
        if let draft = model.merge {
            AccountDialogFrame(
                title: strings.t("categoriesPage.mergeTitle"), description: strings.t("categoriesPage.mergeDescription"),
                closeLabel: strings.t("common.close"),
                width: 448
            ) {
                AdminCard(padding: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(strings.t("categoriesPage.mergeSourceLabel"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                        Text(CategoryTree.pathLabel(draft.source))
                            .fontWeight(.medium)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                AccountField(label: strings.t("categoriesPage.mergeTarget")) {
                    Picker(
                        strings.t("categoriesPage.mergeTarget"),
                        selection: Binding<Int?>(get: { model.merge?.targetId }, set: { model.merge?.targetId = $0 })
                    ) {
                        if draft.targetId == nil {
                            Text(verbatim: "—").tag(Int?.none)
                        }
                        ForEach(model.mergeTargets, id: \.id) { node in
                            Text(verbatim: CategoryTree.pathLabel(node)).tag(Int?.some(node.id))
                        }
                    }
                    .labelsHidden()
                }
                if let summary = model.mergeSummary {
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } footer: {
                Spacer()
                Button(strings.t("common.cancel")) { model.closeMerge() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await model.confirmMerge() }
                } label: {
                    HStack(spacing: 6) {
                        if draft.isMerging { ProgressView().controlSize(.small) }
                        Text(strings.t("categoriesPage.mergeConfirm"))
                    }
                }
                .buttonStyle(.visionPrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(!draft.canMerge)
            }
        }
    }
}

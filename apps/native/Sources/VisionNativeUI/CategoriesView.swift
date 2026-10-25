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
                .buttonStyle(.vision(.ghost, size: .iconXs))
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
            .visionTooltip(label)
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
        .visionTooltip(strings.t("categoriesPage.rowMenu", ["name": label]))
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

    /// The Delete alert's copy, kept through the exit motion once the model has cleared it.
    private struct DeleteCopy {
        let title: String
        let message: String
        let action: String
    }
    @State private var deleteCopy: DeleteCopy?
    private var shownDeleteCopy: DeleteCopy? {
        if let text = model.deleteText() {
            return DeleteCopy(title: text.title, message: text.message, action: text.action)
        }
        return deleteCopy
    }

    /// The dialog content pads and sizes itself (`AccountDialogFrame`), so the host adds nothing.
    private static var metrics: VisionDialogMetrics {
        VisionDialogMetrics(maxWidth: AccountDialogFrame<EmptyView, EmptyView>.defaultWidth, padding: 0, spacing: 0)
    }

    private func binding(_ isUp: @escaping () -> Bool, close: @escaping () -> Void) -> Binding<Bool> {
        Binding(
            get: { isUp() },
            set: { presented in
                if !presented { close() }
            })
    }

    func body(content: Content) -> some View {
        content
            // `useConfirmDialog`. The buttons decide; the binding only reads.
            .visionAlert(
                title: shownDeleteCopy?.title ?? "",
                message: shownDeleteCopy?.message,
                isPresented: Binding(get: { model.pendingDelete != nil }, set: { _ in })
            ) {
                VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.cancelDelete() }
                VisionDialogAction(shownDeleteCopy?.action ?? "", role: .destructive) {
                    Task { await model.confirmDelete() }
                }
            }
            .onChange(of: model.pendingDelete != nil, initial: true) { _, isUp in
                if isUp, let text = model.deleteText() {
                    deleteCopy = DeleteCopy(title: text.title, message: text.message, action: text.action)
                }
            }
            .visionDialog(
                isPresented: binding({ model.form != nil }, close: { model.closeForm() }), metrics: Self.metrics
            ) {
                themed(CategoryNodeSheet(model: model, shell: shell))
            }
            .visionDialog(
                isPresented: binding({ model.merge != nil }, close: { model.closeMerge() }), metrics: Self.metrics
            ) {
                themed(CategoryMergeSheet(model: model, shell: shell))
            }
    }

    private func themed(_ sheet: some View) -> some View {
        sheet
            .environment(\.visionTheme, theme)
            .environment(\.colorScheme, theme.colorScheme)
            .environment(\.accountDialogHosted, true)
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
                    VisionSelect(
                        selection: Binding(
                            get: { ParentChoice(model.form?.parentId) },
                            set: { model.form?.parentId = $0.parentId }),
                        options: parentOptions,
                        accessibilityLabel: strings.t("categoriesPage.parent"), expands: true)
                }
                AccountField(label: strings.t("addCat.descriptionOptional")) {
                    TextEditor(
                        text: Binding(get: { model.form?.description ?? "" }, set: { model.form?.setDescription($0) })
                    )
                    .visionTextEditor(minHeight: 64)
                    .frame(maxHeight: 120)
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

    /// The parent select's choices: the root, or one category.
    private enum ParentChoice: Hashable {
        case root
        case node(CategoryID)

        init(_ id: CategoryID?) { self = id.map { .node($0) } ?? .root }

        var parentId: CategoryID? {
            switch self {
            case .root: return nil
            case .node(let id): return id
            }
        }
    }

    private var parentOptions: [VisionSelectOption<ParentChoice>] {
        var options = [VisionSelectOption(value: ParentChoice.root, title: strings.t("categoriesPage.root"))]
        for node in model.parentOptions {
            options.append(VisionSelectOption(value: ParentChoice.node(node.id), title: CategoryTree.pathLabel(node)))
        }
        return options
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
                    VisionSelect(
                        selection: Binding<CategoryID?>(get: { model.merge?.targetId }, set: { model.merge?.targetId = $0 }),
                        entries: model.mergeTargets.map {
                            VisionSelectEntry.option(VisionSelectOption(value: $0.id, title: CategoryTree.pathLabel($0)))
                        },
                        placeholder: "—", accessibilityLabel: strings.t("categoriesPage.mergeTarget"), expands: true)
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

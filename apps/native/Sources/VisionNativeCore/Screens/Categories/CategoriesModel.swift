import Foundation
import Observation

/// The Add / Edit category dialog (`CategoryNodeDialog`): Name, Parent category and
/// Description.
public struct CategoryNodeDraft: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case create
        case edit(id: Int)
    }

    /// The Name input's `maxLength`.
    public static let nameLimit = 100
    /// The Description textarea's `maxLength`.
    public static let descriptionLimit = 500

    public let mode: Mode
    /// The edited node (its subtree is not a parent option).
    public let editing: OpenAPI.CategoryNode?
    public private(set) var name: String
    /// `nil`: `categoriesPage.root`.
    public var parentId: Int?
    public private(set) var description: String
    /// `validation.required` under the name after an empty submit.
    public internal(set) var showsNameError = false

    /// Create mode, empty.
    public init() {
        mode = .create
        editing = nil
        name = ""
        parentId = nil
        description = ""
    }

    /// Edit mode, filled from the node.
    public init(editing node: OpenAPI.CategoryNode) {
        mode = .edit(id: node.id)
        editing = node
        name = node.name
        parentId = node.parentId
        description = node.description ?? ""
    }

    /// `form.addCategory.title` or `form.addCategory.editTitle`.
    public var titleKey: String { editing == nil ? "form.addCategory.title" : "form.addCategory.editTitle" }

    /// `categories.createButton` or `common.save`.
    public var submitKey: String { editing == nil ? "categories.createButton" : "common.save" }

    /// Typing sets the name (at most 100 characters) and clears the error.
    public mutating func setName(_ text: String) {
        name = String(text.prefix(Self.nameLimit))
        showsNameError = false
    }

    /// At most 500 characters.
    public mutating func setDescription(_ text: String) {
        description = String(text.prefix(Self.descriptionLimit))
    }

    /// `{ name: trimmed, parentId, description: trimmed || null }`; `nil` while the trimmed
    /// name is empty.
    public var body: CategoryNodeBody? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        return CategoryNodeBody(name: trimmed, parentId: parentId, description: text.isEmpty ? nil : text)
    }
}

/// The Merge category dialog (`CategoryMergeDialog`).
public struct CategoryMergeDraft: Equatable, Sendable {
    public let source: OpenAPI.CategoryNode
    /// `nil` until a target is chosen ("—").
    public var targetId: Int?
    public internal(set) var isMerging = false

    public init(source: OpenAPI.CategoryNode) {
        self.source = source
    }

    /// Merge is disabled until a target is chosen, and while it runs.
    public var canMerge: Bool { targetId != nil && !isMerging }
}

/// The state of `/categories` (CategoriesPage): the tree with its View menu (Show inactive,
/// Expand all / Collapse all), each row's disclosure, name link and ••• menu, the status flip
/// with its Undo toast, and the Add / Edit category, Merge category and Delete category
/// dialogs.
@MainActor
@Observable
public final class CategoriesModel {
    /// `QUERY_STALE_TIME_MS.STANDARD` of `useCategoryTree`.
    public static let staleAfter: TimeInterval = 60
    public static let noticeDuration: Duration = .seconds(4)
    /// `DEFAULT_UNDO_TTL_MS` of `undoToast`.
    public static let undoDuration: Duration = .seconds(8)

    /// The tree's nodes; `nil` until the first answer.
    public private(set) var nodes: [OpenAPI.CategoryNode]?
    public private(set) var error: APIError?

    public var form: CategoryNodeDraft?
    public internal(set) var isSavingForm = false
    /// Bumped when a failed submit should focus the name.
    public internal(set) var nameFocusRequest = 0
    public var merge: CategoryMergeDraft?
    /// The Delete category alert, for this node.
    public internal(set) var pendingDelete: OpenAPI.CategoryNode?
    public internal(set) var isDeleting = false
    /// A status flip (or its Undo) is on its way: Mark inactive / active is disabled.
    public internal(set) var isTogglingStatus = false
    public internal(set) var notice: ScreenNotice?
    /// The Undo of the status toast: the notice it belongs to, the node and the status Undo restores.
    @ObservationIgnored private(set) var pendingUndo: (noticeID: Int, node: OpenAPI.CategoryNode, restore: Bool)?

    @ObservationIgnored let service: any CategoriesService
    @ObservationIgnored weak var shell: NativeShellModel?
    @ObservationIgnored var notices = NoticeCounter()
    private(set) var visible = false
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?

    public init(service: any CategoriesService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }

    func attach(_ shell: NativeShellModel) {
        self.shell = shell
    }

    var strings: any Localizing { shell?.strings ?? DictionaryStrings(language: .en, table: [:]) }

    // MARK: Visibility

    /// The screen appeared: it loads (a fresh tree is reused) and may navigate.
    public func appear() async {
        visible = true
        await load()
    }

    /// The screen went away: every dialog closes, like the unmounted page.
    public func disappear() {
        visible = false
        form = nil
        merge = nil
        pendingDelete = nil
    }

    // MARK: Loading

    public var isLoading: Bool { nodes == nil && error == nil }

    /// `useCategoryTree`: one request at a time; a fresh answer is reused unless `force`.
    public func load(force: Bool = false) async {
        if let inFlight {
            await inFlight.value
            if !force { return }
        }
        if !force, nodes != nil, error == nil, let fetchedAt, now().timeIntervalSince(fetchedAt) < Self.staleAfter {
            return
        }
        let service = service
        let task = Task { [weak self] in
            do {
                let items = try await service.categoryTree()
                self?.nodes = items
                self?.error = nil
                self?.fetchedAt = self?.now()
            } catch is CancellationError {
                return
            } catch {
                self?.error = APIError.wrapping(error)
                self?.fetchedAt = nil
            }
        }
        inFlight = task
        await task.value
        if inFlight == task { inFlight = nil }
    }

    /// The error state's Retry.
    public func retry() async {
        await load(force: true)
    }

    /// Another screen changed the categories.
    public func invalidate() {
        fetchedAt = nil
    }

    // MARK: Route state

    /// `show_all`, read only while shown.
    public var showAll: Bool {
        guard visible, let shell else { return false }
        return CategoriesRoutes.showAll(in: shell.route)
    }

    /// The `expanded` ids in URL order.
    public var expandedIds: [Int] {
        guard visible, let shell else { return [] }
        return CategoriesRoutes.expanded(in: shell.route)
    }

    public var expanded: Set<Int> { Set(expandedIds) }

    /// The tree for the current `show_all`.
    public var tree: CategoryTree {
        CategoryTree(nodes: nodes ?? [], showAll: showAll, locale: Locale(identifier: strings.language.rawValue))
    }

    /// The flat rows under the expanded branches.
    public var rows: [CategoryTreeRow] { tree.rows(expanded: expanded) }

    /// `categoriesPage.subtitle`: visible nodes and roots.
    public var subtitle: String {
        let tree = tree
        return strings.t("categoriesPage.subtitle", ["n": String(tree.visible.count), "g": String(tree.roots.count)])
    }

    /// View menu: Show inactive (`show_all=true`, or removed).
    public func setShowAll(_ on: Bool) {
        guard visible else { return }
        shell?.replaceQuery(CategoriesRoutes.showAllParameter, with: on ? "true" : nil)
    }

    /// View menu: Expand all, or Collapse all once every branch is open.
    public func toggleExpandAll() {
        let tree = tree
        let branches = tree.branchIds
        guard !branches.isEmpty else { return }
        writeExpanded(tree.allExpanded(expanded) ? [] : branches)
    }

    /// A row's chevron.
    public func toggleExpanded(_ id: Int) {
        var ids = expandedIds
        if let index = ids.firstIndex(of: id) {
            ids.remove(at: index)
        } else {
            ids.append(id)
        }
        writeExpanded(ids)
    }

    private func writeExpanded(_ ids: [Int]) {
        guard visible, let shell else { return }
        shell.replaceQuery(CategoriesRoutes.writingExpanded(ids, to: shell.route))
    }

    /// The name link: the node's (or its subtree's) transactions.
    public func openTransactions(_ node: OpenAPI.CategoryNode) {
        guard visible else { return }
        shell?.navigate(to: CategoriesRoutes.transactionsLink(node, subtreeIds: tree.subtreeIds(node.id)))
    }

    // MARK: Add / Edit category

    /// The header's Add category.
    public func openCreate() {
        form = CategoryNodeDraft()
    }

    /// The row menu's Edit.
    public func openEdit(_ node: OpenAPI.CategoryNode) {
        form = CategoryNodeDraft(editing: node)
    }

    public func closeForm() {
        form = nil
    }

    /// The Parent select's options for the open dialog.
    public var parentOptions: [OpenAPI.CategoryNode] {
        tree.parentOptions(editing: form?.editing)
    }

    /// Add category / Save (button or Return): an empty name shows `validation.required` and
    /// takes focus; otherwise create or update, toast, and close on success.
    public func submitForm() async {
        guard let draft = form, !isSavingForm else { return }
        guard let body = draft.body else {
            form?.showsNameError = true
            nameFocusRequest += 1
            return
        }
        isSavingForm = true
        defer { isSavingForm = false }
        switch draft.mode {
        case .create:
            do {
                try await service.createCategoryNode(body)
            } catch {
                post(.error, "categories.createFailedTitle", detail: errorText(error))
                return
            }
            post(.success, "categories.created")
        case .edit(let id):
            do {
                try await service.updateCategoryNode(id: id, body: body)
            } catch {
                post(.error, "categories.updateFailedTitle", detail: errorText(error))
                return
            }
            post(.success, "categories.updated")
        }
        if form?.mode == draft.mode { form = nil }
        await refreshAfterWrite()
    }

    // MARK: Merge category

    /// The row menu's Merge category (disabled without a target).
    public func openMerge(_ node: OpenAPI.CategoryNode) {
        guard tree.canMerge(node) else { return }
        merge = CategoryMergeDraft(source: node)
    }

    public func closeMerge() {
        merge = nil
    }

    /// The Merge into select's options.
    public var mergeTargets: [OpenAPI.CategoryNode] {
        guard let merge else { return [] }
        return tree.mergeTargets(merge.source)
    }

    /// `categoriesPage.mergeSelectionSummary` once a target is chosen.
    public var mergeSummary: String? {
        guard let merge, let targetId = merge.targetId, let target = mergeTargets.first(where: { $0.id == targetId })
        else { return nil }
        return strings.t(
            "categoriesPage.mergeSelectionSummary",
            ["source": CategoryTree.pathLabel(merge.source), "target": CategoryTree.pathLabel(target)])
    }

    /// Merge (button or Return): `POST /api/categories/tree/:sourceId/merge`.
    public func confirmMerge() async {
        guard let draft = merge, draft.canMerge, let targetId = draft.targetId else { return }
        merge?.isMerging = true
        do {
            try await service.mergeCategoryNode(sourceId: draft.source.id, targetId: targetId)
        } catch {
            merge?.isMerging = false
            post(.error, "categories.updateFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "categories.updated")
        if merge?.source.id == draft.source.id { merge = nil }
        await refreshAfterWrite()
    }

    // MARK: Status

    /// Mark inactive / Mark active: the PATCH at once, then the Undo toast.
    public func toggleStatus(_ node: OpenAPI.CategoryNode) async {
        guard !isTogglingStatus else { return }
        let nextActive = !node.isActive
        isTogglingStatus = true
        defer { isTogglingStatus = false }
        do {
            try await service.setCategoryActive(id: node.id, isActive: nextActive)
        } catch {
            post(.error, "categoriesPage.toggleFailed")
            return
        }
        let notice = notices.make(
            .success, nextActive ? "categoriesPage.toast.active" : "categoriesPage.toast.inactive", ["name": node.name])
        self.notice = notice
        pendingUndo = (notice.id, node, !nextActive)
        notices.offerAction(for: notice, titleKey: "common.undo", lifetime: 8, isUndo: true) { [weak self] in
            await self?.restoreStatus(id: node.id, active: !nextActive)
        }
        await refreshAfterWrite()
    }

    /// The toast's Undo (also ⌘Z): the previous status again.
    public func undo() async {
        guard let pending = pendingUndo else { return }
        pendingUndo = nil
        if notice?.id == pending.noticeID { notice = nil }
        await restoreStatus(id: pending.node.id, active: pending.restore)
    }

    private func restoreStatus(id: Int, active: Bool) async {
        isTogglingStatus = true
        defer { isTogglingStatus = false }
        do {
            try await service.setCategoryActive(id: id, isActive: active)
        } catch {
            post(.error, "categoriesPage.toggleFailed")
            return
        }
        await refreshAfterWrite()
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    /// The label of the toast's action: Undo while the status toast is up.
    public func actionTitle(for notice: ScreenNotice) -> String? {
        guard let pendingUndo, pendingUndo.noticeID == notice.id else { return nil }
        return strings.t("common.undo")
    }

    /// The Undo toast lives as long as its Undo.
    public func duration(of notice: ScreenNotice) -> Duration {
        pendingUndo?.noticeID == notice.id ? Self.undoDuration : Self.noticeDuration
    }

    /// ⌘Z answers only while the Undo is up.
    public var hasUndo: Bool { pendingUndo != nil && pendingUndo?.noticeID == notice?.id }

    // MARK: Delete category

    /// The row menu's Delete (disabled on branches).
    public func requestDelete(_ node: OpenAPI.CategoryNode) {
        guard tree.children(of: node.id).isEmpty else { return }
        pendingDelete = node
    }

    public func cancelDelete() {
        pendingDelete = nil
    }

    /// The alert's title, message and confirm label.
    public func deleteText() -> (title: String, message: String, action: String)? {
        guard let node = pendingDelete else { return nil }
        return (
            strings.t("categoriesPage.delete.title"),
            strings.t("categoriesPage.delete.desc", ["name": CategoryTree.pathLabel(node)]),
            strings.t("categoriesPage.delete.confirm")
        )
    }

    /// Delete: `DELETE /api/categories/tree/:id`.
    public func confirmDelete() async {
        guard let node = pendingDelete, !isDeleting else { return }
        pendingDelete = nil
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await service.deleteCategoryNode(id: node.id)
        } catch {
            post(.error, "categories.deleteFailedTitle", detail: errorText(error))
            return
        }
        post(.success, "categories.deleted")
        await refreshAfterWrite()
    }

    // MARK: After a write

    /// `invalidateQueries(categoryKeys.all)`, and the native screens that cache categories
    /// (the pickers of Transactions and their category names) refetch on their next visit.
    func refreshAfterWrite() async {
        invalidate()
        shell?.transactions.invalidate()
        shell?.transactions.pickers.reset()
        shell?.planned.invalidate()
        await load(force: true)
    }

    // MARK: Toasts

    /// The toast was dismissed or timed out; its Undo goes with it.
    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
        if pendingUndo?.noticeID == id { pendingUndo = nil }
    }

    func post(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil) {
        notice = notices.make(kind, key, variables, detail: detail)
    }

    func errorText(_ error: any Error) -> String {
        APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }
}

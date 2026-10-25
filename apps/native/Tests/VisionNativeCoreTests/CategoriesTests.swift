import Foundation
import Observation
import Testing

@testable import VisionNativeCore

// MARK: - Fakes and fixtures

/// A scripted `CategoriesService` that records every call.
actor FakeCategoriesService: CategoriesService {
    var nodes: [OpenAPI.CategoryNode]
    var treeFailure: APIError?
    var writeFailure: APIError?
    private(set) var treeCalls = 0
    private(set) var log: [String] = []
    private(set) var bodies: [String] = []

    init(nodes: [OpenAPI.CategoryNode] = []) {
        self.nodes = nodes
    }

    func set(nodes: [OpenAPI.CategoryNode]) { self.nodes = nodes }
    func set(treeFailure: APIError?) { self.treeFailure = treeFailure }
    func set(writeFailure: APIError?) { self.writeFailure = writeFailure }

    func categoryTree() async throws -> [OpenAPI.CategoryNode] {
        treeCalls += 1
        if let treeFailure { throw treeFailure }
        return nodes
    }

    func createCategoryNode(_ body: CategoryNodeBody) async throws {
        log.append("create")
        if let writeFailure { throw writeFailure }
        bodies.append(String(decoding: try APIBody.encode(body), as: UTF8.self))
    }

    func updateCategoryNode(id: Int, body: CategoryNodeBody) async throws {
        log.append("update \(id)")
        if let writeFailure { throw writeFailure }
        bodies.append(String(decoding: try APIBody.encode(body), as: UTF8.self))
    }

    func setCategoryActive(id: Int, isActive: Bool) async throws {
        log.append("active \(id) \(isActive)")
        if let writeFailure { throw writeFailure }
    }

    func deleteCategoryNode(id: Int) async throws {
        log.append("delete \(id)")
        if let writeFailure { throw writeFailure }
    }

    func mergeCategoryNode(sourceId: Int, targetId: Int) async throws {
        log.append("merge \(sourceId)->\(targetId)")
        if let writeFailure { throw writeFailure }
    }
}

enum CategoriesFixture {
    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "categoriesPage.subtitle": "{n} categories in {g} groups",
            "categoriesPage.mergeSelectionSummary": "{source} merges into {target}",
            "categoriesPage.delete.desc": "Delete {name}?",
            "common.undo": "Undo",
        ])

    static func node(
        _ id: Int, _ name: String, parent: OpenAPI.CategoryNode? = nil, active: Bool = true, description: String? = nil
    ) -> OpenAPI.CategoryNode {
        let path = (parent?.path ?? []) + [name]
        return OpenAPI.CategoryNode(
            id: id, name: name, parentId: parent?.id, pathIds: (parent?.pathIds ?? []) + [id], path: path,
            categoryName: path.joined(separator: ":"), depth: path.count - 1, description: description,
            isActive: active, hierarchyOnly: false, legacyCompatible: true)
    }

    /// Food (Groceries, inactive Restaurants), Transport (Fuel), the inactive Old (active
    /// Kept), and the leaf Bills.
    static func tree() -> [OpenAPI.CategoryNode] {
        let food = node(1, "Food")
        let transport = node(4, "Transport")
        let old = node(6, "Old", active: false)
        return [
            food, node(2, "Groceries", parent: food), node(3, "Restaurants", parent: food, active: false),
            transport, node(5, "Fuel", parent: transport), old, node(7, "Kept", parent: old), node(8, "Bills"),
        ]
    }

    @MainActor
    static func idleModel() -> CategoriesModel {
        CategoriesModel(service: FakeCategoriesService())
    }

    @MainActor
    static func shell(_ model: CategoriesModel, recorder: ShellRecorder) -> NativeShellModel {
        NativeShellModel(
            strings: strings, theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: model, recipients: RecipientsFixture.idleModel(),
            loadSettings: { NativeAppSettings() }, onNavigate: { recorder.actions.append($0) },
            settingsReloadDelay: .milliseconds(1))
    }

    /// A shell on `route` with its settings read and the screen appeared.
    @MainActor
    static func opened(
        _ service: FakeCategoriesService, route: String = "/categories", recorder: ShellRecorder = ShellRecorder()
    ) async throws -> (CategoriesModel, NativeShellModel) {
        let model = CategoriesModel(service: service)
        let shell = shell(model, recorder: recorder)
        shell.routeDidChange(try #require(NativeRoute(route)))
        await shell.settingsSettled()
        await model.appear()
        return (model, shell)
    }
}

// MARK: - Routes and tree

@Suite struct CategoriesRouteTests {
    @Test func theRouteIsNativeForEveryone() {
        #expect(NativeScreen.screen(forPath: "/categories") == .categories)
        #expect(NativeScreen.categories.path == "/categories")
        #expect(!NativeScreen.categories.requiresAdmin)
        #expect(NativeScreen.screen(forPath: "/categories/1") == nil)
    }

    @Test func expandedKeepsUrlOrderWithoutRepeatsOrJunk() throws {
        let route = try #require(NativeRoute("/categories?expanded=4&show_all=true&expanded=x&expanded=1&expanded=4"))
        #expect(CategoriesRoutes.expanded(in: route) == [4, 1])
        #expect(CategoriesRoutes.showAll(in: route))
        let written = CategoriesRoutes.writingExpanded([1], to: route)
        #expect(written.map(\.name) == ["show_all", "expanded"])
        #expect(written.last?.value == "1")
        let off = try #require(NativeRoute("/categories?show_all=1"))
        #expect(!CategoriesRoutes.showAll(in: off))
    }

    @Test func theNameLinkFiltersTheLeafOrTheWholeSubtree() throws {
        let nodes = CategoriesFixture.tree()
        let tree = CategoryTree(nodes: nodes, showAll: false)
        let food = try #require(tree.node(1))
        let branch = CategoriesRoutes.transactionsLink(food, subtreeIds: tree.subtreeIds(1))
        let branchFilters = TransactionFilters(route: try #require(NativeRoute(branch)))
        #expect(branchFilters.categoryIds == [1, 2, 3])
        #expect(branchFilters.filterLabel == "Food")
        let groceries = try #require(tree.node(2))
        let leaf = CategoriesRoutes.transactionsLink(groceries, subtreeIds: tree.subtreeIds(2))
        let leafFilters = TransactionFilters(route: try #require(NativeRoute(leaf)))
        #expect(leafFilters.categoryId == 2)
        #expect(leafFilters.filterLabel == "Food / Groceries")
    }

    @Test func activeViewKeepsAncestorsOfActiveNodesAndSortsByName() {
        let tree = CategoryTree(nodes: CategoriesFixture.tree(), showAll: false)
        #expect(Set(tree.visible.map(\.id)) == [1, 2, 4, 5, 6, 7, 8])
        #expect(tree.roots.map(\.name) == ["Bills", "Food", "Old", "Transport"])
        #expect(tree.branchIds == [1, 4, 6])
        #expect(tree.rows(expanded: [1]).map(\.id) == [8, 1, 2, 6, 4])
        #expect(tree.rows(expanded: [1]).first { $0.id == 2 }?.level == 1)
        #expect(tree.subtreeCount(1) == 2)
        #expect(!tree.allExpanded([1, 4]))
        #expect(tree.allExpanded([1, 4, 6]))
        let all = CategoryTree(nodes: CategoriesFixture.tree(), showAll: true)
        #expect(all.subtreeCount(1) == 3)
        #expect(all.children(of: 1).map(\.name) == ["Groceries", "Restaurants"])
    }

    @Test func mergeTargetsAndParentsLeaveOutTheSubtreeAndInactiveNodes() throws {
        let tree = CategoryTree(nodes: CategoriesFixture.tree(), showAll: true)
        let food = try #require(tree.node(1))
        #expect(tree.mergeTargets(food).map(\.id) == [4, 5, 7, 8])
        #expect(tree.parentOptions(editing: food).map(\.id) == [4, 5, 7, 8])
        #expect(tree.parentOptions(editing: nil).map(\.id) == [1, 2, 4, 5, 7, 8])
        let lonely = CategoryTree(nodes: [CategoriesFixture.node(1, "Only")], showAll: true)
        #expect(!lonely.canMerge(try #require(lonely.node(1))))
    }
}

// MARK: - Dialog drafts

@Suite struct CategoryDraftTests {
    @Test func theBodySendsNullsForARootAndAnEmptyDescription() throws {
        var draft = CategoryNodeDraft()
        draft.setName("  Pets  ")
        draft.setDescription("   ")
        let body = try #require(draft.body)
        let json = String(decoding: try APIBody.encode(body), as: UTF8.self)
        #expect(json == "{\"description\":null,\"name\":\"Pets\",\"parentId\":null}")
        draft.parentId = 4
        draft.setDescription(" Vet ")
        let moved = try #require(draft.body)
        #expect(moved == CategoryNodeBody(name: "Pets", parentId: 4, description: "Vet"))
    }

    @Test func limitsAndKeysFollowTheMode() {
        var draft = CategoryNodeDraft()
        draft.setName(String(repeating: "a", count: 140))
        #expect(draft.name.count == CategoryNodeDraft.nameLimit)
        draft.setDescription(String(repeating: "b", count: 600))
        #expect(draft.description.count == CategoryNodeDraft.descriptionLimit)
        #expect(draft.titleKey == "form.addCategory.title")
        #expect(draft.submitKey == "categories.createButton")
        let edit = CategoryNodeDraft(editing: CategoriesFixture.node(3, "Bills", description: "Monthly"))
        #expect(edit.mode == .edit(id: 3))
        #expect(edit.description == "Monthly")
        #expect(edit.titleKey == "form.addCategory.editTitle")
        #expect(edit.submitKey == "common.save")
        var blank = CategoryNodeDraft()
        blank.setName("   ")
        #expect(blank.body == nil)
    }
}

// MARK: - Screen

@MainActor
@Suite struct CategoriesScreenTests {
    @Test func appearLoadsOnceAndRetryRefetches() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(shell.detail == .native(.categories))
        #expect(model.nodes?.count == 8)
        #expect(model.subtitle == "7 categories in 4 groups")
        await model.appear()
        #expect(await service.treeCalls == 1)
        await service.set(treeFailure: .network("offline"))
        await model.retry()
        #expect(model.error != nil)
        #expect(!model.isLoading)
        await service.set(treeFailure: nil)
        await model.retry()
        #expect(model.error == nil)
        #expect(await service.treeCalls == 3)
    }

    @Test func concurrentLoadsShareOneRequest() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let model = CategoriesModel(service: service)
        async let first: Void = model.load()
        async let second: Void = model.load()
        _ = await (first, second)
        #expect(await service.treeCalls == 1)
    }

    @Test func showAllAndExpandWriteTheRoute() async throws {
        let recorder = ShellRecorder()
        let (model, shell) = try await CategoriesFixture.opened(
            FakeCategoriesService(nodes: CategoriesFixture.tree()), recorder: recorder)
        defer { withExtendedLifetime(shell) {} }
        model.toggleExpanded(4)
        model.toggleExpanded(1)
        #expect(model.expandedIds == [4, 1])
        #expect(recorder.actions.last == .replaceRoute("/categories?expanded=4&expanded=1"))
        model.toggleExpanded(4)
        #expect(model.expandedIds == [1])
        model.toggleExpandAll()
        #expect(model.expandedIds == [1, 4, 6])
        model.toggleExpandAll()
        #expect(model.expandedIds.isEmpty)
        model.setShowAll(true)
        #expect(model.showAll)
        #expect(model.tree.visible.count == 8)
        model.setShowAll(false)
        #expect(shell.route.value("show_all") == nil)
    }

    @Test func theNameLinkNavigatesOnlyWhileShown() async throws {
        let recorder = ShellRecorder()
        let (model, shell) = try await CategoriesFixture.opened(
            FakeCategoriesService(nodes: CategoriesFixture.tree()), recorder: recorder)
        defer { withExtendedLifetime(shell) {} }
        let bills = try #require(model.tree.node(8))
        model.openTransactions(bills)
        #expect(recorder.actions.last == .navigate("/transactions?category_id=8&filter_label=Bills"))
        model.disappear()
        let before = recorder.actions.count
        model.openTransactions(bills)
        #expect(recorder.actions.count == before)
    }

    @Test func addValidatesThenCreatesAndRefetches() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        await model.submitForm()
        #expect(model.form?.showsNameError == true)
        #expect(model.nameFocusRequest == 1)
        #expect(await service.log.isEmpty)
        model.form?.setName("Pets")
        #expect(model.form?.showsNameError == false)
        model.form?.parentId = 1
        await model.submitForm()
        #expect(model.form == nil)
        #expect(model.notice?.key == "categories.created")
        #expect(await service.bodies == ["{\"description\":null,\"name\":\"Pets\",\"parentId\":1}"])
        #expect(await service.treeCalls == 2)
    }

    @Test func aFailedEditKeepsTheDialogOpen() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openEdit(try #require(model.tree.node(2)))
        #expect(model.parentOptions.map(\.id) == [1, 4, 5, 7, 8])
        model.form?.parentId = nil
        await service.set(writeFailure: .network("offline"))
        await model.submitForm()
        #expect(model.form != nil)
        #expect(model.notice?.key == "categories.updateFailedTitle")
        await service.set(writeFailure: nil)
        await model.submitForm()
        #expect(model.form == nil)
        #expect(model.notice?.key == "categories.updated")
        #expect(await service.log.last == "update 2")
        #expect(await service.bodies == ["{\"description\":null,\"name\":\"Groceries\",\"parentId\":null}"])
    }

    @Test func mergeNeedsATargetAndPostsIt() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openMerge(try #require(model.tree.node(2)))
        #expect(model.merge?.canMerge == false)
        #expect(model.mergeSummary == nil)
        model.merge?.targetId = 8
        #expect(model.mergeSummary == "Food / Groceries merges into Bills")
        await model.confirmMerge()
        #expect(model.merge == nil)
        #expect(await service.log == ["merge 2->8"])
        #expect(model.notice?.key == "categories.updated")
    }

    @Test func statusFlipOffersUndoThatRestoresIt() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let bills = try #require(model.tree.node(8))
        await model.toggleStatus(bills)
        let notice = try #require(model.notice)
        #expect(notice.key == "categoriesPage.toast.inactive")
        #expect(notice.variables["name"] == "Bills")
        #expect(model.actionTitle(for: notice) == "Undo")
        #expect(model.duration(of: notice) == CategoriesModel.undoDuration)
        #expect(model.hasUndo)
        await model.undo()
        #expect(await service.log == ["active 8 false", "active 8 true"])
        #expect(!model.hasUndo)
        await model.toggleStatus(bills)
        let second = try #require(model.notice)
        model.clearNotice(second.id)
        await model.undo()
        #expect(await service.log.count == 3)
    }

    @Test func deleteIsRefusedOnBranchesAndAsksFirstOnLeaves() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.requestDelete(try #require(model.tree.node(1)))
        #expect(model.pendingDelete == nil)
        model.requestDelete(try #require(model.tree.node(8)))
        #expect(model.deleteText()?.message == "Delete Bills?")
        model.cancelDelete()
        #expect(await service.log.isEmpty)
        model.requestDelete(try #require(model.tree.node(8)))
        await model.confirmDelete()
        #expect(await service.log == ["delete 8"])
        #expect(model.notice?.key == "categories.deleted")
    }

    @Test func aWriteInvalidatesTheSharedPickers() async throws {
        let service = FakeCategoriesService(nodes: CategoriesFixture.tree())
        let (model, shell) = try await CategoriesFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await shell.transactions.pickers.load()
        #expect(shell.transactions.pickers.isLoaded)
        await model.toggleStatus(try #require(model.tree.node(8)))
        #expect(!shell.transactions.pickers.isLoaded)
    }

    @Test func disappearClosesEveryDialog() async throws {
        let (model, shell) = try await CategoriesFixture.opened(FakeCategoriesService(nodes: CategoriesFixture.tree()))
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        model.openMerge(try #require(model.tree.node(2)))
        model.requestDelete(try #require(model.tree.node(8)))
        model.disappear()
        #expect(model.form == nil)
        #expect(model.merge == nil)
        #expect(model.pendingDelete == nil)
    }

    @Test func aRevisitWithAFreshTreeRedrawsFromTheRoute() async throws {
        let (model, shell) = try await CategoriesFixture.opened(
            FakeCategoriesService(nodes: CategoriesFixture.tree()), route: "/categories?show_all=true")
        defer { withExtendedLifetime(shell) {} }
        model.disappear()
        // Hidden, the body reads no route; the revisit reuses the tree, so only `visible` changes.
        final class Changed: @unchecked Sendable { var fired = false }
        let changed = Changed()
        withObservationTracking { _ = model.showAll } onChange: { changed.fired = true }
        await model.appear()
        #expect(changed.fired)
        #expect(model.showAll)
    }
}

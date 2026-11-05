import AppKit
import SwiftUI
import Testing
import VisionNativeCore
@testable import VisionNativeUI

/// A categories service with a fixed tree: Voeding (Boodschappen, the inactive Restaurants),
/// Vervoer (Brandstof) and the leaf Vaste kosten. `failing` fails the tree.
actor StaticCategoriesService: CategoriesService {
    let nodes: [OpenAPI.CategoryNode]
    let failing: Bool

    init(nodes: [OpenAPI.CategoryNode] = StaticCategoriesService.sample, failing: Bool = false) {
        self.nodes = nodes
        self.failing = failing
    }

    static func node(
        _ id: CategoryID, _ name: String, parent: OpenAPI.CategoryNode? = nil, active: Bool = true,
        description: String? = nil
    ) -> OpenAPI.CategoryNode {
        let path = (parent?.path ?? []) + [name]
        return OpenAPI.CategoryNode(
            id: id, name: name, parentId: parent?.id, pathIds: (parent?.pathIds ?? []) + [id], path: path,
            categoryName: path.joined(separator: ":"), depth: path.count - 1, description: description,
            isActive: active, hierarchyOnly: false, legacyCompatible: true)
    }

    static let sample: [OpenAPI.CategoryNode] = {
        let food = node(1, "Voeding", description: "Alles wat we eten en drinken, thuis en onderweg")
        let transport = node(4, "Vervoer")
        return [
            food, node(2, "Boodschappen", parent: food), node(3, "Restaurants", parent: food, active: false),
            transport, node(5, "Brandstof", parent: transport), node(6, "Vaste kosten"),
        ]
    }()

    func categoryTree() async throws -> [OpenAPI.CategoryNode] {
        if failing { throw APIError.network("offline") }
        return nodes
    }

    func createCategoryNode(_ body: CategoryNodeBody) async throws {}
    func updateCategoryNode(id: CategoryID, body: CategoryNodeBody) async throws {}
    func setCategoryActive(id: CategoryID, isActive: Bool) async throws {}
    func deleteCategoryNode(id: CategoryID) async throws {}
    func mergeCategoryNode(sourceId: CategoryID, targetId: CategoryID) async throws {}
}

/// A payees service with fixed answers: a primary with two aliases, a payee with a default
/// category and notes, and an inactive one; one match rule. `failing` fails the list.
actor StaticRecipientsService: RecipientsService {
    let rows: [OpenAPI.Recipient]
    let failing: Bool

    init(rows: [OpenAPI.Recipient] = StaticRecipientsService.sample, failing: Bool = false) {
        self.rows = rows
        self.failing = failing
    }

    static func payee(
        _ id: RecipientID, _ name: String, account: String? = nil, category: String? = nil,
        primary: (RecipientID, String)? = nil,
        aliases: Int? = nil, notes: String? = nil, active: Bool = true
    ) -> OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: name, primaryBankAccount: account, defaultCategoryId: category == nil ? nil : 2,
            defaultCategoryName: category, primaryRecipientId: primary?.0, primaryRecipientName: primary?.1,
            aliasCount: aliases, notes: notes, isActive: active, createdAt: fixtureInstant("2026-01-01T00:00:00.000Z"), links: [])
    }

    static let sample: [OpenAPI.Recipient] = [
        payee(1, "KBC Bank NV met een bijzonder lange naam", account: "BE68 5390 0754 7034", category: "BANK:KOSTEN", aliases: 2),
        payee(2, "Kbc", primary: (1, "KBC Bank NV met een bijzonder lange naam")),
        payee(3, "KBC NV", primary: (1, "KBC Bank NV met een bijzonder lange naam")),
        payee(4, "Albert Heijn", category: "VOEDING:BOODSCHAPPEN", notes: "Wekelijkse boodschappen"),
        payee(5, "Delhaize", active: false),
    ]

    static let rule = OpenAPI.RecipientPattern(
        id: 10, pattern: "KBC BANK NV", patternKind: .init(rawValue: "literal_prefix"), caseSensitive: true, priority: 50,
        isActive: true, source: .init(rawValue: "merge"), notes: "Na het samenvoegen", createdAt: fixtureInstant("2026-01-01T00:00:00.000Z"))

    func payeePage(_ query: PayeePageQuery, offset: Int, limit: Int) async throws -> PayeePage {
        if failing { throw APIError.network("offline") }
        let end = min(rows.count, offset + limit)
        return PayeePage(items: offset < end ? Array(rows[offset..<end]) : [], total: rows.count)
    }

    func createPayee(name: String, notes: String?) async throws -> Bool { true }
    func updatePayee(id: RecipientID, patch: PayeePatch) async throws {}
    func deletePayee(id: RecipientID) async throws {}

    func mergePayees(primaryId: RecipientID, aliasIds: [RecipientID]) async throws -> PayeeMergeResult {
        PayeeMergeResult(primary: .init(id: primaryId, name: "KBC"), mergedIds: aliasIds)
    }

    func unmergePayee(id: RecipientID) async throws {}
    func matchRules(recipientId: RecipientID) async throws -> [OpenAPI.RecipientPattern] { [Self.rule] }
    func createMatchRule(recipientId: RecipientID, body: MatchRuleBody) async throws {}
    func updateMatchRule(recipientId: RecipientID, patternId: RecipientPatternID, patch: MatchRulePatch) async throws {}
    func deleteMatchRule(recipientId: RecipientID, patternId: RecipientPatternID) async throws {}

    func previewMatchRule(recipientId: RecipientID, pattern: String, kind: MatchRuleKind, caseSensitive: Bool)
        async throws -> Int
    { 4 }
}

/// `/categories` and `/recipients` build and lay out in both languages and appearances.
@MainActor
@Suite struct CategoriesRecipientsStructureTests {
    func makeShell(
        language: NativeLanguage, appearance: ThemeAppearance,
        categories: StaticCategoriesService = StaticCategoriesService(),
        recipients: StaticRecipientsService = StaticRecipientsService()
    ) -> NativeShellModel {
        NativeScreenStructureTests().makeShell(
            language: language, appearance: appearance, adminMode: false, categories: categories,
            recipients: recipients)
    }

    func layOut<Content: View>(_ view: Content) -> NSHostingView<Content> {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        host.layoutSubtreeIfNeeded()
        return host
    }

    func themed<Content: View>(_ view: Content, _ shell: NativeShellModel) -> some View {
        view.environment(\.visionTheme, VisionTheme(selection: shell.theme))
    }

    // MARK: Categories

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theCategoriesScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.categories
        shell.show(try #require(NativeRoute("/categories?show_all=true")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.categories))
        // Each host stays alive until the end, so no `.onDisappear` resets the model early.
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        #expect(model.isLoading)
        let loadingHost = layOut(themed(CategoriesView(model: model, shell: shell), shell))
        hosts.append(loadingHost)
        #expect(loadingHost.fittingSize.width > 0)
        await model.appear()
        model.toggleExpandAll()
        #expect(model.rows.count == 6)
        let loadedHost = layOut(themed(CategoriesView(model: model, shell: shell), shell))
        hosts.append(loadedHost)
        #expect(loadedHost.fittingSize.height > 0)
        // The delete confirmation over the tree.
        model.requestDelete(try #require(model.tree.node(6)))
        #expect(model.deleteText() != nil)
        let deleteHost = layOut(themed(CategoriesView(model: model, shell: shell), shell))
        hosts.append(deleteHost)
        #expect(deleteHost.fittingSize.height > 0)
        model.cancelDelete()
        // No categories, and the error card with Retry.
        let empty = makeShell(language: language, appearance: appearance, categories: StaticCategoriesService(nodes: []))
        empty.show(try #require(NativeRoute("/categories")))
        await empty.settingsSettled()
        await empty.categories.appear()
        #expect(empty.categories.rows.isEmpty)
        let emptyHost = layOut(themed(CategoriesView(model: empty.categories, shell: empty), empty))
        hosts.append(emptyHost)
        #expect(emptyHost.fittingSize.height > 0)
        let failing = makeShell(
            language: language, appearance: appearance, categories: StaticCategoriesService(failing: true))
        failing.show(try #require(NativeRoute("/categories")))
        await failing.settingsSettled()
        await failing.categories.appear()
        #expect(failing.categories.error != nil)
        let failingHost = layOut(themed(CategoriesView(model: failing.categories, shell: failing), failing))
        hosts.append(failingHost)
        #expect(failingHost.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theCategoryDialogsLayOut(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.categories
        shell.show(try #require(NativeRoute("/categories")))
        await shell.settingsSettled()
        await model.appear()
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        // Add, with the empty-name error, then Edit.
        model.openCreate()
        await model.submitForm()
        #expect(model.form?.showsNameError == true)
        let addHost = layOut(themed(CategoryNodeSheet(model: model, shell: shell), shell))
        hosts.append(addHost)
        #expect(addHost.fittingSize.height > 0)
        model.openEdit(try #require(model.tree.node(2)))
        let editHost = layOut(themed(CategoryNodeSheet(model: model, shell: shell), shell))
        hosts.append(editHost)
        #expect(editHost.fittingSize.height > 0)
        model.closeForm()
        // Merge, with a target chosen.
        model.openMerge(try #require(model.tree.node(2)))
        model.merge?.targetId = 6
        #expect(model.mergeSummary != nil)
        let mergeHost = layOut(themed(CategoryMergeSheet(model: model, shell: shell), shell))
        hosts.append(mergeHost)
        #expect(mergeHost.fittingSize.height > 0)
        model.closeMerge()
    }

    // MARK: Recipients

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theRecipientsScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.recipients
        shell.show(try #require(NativeRoute("/recipients?show_all=true")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.recipients))
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        #expect(model.isLoading)
        let loadingHost = layOut(themed(RecipientsView(model: model, shell: shell), shell))
        hosts.append(loadingHost)
        #expect(loadingHost.fittingSize.width > 0)
        await model.appear()
        #expect(model.rows?.count == 5)
        let loadedHost = layOut(themed(RecipientsView(model: model, shell: shell), shell))
        hosts.append(loadedHost)
        #expect(loadedHost.fittingSize.height > 0)
        // A row in inline edit, then a column filter and the delete confirmation.
        model.startEditing(try #require(model.rows?.first))
        let editHost = layOut(themed(RecipientsView(model: model, shell: shell), shell))
        hosts.append(editHost)
        #expect(editHost.fittingSize.height > 0)
        model.cancelEditing()
        model.setColumnFilter(PayeeColumns.name, to: "kbc")
        model.requestDelete(try #require(model.rows?.first))
        let deleteHost = layOut(themed(RecipientsView(model: model, shell: shell), shell))
        hosts.append(deleteHost)
        #expect(deleteHost.fittingSize.height > 0)
        model.cancelDelete()
        // No payees, and the error card with Retry.
        let empty = makeShell(language: language, appearance: appearance, recipients: StaticRecipientsService(rows: []))
        empty.show(try #require(NativeRoute("/recipients")))
        await empty.settingsSettled()
        await empty.recipients.appear()
        #expect(empty.recipients.rows?.isEmpty == true)
        let emptyHost = layOut(themed(RecipientsView(model: empty.recipients, shell: empty), empty))
        hosts.append(emptyHost)
        #expect(emptyHost.fittingSize.height > 0)
        let failing = makeShell(
            language: language, appearance: appearance, recipients: StaticRecipientsService(failing: true))
        failing.show(try #require(NativeRoute("/recipients")))
        await failing.settingsSettled()
        await failing.recipients.appear()
        #expect(failing.recipients.error != nil)
        let failingHost = layOut(themed(RecipientsView(model: failing.recipients, shell: failing), failing))
        hosts.append(failingHost)
        #expect(failingHost.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theRecipientDialogsLayOut(_ language: NativeLanguage, _ appearance: ThemeAppearance) async throws {
        let shell = makeShell(language: language, appearance: appearance)
        let model = shell.recipients
        shell.show(try #require(NativeRoute("/recipients")))
        await shell.settingsSettled()
        await model.appear()
        var hosts: [NSView] = []
        defer { withExtendedLifetime(hosts) {} }
        // Add payee, with the empty-name error.
        model.openAdd()
        await model.submitAdd()
        #expect(model.add?.showsNameError == true)
        let addHost = layOut(themed(PayeeAddSheet(model: model, shell: shell), shell))
        hosts.append(addHost)
        #expect(addHost.fittingSize.height > 0)
        model.closeAdd()
        // Merge payees: the list, then a primary with aliases.
        await model.openMerge()
        let listHost = layOut(themed(PayeeMergeSheet(merge: model.merge, shell: shell), shell))
        hosts.append(listHost)
        #expect(listHost.fittingSize.height > 0)
        model.merge.selectPrimary(1)
        model.merge.toggleAlias(4)
        model.merge.toggleAlias(5)
        #expect(model.merge.canMerge)
        let selectedHost = layOut(themed(PayeeMergeSheet(merge: model.merge, shell: shell), shell))
        hosts.append(selectedHost)
        #expect(selectedHost.fittingSize.height > 0)
        model.merge.cancel()
        // Match rules: the list, then the form with a preview.
        await model.openRules(try #require(model.rows?.first))
        #expect(model.rules?.patterns?.count == 1)
        let rulesHost = layOut(themed(MatchRulesSheet(model: model, shell: shell), shell))
        hosts.append(rulesHost)
        #expect(rulesHost.fittingSize.height > 0)
        model.startNewRule()
        model.rules?.setPattern("ALBERT")
        await model.previewRule()
        #expect(model.rules?.previewCount == 4)
        let formHost = layOut(themed(MatchRulesSheet(model: model, shell: shell), shell))
        hosts.append(formHost)
        #expect(formHost.fittingSize.height > 0)
        model.requestRuleDelete(StaticRecipientsService.rule)
        let deleteHost = layOut(themed(MatchRulesSheet(model: model, shell: shell), shell))
        hosts.append(deleteHost)
        #expect(deleteHost.fittingSize.height > 0)
        model.cancelRuleDelete()
        model.closeRules()
    }

    @Test func theShellShowsCategoriesAndRecipients() async throws {
        let shell = makeShell(language: .nl, appearance: .dark)
        let host = layOut(ShellRootView(model: shell))
        defer { withExtendedLifetime(host) {} }
        shell.show(try #require(NativeRoute("/categories")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.categories))
        host.layoutSubtreeIfNeeded()
        shell.show(try #require(NativeRoute("/recipients")))
        #expect(shell.detail == .native(.recipients))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }
}

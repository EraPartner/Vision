import Foundation
import Testing

@testable import VisionNativeCore

// MARK: - Fakes and fixtures

/// A scripted `RecipientsService` that records every call.
actor FakeRecipientsService: RecipientsService {
    var payees: [OpenAPI.Recipient]
    var pageFailure: APIError?
    /// Pages from these offsets fail (the load-more alert).
    var failingOffsets: Set<Int> = []
    var writeFailure: APIError?
    var createdNew = true
    var mergeResult = PayeeMergeResult(primary: .init(id: 1, name: "KBC"), mergedIds: [2, 3])
    var rules: [OpenAPI.RecipientPattern] = []
    var previewCount = 3
    private var previewGate: CallGate?
    private var ruleWriteGate: CallGate?
    private var rulesGate: CallGate?
    private(set) var queries: [PayeePageQuery] = []
    private(set) var pages: [String] = []
    private(set) var log: [String] = []
    private(set) var bodies: [String] = []

    init(payees: [OpenAPI.Recipient] = []) {
        self.payees = payees
    }

    func set(pageFailure: APIError?) { self.pageFailure = pageFailure }
    func set(failingOffsets: Set<Int>) { self.failingOffsets = failingOffsets }
    func set(writeFailure: APIError?) { self.writeFailure = writeFailure }
    func set(createdNew: Bool) { self.createdNew = createdNew }
    func set(mergeResult: PayeeMergeResult) { self.mergeResult = mergeResult }
    func set(rules: [OpenAPI.RecipientPattern]) { self.rules = rules }
    func holdNextPreview(_ gate: CallGate) { previewGate = gate }
    func holdNextRuleWrite(_ gate: CallGate) { ruleWriteGate = gate }
    func holdNextRules(_ gate: CallGate) { rulesGate = gate }

    func payeePage(_ query: PayeePageQuery, offset: Int, limit: Int) async throws -> PayeePage {
        queries.append(query)
        pages.append("\(offset):\(limit)")
        if let pageFailure { throw pageFailure }
        if failingOffsets.contains(offset) { throw APIError.network("offline") }
        let end = min(payees.count, offset + limit)
        let items = offset < end ? Array(payees[offset..<end]) : []
        return PayeePage(items: items, total: payees.count)
    }

    func createPayee(name: String, notes: String?) async throws -> Bool {
        log.append("create \(name) \(notes ?? "nil")")
        if let writeFailure { throw writeFailure }
        return createdNew
    }

    func updatePayee(id: RecipientID, patch: PayeePatch) async throws {
        log.append("update \(id)")
        if let writeFailure { throw writeFailure }
        bodies.append(String(decoding: try APIBody.encode(patch), as: UTF8.self))
    }

    func deletePayee(id: RecipientID) async throws {
        log.append("delete \(id)")
        if let writeFailure { throw writeFailure }
    }

    func mergePayees(primaryId: RecipientID, aliasIds: [RecipientID]) async throws -> PayeeMergeResult {
        log.append("merge \(aliasIds.map(\.rawValue))->\(primaryId)")
        if let writeFailure { throw writeFailure }
        return mergeResult
    }

    func unmergePayee(id: RecipientID) async throws {
        log.append("unmerge \(id)")
        if let writeFailure { throw writeFailure }
    }

    func matchRules(recipientId: RecipientID) async throws -> [OpenAPI.RecipientPattern] {
        log.append("rules \(recipientId)")
        let answer = rules
        if let gate = rulesGate {
            rulesGate = nil
            await gate.wait()
        }
        return answer
    }

    func createMatchRule(recipientId: RecipientID, body: MatchRuleBody) async throws {
        log.append("create rule \(recipientId)")
        if let gate = ruleWriteGate {
            ruleWriteGate = nil
            await gate.wait()
        }
        if let writeFailure { throw writeFailure }
        bodies.append(String(decoding: try APIBody.encode(body), as: UTF8.self))
    }

    func updateMatchRule(recipientId: RecipientID, patternId: RecipientPatternID, patch: MatchRulePatch) async throws {
        log.append("update rule \(recipientId)/\(patternId)")
        if let writeFailure { throw writeFailure }
        bodies.append(String(decoding: try APIBody.encode(patch), as: UTF8.self))
    }

    func deleteMatchRule(recipientId: RecipientID, patternId: RecipientPatternID) async throws {
        log.append("delete rule \(recipientId)/\(patternId)")
        if let writeFailure { throw writeFailure }
    }

    func previewMatchRule(recipientId: RecipientID, pattern: String, kind: MatchRuleKind, caseSensitive: Bool)
        async throws -> Int
    {
        log.append("preview \(recipientId) \(pattern) \(kind.rawValue) \(caseSensitive)")
        let answer = previewCount
        if let gate = previewGate {
            previewGate = nil
            await gate.wait()
        }
        return answer
    }
}

enum RecipientsFixture {
    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "recipientsPage.none": "None",
            "recipientsPage.delete.desc": "Delete \"{name}\"?",
            "common.undo": "Undo",
            "recipients.createRule": "Create rule",
            "recipients.createRuleSuggestion": "A rule for \"{pattern}\" would match {n} existing payees.",
            "merge.mergeCount.one": "Merge {count} payee",
            "merge.mergeCount.other": "Merge {count} payees",
            "merge.merging": "Merging…",
        ])

    static func payee(
        _ id: RecipientID, _ name: String, account: String? = nil, category: String? = nil,
        categoryId: CategoryID? = nil, primary: (id: RecipientID, name: String)? = nil, aliases: Int? = nil, notes: String? = nil, active: Bool = true
    ) -> OpenAPI.Recipient {
        OpenAPI.Recipient(
            id: id, name: name, primaryBankAccount: account, defaultCategoryId: categoryId,
            defaultCategoryName: category, primaryRecipientId: primary?.id, primaryRecipientName: primary?.name,
            aliasCount: aliases, notes: notes, isActive: active, createdAt: "2026-01-01", links: [])
    }

    static func rule(
        _ id: RecipientPatternID, _ pattern: String, kind: String = "literal_prefix", active: Bool = true,
        notes: String? = nil
    ) -> OpenAPI.RecipientPattern {
        OpenAPI.RecipientPattern(
            id: id, pattern: pattern, patternKind: .init(rawValue: kind), caseSensitive: false, priority: 100, isActive: active,
            source: .user, notes: notes, createdAt: "2026-01-01")
    }

    /// KBC (two aliases), its aliases Kbc Bank and KBC NV, Albert Heijn and Delhaize.
    static func payees() -> [OpenAPI.Recipient] {
        [
            payee(1, "KBC", account: "BE68 5390", category: "BANK:FEES", categoryId: 9, aliases: 2),
            payee(2, "Kbc Bank", primary: (1, "KBC")),
            payee(3, "KBC NV", primary: (1, "KBC")),
            payee(4, "Albert Heijn", category: "FOOD:GROCERIES", categoryId: 5, notes: "Weekly"),
            payee(5, "Delhaize", active: false),
        ]
    }

    @MainActor
    static func idleModel() -> RecipientsModel {
        RecipientsModel(service: FakeRecipientsService())
    }

    @MainActor
    static func shell(_ model: RecipientsModel, settings: NativeAppSettings) -> NativeShellModel {
        NativeShellModel(
            strings: strings, theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()), admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: model,
            loadSettings: { settings })
    }

    /// A shell on `route` with its settings read and the screen appeared; pages of two.
    @MainActor
    static func opened(
        _ service: FakeRecipientsService, route: String = "/recipients",
        settings: NativeAppSettings = NativeAppSettings(defaultPageSize: 2)
    ) async throws -> (RecipientsModel, NativeShellModel) {
        let model = RecipientsModel(service: service)
        let shell = shell(model, settings: settings)
        shell.show(try #require(NativeRoute(route)))
        await shell.settingsSettled()
        await model.appear()
        return (model, shell)
    }
}

// MARK: - Routes and values

@Suite struct RecipientsRouteTests {
    @Test func theRouteIsNativeForEveryone() {
        #expect(NativeScreen.screen(forPath: "/recipients") == .recipients)
        #expect(NativeScreen.recipients.path == "/recipients")
        #expect(!NativeScreen.recipients.requiresAdmin)
    }

    @Test func theSortNeedsBothValidHalves() throws {
        let good = try #require(NativeRoute("/recipients?sort_key=notes&sort_dir=desc"))
        #expect(RecipientsRoutes.sort(in: good) == LocalTableSort(key: "notes", ascending: false))
        let badKey = try #require(NativeRoute("/recipients?sort_key=created_at&sort_dir=asc"))
        #expect(RecipientsRoutes.sort(in: badKey) == nil)
        let badDir = try #require(NativeRoute("/recipients?sort_key=name&sort_dir=up"))
        #expect(RecipientsRoutes.sort(in: badDir) == nil)
        let base = try #require(NativeRoute("/recipients?show_all=true&sort_key=name&sort_dir=asc"))
        let cleared = RecipientsRoutes.writingSort(nil, to: base)
        #expect(cleared.map(\.name) == ["show_all"])
        let written = RecipientsRoutes.writingSort(LocalTableSort(key: "is_active", ascending: true), to: base)
        #expect(written.map { "\($0.name)=\($0.value ?? "")" } == ["show_all=true", "sort_key=is_active", "sort_dir=asc"])
    }

    @Test func theSearchStartsAtThreeCharacters() {
        #expect(RecipientsRoutes.gate("  ab ") == "")
        #expect(RecipientsRoutes.gate(" abc ") == "abc")
        #expect(RecipientsRoutes.gate("") == "")
    }

    @Test func theNameLinkFiltersThePayee() throws {
        let link = RecipientsRoutes.transactionsLink(RecipientsFixture.payee(4, "Albert & Co"))
        let filters = TransactionFilters(route: try #require(NativeRoute(link)))
        #expect(filters.recipientId == 4)
        #expect(filters.filterLabel == "Albert & Co")
    }

    @Test func columnValuesAndTheCategoryBadge() {
        let payee = RecipientsFixture.payee(1, "KBC", notes: nil)
        #expect(PayeeColumns.value(payee, key: PayeeColumns.account, none: "None") == .text("None"))
        #expect(PayeeColumns.value(payee, key: PayeeColumns.notes, none: "None") == .text(""))
        #expect(PayeeColumns.value(payee, key: PayeeColumns.status, none: "None") == .bool(true))
        #expect(PayeeColumns.categoryLabel("FOOD:GROCERIES") == "Groceries")
        #expect(PayeeColumns.categoryLabel("FOOD") == "Food")
        #expect(PayeeColumns.categoryLabel("A: b:C") == "b:c")
        #expect(PayeeColumns.categoryLabel(nil) == nil)
        #expect(PayeeColumns.categoryLabel("") == nil)
    }

    @Test func theMergeAnswerDecodesItsSuggestion() throws {
        let json = """
            {"primary":{"id":1,"name":"KBC"},"merged_ids":[2,3],
             "patternSuggestion":{"pattern":"KBC","kind":"literal_prefix","matchCount":4}}
            """
        let result = try JSONDecoder().decode(PayeeMergeResult.self, from: Data(json.utf8))
        #expect(result.primary.name == "KBC")
        #expect(result.mergedIds == [2, 3])
        #expect(result.suggestion == .init(pattern: "KBC", kind: "literal_prefix", matchCount: 4))
        let plain = try JSONDecoder().decode(PayeeMergeResult.self, from: Data(#"{"primary":{"id":1,"name":"K"}}"#.utf8))
        #expect(plain.mergedIds.isEmpty)
        #expect(plain.suggestion == nil)
    }

    @Test func patchesSendNullOnlyWhenAsked() throws {
        let none = String(decoding: try APIBody.encode(PayeePatch(defaultCategoryId: .some(nil))), as: UTF8.self)
        #expect(none == "{\"default_category_id\":null}")
        let some = String(decoding: try APIBody.encode(PayeePatch(defaultCategoryId: 5)), as: UTF8.self)
        #expect(some == "{\"default_category_id\":5}")
        let status = String(decoding: try APIBody.encode(PayeePatch(isActive: false)), as: UTF8.self)
        #expect(status == "{\"is_active\":false}")
        let rule = String(decoding: try APIBody.encode(MatchRulePatch.active(true)), as: UTF8.self)
        #expect(rule == "{\"is_active\":true}")
    }

    @Test func thePriorityParsesLikeParseInt() {
        var form = MatchRuleForm()
        #expect(form.priority == 100)
        form.priorityText = "12x"
        #expect(form.priority == 12)
        form.priorityText = "0"
        #expect(form.priority == 100)
        form.priorityText = "abc"
        #expect(form.priority == 100)
        form.priorityText = " -3"
        #expect(form.priority == -3)
        form.pattern = "  "
        #expect(!form.canSave)
        #expect(form.body == nil)
    }

    @Test func thePriorityMustBeBetweenOneAnd999() {
        var form = MatchRuleForm()
        form.pattern = "KBC"
        form.priorityText = "-3"
        #expect(!form.priorityIsValid)
        #expect(form.body == nil)
        form.priorityText = "1000"
        #expect(!form.priorityIsValid)
        #expect(form.body == nil)
        form.priorityText = "999"
        #expect(form.priorityIsValid)
        #expect(form.body?.priority == 999)
        form.priorityText = "1"
        #expect(form.body?.priority == 1)
    }
}

// MARK: - Screen

@MainActor
@Suite struct RecipientsScreenTests {
    @Test func theRouteDrivesTheFirstPage() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(
            service, route: "/recipients?show_all=true&uncategorized=true&search=kbc&sort_key=name&sort_dir=desc")
        defer { withExtendedLifetime(shell) {} }
        #expect(shell.detail == .native(.recipients))
        #expect(model.searchText == "kbc")
        #expect(
            await service.queries.first
                == PayeePageQuery(active: false, search: "kbc", uncategorized: true, sortBy: "name", sortDir: "desc"))
        #expect(await service.pages == ["0:2"])
        #expect(model.tableQuery.sort == LocalTableSort(key: "name", ascending: false))
    }

    @Test func pagesLoadOnScrollAndAFailureOffersRetry() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.rows?.count == 2)
        #expect(model.total == 5)
        #expect(model.hasMore)
        await service.set(failingOffsets: [2])
        await model.rowAppeared(2)
        #expect(model.loadMoreFailed)
        #expect(model.rows?.count == 2)
        // The alert stops the scroll trigger; only Retry asks again.
        await model.rowAppeared(2)
        #expect(await service.pages == ["0:2", "2:2"])
        await service.set(failingOffsets: [])
        await model.loadMore()
        #expect(!model.loadMoreFailed)
        #expect(model.rows?.map(\.id) == [1, 2, 3, 4])
        await model.rowAppeared(4)
        #expect(model.rows?.count == 5)
        #expect(!model.hasMore)
    }

    @Test func anErrorShowsAndRetryRefetches() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        await service.set(pageFailure: .network("offline"))
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.error != nil)
        #expect(!model.isLoading)
        await service.set(pageFailure: nil)
        await model.retry()
        #expect(model.error == nil)
        #expect(model.rows?.count == 2)
    }

    @Test func viewSearchAndSortWriteTheRouteAndReload() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await model.setShowAll(true)
        await model.setUncategorizedOnly(true)
        #expect(shell.route.string == "/recipients?show_all=true&uncategorized=true")
        #expect(await service.queries.last?.active == false)
        #expect(await service.queries.last?.uncategorized == true)
        model.searchText = "ab"
        await model.commitSearch()
        #expect(shell.route.value("search") == nil)
        model.searchText = " abc "
        await model.commitSearch()
        #expect(shell.route.value("search") == "abc")
        #expect(await service.queries.last?.search == "abc")
        await model.toggleSort("name")
        #expect(model.sort == LocalTableSort(key: "name", ascending: true))
        await model.toggleSort("name")
        #expect(model.sort == LocalTableSort(key: "name", ascending: false))
        await model.toggleSort("name")
        #expect(model.sort == nil)
        #expect(shell.route.value("sort_key") == nil)
        await model.toggleSort("notes")
        model.setColumnFilter(PayeeColumns.name, to: "kbc")
        await model.clearAll()
        #expect(model.searchText.isEmpty)
        #expect(model.columnFilters.isEmpty)
        #expect(shell.route.string == "/recipients?show_all=true&uncategorized=true")
    }

    @Test func columnFiltersNarrowOnlyTheLoadedRows() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(
            service, settings: NativeAppSettings(defaultPageSize: 50))
        defer { withExtendedLifetime(shell) {} }
        let requests = await service.pages.count
        model.setColumnFilter(PayeeColumns.name, to: "kbc")
        #expect(model.shownRows.map(\.id) == [1, 2, 3])
        model.setColumnFilter(PayeeColumns.account, to: "none")
        #expect(model.shownRows.map(\.id) == [2, 3])
        #expect(model.filterValues(PayeeColumns.account).contains("None"))
        #expect(await service.pages.count == requests)
        var next = model.tableQuery
        next.setFilter(PayeeColumns.account, to: "")
        await model.apply(next)
        #expect(model.shownRows.map(\.id) == [1, 2, 3])
    }

    @Test func inlineEditSendsNameNotesAndStatus() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        model.startEditing(kbc)
        #expect(model.editing == PayeeRowEdit(id: 1, name: "KBC", notes: ""))
        model.editing?.name = "KBC Bank"
        await model.saveEditing()
        #expect(model.editing == nil)
        #expect(await service.bodies == ["{\"is_active\":true,\"name\":\"KBC Bank\",\"notes\":\"\"}"])
        #expect(model.notice?.key == "recipients.updated")
        model.startEditing(kbc)
        await model.setDefaultCategory(kbc, to: nil)
        #expect(model.editing == nil)
        #expect(await service.bodies.last == "{\"default_category_id\":null}")
        model.startEditing(kbc)
        model.cancelEditing()
        #expect(model.editing == nil)
    }

    @Test func statusFlipOffersUndo() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        await model.toggleStatus(kbc)
        let notice = try #require(model.notice)
        #expect(notice.key == "recipientsPage.toast.inactive")
        #expect(model.actionTitle(for: notice) == "Undo")
        #expect(model.actionIsUndo)
        #expect(model.duration(of: notice) == RecipientsModel.undoDuration)
        await model.performPendingAction()
        #expect(await service.bodies == ["{\"is_active\":false}", "{\"is_active\":true}"])
        #expect(!model.actionIsUndo)
    }

    @Test func unmergeIsForAliasesAndInvalidatesTheOtherScreens() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await shell.transactions.pickers.load()
        let rows = try #require(model.rows)
        await model.unmerge(rows[0])
        #expect(await service.log.isEmpty)
        await model.unmerge(rows[1])
        #expect(await service.log == ["unmerge 2"])
        #expect(model.notice?.key == "recipients.unmerged")
        #expect(!shell.transactions.pickers.isLoaded)
    }

    @Test func deleteAsksFirst() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        model.requestDelete(kbc)
        #expect(model.deleteText()?.message == "Delete \"KBC\"?")
        model.cancelDelete()
        #expect(model.pendingDelete == nil)
        model.requestDelete(kbc)
        await service.set(writeFailure: .network("offline"))
        await model.confirmDelete()
        #expect(model.notice?.key == "recipients.deleteFailedTitle")
        await service.set(writeFailure: nil)
        model.requestDelete(kbc)
        await model.confirmDelete()
        #expect(model.notice?.key == "recipients.deleted")
        #expect(await service.log == ["delete 1", "delete 1"])
    }

    @Test func addValidatesTrimsAndReportsAnExistingPayee() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openAdd()
        await model.submitAdd()
        #expect(model.add?.showsNameError == true)
        #expect(model.addFocusRequest == 1)
        model.add?.setName("  Colruyt  ")
        model.add?.setNotes("  ")
        await model.submitAdd()
        #expect(model.add == nil)
        #expect(model.notice?.key == "recipients.created")
        await service.set(createdNew: false)
        model.openAdd()
        model.add?.setName("KBC")
        model.add?.setNotes(" Bank ")
        await model.submitAdd()
        #expect(model.notice?.key == "recipients.exists")
        #expect(model.notice?.kind == .info)
        #expect(await service.log == ["create Colruyt nil", "create KBC Bank"])
        var draft = PayeeAddDraft()
        draft.setName(String(repeating: "x", count: 250))
        #expect(draft.name.count == PayeeAddDraft.nameLimit)
    }

    @Test func mergeSelectsAPrimaryAndAliasesAndOffersTheRule() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        await service.set(
            mergeResult: PayeeMergeResult(
                primary: .init(id: 4, name: "Albert Heijn"), mergedIds: [5],
                suggestion: .init(pattern: "ALBERT", kind: "literal_prefix", matchCount: 6)))
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        shell.setLeaveGuard(model.leaveGuard)
        await model.openMerge()
        let merge = model.merge
        #expect(merge.isOpen)
        #expect(merge.payees?.count == 5)
        #expect(await service.queries.last == PayeePageQuery(active: false, sortBy: "name", sortDir: "asc"))
        #expect(await service.pages.last == "0:\(RecipientsModel.mergePageSize)")
        #expect(merge.primaryOptions.map(\.id) == [1, 4, 5])
        merge.primarySearch = "albert"
        #expect(merge.primaryOptions.map(\.id) == [4])
        merge.selectPrimary(4)
        merge.toggleAlias(4)
        merge.toggleAlias(5)
        #expect(merge.aliasIds == [5])
        #expect(merge.canMerge)
        #expect(merge.confirmTitle(RecipientsFixture.strings) == "Merge 1 payee")
        #expect(shell.hasGuardedUnsavedChanges)
        merge.dismiss()
        #expect(!merge.isOpen)
        #expect(merge.hasSelection)
        merge.isOpen = true
        await merge.confirm()
        #expect(await service.log == ["merge [5]->4"])
        #expect(!merge.isOpen)
        #expect(!merge.hasSelection)
        let notice = try #require(model.notice)
        #expect(notice.key == "recipients.merged")
        #expect(notice.variables == ["n": "1", "name": "Albert Heijn"])
        #expect(notice.detail == "A rule for \"ALBERT\" would match 6 existing payees.")
        #expect(model.actionTitle(for: notice) == "Create rule")
        #expect(!model.actionIsUndo)
        #expect(model.duration(of: notice) == RecipientsModel.suggestionDuration)
        await model.performPendingAction()
        #expect(await service.log.last == "create rule 4")
        #expect(
            await service.bodies.last
                == "{\"case_sensitive\":false,\"notes\":null,\"pattern\":\"ALBERT\",\"pattern_kind\":\"literal_prefix\"}")
        #expect(model.notice?.key == "recipientPatterns.toast.created")
    }

    @Test func aFailedMergeKeepsTheSelectionAndCancelResetsIt() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        await model.openMerge()
        model.merge.selectPrimary(1)
        model.merge.toggleAlias(4)
        await service.set(writeFailure: .network("offline"))
        await model.merge.confirm()
        #expect(model.notice?.key == "recipients.mergeFailedTitle")
        #expect(model.merge.isOpen)
        #expect(model.merge.aliasIds == [4])
        model.merge.clearPrimary()
        #expect(model.merge.aliasIds.isEmpty)
        model.merge.selectPrimary(1)
        model.merge.cancel()
        #expect(!model.merge.hasSelection)
        #expect(!model.merge.isOpen)
    }

    @Test func theLeaveGuardDiscardsTheMergeSelection() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let guardHook = model.leaveGuard
        #expect(!guardHook.hasUnsavedChanges())
        await model.openMerge()
        model.merge.selectPrimary(1)
        #expect(guardHook.hasUnsavedChanges())
        model.disappear()
        #expect(model.merge.hasSelection)
        guardHook.discard()
        #expect(!model.merge.hasSelection)
    }

    @Test func matchRulesPreviewSaveToggleAndDelete() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        await service.set(rules: [RecipientsFixture.rule(10, "KBC ", notes: "old")])
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        await model.openRules(kbc)
        #expect(model.rules?.recipientName == "KBC")
        #expect(model.rules?.patterns?.count == 1)
        #expect(model.rules?.showsEmpty == false)

        model.startNewRule()
        model.rules?.setPattern("  NET ")
        await model.previewRule()
        #expect(model.rules?.previewCount == 3)
        #expect(await service.log.last == "preview 1 NET literal_prefix false")
        model.rules?.setKind(.glob)
        #expect(model.rules?.previewCount == nil)
        model.rules?.setPriority("12x")
        await model.saveRule()
        #expect(model.rules?.form == nil)
        #expect(model.notice?.key == "recipientPatterns.toast.created")
        #expect(
            await service.bodies.last
                == "{\"case_sensitive\":false,\"notes\":null,\"pattern\":\"NET\",\"pattern_kind\":\"glob\",\"priority\":12}")

        let rule = try #require(model.rules?.patterns?.first)
        model.editRule(rule)
        #expect(model.rules?.editingId == 10)
        #expect(model.rules?.form?.notes == "old")
        model.editRule(rule)
        #expect(model.rules?.form == nil)
        model.editRule(rule)
        model.rules?.setNotes("")
        await model.saveRule()
        #expect(await service.log.contains("update rule 1/10"))
        #expect(
            await service.bodies.last
                == "{\"case_sensitive\":false,\"notes\":null,\"pattern\":\"KBC\",\"pattern_kind\":\"literal_prefix\",\"priority\":100}")

        await model.toggleRule(rule)
        #expect(await service.bodies.last == "{\"is_active\":false}")
        model.requestRuleDelete(rule)
        #expect(model.rules?.pendingDelete == rule)
        await model.confirmRuleDelete()
        #expect(await service.log.last == "rules 1")
        #expect(await service.log.contains("delete rule 1/10"))
        #expect(model.notice?.key == "recipientPatterns.toast.deleted")
        model.closeRules()
        #expect(model.rules == nil)
    }

    @Test func aPreviewFromAClosedDialogDoesNotReachTheNextOne() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        let kbcBank = try #require(model.rows?.last)
        await model.openRules(kbc)
        model.startNewRule()
        model.rules?.setPattern("KBC")
        let gate = CallGate()
        await service.holdNextPreview(gate)
        let stale = Task { await model.previewRule() }
        while !(await service.log.contains("preview 1 KBC literal_prefix false")) { await Task.yield() }

        // The same edits on another payee reach the same preview version.
        model.closeRules()
        await model.openRules(kbcBank)
        model.startNewRule()
        model.rules?.setPattern("Bank")
        gate.open()
        await stale.value
        #expect(model.rules?.recipientId == 2)
        #expect(model.rules?.previewCount == nil)
        #expect(model.rules?.isPreviewing == false)
    }

    @Test func aRuleListFromAClosedDialogDoesNotReplaceTheNewerOne() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        await service.set(rules: [RecipientsFixture.rule(10, "KBC")])
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        let gate = CallGate()
        await service.holdNextRules(gate)
        let stale = Task { await model.openRules(kbc) }
        while !(await service.log.contains("rules 1")) { await Task.yield() }

        await service.set(rules: [RecipientsFixture.rule(10, "KBC"), RecipientsFixture.rule(11, "KBC NV")])
        model.closeRules()
        await model.openRules(kbc)
        #expect(model.rules?.patterns?.map(\.id) == [10, 11])
        gate.open()
        await stale.value
        #expect(model.rules?.patterns?.map(\.id) == [10, 11])
    }

    @Test func aSaveFromAClosedDialogLeavesTheNextFormOpen() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        await model.openRules(kbc)
        model.startNewRule()
        model.rules?.setPattern("KBC")
        let gate = CallGate()
        await service.holdNextRuleWrite(gate)
        let stale = Task { await model.saveRule() }
        while !(await service.log.contains("create rule 1")) { await Task.yield() }

        model.closeRules()
        await model.openRules(kbc)
        model.startNewRule()
        model.rules?.setPattern("KBC NV")
        gate.open()
        await stale.value
        #expect(model.notice?.key == "recipientPatterns.toast.created")
        #expect(model.rules?.form?.pattern == "KBC NV")
        #expect(model.rules?.isSaving == false)
    }

    @Test func disappearClosesTheDialogsButKeepsTheMergeSelection() async throws {
        let service = FakeRecipientsService(payees: RecipientsFixture.payees())
        let (model, shell) = try await RecipientsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        let kbc = try #require(model.rows?.first)
        model.startEditing(kbc)
        model.openAdd()
        model.requestDelete(kbc)
        await model.openMerge()
        model.merge.selectPrimary(1)
        model.disappear()
        #expect(model.editing == nil)
        #expect(model.add == nil)
        #expect(model.pendingDelete == nil)
        #expect(!model.merge.isOpen)
        #expect(model.merge.primaryId == 1)
        let before = await service.pages.count
        await model.setShowAll(true)
        #expect(await service.pages.count == before)
    }
}

import Foundation
import Testing

@testable import VisionNativeCore

// MARK: - Fakes and fixtures

/// A scripted `AccountsService` that records every call.
actor FakeAccountsService: AccountsService {
    var list: [OpenAPI.Account]
    var listFailure: APIError?
    var portfolio: [PortfolioAccountRow]
    var portfolioTotals: [PortfolioAccountTotalsRow] = []
    var portfolioFailure: APIError?
    var totals: OpenAPI.AccountTotals = AccountsFixture.totals()
    var totalsFailure: APIError?
    /// The whole ledger, newest first; pages are cut from it.
    var ledgerRows: [AccountLedgerRow]
    var plannedPage: AccountPlannedPage
    var plannedFailure: APIError?
    var createdId: AccountID = 99
    var createFailure: APIError?
    var updateFailure: APIError?
    var deleteFailure: APIError?
    var openingWarning: String?
    var openingFailure: APIError?
    var statementFailure: APIError?
    var reconcileFailure: APIError?
    var preview: Result<AccountMergePreview, APIError>?
    var mergeCounts = AccountMergeCounts(transactions: 3, planned: 1)
    var mergeFailure: APIError?
    var closeFailures: [APIError] = []
    var lots: Result<AccountLotPreview, APIError> = .success(
        AccountLotPreview(accountId: 0, eligibleCount: 0, transactionIds: [], limit: 500))
    var retagFailure: APIError?
    private var openingGate: CallGate?

    private(set) var log: [String] = []
    private(set) var created: [OpenAPI.AccountCreate] = []
    private(set) var patches: [String] = []
    private(set) var retags: [LotRetagRequest] = []
    private(set) var ledgerRequests: [String] = []
    private(set) var listRequests: [String] = []

    init(
        list: [OpenAPI.Account] = [], portfolio: [PortfolioAccountRow] = [], ledgerRows: [AccountLedgerRow] = [],
        plannedPage: AccountPlannedPage = AccountPlannedPage(rows: [], total: 0)
    ) {
        self.list = list
        self.portfolio = portfolio
        self.ledgerRows = ledgerRows
        self.plannedPage = plannedPage
    }

    func set(list: [OpenAPI.Account]) { self.list = list }
    func set(listFailure: APIError?) { self.listFailure = listFailure }
    func set(portfolioFailure: APIError?) { self.portfolioFailure = portfolioFailure }
    func set(portfolioTotals: [PortfolioAccountTotalsRow]) { self.portfolioTotals = portfolioTotals }
    func set(totals: OpenAPI.AccountTotals) { self.totals = totals }
    func set(totalsFailure: APIError?) { self.totalsFailure = totalsFailure }
    func set(plannedFailure: APIError?) { self.plannedFailure = plannedFailure }
    func set(createFailure: APIError?) { self.createFailure = createFailure }
    func set(updateFailure: APIError?) { self.updateFailure = updateFailure }
    func set(deleteFailure: APIError?) { self.deleteFailure = deleteFailure }
    func set(openingWarning: String?) { self.openingWarning = openingWarning }
    func holdNextOpening(_ gate: CallGate) { openingGate = gate }
    func set(reconcileFailure: APIError?) { self.reconcileFailure = reconcileFailure }
    func set(preview: Result<AccountMergePreview, APIError>?) { self.preview = preview }
    func set(closeFailures: [APIError]) { self.closeFailures = closeFailures }
    func set(lots: Result<AccountLotPreview, APIError>) { self.lots = lots }

    func accounts(active: String) async throws -> [OpenAPI.Account] {
        listRequests.append(active)
        if let listFailure { throw listFailure }
        return active == "true" ? list.filter { $0.isActive } : list
    }

    func portfolioAccountRows(currency: CurrencyCode) async throws -> AccountPortfolioSummary {
        log.append("portfolio \(currency)")
        if let portfolioFailure { throw portfolioFailure }
        return AccountPortfolioSummary(byAccount: portfolio, accountTotals: portfolioTotals)
    }

    func accountTotals(currency: CurrencyCode) async throws -> OpenAPI.AccountTotals {
        log.append("totals \(currency)")
        if let totalsFailure { throw totalsFailure }
        return totals
    }

    func ledger(accountId: AccountID, offset: Int, limit: Int) async throws -> AccountLedgerPage {
        ledgerRequests.append("\(accountId):\(offset):\(limit)")
        let end = min(ledgerRows.count, offset + limit)
        let rows = offset < end ? Array(ledgerRows[offset..<end]) : []
        return AccountLedgerPage(rows: rows, total: ledgerRows.count)
    }

    func plannedRows(accountId: AccountID) async throws -> AccountPlannedPage {
        log.append("planned \(accountId)")
        if let plannedFailure { throw plannedFailure }
        return plannedPage
    }

    func createAccount(_ body: OpenAPI.AccountCreate) async throws -> AccountID {
        log.append("create")
        if let createFailure { throw createFailure }
        created.append(body)
        return createdId
    }

    func updateAccount(id: AccountID, patch: AccountPatch) async throws {
        log.append("update \(id)")
        if let updateFailure { throw updateFailure }
        patches.append(String(decoding: try APIBody.encode(patch), as: UTF8.self))
    }

    func deleteAccount(id: AccountID) async throws {
        log.append("delete \(id)")
        if let deleteFailure { throw deleteFailure }
    }

    func setOpeningBalance(id: AccountID, balance: Decimal, date: String, currency: CurrencyCode) async throws -> String? {
        log.append("opening \(id) \(balance) \(date) \(currency)")
        if let gate = openingGate {
            openingGate = nil
            await gate.wait()
        }
        if let openingFailure { throw openingFailure }
        return openingWarning
    }

    func setStatementBalance(id: AccountID, currency: CurrencyCode, balance: Decimal, date: String) async throws {
        log.append("statement \(id) \(currency) \(balance) \(date)")
        if let statementFailure { throw statementFailure }
    }

    func reconcile(id: AccountID, mode: ReconcileMode, currency: CurrencyCode) async throws {
        log.append("reconcile \(id) \(mode.rawValue) \(currency)")
        if let reconcileFailure { throw reconcileFailure }
    }

    func mergePreview(sourceId: AccountID, targetId: AccountID) async throws -> AccountMergePreview {
        log.append("preview \(sourceId)->\(targetId)")
        guard let preview else {
            return AccountMergePreview(
                into: targetId, source: sourceId, transactions: 12, planned: 2, projectedBalance: 150)
        }
        return try preview.get()
    }

    func merge(targetId: AccountID, sourceIds: [AccountID]) async throws -> AccountMergeCounts {
        log.append("merge \(sourceIds.map(\.rawValue))->\(targetId)")
        if let mergeFailure { throw mergeFailure }
        return mergeCounts
    }

    func closeAccount(id: AccountID, balanceHandling: CloseBalanceHandling) async throws {
        log.append("close \(id) \(balanceHandling.rawValue)")
        if !closeFailures.isEmpty { throw closeFailures.removeFirst() }
    }

    func lotPreview(accountId: AccountID) async throws -> AccountLotPreview {
        log.append("lots \(accountId)")
        return try lots.get()
    }

    func retagLots(_ request: LotRetagRequest) async throws -> LotRetagReceipt {
        log.append("retag")
        retags.append(request)
        if let retagFailure { throw retagFailure }
        return LotRetagReceipt(movedCount: request.transactionIds.count)
    }
}

/// A key maker that counts its keys.
final class KeyCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return "key-\(count)"
    }
}

enum AccountsFixture {
    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "accounts.type.checking": "Checking", "accounts.type.savings": "Savings",
            "accounts.type.brokerage": "Brokerage", "accounts.driftBadge": "{amount} off your statement",
            "accounts.driftBadgeStatement": "statement of {date}",
            "accounts.provenance.sum.one": "Sum of {count} entry", "accounts.provenance.sum.other": "Sum of {count} entries",
            "accounts.provenance.anchored.other": "Statement of {date} plus {count} entries since",
            "accounts.owner.me": "Me", "accounts.liquidity.liquid": "Liquid", "common.yes": "Yes", "common.no": "No",
            "accounts.detail.upcomingPlannedTruncated": "Showing {shown} of {total} planned transactions.",
            "accounts.mergedReceipt": "Moved {transactions} transactions and {planned} planned payments.",
            "accounts.close.portfolioMoved": "Moved {count} portfolio lot transactions.",
            "accounts.close.portfolioPartialHint": "Moved {count} lot transactions.",
        ])

    static func account(
        _ id: AccountID, _ name: String, type: String = "checking", currency: CurrencyCode = "EUR", balance: Decimal? = 0,
        displayName: String? = nil, institution: String? = nil, isActive: Bool = true, inNetWorth: Bool = true,
        multiCurrencyCash: Bool = false, statements: [OpenAPI.Account.StatementBalancesItem]? = nil,
        parts: [OpenAPI.Account.BalancePartsItem]? = nil, incomplete: Bool? = nil, unconverted: [CurrencyCode]? = nil,
        reconcilableBalance: Decimal? = nil, reconcilableCurrency: CurrencyCode? = nil, drift: Decimal? = nil,
        anchorDate: String? = nil, postAnchorCount: Int? = nil, hasTransactions: Bool? = true
    ) -> OpenAPI.Account {
        let kind = OpenAPI.Account.AccountType(rawValue: type)
        let flags = AccountTypeFlags.of(kind)
        return OpenAPI.Account(
            id: id, name: name, displayName: displayName, institution: institution, currency: currency, type: kind,
            liquidityClass: flags.liquidityClass, spendable: flags.spendable, inNetWorth: inNetWorth,
            taxWrapper: flags.taxWrapper, owner: .me, multiCurrencyCash: multiCurrencyCash,
            hasCashSleeve: flags.hasCashSleeve, statementBalances: statements, computedBalance: balance,
            balanceParts: parts, balanceIncomplete: incomplete, unconvertedCurrencies: unconverted,
            reconcilableBalance: reconcilableBalance, reconcilableCurrency: reconcilableCurrency, drift: drift,
            anchorDate: anchorDate, postAnchorCount: postAnchorCount, hasTransactions: hasTransactions,
            isActive: isActive, createdAt: "2026-01-01", updatedAt: "2026-01-01")
    }

    static func decimal(_ text: String) -> Decimal {
        Decimal(string: text) ?? 0
    }

    /// The server's `GET /api/accounts/totals` answer; the groups default to zero.
    static func totals(
        netCash: Decimal = 0, netCashMissing: [CurrencyCode] = [], cash: OpenAPI.AccountGroupTotal = group(),
        portfolio: OpenAPI.AccountGroupTotal = group(), liabilities: OpenAPI.AccountGroupTotal = group(),
        archived: OpenAPI.AccountGroupTotal = group()
    ) -> OpenAPI.AccountTotals {
        OpenAPI.AccountTotals(
            currency: "EUR",
            netCash: .init(total: netCash, unconvertedCount: netCashMissing.count, unconvertedCurrencies: netCashMissing),
            groups: .init(cash: cash, portfolio: portfolio, liabilities: liabilities, archived: archived),
            accounts: [])
    }

    static func group(
        total: Decimal = 0, missing: [CurrencyCode] = [], holdingsUnavailable: Bool = false
    ) -> OpenAPI.AccountGroupTotal {
        OpenAPI.AccountGroupTotal(
            total: total, cash: total, holdings: 0, holdingsUnavailable: holdingsUnavailable,
            unconvertedCount: missing.count, unconvertedCurrencies: missing)
    }

    static func row(_ id: TransactionID, date: String, amount: Decimal, running: Decimal?, currency: CurrencyCode = "EUR")
        -> AccountLedgerRow
    {
        AccountLedgerRow(
            id: id, date: date, recipientName: "Payee \(id.rawValue)", memo: "Memo \(id.rawValue)", categoryName: nil, amount: amount,
            currency: currency, runningBalance: running)
    }

    @MainActor
    static func idleModel() -> AccountsModel {
        model(FakeAccountsService())
    }

    @MainActor
    static func model(
        _ service: FakeAccountsService, keys: KeyCounter = KeyCounter()
    ) -> AccountsModel {
        AccountsModel(
            service: service,
            calendar: PlannedFixture.calendar, now: { PlannedFixture.today }, makeKey: { keys.next() })
    }

    @MainActor
    static func shell(
        _ model: AccountsModel, settings: NativeAppSettings = NativeAppSettings()
    ) -> NativeShellModel {
        NativeShellModel(
            strings: strings, theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService(rates: [])), admin: AdminFixture.screens(), planned: PlannedFixture.idleModel(),
            imports: ImportFixture.idleModel(), transactions: TransactionsFixture.idleModel(), accounts: model,
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { settings })
    }

    /// A shell on `route` with its settings read and the screen appeared.
    @MainActor
    static func opened(
        _ service: FakeAccountsService, route: String = "/accounts", keys: KeyCounter = KeyCounter()
    ) async throws -> (AccountsModel, NativeShellModel) {
        let model = model(service, keys: keys)
        let shell = shell(model)
        let parsed = try #require(NativeRoute(route))
        shell.show(parsed)
        await shell.settingsSettled()
        let id = AccountsRoutes.detailId(forPath: parsed.path)
        await model.appear(id.map { AccountsScreen.detail($0) } ?? .hub)
        return (model, shell)
    }
}

// MARK: - Routes

@Suite struct AccountsRouteTests {
    @Test func theRoutesParseBothWays() throws {
        #expect(NativeScreen.screen(forPath: "/accounts") == .accounts)
        #expect(NativeScreen.screen(forPath: "/accounts/12") == .accountDetail(id: 12))
        #expect(NativeScreen.screen(forPath: "/accounts/abc") == .accountDetail(id: 0))
        #expect(NativeScreen.screen(forPath: "/accounts/0") == .accountDetail(id: 0))
        #expect(NativeScreen.screen(forPath: "/accounts/12/ledger") == nil)
        #expect(NativeScreen.accounts.path == "/accounts")
        #expect(NativeScreen.accountDetail(id: 7).path == "/accounts/7")
        #expect(!NativeScreen.accounts.requiresAdmin)
        #expect(!NativeScreen.accountDetail(id: 7).requiresAdmin)
        #expect(NativeScreen.fixedScreens.contains(.accounts))
        // Part B: categories and payees are native too.
        #expect(NativeScreen.screen(forPath: "/categories") == .categories)
        #expect(NativeScreen.screen(forPath: "/recipients") == .recipients)
    }

    @Test func sinceAcceptsOnlyADay() throws {
        let good = try #require(NativeRoute("/accounts/3?since=2026-09-01"))
        #expect(AccountsRoutes.since(in: good) == "2026-09-01")
        let bad = try #require(NativeRoute("/accounts/3?since=2026-9-1"))
        #expect(AccountsRoutes.since(in: bad) == nil)
        #expect(AccountsRoutes.sinceRoute(3, since: "2026-09-01") == "/accounts/3?since=2026-09-01")
        #expect(AccountDates.daysBetween("2026-08-01", "2026-09-15") == 45)
    }

    @Test func viewTransactionsHitsTheTransactionsDeepLink() throws {
        let account = AccountsFixture.account(5, "kbc", displayName: "My Bank")
        let link = AccountsRoutes.transactionsLink(account)
        #expect(link == "/transactions?account_id=5&filter_label=My%20Bank")
        let filters = TransactionFilters(route: try #require(NativeRoute(link)))
        #expect(filters.accountId == 5)
        #expect(filters.filterLabel == "My Bank")
    }
}

// MARK: - Grouping, totals, metrics

@Suite struct AccountsGroupingTests {
    @Test func groupsComeInOrderSortedByLabelWithEmptyGroupsLeftOut() {
        let accounts = [
            AccountsFixture.account(1, "Savings 10", type: "savings"),
            AccountsFixture.account(2, "savings 9", type: "savings"),
            AccountsFixture.account(3, "Broker", type: "brokerage"),
            AccountsFixture.account(4, "Old", isActive: false),
            AccountsFixture.account(5, "Card", type: "liability"),
            AccountsFixture.account(6, "Alpha", type: "pension"),
        ]
        let groups = AccountGrouping.groups(accounts, locale: Locale(identifier: "en"))
        #expect(groups.map { $0.id } == [.cash, .portfolio, .liabilities, .archived])
        #expect(groups[0].accounts.map { $0.id } == [6, 2, 1])
        let noPortfolio = AccountGrouping.groups(accounts.filter { $0.id != 3 }, locale: Locale(identifier: "en"))
        #expect(!noPortfolio.contains { $0.id == .portfolio })
    }

    @Test func brokerMetricsReadThePositionRowAndTheServerAccountTotals() {
        let summary = AccountPortfolioSummary(
            byAccount: [
                PortfolioAccountRow(accountId: 3, contributionKind: .position, currentValue: 500),
                PortfolioAccountRow(accountId: 3, contributionKind: .nonPosition, currentValue: 0),
                PortfolioAccountRow(accountId: 4, contributionKind: .position, currentValue: 9),
            ],
            accountTotals: [
                PortfolioAccountTotalsRow(accountId: 3, oversold: true, gainLoss: 25),
                PortfolioAccountTotalsRow(accountId: 4, oversold: false, gainLoss: 1),
            ])
        let metrics = BrokerAccountMetrics.of(summary, accountId: 3)
        #expect(metrics == BrokerAccountMetrics(holdingsValue: 500, gainLoss: 25, oversold: true, hasPosition: true))
        #expect(
            BrokerAccountMetrics.of(summary, accountId: 8)
                == BrokerAccountMetrics(holdingsValue: 0, gainLoss: 0, oversold: false, hasPosition: false))
        #expect(BrokerAccountMetrics.of(nil, accountId: 3) == nil)
    }

    @Test func theDriftChipTurnsWarningOnceTheStatementIsStale() {
        let settings = NativeAppSettings()
        let fresh = AccountsFixture.account(
            1, "A", statements: [.init(currency: "EUR", balance: 110, balanceDate: "2026-10-01")], drift: 10)
        let chip = AccountDrift.of(fresh, today: "2026-10-12", settings: settings, strings: AccountsFixture.strings)
        #expect(chip?.stale == false)
        #expect(chip?.tooltipKey == "accounts.driftTooltip")
        #expect(chip?.label.hasSuffix("off your statement · statement of 01/10/2026") == true)
        let stale = AccountsFixture.account(
            1, "A", statements: [.init(currency: "EUR", balance: 110, balanceDate: "2026-08-01")], drift: 10)
        #expect(AccountDrift.of(stale, today: "2026-10-12", settings: settings, strings: AccountsFixture.strings)?.stale == true)
        #expect(AccountDrift.of(AccountsFixture.account(1, "A", drift: 0), today: "2026-10-12", settings: settings, strings: AccountsFixture.strings) == nil)
    }

    @Test func provenanceReadsTheAnchorOrTheSum() {
        let settings = NativeAppSettings()
        let sum = AccountsFixture.account(1, "A", postAnchorCount: 1)
        #expect(AccountProvenance.text(sum, settings: settings, strings: AccountsFixture.strings) == "Sum of 1 entry")
        let anchored = AccountsFixture.account(1, "A", anchorDate: "2026-09-30", postAnchorCount: 4)
        #expect(
            AccountProvenance.text(anchored, settings: settings, strings: AccountsFixture.strings)
                == "Statement of 30/09/2026 plus 4 entries since")
        #expect(AccountProvenance.text(AccountsFixture.account(1, "A"), settings: settings, strings: AccountsFixture.strings) == nil)
    }
}

// MARK: - Hub

@MainActor
@Suite struct AccountsHubTests {
    @Test func theHubShowsTheServerSubtotalsAndNetCash() async throws {
        let service = FakeAccountsService(
            list: [
                AccountsFixture.account(1, "Checking", balance: 100),
                AccountsFixture.account(3, "Broker", type: "brokerage", balance: 10),
            ],
            portfolio: [PortfolioAccountRow(accountId: 3, contributionKind: .position, currentValue: 400)])
        await service.set(portfolioTotals: [PortfolioAccountTotalsRow(accountId: 3, oversold: false, gainLoss: -5)])
        await service.set(
            totals: AccountsFixture.totals(
                netCash: 125, cash: AccountsFixture.group(total: 125), portfolio: AccountsFixture.group(total: 410)))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(shell.detail == .native(.accounts))
        #expect(model.visibleGroups.map { $0.id } == [.cash, .portfolio])
        #expect(model.subtotal(model.visibleGroups[0]) == .amount(AccountTotal(amount: 125, incomplete: false)))
        #expect(model.subtotal(model.visibleGroups[1]) == .amount(AccountTotal(amount: 410, incomplete: false)))
        #expect(model.netCash == .amount(AccountTotal(amount: 125, incomplete: false)))
        let broker = try #require(model.account(3))
        #expect(model.metrics(broker)?.holdingsValue == 400)
        #expect(model.metrics(broker)?.gainLoss == -5)
        let log = await service.log
        #expect(log.contains("portfolio EUR"))
        #expect(log.contains("totals EUR"))
    }

    @Test func unconvertedBalancesMarkTheSubtotalsIncompleteAndAnUnavailableHoldingsFigureShowsAsSuch() async throws {
        let service = FakeAccountsService(list: [
            AccountsFixture.account(1, "Francs", currency: "CHF", balance: 100),
            AccountsFixture.account(3, "Broker", type: "brokerage", balance: 10),
        ])
        await service.set(
            totals: AccountsFixture.totals(
                netCash: 0, netCashMissing: ["CHF"], cash: AccountsFixture.group(total: 0, missing: ["CHF"]),
                portfolio: AccountsFixture.group(holdingsUnavailable: true)))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.subtotal(model.visibleGroups[0]) == .amount(AccountTotal(amount: 0, incomplete: true)))
        #expect(model.subtotal(model.visibleGroups[1]) == .unavailable)
        #expect(model.netCash == .amount(AccountTotal(amount: 0, incomplete: true)))
    }

    @Test func aFailedTotalsRequestLeavesTheSubtotalsAndNetCashUnavailable() async throws {
        let service = FakeAccountsService(list: [AccountsFixture.account(1, "Checking", balance: 100)])
        await service.set(totalsFailure: .network("offline"))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.totalsError != nil)
        #expect(model.subtotal(model.visibleGroups[0]) == .unavailable)
        #expect(model.netCash == .unavailable)
    }

    @Test func anErrorShowsAndRetryRefetches() async throws {
        let service = FakeAccountsService(list: [AccountsFixture.account(1, "A")])
        await service.set(listFailure: .network("offline"))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        #expect(model.accountsError != nil)
        #expect(!model.isLoading)
        await service.set(listFailure: nil)
        await model.retry()
        #expect(model.accountsError == nil)
        #expect(model.accounts?.count == 1)
    }

    @Test func anEmptyListIsNotLoading() async throws {
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService())
        defer { withExtendedLifetime(shell) {} }
        #expect(!model.isLoading)
        #expect(model.accounts?.isEmpty == true)
        #expect(model.groups.isEmpty)
    }

    @Test func rowActionsNavigateOnlyWhileShown() async throws {
        let account = AccountsFixture.account(5, "kbc", displayName: "My Bank")
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService(list: [account]))
        defer { withExtendedLifetime(shell) {} }
        model.openDetail(account)
        #expect(shell.nativeNavigationLocation.raw == "/accounts/5")
        model.openTransactions(account)
        #expect(shell.nativeNavigationLocation.raw == "/transactions?account_id=5&filter_label=My%20Bank")
        model.disappear(.hub)
        let before = shell.nativeNavigationLocation.raw
        model.openDetail(account)
        #expect(shell.nativeNavigationLocation.raw == before)
    }

    @Test func reconcileShowsForDriftOrMultiCurrencyCashButNotHoldingsOnly() async throws {
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService())
        defer { withExtendedLifetime(shell) {} }
        #expect(model.canReconcile(AccountsFixture.account(1, "A", drift: 5)))
        #expect(model.canReconcile(AccountsFixture.account(1, "A", multiCurrencyCash: true)))
        #expect(!model.canReconcile(AccountsFixture.account(1, "A")))
        #expect(!model.canReconcile(AccountsFixture.account(1, "W", type: "wallet", drift: 5)))
        #expect(!AccountKinds.canViewTransactions(AccountsFixture.account(1, "W", type: "wallet")))
        #expect(!AccountKinds.canViewTransactions(AccountsFixture.account(1, "A", hasTransactions: false)))
        #expect(model.meta(AccountsFixture.account(1, "A", institution: "KBC")) == "Checking · EUR · KBC")
    }

    @Test func accountsIsNativeWithoutAdminMode() async throws {
        let model = AccountsFixture.idleModel()
        let shell = AccountsFixture.shell(model)
        shell.show(try #require(NativeRoute("/accounts/4?since=2026-01-01")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.accountDetail(id: 4)))
    }
}

// MARK: - Add / Edit account

@MainActor
@Suite struct AccountFormTests {
    @Test func theNameMirrorsIntoTheDisplayNameUntilItIsEdited() {
        var draft = AccountFormDraft(today: PlannedDay(year: 2026, month: 10, day: 12), numberFormat: .eu)
        draft.setName("KBC")
        #expect(draft.displayName == "KBC")
        draft.setDisplayName("Daily")
        draft.setName("KBC Checking")
        #expect(draft.displayName == "Daily")
        var edit = AccountFormDraft(editing: AccountsFixture.account(1, "A", displayName: "Shown"), numberFormat: .eu)
        edit.setName("B")
        #expect(edit.displayName == "Shown")
        #expect(edit.showAdvanced)
        #expect(!edit.showsOpeningBalance)
        draft.setName(String(repeating: "x", count: 250))
        #expect(draft.name.count == 200)
    }

    @Test func aTypeChangeFillsOnlyUntouchedFlagsAndHoldingsOnlyClearsTheOpeningBalance() {
        var draft = AccountFormDraft(today: PlannedDay(year: 2026, month: 10, day: 12), numberFormat: .eu)
        draft.setSpendable(true)
        draft.setType(.pension)
        #expect(draft.spendable)
        #expect(draft.liquidityClass == .illiquid)
        #expect(draft.taxWrapper == .pension)
        draft.setOpeningBalance("100")
        draft.setType(.wallet)
        #expect(draft.openingBalance.isEmpty)
        #expect(!draft.showsOpeningBalance)
        #expect(!draft.hasCashSleeve)
        draft.setType(.liability)
        #expect(draft.openingLabelKey == "accounts.openingBalance.createDebtLabel")
    }

    @Test func submitChecksTheNameThenTheOpeningBalanceThenItsDate() {
        var draft = AccountFormDraft(today: PlannedDay(year: 2026, month: 10, day: 12), numberFormat: .eu)
        let empty = draft.check()
        #expect(empty == .blocked)
        draft.setName("  A  ")
        draft.setOpeningBalance("12,3,4")
        let invalid = draft.check()
        #expect(invalid == .openingInvalid)
        #expect(draft.showsOpeningError)
        draft.setOpeningBalance("1.250,50")
        draft.openingDate = nil
        let missing = draft.check()
        #expect(missing == .openingDateMissing)
        #expect(draft.showsOpeningDateError)
        draft.openingDate = PlannedDay(year: 2026, month: 1, day: 2)
        let ready = draft.check()
        #expect(ready == .ready)
        #expect(draft.openingStamp?.balance == AccountsFixture.decimal("1250.5"))
        #expect(draft.openingStamp?.date == "2026-01-02")
        #expect(draft.createBody.name == "A")
        #expect(draft.createBody.displayName == "A")
    }

    @Test func editSendsNullForClearedOptionalFields() throws {
        var draft = AccountFormDraft(
            editing: AccountsFixture.account(1, "A", displayName: "Shown", institution: "KBC"), numberFormat: .eu)
        draft.setDisplayName("  ")
        draft.setInstitution("")
        let json = String(decoding: try APIBody.encode(draft.patch), as: UTF8.self)
        #expect(json.contains("\"display_name\":null"))
        #expect(json.contains("\"institution\":null"))
        #expect(json.contains("\"name\":\"A\""))
        #expect(!json.contains("is_active"))
        let reopen = String(decoding: try APIBody.encode(AccountPatch.reopen), as: UTF8.self)
        #expect(reopen == "{\"is_active\":true}")
    }

    @Test func createStampsTheOpeningBalanceAndRefreshes() async throws {
        let service = FakeAccountsService()
        await service.set(openingWarning: "Anchor is inert")
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        model.form?.setName("New")
        model.form?.currency = "USD"
        model.form?.setOpeningBalance("250,75")
        await model.submitForm()
        #expect(model.form == nil)
        let log = await service.log
        #expect(log.contains("create"))
        #expect(log.contains("opening 99 250.75 2026-10-12 USD"))
        #expect(model.notice?.key == "accounts.openingBalance.saved")
        #expect(model.notice?.kind == .info)
        #expect(model.notice?.detail == "Anchor is inert")
        #expect(await service.created.first?.currency == "USD")
    }

    @Test func aNewSheetDoesNotWaitOnTheLastCreate() async throws {
        let service = FakeAccountsService()
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        model.form?.setName("New")
        model.form?.setOpeningBalance("250,75")
        let gate = CallGate()
        await service.holdNextOpening(gate)
        let creating = Task { await model.submitForm() }
        while !(await service.log.contains(where: { $0.hasPrefix("opening 99") })) { await Task.yield() }
        #expect(model.form == nil)
        #expect(!model.isSavingForm)
        gate.open()
        await creating.value
        #expect(!model.isSavingForm)
    }

    @Test func everyFailedSubmitAsksForFocusAgain() async throws {
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService())
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        model.form?.setName("New")
        model.form?.setOpeningBalance("abc")
        await model.submitForm()
        #expect(model.formFocus == .openingBalance)
        #expect(model.formFocusRequest == 1)
        await model.submitForm()
        #expect(model.formFocusRequest == 2)
    }

    @Test func aFailedCreateKeepsTheSheet() async throws {
        let service = FakeAccountsService()
        await service.set(createFailure: .client(APIClientError(status: 400, code: .validationError, message: "Name taken")))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openCreate()
        model.form?.setName("New")
        await model.submitForm()
        #expect(model.form != nil)
        #expect(model.notice?.key == "accounts.createFailedTitle")
        #expect(model.notice?.detail == "Name taken")
    }

    @Test func editPatchesAndCloses() async throws {
        let account = AccountsFixture.account(4, "A")
        let service = FakeAccountsService(list: [account])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/4")
        defer { withExtendedLifetime(shell) {} }
        model.openEdit(account)
        model.form?.setInstitution("Belfius")
        await model.submitForm()
        #expect(model.form == nil)
        #expect(model.notice?.key == "accounts.updated")
        let patch = try #require(await service.patches.first)
        #expect(patch.contains("\"institution\":\"Belfius\""))
    }
}

// MARK: - Reconcile and opening balance

@MainActor
@Suite struct AccountReconcileTests {
    static let today = PlannedDay(year: 2026, month: 10, day: 12)

    static func drifting() -> OpenAPI.Account {
        AccountsFixture.account(
            7, "Daily", balance: 900, statements: [.init(currency: "EUR", balance: 950, balanceDate: "2026-09-30")],
            reconcilableBalance: 900, drift: 50)
    }

    @Test func theFiguresFollowTheReconciliationBase() {
        var draft = ReconcileDraft(account: Self.drifting(), today: Self.today, numberFormat: .eu)
        #expect(draft.statement == 950)
        #expect(draft.base == 900)
        #expect(draft.delta == 50)
        #expect(draft.baseIsComputed)
        #expect(draft.previewDrift == 50)
        #expect(draft.sinceDate == "2026-09-30")
        draft.setReading("900,004")
        #expect(draft.parsedReading == 900)
        #expect(draft.previewIsZero)
        draft.setReading("-0,005")
        #expect(draft.parsedReading == AccountsFixture.decimal("-0.01"))
        draft.setReading("abc")
        #expect(draft.readingInvalid)
        draft.setReading("1.000,50")
        #expect(draft.previewDrift == AccountsFixture.decimal("100.5"))
        #expect(!draft.isBackdated(today: "2026-10-12"))
        draft.readingDate = PlannedDay(year: 2026, month: 10, day: 1)
        #expect(draft.isBackdated(today: "2026-10-12"))
        #expect(draft.sinceDate == "2026-10-01")
        draft.readingDate = nil
        #expect(draft.readingNeedsDate)
        #expect(!draft.canSaveReading)
    }

    @Test func multiCurrencyAccountsPickAPartitionAndTheBackfillNeedsNoAnchor() {
        let account = AccountsFixture.account(
            7, "Multi", balance: 300, multiCurrencyCash: true,
            parts: [.init(currency: "EUR", balance: 200), .init(currency: "USD", balance: 200)],
            reconcilableBalance: 200, reconcilableCurrency: "EUR")
        var draft = ReconcileDraft(account: account, today: Self.today, numberFormat: .eu)
        #expect(draft.showsCurrencyPicker)
        #expect(draft.availableCurrencies == ["EUR", "USD"])
        draft.setReading("5")
        draft.selectCurrency("USD")
        #expect(draft.reading.isEmpty)
        #expect(draft.base == 200)
        #expect(!draft.baseIsComputed)
        #expect(!draft.canBackfill)
        draft.setReading("210")
        #expect(draft.canBackfill)
        let anchored = ReconcileDraft(
            account: AccountsFixture.account(1, "A", anchorDate: "2026-01-01"), today: Self.today, numberFormat: .eu)
        #expect(!anchored.canBackfill)
    }

    @Test func aTypedReadingIsSavedBeforeTheResolution() async throws {
        let account = Self.drifting()
        let service = FakeAccountsService(list: [account])
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openReconcile(account)
        model.reconcile?.setReading("960")
        await model.resolve(.adjustment)
        #expect(model.reconcile == nil)
        let log = await service.log
        let statement = try #require(log.firstIndex(of: "statement 7 EUR 960 2026-10-12"))
        let reconcile = try #require(log.firstIndex(of: "reconcile 7 adjustment EUR"))
        #expect(statement < reconcile)
        #expect(model.notice?.key == "accounts.reconcile.adjustSaved")
    }

    @Test func aReadingThatMatchesTheLedgerIsTheResolution() async throws {
        let account = Self.drifting()
        let service = FakeAccountsService(list: [account])
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openReconcile(account)
        model.reconcile?.setReading("900")
        await model.resolve(.accept)
        let log = await service.log
        #expect(log.contains("statement 7 EUR 900 2026-10-12"))
        #expect(!log.contains { $0.hasPrefix("reconcile") })
        #expect(model.notice?.key == "accounts.reconcile.readingSaved")
    }

    @Test func aFailedResolutionKeepsTheDialogAndToasts() async throws {
        let account = Self.drifting()
        let service = FakeAccountsService(list: [account])
        await service.set(reconcileFailure: .network("offline"))
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openReconcile(account)
        await model.resolve(.accept)
        #expect(model.reconcile != nil)
        #expect(model.reconcile?.pendingAction == nil)
        #expect(model.notice?.key == "accounts.reconcile.failed")
    }

    @Test func saveReadingBackfillAndShowSince() async throws {
        let account = Self.drifting()
        let service = FakeAccountsService(list: [account])
        let (model, shell) = try await AccountsFixture.opened(service)
        defer { withExtendedLifetime(shell) {} }
        model.openReconcile(account)
        model.reconcile?.setReading("940,10")
        await model.saveReading()
        #expect(await service.log.contains("statement 7 EUR 940.1 2026-10-12"))
        #expect(model.notice?.key == "accounts.reconcile.readingSaved")
        model.openReconcile(account)
        #expect(model.reconcile?.canBackfill == true)
        await model.backfillOpening()
        #expect(await service.log.contains("opening 7 950 2026-09-30 EUR"))
        model.openReconcile(account)
        model.showSince()
        #expect(model.reconcile == nil)
        #expect(shell.nativeNavigationLocation.raw == "/accounts/7?since=2026-09-30")
    }

    @Test func theOpeningBalancePrefillsFromTheStatementThenTheBase() async throws {
        let calendar = PlannedFixture.calendar
        let fromStatement = OpeningBalanceDraft(
            account: Self.drifting(), today: Self.today, numberFormat: .eu, calendar: calendar)
        #expect(fromStatement.balance == "950")
        #expect(fromStatement.date == PlannedDay(year: 2026, month: 9, day: 30))
        let fromBase = OpeningBalanceDraft(
            account: AccountsFixture.account(2, "B", balance: 30, reconcilableBalance: AccountsFixture.decimal("12.5"), reconcilableCurrency: "USD"),
            today: Self.today, numberFormat: .eu, calendar: calendar)
        #expect(fromBase.balance == "12,5")
        #expect(fromBase.currency == "USD")
        #expect(fromBase.date == Self.today)
        var empty = OpeningBalanceDraft(
            account: AccountsFixture.account(3, "C", balance: nil), today: Self.today, numberFormat: .eu, calendar: calendar)
        #expect(!empty.canSubmit)
        empty.balance = "10"
        #expect(empty.canSubmit)
        empty.date = nil
        #expect(!empty.canSubmit)
    }

    @Test func setOpeningBalancePostsTheAnchorCurrency() async throws {
        let account = AccountsFixture.account(2, "B", balance: 30, reconcilableBalance: 20, reconcilableCurrency: "USD")
        let service = FakeAccountsService(list: [account])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        model.openOpeningBalance(account)
        model.opening?.balance = "25"
        await model.submitOpeningBalance()
        #expect(model.opening == nil)
        #expect(await service.log.contains("opening 2 25 2026-10-12 USD"))
        #expect(model.notice?.key == "accounts.openingBalance.saved")
        #expect(model.notice?.kind == .success)
    }
}

// MARK: - Merge, close, transfer, delete

@MainActor
@Suite struct AccountLifecycleTests {
    @Test func mergeNeedsThePreviewAndTheAcknowledgementOfThisPair() async throws {
        let source = AccountsFixture.account(1, "Old", type: "savings")
        let target = AccountsFixture.account(2, "New")
        let service = FakeAccountsService(list: [source, target, AccountsFixture.account(3, "Third")])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/1")
        defer { withExtendedLifetime(shell) {} }
        model.openMerge(source)
        #expect(model.mergeCandidates.map { $0.id } == [2, 3])
        #expect(model.merge?.canMerge == false)
        await model.selectMergeTarget(2)
        #expect(model.merge?.previewReady == true)
        model.setMergeAcknowledged(true)
        #expect(model.merge?.canMerge == true)
        await model.selectMergeTarget(3)
        #expect(model.merge?.acknowledged == false)
        await model.selectMergeTarget(2)
        model.setMergeAcknowledged(true)
        await model.confirmMerge()
        #expect(model.merge == nil)
        #expect(await service.log.contains("merge [1]->2"))
        #expect(model.notice?.key == "accounts.merged")
        #expect(model.notice?.detail == "Moved 3 transactions and 1 planned payments.")
    }

    @Test func aFailedPreviewOffersRetryAndBlocksTheAcknowledgement() async throws {
        let source = AccountsFixture.account(1, "Old")
        let service = FakeAccountsService(list: [source, AccountsFixture.account(2, "New")])
        await service.set(preview: .failure(.network("offline")))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/1")
        defer { withExtendedLifetime(shell) {} }
        model.openMerge(source)
        await model.selectMergeTarget(2)
        #expect(model.merge?.preview == .failed)
        model.setMergeAcknowledged(true)
        #expect(model.merge?.acknowledged == false)
        await service.set(preview: nil)
        await model.retryMergePreview()
        #expect(model.merge?.previewReady == true)
    }

    @Test func closeMovesTheLotsOnceAndReusesTheKeyOnRetry() async throws {
        let broker = AccountsFixture.account(3, "Broker", type: "brokerage", balance: 12)
        let other = AccountsFixture.account(4, "Other broker", type: "brokerage")
        let service = FakeAccountsService(list: [broker, other, AccountsFixture.account(5, "Checking")])
        await service.set(lots: .success(AccountLotPreview(accountId: 3, eligibleCount: 2, transactionIds: [10, 11], limit: 500)))
        await service.set(closeFailures: [.network("offline")])
        let keys = KeyCounter()
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/3", keys: keys)
        defer { withExtendedLifetime(shell) {} }
        await model.openClose(broker)
        let draft = try #require(model.close)
        #expect(draft.showsLotChoice)
        #expect(draft.destinations.map { $0.id } == [4])
        #expect(draft.residualParts == [AccountResidual(currency: "EUR", balance: 12)])
        #expect(draft.balanceHandling == .adjustment)
        model.setCloseLotChoice(.account(4))
        await model.confirmClose()
        #expect(model.close != nil)
        #expect(model.notice?.key == "accounts.close.portfolioPartial")
        #expect(model.notice?.detail == "Moved 2 lot transactions.")
        await model.confirmClose()
        #expect(model.close == nil)
        #expect(model.notice?.key == "accounts.close.done")
        #expect(model.notice?.detail == "Moved 2 portfolio lot transactions.")
        let retags = await service.retags
        #expect(retags.count == 2)
        #expect(retags.allSatisfy { $0.idempotencyKey == "key-1" && $0.toAccountId == 4 && $0.fromAccountId == 3 })
        #expect(await service.log.filter { $0 == "close 3 adjustment" }.count == 2)
    }

    @Test func closeKeepsTheLotsByDefaultAndCanPreserveTheResidual() async throws {
        let checking = AccountsFixture.account(5, "Checking", balance: 3)
        let service = FakeAccountsService(list: [checking])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/5")
        defer { withExtendedLifetime(shell) {} }
        await model.openClose(checking)
        #expect(model.close?.lotPreview == nil)
        model.close?.zeroOut = false
        await model.confirmClose()
        #expect(await service.log.contains("close 5 preserve"))
        #expect(await service.retags.isEmpty)
    }

    @Test func anOverLimitLotMoveBlocksClose() {
        var draft = CloseDraft(account: AccountsFixture.account(3, "Broker", type: "brokerage"))
        draft.lotPreview = .loaded(AccountLotPreview(accountId: 3, eligibleCount: 600, transactionIds: [], limit: 500))
        #expect(draft.canClose)
        draft.lotChoice = .unassigned
        #expect(draft.retagUnavailable)
        #expect(!draft.canClose)
        #expect(LotDestination.unassigned.toAccountId == nil)
        #expect(LotMoveKey.fingerprint(ids: [1, 2], from: 3, to: nil) == "1,2|3|unassigned")
    }

    @Test func transferLotsSendsNullForUnassignedAndShowsTheReceipt() async throws {
        let broker = AccountsFixture.account(3, "Broker", type: "brokerage")
        let service = FakeAccountsService(list: [broker, AccountsFixture.account(4, "Exchange", type: "crypto_exchange")])
        await service.set(lots: .success(AccountLotPreview(accountId: 3, eligibleCount: 1, transactionIds: [10], limit: 500)))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/3")
        defer { withExtendedLifetime(shell) {} }
        await model.openTransfer(broker)
        #expect(model.transfer?.destinations.map { $0.id } == [4])
        #expect(model.transfer?.canTransfer == false)
        model.setTransferDestination(.unassigned)
        #expect(model.transfer?.canTransfer == true)
        await model.confirmTransfer()
        #expect(model.transfer?.receipt == LotRetagReceipt(movedCount: 1))
        #expect(model.notice?.key == "portfolio.brokerTransfer.done")
        let request = try #require(await service.retags.first)
        let json = String(decoding: try APIBody.encode(request), as: UTF8.self)
        #expect(json.contains("\"to_account_id\":null"))
        #expect(json.contains("\"from_account_id\":3"))
    }

    @Test func deleteAsksFirstThenLeavesForTheHub() async throws {
        let account = AccountsFixture.account(6, "Unused", hasTransactions: false)
        let service = FakeAccountsService(list: [account, AccountsFixture.account(7, "Kept")])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/6")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.menuItems(account).last == .delete)
        model.requestDelete(account)
        #expect(model.deleteText()?.title == "accounts.delete.title")
        model.cancelDelete()
        #expect(await service.log.contains("delete 6") == false)
        model.requestDelete(account)
        await model.confirmDelete()
        #expect(await service.log.contains("delete 6"))
        #expect(model.notice?.key == "accounts.deleted")
        #expect(shell.nativeNavigationLocation.raw == "/accounts")
    }

    @Test func aStillReferencedAccountOpensCloseInstead() async throws {
        let account = AccountsFixture.account(6, "Busy", hasTransactions: false)
        let service = FakeAccountsService(list: [account])
        await service.set(deleteFailure: .client(APIClientError(status: 409, code: .conflict, message: "referenced")))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/6")
        defer { withExtendedLifetime(shell) {} }
        model.requestDelete(account)
        await model.confirmDelete()
        #expect(model.notice?.kind == .info)
        #expect(model.notice?.key == "accounts.delete.stillReferenced")
        #expect(model.notice?.variables == ["name": "Busy"])
        #expect(model.close?.account.id == 6)
    }

    @Test func reopenPatchesIsActive() async throws {
        let closed = AccountsFixture.account(8, "Closed", isActive: false)
        let service = FakeAccountsService(list: [closed])
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/8")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.menuItems(closed).contains(.reopen))
        await model.reopen(closed)
        #expect(await service.patches == ["{\"is_active\":true}"])
        #expect(model.notice?.key == "accounts.updated")
    }

    @Test func theHeaderMenuFollowsTheWebOrder() async throws {
        let broker = AccountsFixture.account(3, "Broker", type: "brokerage")
        let wallet = AccountsFixture.account(4, "Wallet", type: "wallet", hasTransactions: false)
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService(list: [broker, wallet]))
        defer { withExtendedLifetime(shell) {} }
        #expect(
            model.menuItems(broker)
                == [.edit, .openingBalance, .viewTransactions, .separator, .merge, .transferLots, .close, .deleteDisabled])
        #expect(model.menuItems(wallet) == [.edit, .separator, .merge, .transferLots, .close, .delete])
    }
}

// MARK: - Detail: ledger and planned

@MainActor
@Suite struct AccountDetailTests {
    static func ledger(_ count: Int) -> [AccountLedgerRow] {
        (0..<count).map { index in
            let day = 28 - (index % 28)
            let month = index < 28 ? 10 : 9
            return AccountsFixture.row(
                TransactionID(rawValue: index + 1), date: String(format: "2026-%02d-%02d", month, day), amount: 1,
                running: Decimal(1000 - index))
        }
    }

    @Test func aWriteFromTheHubRefetchesTheCachedLedger() async throws {
        let account = AccountsFixture.account(2, "Daily")
        let service = FakeAccountsService(list: [account], ledgerRows: Self.ledger(3))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        // Back to the hub as a switch does: the hub appears before the detail goes away.
        await model.appear(.hub)
        model.disappear(.detail(2))
        model.openCreate()
        model.form?.setName("New")
        await model.submitForm()
        await model.appear(.detail(2))
        #expect(await service.ledgerRequests == ["2:0:100", "2:0:100"])
        #expect(model.ledger?.count == 3)
    }

    @Test func theLedgerPagesByAHundredWithItsRunningBalance() async throws {
        let account = AccountsFixture.account(2, "Daily")
        let service = FakeAccountsService(list: [account], ledgerRows: Self.ledger(150))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.ledger?.count == 100)
        #expect(model.ledgerTotal == 150)
        #expect(model.ledger?.first?.runningBalance == 1000)
        #expect(model.ledgerHasMore)
        await model.loadMoreLedger()
        #expect(model.ledger?.count == 150)
        #expect(!model.ledgerHasMore)
        #expect(await service.ledgerRequests == ["2:0:100", "2:100:100"])
        let points = model.sparkPoints(account)
        #expect(points.count == 100)
        #expect(points.first == 901)
        #expect(points.last == 1000)
        #expect(AccountsModel.trend(points) == .up)
        #expect(AccountsModel.trend([5]) == .flat)
    }

    @Test func sinceFiltersTheLoadedRowsAndStopsLoadMore() async throws {
        let account = AccountsFixture.account(2, "Daily")
        let service = FakeAccountsService(list: [account], ledgerRows: Self.ledger(150))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2?since=2026-10-20")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.since == "2026-10-20")
        #expect(model.visibleLedger.allSatisfy { $0.date >= "2026-10-20" })
        #expect(!model.visibleLedger.isEmpty)
        #expect(!model.ledgerHasMore)
        model.clearSince()
        #expect(shell.nativeNavigationLocation.raw == "/accounts/2")
        #expect(model.since == nil)
        #expect(model.ledgerHasMore)
    }

    @Test func holdingsOnlyAccountsLoadNoLedgerOrPlannedRows() async throws {
        let wallet = AccountsFixture.account(4, "Wallet", type: "wallet")
        let service = FakeAccountsService(list: [wallet], ledgerRows: Self.ledger(3))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/4")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.ledger == nil)
        #expect(await service.ledgerRequests.isEmpty)
        #expect(await service.log.contains("planned 4") == false)
        #expect(await service.log.contains("portfolio EUR"))
    }

    @Test func plannedRowsSortByDateAndNoteATruncation() async throws {
        let account = AccountsFixture.account(2, "Daily")
        let page = AccountPlannedPage(
            rows: [
                AccountPlannedRow(id: 1, date: "2026-12-01", recipientName: "Rent", amount: -900),
                AccountPlannedRow(id: 2, date: "2026-11-01", memo: "Gym", amount: -30),
            ],
            total: 7)
        let service = FakeAccountsService(list: [account], plannedPage: page)
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.plannedRows.map { $0.id } == [2, 1])
        #expect(model.plannedRows.first?.title == "Gym")
        #expect(model.plannedTruncatedText == "Showing 2 of 7 planned transactions.")
        #expect(model.showsPlannedCard)
    }

    @Test func aFailedPlannedLoadRetries() async throws {
        let account = AccountsFixture.account(2, "Daily")
        let service = FakeAccountsService(list: [account])
        await service.set(plannedFailure: .network("offline"))
        let (model, shell) = try await AccountsFixture.opened(service, route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.plannedError != nil)
        #expect(model.showsPlannedCard)
        await service.set(plannedFailure: nil)
        await model.retryPlanned()
        #expect(model.plannedError == nil)
        #expect(!model.showsPlannedCard)
    }

    @Test func anUnknownOrInvalidIdIsNotFound() async throws {
        let (model, shell) = try await AccountsFixture.opened(
            FakeAccountsService(list: [AccountsFixture.account(2, "Daily")]), route: "/accounts/9")
        defer { withExtendedLifetime(shell) {} }
        #expect(model.detailState(9) == .notFound)
        #expect(model.detailState(0) == .notFound)
        #expect(model.detailState(2) == .loaded(AccountsFixture.account(2, "Daily")))
    }

    @Test func theDetailsCardLeavesOutTheTaxWrapper() async throws {
        let account = AccountsFixture.account(2, "Daily", institution: "KBC")
        let (model, shell) = try await AccountsFixture.opened(FakeAccountsService(list: [account]), route: "/accounts/2")
        defer { withExtendedLifetime(shell) {} }
        let entries = model.details(account)
        #expect(
            entries.map { $0.labelKey } == [
                "accounts.field.type", "accounts.field.currency", "accounts.field.owner", "accounts.field.liquidityClass",
                "accounts.field.institution", "accounts.field.spendable", "accounts.field.inNetWorth",
            ])
        #expect(entries.last?.value == "Yes")
    }
}

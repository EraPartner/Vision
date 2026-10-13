import Foundation
import Observation

/// Which accounts screen is on screen: the hub or one account's detail.
public enum AccountsScreen: Equatable, Hashable, Sendable {
    case hub
    /// `/accounts/:id`; `0` for an id that is not a positive whole number.
    case detail(Int)
}

/// A group header's or Net cash's figure.
public enum AccountSubtotal: Equatable, Sendable {
    /// `accounts.group.subtotalPending`: the portfolio summary or the exchange rates load.
    case pending
    /// `accounts.group.subtotalUnavailable`: the portfolio summary failed.
    case unavailable
    case amount(AccountTotal)
}

/// What `/accounts/:id` shows.
public enum AccountDetailState: Equatable, Sendable {
    case loading
    case failed(APIError)
    /// `accounts.detail.notFoundTitle`.
    case notFound
    case loaded(OpenAPI.Account)
}

/// The rows of the detail's header menu (`accounts.actionsMenu`), in the web's order.
public enum AccountMenuItem: Equatable, Sendable {
    case edit
    case openingBalance
    case viewTransactions
    case separator
    case merge
    case transferLots
    case close
    case reopen
    case delete
    /// Delete, disabled, with `accounts.delete.hasTransactions`.
    case deleteDisabled
}

/// One row of the Details card.
public struct AccountDetailEntry: Equatable, Sendable, Identifiable {
    public let labelKey: String
    public let value: String

    public var id: String { labelKey }

    public init(labelKey: String, value: String) {
        self.labelKey = labelKey
        self.value = value
    }
}

/// The state of `/accounts` (AccountsPage) and `/accounts/:id` (AccountDetailPage): the
/// grouped account list with subtotals, Net cash and broker metrics, one account's balance,
/// holdings, upcoming planned rows, ledger and details, and every dialog both pages open
/// (Add/Edit account, Reconcile, Set opening balance, Merge, Close, Transfer lots, Delete).
@MainActor
@Observable
public final class AccountsModel {
    /// `staleTime: 2 * 60_000` of `useAccounts`.
    public static let staleAfter: TimeInterval = 120
    /// `QUERY_STALE_TIME_MS.STANDARD` of the portfolio summary.
    public static let portfolioStaleAfter: TimeInterval = 60
    /// `LEDGER_PAGE_SIZE`.
    public nonisolated static let ledgerPageSize = 100
    /// `SPARKLINE_MAX_POINTS`.
    public nonisolated static let sparklineMaxPoints = 100
    public static let noticeDuration: Duration = .seconds(4)

    /// `useAccounts({ active: "all" })`; `nil` until the first answer.
    public private(set) var accounts: [OpenAPI.Account]?
    public private(set) var accountsError: APIError?
    /// `byAccount` of the portfolio summary; `nil` until the first answer.
    public private(set) var portfolioRows: [PortfolioAccountRow]?
    public private(set) var portfolioError: APIError?
    /// The Archived disclosure, collapsed by default.
    public var archivedOpen = false

    /// The detail's ledger (newest first); `nil` until the first page.
    public private(set) var ledger: [AccountLedgerRow]?
    public private(set) var ledgerTotal = 0
    public private(set) var ledgerError: APIError?
    public private(set) var isFetchingMoreLedger = false
    /// The detail's upcoming planned rows; `nil` until loaded.
    public private(set) var planned: AccountPlannedPage?
    public private(set) var plannedError: APIError?

    /// The Add / Edit account sheet.
    public var form: AccountFormDraft?
    public internal(set) var isSavingForm = false
    /// The field the sheet focuses after a failed submit.
    public internal(set) var formFocus: AccountFormFocus?
    /// Bumped by every failed submit, so a repeated failure refocuses the same field.
    public internal(set) var formFocusRequest = 0
    public var reconcile: ReconcileDraft?
    public var opening: OpeningBalanceDraft?
    public var merge: MergeDraft?
    public var close: CloseDraft?
    public var transfer: BrokerTransferDraft?
    /// The Delete account? alert, for this account.
    public internal(set) var pendingDelete: OpenAPI.Account?
    public internal(set) var isDeleting = false
    public internal(set) var isReopening = false
    public internal(set) var notice: ScreenNotice?

    /// The shared exchange rates (hub subtotals and Net cash convert with them).
    public let rates: ExchangeRatesModel

    @ObservationIgnored let service: any AccountsService
    @ObservationIgnored weak var shell: NativeShellModel?
    @ObservationIgnored public let calendar: Calendar
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored let makeKey: @Sendable () -> String
    @ObservationIgnored var notices = NoticeCounter()
    @ObservationIgnored private(set) var visible: AccountsScreen?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var cacheGeneration = 0
    @ObservationIgnored private var portfolioFetchedAt: Date?
    @ObservationIgnored private var portfolioCurrency: String?
    @ObservationIgnored private var portfolioInFlight: (currency: String, task: Task<Void, Never>)?
    @ObservationIgnored private(set) var detailId: Int?
    @ObservationIgnored private var ledgerVersion = 0
    @ObservationIgnored private var ledgerInFlight: (id: Int, task: Task<Void, Never>)?
    @ObservationIgnored private var plannedInFlight: (id: Int, task: Task<Void, Never>)?

    public init(
        service: any AccountsService, rates: ExchangeRatesModel, calendar: Calendar = PlannedDates.local,
        now: @escaping @Sendable () -> Date = { Date() },
        makeKey: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.service = service
        self.rates = rates
        self.calendar = calendar
        self.now = now
        self.makeKey = makeKey
    }

    func attach(_ shell: NativeShellModel) {
        self.shell = shell
    }

    var strings: any Localizing { shell?.strings ?? DictionaryStrings(language: .en, table: [:]) }
    public var settings: NativeAppSettings { shell?.settings ?? .defaults }

    /// `appSettings.defaultCurrency || "EUR"`: the hub's display currency.
    public var displayCurrency: String { settings.defaultCurrency.isEmpty ? "EUR" : settings.defaultCurrency }

    /// Today's local day.
    public var today: PlannedDay { PlannedDay(now(), calendar: calendar) }

    // MARK: Visibility

    /// A screen appeared: it loads and may navigate. Arriving from another page refetches
    /// the list in the background (the cached rows stay), as another screen may have changed
    /// the balances; switching between the hub and a detail reuses it.
    public func appear(_ screen: AccountsScreen) async {
        let arriving = visible == nil
        visible = screen
        if case .detail(let id) = screen, detailId != id { resetDetail(id) }
        let rates = rates
        let ratesTask = Task { await rates.appear() }
        var portfolioTask: Task<Void, Never>?
        if screen == .hub {
            portfolioTask = Task { [weak self] in
                guard let self else { return }
                await self.loadPortfolio()
            }
        }
        await load(force: arriving && accounts != nil)
        if case .detail(let id) = screen, visible == screen {
            await loadDetail(id, force: arriving)
        }
        await portfolioTask?.value
        await ratesTask.value
    }

    /// A screen went away. A newer screen (the hub opening a detail) keeps the state.
    public func disappear(_ screen: AccountsScreen) {
        guard visible == screen else { return }
        visible = nil
        archivedOpen = false
        closeDialogs()
    }

    /// Every dialog closes, like the unmounted page.
    func closeDialogs() {
        form = nil
        formFocus = nil
        reconcile = nil
        opening = nil
        merge = nil
        close = nil
        transfer = nil
        pendingDelete = nil
    }

    private func resetDetail(_ id: Int) {
        detailId = id
        ledgerVersion += 1
        ledger = nil
        ledgerTotal = 0
        ledgerError = nil
        isFetchingMoreLedger = false
        ledgerInFlight = nil
        planned = nil
        plannedError = nil
        plannedInFlight = nil
        closeDialogs()
    }

    /// The shell this screen navigates through, only while it is shown.
    func navigate(to url: String) {
        guard visible != nil else { return }
        shell?.navigate(to: url)
    }

    // MARK: Accounts

    public var isLoading: Bool { accounts == nil && accountsError == nil }

    /// The list goes stale (another screen changed an account).
    public func invalidate() {
        cacheGeneration += 1
        fetchedAt = nil
        portfolioFetchedAt = nil
    }

    /// `useAccounts({ active: "all" })`: one request at a time; a fresh answer is reused
    /// unless `force`.
    public func load(force: Bool = false) async {
        if let inFlight {
            await inFlight.value
            if !force { return }
        }
        if !force, accounts != nil, accountsError == nil, let fetchedAt,
            now().timeIntervalSince(fetchedAt) < Self.staleAfter
        {
            return
        }
        let service = service
        let generation = cacheGeneration
        let task = Task { [weak self] in
            do {
                let items = try await service.accounts(active: "all")
                self?.accounts = items
                self?.accountsError = nil
                self?.fetchedAt = self?.cacheGeneration == generation ? self?.now() : nil
            } catch is CancellationError {
                return
            } catch {
                self?.accountsError = APIError.wrapping(error)
                self?.fetchedAt = nil
            }
        }
        inFlight = task
        await task.value
        if inFlight == task { inFlight = nil }
    }

    /// The error state's Retry: `refetch()`.
    public func retry() async {
        await load(force: true)
        if case .detail(let id) = visible { await loadDetail(id, force: true) }
    }

    // MARK: Portfolio summary

    /// The summary is on its way (only meaningful once requested).
    public var isPortfolioLoading: Bool { portfolioRows == nil && portfolioError == nil }

    /// `usePortfolioSummaryQuery(displayCurrency)`.
    public func loadPortfolio(force: Bool = false) async {
        let currency = displayCurrency
        if let portfolioInFlight, portfolioInFlight.currency == currency {
            await portfolioInFlight.task.value
            if !force { return }
        }
        if !force, portfolioCurrency == currency, portfolioRows != nil, portfolioError == nil,
            let portfolioFetchedAt, now().timeIntervalSince(portfolioFetchedAt) < Self.portfolioStaleAfter
        {
            return
        }
        if portfolioCurrency != currency {
            portfolioRows = nil
            portfolioError = nil
        }
        portfolioCurrency = currency
        let service = service
        let generation = cacheGeneration
        let task = Task { [weak self] in
            do {
                let rows = try await service.portfolioAccountRows(currency: currency)
                guard self?.portfolioCurrency == currency else { return }
                self?.portfolioRows = rows
                self?.portfolioError = nil
                self?.portfolioFetchedAt = self?.cacheGeneration == generation ? self?.now() : nil
            } catch is CancellationError {
                return
            } catch {
                guard self?.portfolioCurrency == currency else { return }
                self?.portfolioError = APIError.wrapping(error)
                self?.portfolioFetchedAt = nil
            }
        }
        portfolioInFlight = (currency, task)
        await task.value
        if portfolioInFlight?.task == task { portfolioInFlight = nil }
    }

    /// The holdings card's Retry.
    public func retryPortfolio() async {
        portfolioError = nil
        await loadPortfolio(force: true)
    }

    /// `getBrokerAccountMetrics(portfolioSummary, id)`.
    public func metrics(_ account: OpenAPI.Account) -> BrokerAccountMetrics? {
        BrokerAccountMetrics.of(portfolioRows, accountId: account.id)
    }

    // MARK: Hub

    /// `useCurrencyConverter(displayCurrency)` over the shared rates.
    public var converter: PlannedCurrencyConverter {
        PlannedCurrencyConverter(rates: rates.data, target: displayCurrency)
    }

    private var collationLocale: Locale { Locale(identifier: strings.language.rawValue) }

    /// The groups in order, Archived included.
    public var groups: [AccountGroup] {
        AccountGrouping.groups(accounts ?? [], locale: collationLocale)
    }

    /// The groups above Net cash.
    public var visibleGroups: [AccountGroup] { groups.filter { $0.id != .archived } }

    /// The collapsed Archived group.
    public var archivedGroup: AccountGroup? { groups.first { $0.id == .archived } }

    /// `renderGroupSubtotal`: the converted cash balances plus the broker holdings.
    public func subtotal(_ group: AccountGroup) -> AccountSubtotal {
        let needsPortfolio = group.accounts.contains { AccountKinds.isPortfolio($0) }
        if needsPortfolio && isPortfolioLoading { return .pending }
        if needsPortfolio && portfolioError != nil { return .unavailable }
        if rates.isLoading { return .pending }
        let cash = AccountGrouping.sumConverted(
            group.accounts.filter { !AccountKinds.isHoldingsOnly($0) }, converter: converter)
        var holdings = Decimal(0)
        for account in group.accounts where AccountKinds.isPortfolio(account) {
            holdings += metrics(account)?.holdingsValue ?? 0
        }
        return .amount(AccountTotal(amount: cash.amount + holdings, incomplete: cash.incomplete))
    }

    /// Net cash; pending while the rates load.
    public var netCash: AccountSubtotal {
        if rates.isLoading { return .pending }
        return .amount(AccountGrouping.netCash(accounts ?? [], converter: converter))
    }

    /// The meta line: type, currency and institution.
    public func meta(_ account: OpenAPI.Account) -> String {
        var parts = [typeLabel(account), account.currency]
        if let institution = account.institution, !institution.isEmpty { parts.append(institution) }
        return parts.joined(separator: " · ")
    }

    public func typeLabel(_ account: OpenAPI.Account) -> String {
        strings.t("accounts.type.\(account.type)")
    }

    /// The drift chip; none for wallets and exchanges.
    public func drift(_ account: OpenAPI.Account) -> AccountDrift? {
        if AccountKinds.isHoldingsOnly(account) { return nil }
        return AccountDrift.of(account, today: today.ymd, settings: settings, strings: strings)
    }

    /// The provenance subline.
    public func provenance(_ account: OpenAPI.Account) -> String? {
        AccountProvenance.text(account, settings: settings, strings: strings)
    }

    /// Reconcile balance shows in the row menu: drift or multi-currency cash, not holdings-only.
    public func canReconcile(_ account: OpenAPI.Account) -> Bool {
        !AccountKinds.isHoldingsOnly(account) && (drift(account) != nil || account.multiCurrencyCash)
    }

    /// The parts the converted balance leaves out (the incomplete warning).
    public func excludedParts(_ account: OpenAPI.Account) -> [OpenAPI.Account.BalancePartsItem] {
        let unconverted = account.unconvertedCurrencies ?? []
        return (account.balanceParts ?? []).filter { unconverted.contains($0.currency) }
    }

    /// `formatCurrency` in the app's number format.
    public func money(_ amount: Decimal, currency: String, signed: Bool = false) -> String {
        VisionFormat.currency(
            amount, code: currency.uppercased(), locale: settings.numberFormat.locale,
            fractionDigits: settings.showDecimalPlaces, signed: signed)
    }

    /// A count in the money formatter's locale (`numFmt.format`).
    public func count(_ value: Int) -> String {
        VisionFormat.decimal(Decimal(value), fractionDigits: 0, locale: settings.numberFormat.locale)
    }

    /// A row or View details: `/accounts/:id`.
    public func openDetail(_ account: OpenAPI.Account) {
        navigate(to: AccountsRoutes.detailPath(account.id))
    }

    /// View transactions: `/transactions?account_id=<id>&filter_label=<label>`.
    public func openTransactions(_ account: OpenAPI.Account) {
        navigate(to: AccountsRoutes.transactionsLink(account))
    }

    /// All accounts: `/accounts`.
    public func backToHub() {
        navigate(to: AccountsRoutes.path)
    }

    // MARK: Detail

    /// The detail's account, once the list is in.
    public func detailState(_ id: Int) -> AccountDetailState {
        if let accountsError { return .failed(accountsError) }
        guard let accounts else { return .loading }
        guard id > 0, let account = accounts.first(where: { $0.id == id }) else { return .notFound }
        return .loaded(account)
    }

    /// The detail's account, or `nil`.
    public func account(_ id: Int) -> OpenAPI.Account? {
        guard id > 0 else { return nil }
        return accounts?.first { $0.id == id }
    }

    private func loadDetail(_ id: Int, force: Bool) async {
        guard let account = account(id) else { return }
        var tasks: [Task<Void, Never>] = []
        if AccountKinds.isPortfolio(account) {
            tasks.append(
                Task { [weak self] in
                    guard let self else { return }
                    await self.loadPortfolio()
                })
        }
        if !AccountKinds.isHoldingsOnly(account) {
            tasks.append(
                Task { [weak self] in
                    guard let self else { return }
                    await self.loadPlanned(id, force: force)
                })
        }
        if AccountKinds.canViewTransactions(account) {
            await loadLedger(id, force: force)
        }
        for task in tasks { await task.value }
    }

    /// The header subtitle: type, currency and institution (when set).
    public func detailSubtitle(_ account: OpenAPI.Account) -> String {
        meta(account)
    }

    /// The header menu rows in order (AccountDetailPage.tsx:410).
    public func menuItems(_ account: OpenAPI.Account) -> [AccountMenuItem] {
        var items: [AccountMenuItem] = [.edit]
        if !AccountKinds.isHoldingsOnly(account) { items.append(.openingBalance) }
        if AccountKinds.canViewTransactions(account) { items.append(.viewTransactions) }
        items.append(.separator)
        if (accounts?.count ?? 0) > 1 { items.append(.merge) }
        if account.isActive && AccountKinds.isPortfolio(account) { items.append(.transferLots) }
        items.append(account.isActive ? .close : .reopen)
        items.append(account.hasTransactions == false ? .delete : .deleteDisabled)
        return items
    }

    /// The Reconcile balance button of the balance card: multi-currency cash without drift.
    public func showsReconcileButton(_ account: OpenAPI.Account) -> Bool {
        !AccountKinds.isHoldingsOnly(account) && drift(account) == nil && account.multiCurrencyCash
    }

    /// The Details card (AccountDetailPage.tsx:358); no tax wrapper.
    public func details(_ account: OpenAPI.Account) -> [AccountDetailEntry] {
        var entries = [
            AccountDetailEntry(labelKey: "accounts.field.type", value: typeLabel(account)),
            AccountDetailEntry(labelKey: "accounts.field.currency", value: account.currency),
            AccountDetailEntry(labelKey: "accounts.field.owner", value: strings.t("accounts.owner.\(account.owner)")),
            AccountDetailEntry(
                labelKey: "accounts.field.liquidityClass",
                value: strings.t("accounts.liquidity.\(account.liquidityClass)")),
        ]
        if let institution = account.institution, !institution.isEmpty {
            entries.append(AccountDetailEntry(labelKey: "accounts.field.institution", value: institution))
        }
        entries.append(
            AccountDetailEntry(
                labelKey: "accounts.field.spendable", value: strings.t(account.spendable ? "common.yes" : "common.no")))
        entries.append(
            AccountDetailEntry(
                labelKey: "accounts.field.inNetWorth", value: strings.t(account.inNetWorth ? "common.yes" : "common.no")))
        return entries
    }

    // MARK: Ledger

    /// `?since=`, when it reads as a day.
    public var since: String? {
        guard case .detail = visible, let shell else { return nil }
        return AccountsRoutes.since(in: shell.route)
    }

    /// The since banner's ×: removes `since` with a replace write.
    public func clearSince() {
        guard visible != nil else { return }
        shell?.replaceQuery(AccountsRoutes.sinceParameter, with: nil)
    }

    /// The rows the ledger shows: on or after `since`.
    public var visibleLedger: [AccountLedgerRow] {
        let rows = ledger ?? []
        guard let since else { return rows }
        return rows.filter { $0.date >= since }
    }

    /// More rows exist and the since window still spans every loaded row.
    public var ledgerHasMore: Bool {
        let rows = ledger ?? []
        return rows.count < ledgerTotal && (since == nil || visibleLedger.count == rows.count)
    }

    public var isLedgerLoading: Bool { ledger == nil && ledgerError == nil }

    /// The first page (a reload after a write keeps the loaded window).
    func loadLedger(_ id: Int, force: Bool = false) async {
        if let ledgerInFlight, ledgerInFlight.id == id {
            await ledgerInFlight.task.value
            if !force { return }
        }
        if !force, ledger != nil, ledgerError == nil, detailId == id { return }
        let limit = max(Self.ledgerPageSize, ledger?.count ?? 0)
        let version = ledgerVersion
        let service = service
        let task = Task { [weak self] in
            do {
                let page = try await service.ledger(accountId: id, offset: 0, limit: limit)
                guard let self, self.ledgerVersion == version else { return }
                self.ledger = page.rows
                self.ledgerTotal = page.total
                self.ledgerError = nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.ledgerVersion == version else { return }
                if self.ledger == nil { self.ledgerError = APIError.wrapping(error) }
            }
        }
        ledgerInFlight = (id, task)
        await task.value
        if ledgerInFlight?.task == task { ledgerInFlight = nil }
    }

    /// Load more: the next 100 rows.
    public func loadMoreLedger() async {
        guard let id = detailId, let rows = ledger, ledgerHasMore, !isFetchingMoreLedger, ledgerInFlight == nil else {
            return
        }
        isFetchingMoreLedger = true
        let version = ledgerVersion
        defer { if ledgerVersion == version { isFetchingMoreLedger = false } }
        guard
            let page = try? await service.ledger(accountId: id, offset: rows.count, limit: Self.ledgerPageSize),
            ledgerVersion == version
        else { return }
        let existing = Set((ledger ?? []).map(\.id))
        let added = page.rows.filter { !existing.contains($0.id) }
        ledger = (ledger ?? []) + added
        ledgerTotal = page.total
    }

    /// The sparkline: up to 100 running balances in the account currency, oldest first.
    public func sparkPoints(_ account: OpenAPI.Account) -> [Decimal] {
        let points = (ledger ?? []).filter { $0.currency == account.currency }
            .prefix(Self.sparklineMaxPoints)
            .compactMap { $0.runningBalance ?? $0.balance }
        return Array(points.reversed())
    }

    /// The sparkline's colour.
    public nonisolated static func trend(_ points: [Decimal]) -> AccountTrend {
        guard points.count >= 2, let first = points.first, let last = points.last else { return .flat }
        if last > first { return .up }
        if last < first { return .down }
        return .flat
    }

    // MARK: Planned

    public var isPlannedLoading: Bool { planned == nil && plannedError == nil }

    /// `useAccountPlannedTransactions`.
    func loadPlanned(_ id: Int, force: Bool = false) async {
        if let plannedInFlight, plannedInFlight.id == id {
            await plannedInFlight.task.value
            if !force { return }
        }
        if !force, planned != nil, plannedError == nil, detailId == id { return }
        let service = service
        let task = Task { [weak self] in
            do {
                let page = try await service.plannedRows(accountId: id)
                guard let self, self.detailId == id else { return }
                self.planned = page
                self.plannedError = nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.detailId == id else { return }
                self.plannedError = APIError.wrapping(error)
            }
        }
        plannedInFlight = (id, task)
        await task.value
        if plannedInFlight?.task == task { plannedInFlight = nil }
    }

    /// The planned card's Retry.
    public func retryPlanned() async {
        guard let id = detailId else { return }
        plannedError = nil
        planned = nil
        await loadPlanned(id, force: true)
    }

    /// The rows by planned date.
    public var plannedRows: [AccountPlannedRow] {
        (planned?.rows ?? []).sorted { $0.date < $1.date }
    }

    /// The card shows while loading, on error, or with rows.
    public var showsPlannedCard: Bool {
        isPlannedLoading || plannedError != nil || !plannedRows.isEmpty
    }

    /// `accounts.detail.upcomingPlannedTruncated`, when the server holds more.
    public var plannedTruncatedText: String? {
        guard let planned, planned.total > planned.rows.count else { return nil }
        return strings.t(
            "accounts.detail.upcomingPlannedTruncated", ["shown": String(planned.rows.count), "total": String(planned.total)])
    }

    // MARK: After a write

    /// `invalidateAccountDerived` / `invalidateAccountRepoint`: the list, the summary, the
    /// shown account's ledger and planned rows, and the other native screens' caches.
    func refreshAfterWrite() async {
        invalidate()
        shell?.transactions.invalidate()
        shell?.planned.invalidate()
        await load(force: true)
        if visible == .hub || portfolioRows != nil {
            await loadPortfolio(force: true)
        }
        if case .detail(let id) = visible {
            await loadDetail(id, force: true)
        }
    }

    // MARK: Toasts

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }

    func post(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil) {
        notice = notices.make(kind, key, variables, detail: detail)
    }

    func errorText(_ error: any Error) -> String {
        if let flow = error as? AccountFlowError { return flow.message }
        return APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }

    func t(_ key: String, _ variables: [String: String] = [:]) -> String {
        strings.t(key, variables)
    }
}

/// A dialog's own refusal (`throw new Error(t(...))`): its text is the toast's description.
struct AccountFlowError: Error {
    let message: String
}

/// The Add / Edit account field a failed submit focuses.
public enum AccountFormFocus: Equatable, Sendable {
    case openingBalance
    case openingDate
}

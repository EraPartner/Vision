import Foundation
import Observation

/// The person whose detail `/owes` shows (`selectedRecipient`).
public struct OwesPerson: Equatable, Sendable {
    public let id: RecipientID
    public let name: String

    public init(id: RecipientID, name: String) {
        self.id = id
        self.name = name
    }
}

/// The Record payment dialog: the split, its remaining amount and the typed amount.
public struct OwesPaymentDraft: Equatable, Sendable {
    public let splitId: SplitID
    public let remaining: Decimal
    /// The split's own currency (the transaction's), `splitCurrency` of the web dialog.
    public let currency: CurrencyCode
    public var amountText: String
    /// `owesPage.recordDialog.invalidAmount` shows.
    public var invalid = false
}

/// What an `/owes` alert asks.
public enum OwesConfirmation: Equatable, Sendable {
    /// Settle all outstanding splits of the person.
    case settleAll(count: Int, amount: Decimal, unconvertedCount: Int)
    /// Delete this split.
    case deleteSplit(SplitID)
}

/// One row of the person detail's Recent transactions table.
public struct OwesRecentRow: Equatable, Sendable, Identifiable {
    public let id: TransactionID
    public let date: String
    /// The memo, else `owesPage.transaction`.
    public let description: String
    /// The category, else `txPage.field.uncategorized`.
    public let category: String
    public let amount: Decimal
    public let currency: CurrencyCode
    /// The bank account, else `—`.
    public let bankAccount: String

    /// The columns in the web's order.
    public static let keys = ["date", "description", "category", "amount", "bankAccount"]

    public func rawValue(_ key: String) -> TableRawValue {
        switch key {
        case "date": return .text(date)
        case "description": return .text(description)
        case "category": return .text(category)
        case "amount": return .number(amount)
        case "bankAccount": return .text(bankAccount)
        default: return .none
        }
    }
}

/// The state of `/owes` (`OwesPage` with `RecipientOwesDetail`): the people who owe you with
/// the total outstanding, one person's open splits with Record payment, Mark as settled,
/// Delete split, Settle all and Export CSV, and the person's recent transactions (paged by
/// 10 as the table scrolls, searched, filtered and sorted locally).
@MainActor
@Observable
public final class OwesModel {
    /// `QUERY_STALE_TIME_MS.FREQUENT`.
    public static let staleAfter: TimeInterval = 30
    /// `RECIPIENT_TRANSACTION_PAGE_SIZE`.
    public nonisolated static let recentPageSize = 10
    public static let noticeDuration: Duration = .seconds(4)

    /// `useOwedSummary`; `nil` until the first answer.
    public private(set) var summary: [OpenAPI.SplitOwed]?
    /// `summary` of the owed read: the total outstanding in the default currency, computed on
    /// the server, and the open splits left out for want of a stored rate.
    public private(set) var summaryTotals: OpenAPI.OwedTotals?
    public private(set) var summaryError: APIError?
    /// The person detail, while one is open.
    public private(set) var person: OwesPerson?
    /// `useOwedByRecipient`; `nil` until the first answer for the person.
    public private(set) var splits: [OpenAPI.SplitOwedDetail]?
    public private(set) var splitsTotals: OpenAPI.OwedTotals?
    public private(set) var splitsError: APIError?
    /// `useRecentRecipientTransactions`.
    public private(set) var recent: [OpenAPI.Transaction] = []
    public private(set) var recentTotal = 0
    public private(set) var recentLoaded = false
    public private(set) var isFetchingMoreRecent = false
    /// The Recent transactions table's search, column filters and sort.
    public var recentQuery = LocalTableQuery()
    /// The Record payment dialog.
    public var payment: OwesPaymentDraft?
    public private(set) var isRecording = false
    /// The alert on screen.
    public private(set) var confirmation: OwesConfirmation?
    public private(set) var isSettlingAll = false
    public private(set) var isExporting = false
    public private(set) var settlePending = false
    public private(set) var deletePending = false
    public private(set) var notice: ScreenNotice?

    /// Saves bytes under a suggested name (the Save panel): `true` once written.
    @ObservationIgnored public var save: @MainActor (Data, String) async throws -> Bool = { _, _ in false }

    @ObservationIgnored private let service: any SplitsService
    @ObservationIgnored private weak var shell: NativeShellModel?
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var summaryFetchedAt: Date?
    @ObservationIgnored private var summaryInFlight: Task<Void, Never>?
    @ObservationIgnored private var splitsFetchedAt: Date?
    @ObservationIgnored private var splitsInFlight: (id: RecipientID, task: Task<Void, Never>)?
    @ObservationIgnored private var recentInFlight: (id: RecipientID, task: Task<Void, Never>)?
    @ObservationIgnored private var recentOffset = 0
    @ObservationIgnored private var recentVersion = 0
    @ObservationIgnored private var isVisible = false
    /// Bumped by `invalidate()`: a fetch that started before it does not count as fresh.
    @ObservationIgnored private var cacheGeneration = 0

    public init(
        service: any SplitsService, calendar: Calendar = PlannedDates.local,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.calendar = calendar
        self.now = now
    }

    func attach(_ shell: NativeShellModel) {
        self.shell = shell
    }

    private var strings: any Localizing { shell?.strings ?? DictionaryStrings(language: .en, table: [:]) }
    private var settings: NativeAppSettings { shell?.settings ?? .defaults }

    /// `appSettings.defaultCurrency || "EUR"`: the owed amounts' currency.
    public var defaultCurrency: CurrencyCode { LedgerCurrency.display(settings) }

    // MARK: Visibility

    /// The screen appeared: it loads and may navigate.
    public func appear() async {
        isVisible = true
        await loadSummary()
    }

    /// The screen went away: the person detail and its dialogs go with it, like the
    /// unmounted page.
    public func disappear() {
        isVisible = false
        person = nil
        splits = nil
        splitsError = nil
        payment = nil
        confirmation = nil
        resetRecent()
    }

    // MARK: Summary

    /// `invalidateQueries({ queryKey: splitKeys.all })` after a split is created elsewhere
    /// (the Split dialog, Bulk split): the summary and the person detail refetch on their
    /// next load instead of serving a 30 s old answer.
    public func invalidate() {
        cacheGeneration += 1
        summaryFetchedAt = nil
        splitsFetchedAt = nil
    }

    public var isLoadingSummary: Bool { summary == nil && summaryError == nil }

    /// `useOwedSummary`: one request at a time; a fresh answer (30 s) is reused unless
    /// `force`.
    public func loadSummary(force: Bool = false) async {
        if let summaryInFlight {
            await summaryInFlight.value
            if !force { return }
        }
        if !force, summary != nil, summaryError == nil, let summaryFetchedAt,
            now().timeIntervalSince(summaryFetchedAt) < Self.staleAfter
        {
            return
        }
        let service = service
        let currency = defaultCurrency
        let generation = cacheGeneration
        let task = Task { [weak self] in
            do {
                let page = try await service.owedSummary(currency: currency)
                self?.summary = page.items
                self?.summaryTotals = page.summary
                self?.summaryError = nil
                self?.summaryFetchedAt = self?.cacheGeneration == generation ? self?.now() : nil
            } catch is CancellationError {
                return
            } catch {
                self?.summaryError = APIError.wrapping(error)
                self?.summaryFetchedAt = nil
            }
        }
        summaryInFlight = task
        await task.value
        if summaryInFlight == task { summaryInFlight = nil }
    }

    /// `totalOwed`: `summary.remaining`, converted on the server; the card shows above zero.
    public var totalOutstanding: Decimal { summaryTotals?.remaining ?? 0 }

    /// `unconvertedCount`: open splits left out of the total, shown with `owesPage.fxUnavailable`.
    public var unconvertedCount: Int { summaryTotals?.unconvertedCount ?? 0 }

    /// The total card shows while there is an amount or a split left out.
    public var showsTotalCard: Bool { totalOutstanding > 0 || unconvertedCount > 0 }

    /// `owesPage.fromPerson` / `owesPage.fromPeople`.
    public func peopleLabel() -> String {
        let count = summary?.count ?? 0
        return strings.t(count == 1 ? "owesPage.fromPerson" : "owesPage.fromPeople", ["n": String(count)])
    }

    /// A person row's subtitle: the count, Paid and Total.
    public func personSubtitle(_ item: OpenAPI.SplitOwed) -> String {
        let count = strings.t(
            item.splitCount == 1 ? "owesPage.split" : "owesPage.splits", ["n": String(item.splitCount)])
        let paid = strings.t("owesPage.paid", ["amount": money(item.totalPaid)])
        let total = strings.t("owesPage.totalLabel", ["amount": money(item.totalOwed)])
        return "\(count) · \(paid) · \(total)"
    }

    /// The repayment progress, 0 to 1.
    public nonisolated static func progress(paid: Decimal, of total: Decimal) -> Double {
        guard total > 0 else { return 0 }
        let ratio = NSDecimalNumber(decimal: paid / total).doubleValue
        return min(max(ratio, 0), 1)
    }

    /// `formatCurrency(amount, defaultCurrency, locale, decimals)`.
    public func money(_ amount: Decimal, currency: CurrencyCode? = nil) -> String {
        VisionFormat.currency(
            amount, code: (currency ?? defaultCurrency), locale: settings.numberFormat.locale,
            fractionDigits: settings.showDecimalPlaces)
    }

    // MARK: Person detail

    /// A person row: the detail opens.
    public func open(_ item: OpenAPI.SplitOwed) async {
        let next = OwesPerson(id: item.recipientId, name: item.recipientName)
        if person != next {
            person = next
            splits = nil
            splitsError = nil
            splitsFetchedAt = nil
            resetRecent()
        }
        await loadSplits()
    }

    /// Back: the person list.
    public func back() {
        person = nil
        splits = nil
        splitsError = nil
        payment = nil
        confirmation = nil
        resetRecent()
    }

    public var isLoadingSplits: Bool { person != nil && splits == nil && splitsError == nil }

    /// `useOwedByRecipient`, shared per person like the summary.
    public func loadSplits(force: Bool = false) async {
        guard let person else { return }
        let id = person.id
        if let splitsInFlight, splitsInFlight.id == id {
            await splitsInFlight.task.value
            if !force { return }
        }
        if !force, splits != nil, splitsError == nil, let splitsFetchedAt,
            now().timeIntervalSince(splitsFetchedAt) < Self.staleAfter
        {
            return
        }
        let service = service
        let currency = defaultCurrency
        let generation = cacheGeneration
        let task = Task { [weak self] in
            do {
                let page = try await service.owed(recipientId: id, currency: currency)
                guard self?.person?.id == id else { return }
                self?.splits = page.items
                self?.splitsTotals = page.summary
                self?.splitsError = nil
                self?.splitsFetchedAt = self?.cacheGeneration == generation ? self?.now() : nil
            } catch is CancellationError {
                return
            } catch {
                guard self?.person?.id == id else { return }
                self?.splitsError = APIError.wrapping(error)
                self?.splitsFetchedAt = nil
            }
        }
        splitsInFlight = (id, task)
        await task.value
        if splitsInFlight?.task == task { splitsInFlight = nil }
    }

    /// The person's total outstanding: `summary.remaining` of the detail read.
    public var personOutstanding: Decimal { splitsTotals?.remaining ?? 0 }

    /// The split's own currency: its transaction's, else the default currency.
    public func currency(of split: OpenAPI.SplitOwedDetail) -> CurrencyCode {
        split.transactionCurrency
    }

    /// The split row's title: "payee - memo", else `owesPage.transaction`.
    public func title(_ split: OpenAPI.SplitOwedDetail) -> String {
        let parts = [split.transactionRecipientName, split.transactionMemo].compactMap { part in
            part.flatMap { $0.isEmpty ? nil : $0 }
        }
        return parts.isEmpty ? strings.t("owesPage.transaction") : parts.joined(separator: " - ")
    }

    /// The split's date in the app format.
    public func dateText(_ split: OpenAPI.SplitOwedDetail) -> String {
        VisionFormat.appDate(split.transactionDate, format: settings.dateFormat)
    }

    /// `owesPage.original` with the note.
    public func originalText(_ split: OpenAPI.SplitOwedDetail) -> String {
        let absolute = split.transactionAmount < 0 ? -split.transactionAmount : split.transactionAmount
        var text = strings.t("owesPage.original", ["amount": money(absolute, currency: currency(of: split))])
        if let note = split.note, !note.isEmpty { text += " · \(note)" }
        return text
    }

    /// `/transactions?transaction_id=<id>&filter_label=<label>`.
    public nonisolated static func transactionLink(_ id: TransactionID, label: String) -> String {
        NativeRoute(
            path: TransactionsRoutes.path,
            query: [
                URLQueryItem(name: "transaction_id", value: String(id.rawValue)),
                URLQueryItem(name: "filter_label", value: label),
            ]
        ).string
    }

    /// The title link, the Recent transactions description link.
    public func openTransaction(_ id: TransactionID, label: String) {
        guard isVisible else { return }
        shell?.navigate(to: Self.transactionLink(id, label: label))
    }

    // MARK: Record payment

    /// Record payment: prefilled with the remaining amount.
    public func openPayment(_ split: OpenAPI.SplitOwedDetail) {
        payment = OwesPaymentDraft(
            splitId: split.id, remaining: split.remaining, currency: currency(of: split),
            amountText: LocaleNumber.editable(split.remaining, format: settings.numberFormat))
    }

    /// Typing clears the error.
    public func setPaymentAmount(_ text: String) {
        payment?.amountText = text
        payment?.invalid = false
    }

    public func closePayment() {
        payment = nil
    }

    /// The dialog's submit: an amount above zero, then `POST /api/splits/:id/pay`.
    public func submitPayment() async {
        guard let draft = payment, !isRecording else { return }
        let amount = LocaleNumber.parseOrZero(draft.amountText, format: settings.numberFormat)
        guard amount > 0 else {
            payment?.invalid = true
            return
        }
        isRecording = true
        defer { isRecording = false }
        do {
            try await service.recordPayment(splitId: draft.splitId, amount: amount)
            if payment?.splitId == draft.splitId { payment = nil }
            post(.success, "splits.paymentRecorded")
            await refreshSplits()
        } catch {
            post(.error, "splits.paymentFailed", detail: errorText(error))
        }
    }

    // MARK: Settle and delete

    /// Mark as settled.
    public func settle(_ splitId: SplitID) async {
        guard !settlePending else { return }
        settlePending = true
        defer { settlePending = false }
        do {
            try await service.settle(splitId: splitId)
            post(.success, "splits.settled")
            await refreshSplits()
        } catch {
            post(.error, "splits.settledFailed", detail: errorText(error))
        }
    }

    /// Settle all: asks first.
    public func requestSettleAll() {
        guard let splits, !splits.isEmpty else { return }
        confirmation = .settleAll(
            count: splits.count, amount: personOutstanding, unconvertedCount: splitsTotals?.unconvertedCount ?? 0)
    }

    /// Delete split: asks first.
    public func requestDeleteSplit(_ splitId: SplitID) {
        confirmation = .deleteSplit(splitId)
    }

    public func cancelConfirmation() {
        confirmation = nil
    }

    /// The alert's title and message.
    public func confirmationText() -> (title: String, message: String, action: String)? {
        switch confirmation {
        case .settleAll(let count, let amount, let unconvertedCount):
            let description = strings.t(
                "owesPage.settleAll.confirmDescription", ["count": String(count), "amount": money(amount)])
            return (
                strings.t("owesPage.settleAll.confirmTitle"),
                unconvertedCount > 0
                    ? "\(description) \(strings.tc("owesPage.fxUnavailable", unconvertedCount))" : description,
                strings.t("owesPage.settleAll.confirmAction")
            )
        case .deleteSplit:
            return (
                strings.t("owesPage.deleteSplitConfirmTitle"), strings.t("owesPage.deleteSplitConfirmDescription"),
                strings.t("common.delete")
            )
        case nil:
            return nil
        }
    }

    /// The alert's confirm button.
    public func confirm() async {
        guard let confirmation else { return }
        self.confirmation = nil
        switch confirmation {
        case .settleAll:
            await settleAll()
        case .deleteSplit(let id):
            await deleteSplit(id)
        }
    }

    private func settleAll() async {
        guard let person, !isSettlingAll else { return }
        isSettlingAll = true
        defer { isSettlingAll = false }
        do {
            let settled = try await service.settleAll(recipientId: person.id)
            post(.success, "splits.allSettled", ["n": String(settled)])
            await refreshSplits()
        } catch {
            post(.error, "splits.allSettledFailed", detail: errorText(error))
        }
    }

    private func deleteSplit(_ id: SplitID) async {
        deletePending = true
        defer { deletePending = false }
        do {
            try await service.deleteSplit(id: id)
            post(.success, "splits.removed")
            await refreshSplits()
        } catch {
            post(.error, "splits.removeFailed", detail: errorText(error))
        }
    }

    /// `invalidateQueries(splitKeys.all)`.
    private func refreshSplits() async {
        await loadSplits(force: true)
        await loadSummary(force: true)
    }

    // MARK: Export

    /// `owed_<name>_<today>.csv`: the name without characters other than letters, digits,
    /// spaces and hyphens, whitespace runs as `_`, lowercased, at most 64 characters.
    public nonisolated static func exportFileName(_ name: String, today: PlannedDay) -> String {
        var safe = name.replacingOccurrences(of: "[^a-zA-Z0-9\\s-]", with: "", options: .regularExpression)
        safe = safe.replacingOccurrences(of: "\\s+", with: "_", options: .regularExpression)
        safe = String(safe.lowercased().prefix(64))
        return "owed_\(safe)_\(today.ymd).csv"
    }

    /// Export CSV through the Save panel.
    public func exportCsv() async {
        guard let person, !(splits ?? []).isEmpty, !isExporting else { return }
        isExporting = true
        defer { isExporting = false }
        do {
            let data = try await service.exportOwedCsv(recipientId: person.id)
            let name = Self.exportFileName(person.name, today: PlannedDay(now(), calendar: calendar))
            if try await save(data, name) {
                post(.success, "owesPage.export.success")
            }
        } catch is CancellationError {
            return
        } catch {
            post(.error, "owesPage.export.failed", detail: errorText(error))
        }
    }

    // MARK: Recent transactions

    private func resetRecent() {
        recentVersion += 1
        recent = []
        recentTotal = 0
        recentOffset = 0
        recentLoaded = false
        isFetchingMoreRecent = false
        recentQuery = LocalTableQuery()
        recentInFlight = nil
    }

    /// More pages exist on the server.
    public var recentHasMore: Bool { recentOffset < recentTotal }

    /// The first page, once per person; a second caller awaits the first.
    public func loadRecent(force: Bool = false) async {
        guard let person else { return }
        let id = person.id
        if let recentInFlight, recentInFlight.id == id {
            await recentInFlight.task.value
            if !force { return }
        }
        if !force, recentLoaded { return }
        let version = recentVersion
        let service = service
        let task = Task { [weak self] in
            guard
                let page = try? await service.recipientTransactions(
                    groupId: RecipientGroupID(rawValue: id.rawValue), offset: 0, limit: OwesModel.recentPageSize)
            else {
                if self?.recentVersion == version { self?.recentLoaded = true }
                return
            }
            guard let self, self.recentVersion == version else { return }
            self.recent = page.items
            self.recentTotal = page.total
            self.recentOffset = page.items.count
            self.recentLoaded = true
        }
        recentInFlight = (id, task)
        await task.value
        if recentInFlight?.task == task { recentInFlight = nil }
    }

    /// `loadMore`: the next page after the loaded rows.
    public func loadMoreRecent() async {
        guard let person, recentLoaded, !isFetchingMoreRecent, recentHasMore else { return }
        isFetchingMoreRecent = true
        let version = recentVersion
        defer { if recentVersion == version { isFetchingMoreRecent = false } }
        guard
            let page = try? await service.recipientTransactions(
                groupId: RecipientGroupID(rawValue: person.id.rawValue), offset: recentOffset, limit: Self.recentPageSize),
            recentVersion == version
        else { return }
        let existing = Set(recent.map(\.id))
        recent += page.items.filter { !existing.contains($0.id) }
        recentOffset += page.items.count
        recentTotal = page.total
    }

    /// A row was drawn: near the end of the loaded rows, the next page loads.
    public func recentRowAppeared(_ id: TransactionID) async {
        let shown = recentRows
        guard let index = shown.firstIndex(where: { $0.id == id }) else { return }
        if index >= shown.count - 3 { await loadMoreRecent() }
    }

    /// The loaded rows as the table shows them.
    public var recentAllRows: [OwesRecentRow] {
        let transaction = strings.t("owesPage.transaction")
        let uncategorized = strings.t("txPage.field.uncategorized")
        return recent.map { item in
            OwesRecentRow(
                id: item.id, date: item.transactionDate.description,
                description: item.memo.flatMap { $0.isEmpty ? nil : $0 } ?? transaction,
                category: item.categoryName.flatMap { $0.isEmpty ? nil : $0 } ?? uncategorized,
                amount: item.amount,
                currency: item.currency ?? defaultCurrency,
                bankAccount: item.bankAccount.flatMap { $0.isEmpty ? nil : $0 } ?? "—")
        }
    }

    /// The rows after the search, column filters and sort.
    public var recentRows: [OwesRecentRow] {
        recentQuery.apply(recentAllRows, keys: OwesRecentRow.keys) { row, key in row.rawValue(key) }
    }

    public func recentFilterValues(_ key: String) -> [String] {
        LocalTableQuery.uniqueValues(recentAllRows, key: key) { row, key in row.rawValue(key) }
    }

    // MARK: Toasts

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }

    private func post(
        _ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:], detail: String? = nil
    ) {
        notice = notices.make(kind, key, variables, detail: detail)
    }

    private func errorText(_ error: any Error) -> String {
        APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }
}

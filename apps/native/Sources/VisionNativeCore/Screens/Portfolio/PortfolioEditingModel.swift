import Foundation
import Observation

public enum PortfolioEditingPresentation: String, Sendable { case investment, transaction }
public enum PortfolioEditingConfirmation: Equatable, Sendable {
    case archive(PortfolioInvestment)
    case deleteInvestment(PortfolioInvestment, titleKey: String, descriptionKey: String)
    case deleteTransaction(PortfolioTransaction)
}

@MainActor @Observable
public final class PortfolioEditingModel {
    public var investmentDraft: PortfolioInvestmentDraft?
    public var tradeDraft: PortfolioTradeDraft?
    public private(set) var presentation: PortfolioEditingPresentation?
    public var confirmation: PortfolioEditingConfirmation?
    public private(set) var isSaving = false
    public private(set) var isMutating = false
    public private(set) var error: String?
    public private(set) var issue: PortfolioFormIssue?
    public private(set) var notice: ScreenNotice?
    public private(set) var providers = PortfolioPriceProvider.fallback
    public private(set) var brokers: [OpenAPI.Account] = []
    public private(set) var brokersError: String?
    public private(set) var brokersLoading = false
    public private(set) var brokerHistoryLoading = false
    public private(set) var brokerHistoryError: String?
    public private(set) var retagReceipt: OpenAPI.PortfolioBrokerRetagReceipt?
    public var settings = NativeAppSettings.defaults
    /// Humanizes failures (`apiErrorToMessage`) for the toasts of mutations without a `strings` argument.
    public var strings: any Localizing = DictionaryStrings(language: .en, table: [:])
    public var hasUnsavedChanges: Bool {
        (investmentDraft?.isEditing == true && investmentDraft != investmentBaseline) || tradeDraft != tradeBaseline
    }
    @ObservationIgnored private let service: any PortfolioEditingService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var onChanged: (@MainActor () async -> Void)?
    private var transactions: [PortfolioTransaction] = []
    @ObservationIgnored private var allInvestmentIds: [InvestmentID] = []
    @ObservationIgnored private var bulkTransactions: [PortfolioTransaction] = []
    @ObservationIgnored private var selectedHistories: [InvestmentID: [PortfolioTransaction]] = [:]
    @ObservationIgnored private var brokerHistoryFetchedAt: Date?
    @ObservationIgnored private var brokerHistoryRevision = UUID()
    @ObservationIgnored private var brokerHistoryTask: Task<Void, Never>?
    @ObservationIgnored private var optionsTask: Task<Void, Never>?
    @ObservationIgnored private var investmentBaseline: PortfolioInvestmentDraft?
    @ObservationIgnored private var tradeBaseline: PortfolioTradeDraft?
    @ObservationIgnored private var createdInvestmentId: InvestmentID?
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var loadedProviders = false
    @ObservationIgnored private var retagKeys: [String: String] = [:]

    public init(service: any PortfolioEditingService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public func configure(settings: NativeAppSettings, strings: (any Localizing)? = nil) {
        self.settings = settings
        if let strings { self.strings = strings }
    }
    public func bindChanged(_ action: @escaping @MainActor () async -> Void) { onChanged = action }
    public func bindInvestments(_ value: [PortfolioInvestment]) {
        let ids = value.map(\.id).sorted()
        guard ids != allInvestmentIds else { return }
        allInvestmentIds = ids
        invalidateBrokerHistory()
    }
    public func bindTransactions(_ value: [PortfolioTransaction], investmentId: InvestmentID? = nil) {
        if let investmentId {
            selectedHistories[investmentId] = value
        } else {
            for (id, rows) in Dictionary(grouping: value, by: \.investmentId) { selectedHistories[id] = rows }
        }
        rebuildBrokerHistory()
    }
    public func invalidateBrokerHistory() {
        brokerHistoryRevision = UUID()
        brokerHistoryTask?.cancel()
        brokerHistoryTask = nil
        brokerHistoryFetchedAt = nil
        bulkTransactions = []
        selectedHistories = [:]
        transactions = []
        brokerHistoryLoading = false
        brokerHistoryError = nil
    }
    private func rebuildBrokerHistory() {
        transactions =
            bulkTransactions.filter { selectedHistories[$0.investmentId] == nil }
            + selectedHistories.values.flatMap { $0 }
    }
    public func beginAddInvestment(allowedAssetClasses: [OpenAPI.AssetClass] = PortfolioAssetKinds.all) {
        guard !isSaving, !isMutating else { return }
        investmentDraft = .init(settings: settings, today: today, allowedAssetClasses: allowedAssetClasses)
        investmentBaseline = investmentDraft
        createdInvestmentId = nil
        open(.investment)
    }
    public func beginEditInvestment(investment: PortfolioInvestment) {
        guard investment.isActive, !isSaving, !isMutating else { return }
        if investmentDraft?.investmentId != investment.id || investmentDraft == investmentBaseline {
            investmentDraft = .init(investment: investment, settings: settings)
            investmentBaseline = investmentDraft
        }
        createdInvestmentId = nil
        open(.investment)
    }
    public func beginAddTransaction(investment: PortfolioInvestment, bookingCurrency: CurrencyCode) {
        guard investment.isActive, !isSaving, !isMutating else { return }
        if tradeDraft?.transactionId != nil || tradeDraft?.investment.id != investment.id || tradeDraft == tradeBaseline
        {
            tradeDraft = .init(investment: investment, bookingCurrency: bookingCurrency, today: today)
            tradeBaseline = tradeDraft
        }
        open(.transaction)
    }
    public func beginEditTransaction(investment: PortfolioInvestment, transaction: PortfolioTransaction) {
        guard investment.isActive, transaction.investmentId == investment.id, !isSaving, !isMutating else { return }
        if tradeDraft?.transactionId != transaction.id || tradeDraft == tradeBaseline {
            tradeDraft = .init(investment: investment, transaction: transaction, settings: settings)
            tradeBaseline = tradeDraft
        }
        open(.transaction)
    }
    public func dismissEditor() {
        guard !isSaving else { return }
        if investmentDraft?.isEditing == false && presentation == .investment {
            investmentDraft = nil
            investmentBaseline = nil
            createdInvestmentId = nil
        }
        presentation = nil
        issue = nil
        error = nil
    }
    public func cancelEditor() {
        guard !isSaving else { return }
        if presentation == .investment { investmentDraft = investmentBaseline }
        if presentation == .transaction { tradeDraft = tradeBaseline }
        dismissEditor()
    }
    public func discardDrafts() {
        guard !isSaving else { return }
        presentation = nil
        investmentDraft = nil
        tradeDraft = nil
        investmentBaseline = nil
        tradeBaseline = nil
        createdInvestmentId = nil
        issue = nil
        error = nil
    }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    public func clearIssue() { issue = nil }
    private func open(_ value: PortfolioEditingPresentation) {
        presentation = value
        issue = nil
        error = nil
    }
    private var today: String { PlannedDates.day(now(), calendar: .current).ymd }
    public var defaultBrokerId: AccountID? {
        preferredBrokerId(investmentId: presentation == .transaction ? tradeDraft?.investment.id : nil)
    }
    public func preferredBrokerId(investmentId: InvestmentID?) -> AccountID? {
        guard !brokersLoading, brokersError == nil, !brokerHistoryLoading, brokerHistoryError == nil,
            allInvestmentIds.isEmpty || brokerHistoryFetchedAt != nil
        else { return nil }
        let active = Set(brokers.map(\.id))
        func latest(_ predicate: (PortfolioTransaction) -> Bool) -> AccountID? {
            transactions.filter { $0.accountId.map { active.contains($0) } == true && predicate($0) }
                .max { lhs, rhs in
                    if lhs.date != rhs.date { return lhs.date < rhs.date }
                    if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
                    return lhs.id < rhs.id
                }?.accountId
        }
        if let investmentId, let instrument = latest({ $0.investmentId == investmentId }) { return instrument }
        return latest { $0.importBatchId == nil }
    }
    public func loadOptions() async {
        if let optionsTask {
            await optionsTask.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.loadOptionsNow()
        }
        optionsTask = task
        await task.value
        optionsTask = nil
    }
    private func loadOptionsNow() async {
        brokersLoading = true
        defer { brokersLoading = false }
        async let history: Void = loadBrokerHistory()
        if !loadedProviders {
            do {
                let values = try await service.portfolioPriceProviders()
                if !values.isEmpty { providers = values }
                loadedProviders = true
            } catch {
                // The fallback catalog keeps the form usable while the catalog is unavailable.
            }
        }
        do {
            brokers = AccountKinds.activeBrokers(try await service.portfolioEditingAccounts())
            brokersError = nil
        } catch { brokersError = error.localizedDescription }
        await history
    }
    public func loadBrokerHistory(force: Bool = false) async {
        if !force, let date = brokerHistoryFetchedAt, now().timeIntervalSince(date) < 120 { return }
        if let brokerHistoryTask {
            await brokerHistoryTask.value
            return
        }
        let token = UUID()
        brokerHistoryRevision = token
        brokerHistoryLoading = true
        let ids = allInvestmentIds
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let values = ids.isEmpty ? [] : try await service.portfolioEditingTransactions(investmentIds: ids)
                guard token == brokerHistoryRevision, !Task.isCancelled else { return }
                guard values.allSatisfy({ ids.contains($0.investmentId) }) else {
                    throw APIError.invalidRequest("Unexpected investment in broker history")
                }
                bulkTransactions = values
                rebuildBrokerHistory()
                brokerHistoryError = nil
                brokerHistoryFetchedAt = now()
            } catch {
                guard token == brokerHistoryRevision, !Task.isCancelled else { return }
                brokerHistoryError = error.localizedDescription
                brokerHistoryFetchedAt = nil
                bulkTransactions = []
                rebuildBrokerHistory()
            }
        }
        brokerHistoryTask = task
        await task.value
        guard token == brokerHistoryRevision else { return }
        brokerHistoryTask = nil
        brokerHistoryLoading = false
    }
    @discardableResult public func saveEditor(strings: any Localizing) async -> Bool {
        guard !isSaving, !isMutating else { return false }
        isSaving = true
        error = nil
        issue = nil
        defer { isSaving = false }
        // The web hook that failed names the toast (`useInvestments` `onError`).
        var failureKey = "common.error"
        do {
            switch presentation {
            case .investment:
                guard let draft = investmentDraft else { return false }
                let body = try draft.payload(format: settings.numberFormat)
                var purchase = try draft.initialPurchase(format: settings.numberFormat, defaultBroker: defaultBrokerId)
                if purchase != nil { purchase?.fields["note"] = .string(strings.t("addInv.initialPurchaseNote")) }
                if let id = draft.investmentId {
                    failureKey = "portfolio.updateInvestmentFailedTitle"
                    _ = try await service.portfolioUpdateInvestment(id: id, payload: body)
                    post("invEdit.toast.updated", ["name": draft.name.trimmingCharacters(in: .whitespacesAndNewlines)])
                } else {
                    if createdInvestmentId == nil {
                        failureKey = "portfolio.createInvestmentFailedTitle"
                        createdInvestmentId = try await service.portfolioCreateInvestment(body).id
                    }
                    if let id = createdInvestmentId, let purchase {
                        failureKey = "portfolio.recordTxnFailedTitle"
                        _ = try await service.portfolioCreateTransaction(investmentId: id, payload: purchase)
                    }
                    post(
                        "addInv.toast.added",
                        [
                            "name": draft.name,
                            "assetClass": strings.t("portfolio.assetClass." + (draft.assetClass?.rawValue ?? "")),
                        ])
                }
                investmentDraft = nil
                investmentBaseline = nil
                createdInvestmentId = nil
            case .transaction:
                guard let draft = tradeDraft else { return false }
                let body = try draft.payload(format: settings.numberFormat, defaultBroker: defaultBrokerId)
                failureKey = "portfolio.recordTxnFailedTitle"
                if let id = draft.transactionId {
                    _ = try await service.portfolioUpdateTransaction(id: id, payload: body)
                } else {
                    _ = try await service.portfolioCreateTransaction(investmentId: draft.investment.id, payload: body)
                }
                post(
                    draft.isEditing ? "txnEdit.toast.updated" : "addPortTxn.toast.recorded",
                    ["type": strings.t("portfolio.txnType." + draft.type.rawValue), "name": draft.investment.name])
                tradeDraft = nil
                tradeBaseline = nil
            case nil: return false
            }
            presentation = nil
            invalidateBrokerHistory()
            await onChanged?()
            return true
        } catch let value as PortfolioFormIssue {
            issue = value
            return false
        } catch {
            let text = Self.message(error, strings: strings)
            self.error = text
            notice = notices.make(.error, failureKey, detail: text)
            return false
        }
    }
    public func confirmArchive(investment: PortfolioInvestment) {
        guard investment.isActive else { return }
        confirmation = .archive(investment)
    }
    public func confirmDeleteInvestment(
        investment: PortfolioInvestment, titleKey: String = "portfolio.deleteInvestment",
        descriptionKey: String = "portfolio.deleteInvestmentDesc"
    ) { confirmation = .deleteInvestment(investment, titleKey: titleKey, descriptionKey: descriptionKey) }
    public func confirmDeleteTransaction(transaction: PortfolioTransaction) {
        confirmation = .deleteTransaction(transaction)
    }
    public func performConfirmation(_ confirmed: PortfolioEditingConfirmation? = nil) async {
        let value = confirmed ?? confirmation
        confirmation = nil
        switch value {
        case .archive(let investment): _ = await archiveInvestment(id: investment.id)
        case .deleteInvestment(let investment, _, _): _ = await deleteInvestment(id: investment.id)
        case .deleteTransaction(let transaction): _ = await deleteTransaction(id: transaction.id)
        case nil: break
        }
    }
    @discardableResult public func archiveInvestment(id: InvestmentID) async -> Bool {
        await mutation(key: nil, failureKey: "portfolio.updateInvestmentFailedTitle") {
            _ = try await service.portfolioUpdateInvestment(id: id, payload: .init(["is_active": .bool(false)]))
        }
    }
    @discardableResult public func restoreInvestment(id: InvestmentID) async -> Bool {
        await mutation(key: nil, failureKey: "portfolio.updateInvestmentFailedTitle") {
            _ = try await service.portfolioUpdateInvestment(id: id, payload: .init(["is_active": .bool(true)]))
        }
    }
    @discardableResult public func deleteInvestment(id: InvestmentID) async -> Bool {
        await mutation(key: nil, failureKey: "portfolio.deleteInvestmentFailedTitle") {
            try await service.portfolioDeleteInvestment(id: id)
        }
    }
    @discardableResult public func deleteTransaction(id: PortfolioTransactionID) async -> Bool {
        await mutation(key: nil, failureKey: "portfolio.deleteTxnFailedTitle") {
            try await service.portfolioDeleteTransaction(id: id)
        }
    }
    @discardableResult public func setTicker(id: InvestmentID, visible: Bool) async -> Bool {
        await mutation(key: nil, failureKey: "portfolio.updateInvestmentFailedTitle") {
            _ = try await service.portfolioUpdateInvestment(id: id, payload: .init(["show_in_ticker": .bool(visible)]))
        }
    }
    /// The exposure card reports a failed import inline (`error`), without a toast.
    @discardableResult public func importExposure(data: Data) async -> Bool {
        await mutation(key: nil, failureKey: nil) { try await service.portfolioImportExposure(data) }
    }
    /// `failureKey` titles the error toast over the humanized detail; `nil` reports only `error`.
    private func mutation(key: String?, failureKey: String?, operation: () async throws -> Void) async -> Bool {
        guard !isMutating, !isSaving else { return false }
        isMutating = true
        error = nil
        defer { isMutating = false }
        do {
            try await operation()
            if let key { post(key) }
            invalidateBrokerHistory()
            await onChanged?()
            return true
        } catch {
            let text = Self.message(error, strings: strings)
            self.error = text
            if let failureKey { notice = notices.make(.error, failureKey, detail: text) }
            return false
        }
    }
    /// `apiErrorToMessage`.
    static func message(_ error: any Error, strings: any Localizing) -> String {
        APIErrorMessage.text(APIError.wrapping(error), strings: strings)
    }
    /// The caller supplies a reviewed complete history; never assign a partial page.
    @discardableResult public func assignUnassignedLots(
        investmentId: InvestmentID, completeHistory: [PortfolioTransaction], historyComplete: Bool, brokerId: AccountID
    ) async -> Bool {
        let ids = Self.unassignedLotIds(investmentId: investmentId, history: completeHistory)
        guard historyComplete, !brokersLoading, brokersError == nil, !ids.isEmpty, ids.count <= 500,
            Set(ids).count == ids.count,
            brokers.contains(where: { $0.id == brokerId })
        else { return false }
        let fingerprint = ids.map { String($0.rawValue) }.joined(separator: ",") + "|\(brokerId.rawValue)"
        if retagKeys[fingerprint] == nil { retagKeys[fingerprint] = UUID().uuidString }
        let body = PortfolioEditingPayload([
            "transaction_ids": .array(ids.map { .number(Decimal($0.rawValue)) }), "from_account_id": .null,
            "to_account_id": .number(Decimal(brokerId.rawValue)), "idempotency_key": .string(retagKeys[fingerprint]!),
        ])
        return await mutation(key: nil, failureKey: "portfolio.assignLotsFailedTitle") {
            let receipt = try await service.portfolioRetagLots(body)
            retagReceipt = receipt
            retagKeys[fingerprint] = nil
            post("portfolio.assignLotsSuccess", ["count": String(receipt.movedCount)])
        }
    }
    public static func unassignedLotIds(investmentId: InvestmentID, history: [PortfolioTransaction])
        -> [PortfolioTransactionID]
    {
        history.filter {
            $0.investmentId == investmentId && $0.accountId == nil
                && PortfolioAssetKinds.lotTransactionTypes.contains($0.type)
        }.map(\.id).sorted()
    }
    private func post(_ key: String, _ variables: [String: String] = [:]) {
        notice = notices.make(.success, key, variables)
    }
}

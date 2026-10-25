import Foundation
import Observation

@MainActor @Observable
public final class PortfolioImportReviewModel {
    public private(set) var batchId: PortfolioImportBatchNumericID?
    public private(set) var preview: PortfolioImportPreview?
    public private(set) var investments: [PortfolioInvestment] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public var selectedRepairBrokerId: AccountID?
    public private(set) var isLoading = false
    public private(set) var isBusy = false
    public private(set) var busyGroup: String?
    public private(set) var error: String?
    public private(set) var notice: String?
    public private(set) var commitResult: PortfolioImportCommitResult?
    public private(set) var outcomeUncertain = false
    public var didMutate: (@MainActor () async -> Void)?
    public var groups: [PortfolioImportPreviewGroup] { preview?.groups ?? [] }
    public var matchedCount: Int { (preview?.totals["symbol"] ?? 0) + (preview?.totals["name_exact"] ?? 0) }
    public var unresolvedCount: Int { (preview?.totals["unresolved"] ?? 0) + (preview?.totals["error"] ?? 0) }
    public var tradeCount: Int { groups.filter { !$0.isCash }.reduce(0) { $0 + $1.rowCount } }
    public var brokerAccounts: [OpenAPI.Account] { portfolioImportBrokerAccounts(accounts) }
    public var requiresAccountRepair: Bool { preview?.requiresAccountRepair ?? false }
    public var routingAccountName: String? {
        brokerAccounts.first { $0.id == selectedRepairBrokerId }.map { $0.displayName ?? $0.name }
            ?? preview?.accountName
    }
    public var canCommit: Bool {
        preview != nil && error == nil && !isBusy && !isLoading && !outcomeUncertain
            && (!requiresAccountRepair || brokerAccounts.contains { $0.id == selectedRepairBrokerId })
    }
    @ObservationIgnored private let service: any PortfolioImportService
    @ObservationIgnored private var revision = UUID()
    public init(service: any PortfolioImportService) { self.service = service }
    public static func parseBatchId(_ raw: String) -> PortfolioImportBatchNumericID? {
        guard raw.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil, let id = Int(raw),
            id <= 9_007_199_254_740_991
        else { return nil }
        return PortfolioImportBatchNumericID(id)
    }
    public func load(batchId: PortfolioImportBatchNumericID, force: Bool = false) async {
        guard batchId.rawValue > 0, batchId.rawValue <= 9_007_199_254_740_991 else {
            invalidate()
            error = "Invalid portfolio import batch identifier"
            return
        }
        if self.batchId == batchId, !force, preview != nil, error == nil { return }
        let generation = UUID()
        revision = generation
        if self.batchId != batchId {
            preview = nil
            selectedRepairBrokerId = nil
            commitResult = nil
            outcomeUncertain = false
        }
        self.batchId = batchId
        isLoading = true
        error = nil
        defer { if generation == revision { isLoading = false } }
        do {
            async let preview = service.importPreview(batchId: batchId)
            async let investments = service.importInvestments()
            async let accounts = service.importAccounts()
            let (source, holdings, brokers) = try await (preview, investments, accounts)
            guard generation == revision, !Task.isCancelled else { return }
            self.preview = source
            self.investments = holdings
            self.accounts = brokers
            outcomeUncertain = false
        } catch { if generation == revision { self.error = error.localizedDescription } }
    }
    public func load(rawBatchId: String) async {
        guard let id = Self.parseBatchId(rawBatchId) else {
            invalidate()
            error = "Invalid portfolio import batch identifier"
            return
        }
        await load(batchId: id)
    }
    public func invalidate() {
        revision = UUID()
        preview = nil
        investments = []
        accounts = []
        batchId = nil
        error = nil
        isLoading = false
        commitResult = nil
    }
    public func override(group: PortfolioImportPreviewGroup, investmentId: InvestmentID) async {
        guard investments.contains(where: { $0.id == investmentId && $0.isActive }) else { return }
        await resolve(group: group, investmentId: investmentId, createNew: false)
    }
    public func createNew(group: PortfolioImportPreviewGroup) async {
        await resolve(group: group, investmentId: nil, createNew: true)
    }
    private func resolve(group: PortfolioImportPreviewGroup, investmentId: InvestmentID?, createNew: Bool) async {
        guard !isBusy, !isLoading, error == nil, !outcomeUncertain, let batchId,
            let current = groups.first(where: { $0 == group }), !current.resolvableRowIds.isEmpty
        else { return }
        isBusy = true
        busyGroup = group.id
        error = nil
        notice = nil
        defer {
            isBusy = false
            busyGroup = nil
        }
        do {
            try await service.importOverride(
                batchId: batchId, rowIds: current.resolvableRowIds, investmentId: investmentId, createNew: createNew)
            await load(batchId: batchId, force: true)
            if error == nil && createNew { notice = "portfolioImport.toast.holdingCreated" }
        } catch {
            let failure = error.localizedDescription
            outcomeUncertain = true
            await load(batchId: batchId, force: true)
            self.error = failure
        }
        await didMutate?()
    }
    public func commit() async -> Bool {
        guard canCommit, let batchId else { return false }
        isBusy = true
        error = nil
        notice = nil
        defer { isBusy = false }
        do {
            let result = try await service.importCommit(batchId: batchId, accountId: selectedRepairBrokerId)
            commitResult = result
            preview = nil
            notice = "portfolioImport.toast.importSuccess"
            await didMutate?()
            return true
        } catch {
            let failure = error.localizedDescription
            outcomeUncertain = true
            await load(batchId: batchId, force: true)
            self.error = failure
            await didMutate?()
            return false
        }
    }
}

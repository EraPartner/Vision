import Foundation
import Observation

@MainActor @Observable
public final class PortfolioImportHistoryModel {
    public static let pageSize = 10
    public private(set) var page: PortfolioImportBatchPage?
    public private(set) var offset = 0
    public private(set) var isLoading = false
    public private(set) var isBusy = false
    public private(set) var error: String?
    public private(set) var notice: String?
    public var pendingRollback: PortfolioImportBatch?
    public var disabled = false
    public var beginRollback: (@MainActor () -> Bool)?
    public var didRollback: (@MainActor (PortfolioImportBatchNumericID, Bool) -> Void)?
    public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any PortfolioImportService
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var loadedAt: Date?
    public init(service: any PortfolioImportService) { self.service = service }
    public func invalidate() {
        revision = UUID()
        loadedAt = nil
        page = nil
        isLoading = false
    }
    public func load(offset: Int = 0, force: Bool = false) async {
        guard offset >= 0 else { return }
        if !force, self.offset == offset, page != nil, let loadedAt, Date().timeIntervalSince(loadedAt) < 30 { return }
        let generation = UUID()
        revision = generation
        if self.offset != offset { page = nil }
        self.offset = offset
        isLoading = true
        error = nil
        defer { if generation == revision { isLoading = false } }
        do {
            let page = try await service.importBatches(limit: Self.pageSize, offset: offset)
            guard generation == revision else { return }
            self.page = page
            loadedAt = Date()
        } catch { if generation == revision { self.error = error.localizedDescription } }
    }
    public func rollback(batchId: PortfolioImportBatchNumericID) async {
        guard !disabled, !isBusy, let batch = page?.items.first(where: { $0.id == batchId }), batch.canRollback,
            beginRollback?() != false
        else { return }
        isBusy = true
        error = nil
        notice = nil
        pendingRollback = nil
        defer { isBusy = false }
        do {
            _ = try await service.importRollback(batchId: batchId)
            didRollback?(batchId, false)
            notice = "portfolioImport.session.history.rollbackSuccess"
            await load(offset: offset, force: true)
        } catch {
            let failure = error.localizedDescription
            await load(offset: offset, force: true)
            let confirmedAborted = page?.items.first(where: { $0.id == batchId })?.status == .aborted
            didRollback?(batchId, !confirmedAborted)
            self.error = failure
        }
        await didMutate?()
    }
}

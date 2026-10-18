import Foundation
import Observation

@MainActor @Observable
public final class PortfolioImportScreens {
    public let advanced: PortfolioImportParserModel
    public let session: PortfolioImportSessionModel
    public var staging: PortfolioImportSessionModel { session }
    public let history: PortfolioImportHistoryModel
    public let review: PortfolioImportReviewModel
    public private(set) var requestedReviewBatchId: Int?
    public var isDirty: Bool { advanced.isDirty || session.isDirty }
    public var isBusy: Bool { advanced.isBusy || session.isBusy || history.isBusy || review.isBusy }
    public var didMutate: (@MainActor () async -> Void)?
    public var navigateToReview: (@MainActor (Int) -> Void)?
    public init(
        service: any PortfolioImportService,
        store: any PortfolioImportSessionStore = PortfolioImportMemorySessionStore()
    ) {
        advanced = PortfolioImportParserModel(service: service)
        session = PortfolioImportSessionModel(service: service, store: store)
        history = PortfolioImportHistoryModel(service: service)
        review = PortfolioImportReviewModel(service: service)
        advanced.didImport = { [weak self] outcome in
            guard let self else { return }
            if outcome.requiresReview {
                requestedReviewBatchId = outcome.batchId
                navigateToReview?(outcome.batchId)
            }
        }
        advanced.didMutate = { [weak self] in await self?.serverChanged() }
        session.didMutate = { [weak self] in await self?.serverChanged() }
        review.didMutate = { [weak self] in await self?.serverChanged() }
        history.didMutate = { [weak self] in await self?.serverChanged() }
        history.beginRollback = { [weak session] in session?.beginRollback() ?? false }
        history.didRollback = { [weak session] id, failed in session?.endRollback(batchId: id, failed: failed) }
    }
    public func load(reviewBatchId: String? = nil) async {
        if let reviewBatchId {
            await review.load(rawBatchId: reviewBatchId)
        } else {
            async let advanced: Void = self.advanced.load()
            async let session: Void = self.session.load()
            _ = await (advanced, session)
        }
    }
    public func invalidate() {
        history.invalidate()
        review.invalidate()
        advanced.invalidateReadSources()
        session.invalidateReadSources()
    }
    public func discardDrafts() {
        advanced.discardDrafts()
        session.discardUnstaged()
    }
    private func serverChanged() async {
        history.invalidate()
        await didMutate?()
    }
}

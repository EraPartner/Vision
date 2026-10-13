import Foundation
import Observation

@MainActor @Observable
public final class ResearchWatchlistAddModel {
    public private(set) var isPresented = false
    public private(set) var selected: ResearchWatchlistPrefill?
    public private(set) var draft = ResearchWatchlistAddDraft()
    public private(set) var query = ""
    public private(set) var searchResults: [ResearchSearchItem] = []
    public private(set) var isSearching = false
    public private(set) var quote: ResearchQuote?
    public private(set) var isQuoteLoading = false
    public private(set) var preview: ResearchWatchlistPreview?
    public private(set) var isSubmitting = false
    public private(set) var validationFailed = false
    public private(set) var validationRevision = 0
    public private(set) var error: String?
    public private(set) var notice: ScreenNotice?
    /// Without a backend idempotency key an unacknowledged POST cannot safely be
    /// repeated. Read-back and the mutation callback run before this guard is set.
    public private(set) var hasUncertainCreate = false
    public private(set) var numberFormat: NumberFormat = .eu
    @ObservationIgnored public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private var scope = UUID()
    @ObservationIgnored private var searchRevision = UUID()
    @ObservationIgnored private var previewRevision = UUID()
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var quoteTask: Task<Void, Never>?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var noticeID = 0

    public init(service: any ResearchService) { self.service = service }

    public func begin(prefill: ResearchWatchlistPrefill? = nil, numberFormat: NumberFormat) {
        guard !isSubmitting else { return }
        scope = UUID()
        self.numberFormat = numberFormat
        isPresented = true
        error = nil
        validationFailed = false
        hasUncertainCreate = false
        if let prefill {
            selected = prefill
            draft.assetClass = ResearchWatchlistInput.assetClass(prefill.type)
            if let currency = prefill.currency { draft.currency = currency }
            draft.targetPrice = LocaleNumber.editable(prefill.price, format: numberFormat)
            query = ""
            searchResults = []
            fetchQuote()
        }
    }

    public func close() {
        // A submitted create can still commit after dismissal. Keep the receipt
        // scope alive until its callback/read-back has completed.
        guard !isSubmitting else { return }
        scope = UUID()
        searchRevision = UUID()
        previewRevision = UUID()
        searchTask?.cancel()
        quoteTask?.cancel()
        previewTask?.cancel()
        isPresented = false
        selected = nil
        query = ""
        searchResults = []
        draft.targetPrice = ""
        draft.notes = ""
        quote = nil
        preview = nil
        isSearching = false
        isQuoteLoading = false
        error = nil
        validationFailed = false
        hasUncertainCreate = false
    }

    public func update(_ change: (inout ResearchWatchlistAddDraft) -> Void) {
        guard !isSubmitting else { return }
        change(&draft)
        validationFailed = false
        updatePreview()
    }

    public func updateSearch(_ value: String) {
        guard !isSubmitting else { return }
        query = value
        searchRevision = UUID()
        searchTask?.cancel()
        searchResults = []
        isSearching = false
        guard isPresented, selected == nil, value.count >= 2 else { return }
        let revision = searchRevision
        let scope = scope
        searchTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard let self, self.scope == scope, self.searchRevision == revision else { return }
            await self.search(value, scope: scope, revision: revision)
        }
    }

    private func search(_ value: String, scope: UUID, revision: UUID) async {
        isSearching = true
        defer { if self.scope == scope && searchRevision == revision { isSearching = false } }
        do {
            let result = try await service.marketSearch(query: value)
            guard self.scope == scope, searchRevision == revision, selected == nil, !Task.isCancelled else { return }
            searchResults = result.items
        } catch {
            if self.scope == scope && searchRevision == revision { searchResults = [] }
        }
    }

    public func select(_ item: ResearchSearchItem) {
        guard !isSubmitting, let symbol = item.symbol, !symbol.isEmpty else { return }
        scope = UUID()
        searchRevision = UUID()
        searchTask?.cancel()
        isSearching = false
        selected = ResearchWatchlistPrefill(symbol: symbol, name: item.name ?? symbol, type: item.type)
        draft.assetClass = ResearchWatchlistInput.assetClass(item.type)
        query = ""
        searchResults = []
        error = nil
        fetchQuote()
    }

    public func changeAsset() {
        guard !isSubmitting else { return }
        scope = UUID()
        quoteTask?.cancel()
        previewTask?.cancel()
        selected = nil
        quote = nil
        preview = nil
        isQuoteLoading = false
        // The web Change action retains the typed target, notes and currency.
    }

    private func fetchQuote() {
        quoteTask?.cancel()
        previewTask?.cancel()
        quote = nil
        preview = nil
        guard let selected else { return }
        let scope = scope
        let symbol = selected.symbol
        isQuoteLoading = true
        quoteTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.scope == scope { self.isQuoteLoading = false } }
            let result = try? await self.service.marketQuotes(symbols: [symbol], detail: "basic")
            guard self.scope == scope, self.selected?.symbol == symbol, !Task.isCancelled else { return }
            self.quote = result?.first
            self.updatePreview()
        }
    }

    private func updatePreview() {
        previewRevision = UUID()
        previewTask?.cancel()
        preview = nil
        guard isPresented, selected != nil, let current = quote?.price, current > 0,
            let target = LocaleNumber.parse(draft.targetPrice, format: numberFormat), target > 0
        else { return }
        let revision = previewRevision
        let scope = scope
        previewTask = Task { [weak self] in
            guard let self else { return }
            do {
                let raw = try await self.service.researchPresentation(
                    ResearchWatchlistPresentation.input(target: target, current: current))
                let value = try raw["result"]?.decode(ResearchWatchlistPresentation.self)
                guard self.scope == scope, self.previewRevision == revision, !Task.isCancelled else { return }
                self.preview = value?.preview
            } catch {
                // A missing comparison never prevents saving a valid draft.
            }
        }
    }

    @discardableResult public func submit() async -> Bool {
        guard isPresented, !isSubmitting, !hasUncertainCreate, let selected, !draft.targetPrice.isEmpty else {
            return false
        }
        guard let target = ResearchWatchlistInput.price(draft.targetPrice, format: numberFormat) else {
            validationFailed = true
            validationRevision += 1
            return false
        }
        let scope = scope
        var body: [String: TaxValue] = [
            "name": .string(selected.name), "symbol": .string(selected.symbol),
            "asset_class": .string(draft.assetClass), "target_price": .number(target),
            "currency": .string(draft.currency), "price_provider_id": .string(selected.symbol),
        ]
        if !draft.notes.isEmpty { body["notes"] = .string(draft.notes) }
        if let current = quote?.price, current > 0, !current.isNaN { body["added_price"] = .number(current) }
        isSubmitting = true
        error = nil
        var success = false
        do {
            _ = try await service.researchCreateWatchlist(.object(body))
            success = true
        } catch {
            self.error = error.localizedDescription
            if case APIError.client(let client) = error, (400..<500).contains(client.status) {
                hasUncertainCreate = false
            } else if case APIError.invalidRequest = error {
                hasUncertainCreate = false
            } else {
                hasUncertainCreate = true
            }
        }
        // Read authority after every attempt, including lost acknowledgements.
        _ = try? await service.researchWatchlist()
        if let didMutate { await didMutate() }
        isSubmitting = false
        guard self.scope == scope else { return false }
        noticeID += 1
        notice = ScreenNotice(
            id: noticeID, kind: success ? .success : .error,
            key: success ? "addWatchlist.success" : "addWatchlist.error",
            detail: success ? nil : error)
        if success { close() }
        return success
    }

    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
}

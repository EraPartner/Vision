import Foundation
import Observation

/// Confirmation state is bound to a single instrument. Closing keeps the same-context draft.
@MainActor @Observable public final class ResearchMarketMappingModel {
    public var isPresented = false
    public private(set) var instrumentKey = ""
    public private(set) var displayName = ""
    public private(set) var investmentId: InvestmentID?
    public private(set) var existing: [ResearchMapping] = []
    public private(set) var proposals: [ResearchMappingProposal] = []
    public var selected: [String: Bool] = [:]
    public private(set) var audit: ResearchMappingAuditData?
    public private(set) var isLoading = false
    public private(set) var isResolving = false
    public private(set) var isSaving = false
    public private(set) var isAuditing = false
    public private(set) var resolveError: String?
    public private(set) var noticeKey: String?
    public var pendingRemoval: ResearchMapping?
    public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var hasResolved = false
    public init(service: any ResearchService, cache: ResearchReadCache? = nil) {
        self.service = service
        self.cache = cache ?? ResearchReadCache()
    }
    public var selectedCount: Int { proposals.filter { $0.isConfirmable && selected[$0.provider] == true }.count }
    private var cacheKey: String { "lookup-mapping:" + instrumentKey }
    public func configure(instrumentKey: String, displayName: String, investmentId: InvestmentID?) {
        if self.instrumentKey != instrumentKey || self.investmentId != investmentId {
            revision = UUID()
            self.instrumentKey = instrumentKey
            self.investmentId = investmentId
            existing = []
            proposals = []
            selected = [:]
            audit = nil
            hasResolved = false
            resolveError = nil
            noticeKey = nil
            pendingRemoval = nil
            isLoading = false
            isResolving = false
            isSaving = false
            isAuditing = false
        }
        self.displayName = displayName
    }
    public func begin() async {
        guard !instrumentKey.isEmpty else { return }
        isPresented = true
        async let stored: Void = loadExisting()
        if !hasResolved { await resolve() }
        await stored
    }
    public func close() { isPresented = false }
    public func reset() {
        configure(instrumentKey: "", displayName: "", investmentId: nil)
        close()
    }
    public func loadExisting(force: Bool = false) async {
        let stamp = revision
        let key = instrumentKey
        let service = service
        isLoading = true
        defer { if stamp == revision { isLoading = false } }
        do {
            let result: ResearchSnapshot<ResearchMappingsData> = try await cache.request(
                key: cacheKey, freshFor: 60, force: force
            ) {
                try await service.researchMappings(instrumentKey: key, keyType: "internal")
            }
            if stamp == revision { existing = result.data.items }
        } catch { if stamp == revision { existing = [] } }
    }
    private var scope: [String: TaxValue] {
        ["instrument_key": .string(instrumentKey), "key_type": .string("internal")]
    }
    public func resolve() async {
        guard !instrumentKey.isEmpty, !isResolving else { return }
        let stamp = revision
        var body = scope
        body["query"] = .string(instrumentKey)
        if let investmentId { body["investment_id"] = .number(Decimal(investmentId.rawValue)) }
        isResolving = true
        resolveError = nil
        defer { if stamp == revision { isResolving = false } }
        do {
            let value = try await service.researchResolveMappings(.object(body))
            guard stamp == revision else { return }
            proposals = value.data.proposals
            hasResolved = true
            selected = Dictionary(
                proposals.filter(\.isConfirmable).map { ($0.provider, true) }, uniquingKeysWith: { _, new in new })
        } catch { if stamp == revision { resolveError = error.localizedDescription } }
    }
    public func save() async {
        guard selectedCount > 0, !isSaving, !isResolving else { return }
        let stamp = revision
        var body = scope
        body["mappings"] = .array(
            proposals.filter { $0.isConfirmable && selected[$0.provider] == true }.map { proposal in
                var item: [String: TaxValue] = [
                    "provider": .string(proposal.provider), "providerSymbol": .string(proposal.providerSymbol!),
                ]
                for key in ["resolvedName", "exchange", "currency"] {
                    if let value = proposal.raw[key] { item[key] = value }
                }
                return .object(item)
            })
        isSaving = true
        defer { if stamp == revision { isSaving = false } }
        do {
            _ = try await service.researchSaveMappings(.object(body))
            cache.invalidate(key: "lookup-mapping:" + (body["instrument_key"]?.stringValue ?? ""))
            await didMutate?()
            guard stamp == revision else { return }
            noticeKey = "research.mapping.saved"
            await loadExisting(force: true)
        } catch { if stamp == revision { noticeKey = "research.mapping.saveError" } }
    }
    public func remove() async {
        guard let row = pendingRemoval else { return }
        let stamp = revision
        let capturedKey = cacheKey
        pendingRemoval = nil
        do {
            try await service.researchDeleteMapping(id: row.id)
            cache.invalidate(key: capturedKey)
            await didMutate?()
            guard stamp == revision else { return }
            noticeKey = "research.mapping.removed"
            await loadExisting(force: true)
        } catch {}
    }
    public func runAudit() async {
        guard !existing.isEmpty, !isAuditing else { return }
        let stamp = revision
        let body = TaxValue.object(scope)
        isAuditing = true
        defer { if stamp == revision { isAuditing = false } }
        do {
            let value = try await service.researchAuditMappings(body)
            guard stamp == revision else { return }
            audit = value.data
            await loadExisting(force: true)
        } catch {}
    }
}

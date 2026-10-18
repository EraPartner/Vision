import Foundation
import Observation

public struct PortfolioImportStatement: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var kind: String?
    public var originalBatchId: Int?
    public var originalSourceName: String?
    public var file: PortfolioImportFile?
    public var detected: PortfolioImportDetected?
    public var accountId: Int?
    public var accountChosenManually = false
    public var adoptPolicy: PortfolioImportReconciliationPolicy?
    public var transferDestinationAccountId: Int?
    public var transferOriginAccountId: Int?
    public var includedSymbols: String?
    public var batchId: Int?
    public var previousBatchIds: [Int] = []
    public var status: String
    public var skipped: Int?
    public var rows: Int?
    public var sourceErrors: Int?
    public var error: String?
    public var progress: ImportProgress?
    enum CodingKeys: String, CodingKey {
        case id, name, kind, originalBatchId, originalSourceName, detected, accountId, adoptPolicy,
            transferDestinationAccountId, transferOriginAccountId, includedSymbols, batchId, previousBatchIds, status,
            skipped, rows, sourceErrors, error
    }
    public init(
        id: String = UUID().uuidString, name: String, file: PortfolioImportFile? = nil, status: String = "detecting"
    ) {
        self.id = id
        self.name = name
        self.file = file
        self.status = status
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        status = try c.decode(String.self, forKey: .status)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        originalBatchId = try c.decodeIfPresent(Int.self, forKey: .originalBatchId)
        originalSourceName = try c.decodeIfPresent(String.self, forKey: .originalSourceName)
        detected = try c.decodeIfPresent(PortfolioImportDetected.self, forKey: .detected)
        accountId = try c.decodeIfPresent(Int.self, forKey: .accountId)
        adoptPolicy = try c.decodeIfPresent(PortfolioImportReconciliationPolicy.self, forKey: .adoptPolicy)
        transferDestinationAccountId = try c.decodeIfPresent(Int.self, forKey: .transferDestinationAccountId)
        transferOriginAccountId = try c.decodeIfPresent(Int.self, forKey: .transferOriginAccountId)
        includedSymbols = try c.decodeIfPresent(String.self, forKey: .includedSymbols)
        batchId = try c.decodeIfPresent(Int.self, forKey: .batchId)
        previousBatchIds = try c.decodeIfPresent([Int].self, forKey: .previousBatchIds) ?? []
        skipped = try c.decodeIfPresent(Int.self, forKey: .skipped)
        rows = try c.decodeIfPresent(Int.self, forKey: .rows)
        sourceErrors = try c.decodeIfPresent(Int.self, forKey: .sourceErrors)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

@MainActor public protocol PortfolioImportSessionStore {
    func read(key: String) async -> Data?
    func write(key: String, data: Data?) async
}

@MainActor public final class PortfolioImportMemorySessionStore: PortfolioImportSessionStore {
    public var values: [String: Data] = [:]
    public init() {}
    public func read(key: String) async -> Data? { values[key] }
    public func write(key: String, data: Data?) async { values[key] = data }
}

@MainActor public final class PortfolioImportClosureSessionStore: PortfolioImportSessionStore {
    private let reader: @MainActor (String) async -> Data?
    private let writer: @MainActor (String, Data?) async -> Void
    public init(
        read: @escaping @MainActor (String) async -> Data?, write: @escaping @MainActor (String, Data?) async -> Void
    ) {
        reader = read
        writer = write
    }
    public func read(key: String) async -> Data? { await reader(key) }
    public func write(key: String, data: Data?) async { await writer(key, data) }
}

@MainActor @Observable
public final class PortfolioImportSessionModel {
    public private(set) var statements: [PortfolioImportStatement] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var policy = "auto"
    public private(set) var reconciliationMode: PortfolioImportReconciliationMode = .full
    public private(set) var operation = "idle"
    public private(set) var plan: PortfolioImportReconciliationPlan?
    public private(set) var result: PortfolioImportReconciliationResult?
    public private(set) var error: String?
    public private(set) var stopped = false
    public private(set) var existingBatches: PortfolioImportBatchPage?
    public private(set) var existingLoading = false
    public private(set) var outcomeUncertain = false
    public private(set) var isRestoring = true
    public var existingBatchId = ""
    public var shownActions = 50
    public var didMutate: (@MainActor () async -> Void)?
    public var brokerAccounts: [OpenAPI.Account] { portfolioImportBrokerAccounts(accounts) }
    public var locked: Bool { isRestoring || ["staging", "commit", "rollback"].contains(operation) }
    public var isBusy: Bool { isRestoring || operation != "idle" }
    public var isDirty: Bool { statements.contains { !["staged", "completed"].contains($0.status) } }
    public var ids: [Int] { statements.filter { $0.status == "staged" }.compactMap(\.batchId).sorted() }
    public var allStaged: Bool { !statements.isEmpty && statements.allSatisfy { $0.status == "staged" } }
    public var kinesisOnly: Bool {
        !statements.isEmpty
            && statements.allSatisfy {
                $0.kind == nil && $0.detected?.source == "kinesis"
                    && ($0.includedSymbols ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
    }
    public var attachmentEligible: Bool { kinesisOnly && statements.allSatisfy { $0.adoptPolicy != .preferSource } }
    public var correctionEligible: Bool {
        (kinesisOnly
            || (!statements.isEmpty
                && statements.allSatisfy {
                    $0.kind == nil && $0.detected?.source == "ibkr" && $0.detected?.presetKey == "ibkr_funding_history"
                        && ($0.includedSymbols ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }))
            && statements.allSatisfy { $0.adoptPolicy != .preserveExisting }
    }
    public var existingOnly: Bool { reconciliationMode != .full }
    public var cashFundingConfirmed: Bool { cashConfirmedSourceKey == routingKey }
    public var scopeValid: Bool {
        switch reconciliationMode {
        case .full: true
        case .adoptExistingOnly, .recordInKindIncomeOnly: attachmentEligible && policy == "preserve_existing"
        case .correctExistingOnly: correctionEligible && policy == "prefer_source"
        case .recordCashOnly: attachmentEligible && policy == "preserve_existing" && cashFundingConfirmed
        }
    }
    public var scope: PortfolioImportReconciliationScope {
        .init(
            batchIds: ids, adoptPolicy: PortfolioImportReconciliationPolicy(rawValue: policy),
            batchPolicies: statements.filter { $0.status == "staged" && $0.adoptPolicy != nil }.map {
                .init(batchId: $0.batchId!, adoptPolicy: $0.adoptPolicy!)
            }.sorted { $0.batchId < $1.batchId }, reconciliationScope: reconciliationMode,
            cashFundingPolicy: reconciliationMode == .recordCashOnly && cashFundingConfirmed
                ? "own_account_transfer" : nil)
    }
    public var canStage: Bool {
        !outcomeUncertain && scopeValid && !statements.isEmpty && statements.contains { $0.status != "staged" }
            && statements.allSatisfy { item in
                item.status == "staged"
                    || (item.file != nil && item.detected != nil
                        && brokerAccounts.contains { account in account.id == item.accountId }
                        && item.status != "detecting")
            }
    }
    public var canPreview: Bool { !outcomeUncertain && allStaged && scopeValid && operation == "idle" }
    public var canCommit: Bool {
        guard scopeValid, allStaged, operation == "idle", !outcomeUncertain, reviewKey == scopeKey, let plan else {
            return false
        }
        let allowed = Set([
            "record_income", "insert", "adopt", "repair_duplicate", "duplicate", "duplicate_source", "cash", "transfer",
            "internal_annotation", "adjustment", "settled",
        ])
        return plan.ready && plan.blockers.isEmpty && plan.actions.allSatisfy { allowed.contains($0.action) }
    }
    public var eligibleExistingBatches: [PortfolioImportBatch] {
        existingBatches?.items.filter { batch in
            batch.isRetainedIbkr && batch.canRollback
                && brokerAccounts.contains { account in account.id == batch.accountId }
                && !statements.contains { item in item.batchId == batch.id || item.originalBatchId == batch.id }
        } ?? []
    }
    @ObservationIgnored private let service: any PortfolioImportService
    @ObservationIgnored private let store: any PortfolioImportSessionStore
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var existingRevision = UUID()
    @ObservationIgnored private var reviewKey: String?
    @ObservationIgnored private var cashConfirmedSourceKey: String?
    @ObservationIgnored private var stopRequested = false
    @ObservationIgnored private var discardPending = false
    @ObservationIgnored private var accountRevision = UUID()
    public static let sessionKey = "vision.portfolio-import.latest-session.v1"
    public static let settingsKey = "vision.portfolio-import.latest-review-settings.v1"
    @ObservationIgnored private var restored = false
    @ObservationIgnored private var restoreWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var checkpointRevision = UUID()
    @ObservationIgnored private var checkpointTask: Task<Void, Never>?
    @ObservationIgnored private var acceptedCommitCount = 0
    @ObservationIgnored private var commitWaiters: [CheckedContinuation<Void, Never>] = []
    private struct ReviewSettings: Codable {
        let sourceRoutingKey: String
        let batchIds: [Int]
        let reconciliationMode: PortfolioImportReconciliationMode
        let policy: String
        let cashFundingPolicy: String?
    }
    public init(
        service: any PortfolioImportService,
        store: any PortfolioImportSessionStore = PortfolioImportMemorySessionStore()
    ) {
        self.service = service
        self.store = store
    }
    private func restore() async {
        if restored {
            if isRestoring { await withCheckedContinuation { restoreWaiters.append($0) } }
            return
        }
        restored = true
        defer {
            isRestoring = false
            for waiter in restoreWaiters { waiter.resume() }
            restoreWaiters = []
            if discardPending {
                discardPending = false
                discardUnstaged()
            }
        }
        let generation = revision
        let data = await store.read(key: Self.sessionKey)
        let settings = await store.read(key: Self.settingsKey)
        guard generation == revision, statements.isEmpty else { return }
        if let data, let rows = try? JSONDecoder().decode([PortfolioImportStatement].self, from: data),
            rows.count <= 100,
            rows.allSatisfy({
                $0.status == "staged" && ($0.accountId ?? 0) > 0 && ($0.batchId ?? 0) > 0
                    && ($0.kind == nil || ["reference", "existing"].contains($0.kind!))
                    && [$0.rows, $0.skipped, $0.sourceErrors].compactMap { $0 }.allSatisfy { $0 >= 0 }
            })
        {
            statements = rows
        }
        if let settings, let value = try? JSONDecoder().decode(ReviewSettings.self, from: settings),
            value.sourceRoutingKey == routingKey, value.batchIds == statements.compactMap(\.batchId).sorted(),
            ["auto", "preserve_existing", "prefer_source"].contains(value.policy),
            value.cashFundingPolicy == nil || value.cashFundingPolicy == "own_account_transfer"
        {
            reconciliationMode = value.reconciliationMode
            policy = value.policy
            if value.cashFundingPolicy != nil { cashConfirmedSourceKey = routingKey }
        }
    }
    private var routingKey: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        func json(_ value: TaxValue) -> String {
            (try? String(decoding: encoder.encode(value), as: UTF8.self)) ?? "null"
        }
        let rows = statements.map { item in
            var fields: [(String, TaxValue)] = [("id", .string(item.id)), ("name", .string(item.name))]
            if let kind = item.kind { fields.append(("kind", .string(kind))) }
            if let id = item.originalBatchId { fields.append(("originalBatchId", .number(Decimal(id)))) }
            if let detected = item.detected {
                fields.append(("source", .string(detected.source)))
                if let preset = detected.presetKey { fields.append(("presetKey", .string(preset))) }
                fields.append(("identities", .array(detected.sourceAccountIdentities.map(TaxValue.string))))
            }
            if let account = item.accountId { fields.append(("accountId", .number(Decimal(account)))) }
            if let policy = item.adoptPolicy { fields.append(("adoptPolicy", .string(policy.rawValue))) }
            fields.append(("includedSymbols", .string(item.includedSymbols ?? "")))
            if let id = item.transferDestinationAccountId {
                fields.append(("transferDestinationAccountId", .number(Decimal(id))))
            }
            if let id = item.transferOriginAccountId {
                fields.append(("transferOriginAccountId", .number(Decimal(id))))
            }
            return "{" + fields.map { json(.string($0.0)) + ":" + json($0.1) }.joined(separator: ",") + "}"
        }
        return "[" + rows.joined(separator: ",") + "]"
    }
    private var scopeKey: String {
        routingKey + "|"
            + ((try? String(decoding: APIBody.encode(scope.requestBody()), as: UTF8.self)) ?? "invalid")
    }
    private func persist() {
        let staged = statements.filter { $0.status == "staged" && $0.batchId != nil }
        let session = staged.isEmpty ? nil : try? JSONEncoder().encode(staged)
        let settings: Data?
        if !statements.isEmpty && statements.allSatisfy({ $0.status == "staged" }) {
            settings = try? JSONEncoder().encode(
                ReviewSettings(
                    sourceRoutingKey: routingKey, batchIds: statements.compactMap(\.batchId).sorted(),
                    reconciliationMode: reconciliationMode, policy: policy,
                    cashFundingPolicy: cashFundingConfirmed ? "own_account_transfer" : nil))
        } else {
            settings = nil
        }
        let generation = UUID()
        checkpointRevision = generation
        let previous = checkpointTask
        checkpointTask = Task { [weak self] in
            await previous?.value
            guard let self, generation == checkpointRevision else { return }
            await store.write(key: Self.sessionKey, data: session)
            guard generation == checkpointRevision else { return }
            await store.write(key: Self.settingsKey, data: settings)
        }
    }
    public func flushCheckpoint() async { await checkpointTask?.value }
    /// Normal reload waits for a reviewed commit's receipt/invalidation tail to create
    /// its final checkpoint before storage admission pauses. Restore does not use this.
    public func flushAcceptedCommits() async {
        if acceptedCommitCount > 0 { await withCheckedContinuation { commitWaiters.append($0) } }
        await flushCheckpoint()
    }
    private func invalidate() {
        revision = UUID()
        plan = nil
        result = nil
        reviewKey = nil
        error = nil
        if cashConfirmedSourceKey != routingKey { cashConfirmedSourceKey = nil }
    }
    public func load() async {
        await restore()
        let generation = UUID()
        accountRevision = generation
        do {
            let accounts = try await service.importAccounts()
            guard generation == accountRevision else { return }
            self.accounts = accounts
            for index in statements.indices
            where statements[index].detected != nil && statements[index].batchId == nil
                && !statements[index].accountChosenManually
            { statements[index].accountId = statements[index].detected?.resolveAccount(accounts) }
            persist()
        } catch { if generation == accountRevision { self.error = error.localizedDescription } }
    }
    public func addFiles(_ files: [PortfolioImportFile]) async {
        guard !locked, !files.isEmpty else { return }
        guard statements.count + files.count <= 100 else {
            error = "portfolioImport.session.tooMany"
            return
        }
        invalidate()
        stopped = false
        if statements.allSatisfy({ $0.status == "completed" }) { statements = [] }
        let entries = files.map { PortfolioImportStatement(name: $0.filename, file: $0) }
        statements += entries
        await withTaskGroup(of: (String, Result<PortfolioImportProbe, Error>).self) { group in
            for entry in entries {
                group.addTask {
                    do {
                        return (
                            entry.id,
                            .success(
                                try await self.service.importProbe(file: entry.file!, config: PortfolioImportConfig()))
                        )
                    } catch { return (entry.id, .failure(error)) }
                }
            }
            for await (id, result) in group {
                guard let index = statements.firstIndex(where: { $0.id == id }), statements[index].status == "detecting"
                else { continue }
                switch result {
                case .success(let value):
                    statements[index].detected = value.detected
                    statements[index].accountId = value.detected?.resolveAccount(accounts)
                    statements[index].status = value.detected == nil ? "error" : "ready"
                    statements[index].error = value.detected == nil ? "portfolioImport.session.unsupported" : nil
                case .failure(let failure):
                    statements[index].status = "error"
                    statements[index].error = failure.localizedDescription
                }
            }
        }
        persist()
    }
    private func edit(_ id: String, restage: Bool = false, _ change: (inout PortfolioImportStatement) -> Void) {
        guard !locked, let index = statements.firstIndex(where: { $0.id == id }),
            statements[index].status != "completed"
        else { return }
        if restage && statements[index].file == nil { return }
        if restage {
            if let batch = statements[index].batchId { statements[index].previousBatchIds.append(batch) }
            statements[index].batchId = nil
            statements[index].status = "ready"
            statements[index].rows = nil
            statements[index].sourceErrors = nil
            statements[index].error = nil
        }
        change(&statements[index])
        invalidate()
        persist()
    }
    public func setAccount(id: String, accountId: Int?) {
        edit(id, restage: true) {
            $0.accountId = accountId
            $0.accountChosenManually = true
        }
    }
    public func setSymbols(id: String, symbols: String) {
        guard !existingOnly else { return }
        edit(id, restage: true) { $0.includedSymbols = symbols }
    }
    public func setStatementPolicy(id: String, policy: PortfolioImportReconciliationPolicy?) {
        edit(id) { $0.adoptPolicy = policy }
    }
    public func setTransferAccount(id: String, accountId: Int?) {
        edit(id, restage: true) {
            $0.transferDestinationAccountId = accountId
            if $0.detected?.source == "nexo" { $0.transferOriginAccountId = accountId }
        }
    }
    public func remove(id: String) {
        guard !locked else { return }
        statements.removeAll { $0.id == id }
        invalidate()
        persist()
    }
    public func clear() {
        guard !locked else { return }
        statements = []
        invalidate()
        persist()
    }
    public func setMode(_ mode: PortfolioImportReconciliationMode) {
        guard !locked else { return }
        reconciliationMode = mode
        if mode == .correctExistingOnly {
            policy = "prefer_source"
        } else if mode != .full {
            policy = "preserve_existing"
        }
        invalidate()
        persist()
    }
    public func setPolicy(_ policy: String) {
        guard !locked, ["auto", "preserve_existing", "prefer_source"].contains(policy), !existingOnly else { return }
        self.policy = policy
        invalidate()
        persist()
    }
    public func setCashFundingConfirmed(_ confirmed: Bool) {
        guard !locked else { return }
        invalidate()
        cashConfirmedSourceKey = confirmed ? routingKey : nil
        persist()
    }
    public func loadExistingBatches(offset: Int = 0) async {
        guard !locked else { return }
        let generation = UUID()
        existingRevision = generation
        existingLoading = true
        defer { if existingRevision == generation { existingLoading = false } }
        do {
            let page = try await service.importBatches(limit: 50, offset: offset)
            guard generation == existingRevision else { return }
            existingBatches = page
            existingBatchId = ""
        } catch { if generation == existingRevision { self.error = error.localizedDescription } }
    }
    public func addExistingBatch(_ raw: String? = nil) {
        guard !locked, statements.count < 100, let id = Int(raw ?? existingBatchId),
            let batch = eligibleExistingBatches.first(where: { $0.id == id })
        else { return }
        var item = PortfolioImportStatement(
            id: "existing-\(id)", name: batch.sourceFilename ?? String(id), status: "staged")
        item.kind = "existing"
        item.batchId = id
        item.accountId = batch.accountId
        item.rows = batch.rowsTotal
        item.sourceErrors = batch.rowsError
        statements.append(item)
        existingBatchId = ""
        invalidate()
        persist()
    }
    public func stage() async {
        guard canStage, operation == "idle" else { return }
        invalidate()
        operation = "staging"
        stopped = false
        stopRequested = false
        defer {
            operation = "idle"
            stopped = stopRequested
            if discardPending {
                discardPending = false
                discardUnstaged()
            }
            persist()
        }
        let items = statements
        for item in items {
            if stopRequested { break }
            guard item.kind != "existing", item.status != "staged", let file = item.file, let detected = item.detected
            else { continue }
            guard let index = statements.firstIndex(where: { $0.id == item.id }) else { continue }
            statements[index].status = "staging"
            statements[index].error = nil
            do {
                var config = PortfolioImportConfig.preset(detected.presetKey ?? detected.source)!
                config.accountId = item.accountId
                config.includedSymbols = item.includedSymbols
                config.transferDestinationAccountId = item.transferDestinationAccountId
                config.transferOriginAccountId = item.transferOriginAccountId
                if detected.source == "kinesis" { config.yieldBasisPolicy = "zero" }
                let staged = try await service.importStream(
                    file: file, config: config, adapterName: config.format ?? "portfolio_generic"
                ) { [weak self] progress in await self?.receiveProgress(progress, id: item.id) }
                guard staged.requiresReview, staged.imported == 0, staged.batchId > 0 else {
                    throw PortfolioImportFailure.unverified("portfolioImport.session.stageUnverified")
                }
                statements[index].batchId = staged.batchId
                statements[index].status = "staged"
                statements[index].skipped = staged.skipped
                statements[index].sourceErrors = staged.errors
                persist()
                let evidence = try await service.importPreview(batchId: staged.batchId)
                statements[index].rows = evidence.groups.reduce(0) { $0 + $1.rows.count }
                statements[index].sourceErrors = (evidence.totals["error"] ?? 0) + (evidence.totals["unresolved"] ?? 0)
            } catch {
                statements[index].status = statements[index].batchId == nil ? "error" : "staged"
                statements[index].error = error.localizedDescription
                self.error = "portfolioImport.session.stageFailed"
                stopRequested = true
                if statements[index].batchId == nil {
                    outcomeUncertain = true
                    _ = try? await service.importBatches(limit: 50, offset: 0)
                }
            }
        }
        await didMutate?()
    }
    private func receiveProgress(_ progress: ImportProgress, id: String) {
        if let index = statements.firstIndex(where: { $0.id == id }) { statements[index].progress = progress }
    }
    public func stop() { if operation == "staging" { stopRequested = true } }
    public func discardUnstaged() {
        if isRestoring {
            discardPending = true
            return
        }
        if operation == "staging" {
            stopRequested = true
            discardPending = true
            return
        }
        statements.removeAll { !["staged", "completed"].contains($0.status) }
        for index in statements.indices { statements[index].file = nil }
        invalidate()
        persist()
    }
    public func invalidateReadSources() {
        accountRevision = UUID()
        revision = UUID()
        plan = nil
        reviewKey = nil
        Task { [weak self] in await self?.load() }
    }
    public func preview() async {
        guard canPreview else { return }
        let generation = UUID()
        revision = generation
        plan = nil
        error = nil
        operation = "preview"
        let submitted = scope
        let key = scopeKey
        defer { if generation == revision || operation == "preview" { operation = "idle" } }
        do {
            let value = try await service.importReconciliationPreview(scope: submitted)
            guard generation == revision, key == scopeKey else { return }
            plan = value
            reviewKey = key
            shownActions = 50
        } catch { if generation == revision { self.error = error.localizedDescription } }
    }
    public func commit() async {
        guard canCommit, let plan else { return }
        acceptedCommitCount += 1
        operation = "commit"
        error = nil
        let submitted = scope
        defer {
            operation = "idle"
            persist()
            acceptedCommitCount -= 1
            if acceptedCommitCount == 0 {
                let waiters = commitWaiters
                commitWaiters = []
                for waiter in waiters { waiter.resume() }
            }
        }
        do {
            let committed = try await service.importReconciliationCommit(
                scope: submitted, fingerprint: plan.planFingerprint)
            result = committed
            self.plan = nil
            reviewKey = nil
            for index in statements.indices {
                statements[index].status = committed.complete == false ? "staged" : "completed"
            }
            await didMutate?()
        } catch {
            self.plan = nil
            reviewKey = nil
            self.error = error.localizedDescription
            outcomeUncertain = true
            await reconcileUnknownWrite(batchIds: submitted.batchIds)
            await didMutate?()
        }
    }
    private func reconcileUnknownWrite(batchIds: [Int]) async {
        if let page = try? await service.importBatches(limit: 200, offset: 0) { existingBatches = page }
        for batchId in batchIds { _ = try? await service.importPreview(batchId: batchId) }
    }
    public func acknowledgeUncertainOutcome() {
        guard operation == "idle" else { return }
        outcomeUncertain = false
        invalidate()
    }
    public func beginRollback() -> Bool {
        guard !isRestoring, operation == "idle" else { return false }
        operation = "rollback"
        return true
    }
    public func endRollback(batchId: Int?, failed: Bool) {
        if let batchId, !failed {
            statements.removeAll { $0.batchId == batchId || $0.originalBatchId == batchId }
            invalidate()
            persist()
        }
        existingBatches = nil
        existingBatchId = ""
        operation = "idle"
    }
}

public typealias PortfolioImportStagingModel = PortfolioImportSessionModel

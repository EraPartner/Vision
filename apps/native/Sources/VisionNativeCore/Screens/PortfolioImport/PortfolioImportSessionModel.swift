import Foundation
import Observation

public struct PortfolioImportStatement: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
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
    /// A checkpoint from before ADR-236 marked reference and existing-history entries with a `kind`.
    /// The web client drops them on restore, and so does the native session.
    public private(set) var isLegacyKind = false
    enum CodingKeys: String, CodingKey {
        case id, name, detected, accountId, adoptPolicy, transferDestinationAccountId, transferOriginAccountId,
            includedSymbols, batchId, previousBatchIds, status, skipped, rows, sourceErrors, error
    }
    enum LegacyKeys: String, CodingKey { case kind }
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
        let legacy = try decoder.container(keyedBy: LegacyKeys.self)
        isLegacyKind = legacy.contains(.kind)
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
    /// The outcomes a reviewed session may commit. `blocked`, `policy_required` and any outcome this
    /// build does not know keep the commit disabled, like the web client.
    public static let committableActions: Set<String> = [
        "insert", "adopt", "duplicate", "duplicate_source", "cash", "transfer", "internal_annotation", "adjustment",
        "settled",
    ]
    /// Blockers the owner settles per row with "Keep both".
    public static let choosableBlockers: Set<String> = [
        "existing_assigned_or_imported_history", "ambiguous_history", "cross_format_identity_missing",
        "cross_format_identity_ambiguous", "funding_date_mismatch", "funding_date_ambiguous",
    ]
    /// Of those, the ones with a single counterpart that "Same transaction" can name.
    public static let sameTransactionBlockers: Set<String> = [
        "existing_assigned_or_imported_history", "cross_format_identity_missing", "funding_date_mismatch",
    ]
    public private(set) var statements: [PortfolioImportStatement] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var policy = "auto"
    public private(set) var rowChoices: [PortfolioImportRowChoice] = []
    public private(set) var operation = "idle"
    public private(set) var plan: PortfolioImportReconciliationPlan?
    public private(set) var result: PortfolioImportReconciliationResult?
    public private(set) var error: String?
    public private(set) var stopped = false
    public private(set) var outcomeUncertain = false
    public private(set) var isRestoring = true
    public var shownActions = 50
    public var didMutate: (@MainActor () async -> Void)?
    public var brokerAccounts: [OpenAPI.Account] { portfolioImportBrokerAccounts(accounts) }
    public var locked: Bool { isRestoring || ["staging", "commit", "rollback"].contains(operation) }
    public var isBusy: Bool { isRestoring || operation != "idle" }
    public var isDirty: Bool { statements.contains { !["staged", "completed"].contains($0.status) } }
    public var ids: [Int] { statements.filter { $0.status == "staged" }.compactMap(\.batchId).sorted() }
    public var allStaged: Bool { !statements.isEmpty && statements.allSatisfy { $0.status == "staged" } }
    /// The reviewed scope: the staged batches, the session policy, the per-statement policies and
    /// the owner's row answers for those batches.
    public var scope: PortfolioImportReconciliationScope {
        let staged = ids
        var overrides: [PortfolioImportReconciliationBatchPolicy] = []
        for item in statements where item.status == "staged" {
            if let batchId = item.batchId, let adoptPolicy = item.adoptPolicy {
                overrides.append(.init(batchId: batchId, adoptPolicy: adoptPolicy))
            }
        }
        return PortfolioImportReconciliationScope(
            batchIds: staged, adoptPolicy: PortfolioImportReconciliationPolicy(rawValue: policy),
            batchPolicies: overrides.sorted { $0.batchId < $1.batchId },
            rowChoices: rowChoices.filter { staged.contains($0.batchId) })
    }
    public var canStage: Bool {
        !outcomeUncertain && !statements.isEmpty && statements.contains { $0.status != "staged" }
            && statements.allSatisfy { item in
                item.status == "staged"
                    || (item.file != nil && item.detected != nil
                        && brokerAccounts.contains { account in account.id == item.accountId }
                        && item.status != "detecting")
            }
    }
    public var canPreview: Bool { !outcomeUncertain && allStaged && operation == "idle" }
    public var canCommit: Bool {
        guard allStaged, operation == "idle", !outcomeUncertain, reviewKey == scopeKey, let plan else { return false }
        return plan.ready && plan.blockers.isEmpty
            && plan.actions.allSatisfy { Self.committableActions.contains($0.action) }
    }
    @ObservationIgnored private let service: any PortfolioImportService
    @ObservationIgnored private let store: any PortfolioImportSessionStore
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var reviewKey: String?
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
        let policy: String
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
        if let data, let stored = try? JSONDecoder().decode([PortfolioImportStatement].self, from: data),
            stored.count <= 100,
            stored.allSatisfy({
                $0.status == "staged" && ($0.accountId ?? 0) > 0 && ($0.batchId ?? 0) > 0
                    && [$0.rows, $0.skipped, $0.sourceErrors].compactMap { $0 }.allSatisfy { $0 >= 0 }
            })
        {
            statements = stored.filter { !$0.isLegacyKind }
        }
        if let settings, let value = try? JSONDecoder().decode(ReviewSettings.self, from: settings),
            value.sourceRoutingKey == routingKey, value.batchIds == statements.compactMap(\.batchId).sorted(),
            ["auto", "preserve_existing", "prefer_source"].contains(value.policy)
        {
            policy = value.policy
        }
    }
    /// The statement settings a review depends on; any change to one invalidates the review. The
    /// shape is the web client's `sourceRoutingKey`.
    private var routingKey: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        func json(_ value: TaxValue) -> String {
            (try? String(decoding: encoder.encode(value), as: UTF8.self)) ?? "null"
        }
        let rows = statements.map { item in
            var fields: [(String, TaxValue)] = [("id", .string(item.id)), ("name", .string(item.name))]
            if let detected = item.detected {
                fields.append(("source", .string(detected.source)))
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
        let body = (try? scope.request()).flatMap { try? APIBody.encode($0) }
        return routingKey + "|" + (body.map { String(decoding: $0, as: UTF8.self) } ?? "invalid")
    }
    private func persist() {
        let staged = statements.filter { $0.status == "staged" && $0.batchId != nil }
        let session = staged.isEmpty ? nil : try? JSONEncoder().encode(staged)
        let settings: Data?
        if !statements.isEmpty && statements.allSatisfy({ $0.status == "staged" }) {
            settings = try? JSONEncoder().encode(
                ReviewSettings(
                    sourceRoutingKey: routingKey, batchIds: statements.compactMap(\.batchId).sorted(), policy: policy))
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
    /// Any change to the statements or the policy drops the review, the owner's row answers and the result.
    private func invalidate() {
        revision = UUID()
        rowChoices = []
        plan = nil
        result = nil
        reviewKey = nil
        error = nil
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
    public func setPolicy(_ policy: String) {
        guard !locked, ["auto", "preserve_existing", "prefer_source"].contains(policy) else { return }
        self.policy = policy
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
            guard item.status != "staged", let file = item.file, let detected = item.detected else { continue }
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
    /// Plans the staged scope. A plan that does not echo exactly this scope is never shown.
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
        } catch { if generation == revision { self.error = Self.message(error) } }
    }
    /// Answers a row that resembles a transaction the account already holds, then reviews again.
    public func choose(batchId: Int, rowId: Int, choice: PortfolioImportRowChoice.Choice) async {
        guard !locked, operation == "idle", allStaged, ids.contains(batchId) else { return }
        rowChoices.removeAll { $0.batchId == batchId && $0.rowId == rowId }
        rowChoices.append(PortfolioImportRowChoice(batchId: batchId, rowId: rowId, choice: choice))
        await preview()
    }
    public func commit() async {
        guard canCommit else { return }
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
            let committed = try await service.importReconciliationCommit(scope: submitted)
            result = committed
            self.plan = nil
            reviewKey = nil
            for index in statements.indices {
                statements[index].status = "completed"
                if let batch = committed.batches.first(where: { $0.batchId == statements[index].batchId }) {
                    statements[index].sourceErrors = batch.errors
                }
            }
            await didMutate?()
        } catch {
            self.plan = nil
            reviewKey = nil
            self.error = Self.message(error)
            // A definite rejection (conflict, blocked plan, bad request) retains no change, so the
            // owner can review again. Anything else may have reached the server.
            if !Self.isDefiniteRejection(error) {
                outcomeUncertain = true
                await reconcileUnknownWrite(batchIds: submitted.batchIds)
            }
            await didMutate?()
        }
    }
    /// A plan or receipt that fails verification reads as unverified, like the web client.
    private static func message(_ error: Error) -> String {
        if case .contract? = error as? APIError { return "portfolioImport.session.responseUnverified" }
        return error.localizedDescription
    }
    private static func isDefiniteRejection(_ error: Error) -> Bool {
        guard case .client(let failure)? = error as? APIError else { return false }
        return (400..<500).contains(failure.status)
    }
    private func reconcileUnknownWrite(batchIds: [Int]) async {
        _ = try? await service.importBatches(limit: 200, offset: 0)
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
            statements.removeAll { $0.batchId == batchId }
            invalidate()
            persist()
        }
        operation = "idle"
    }
}

public typealias PortfolioImportStagingModel = PortfolioImportSessionModel

import Foundation
import Synchronization

/// `reconcileTransfers` of `services/transferReconciliationService.ts` (ADR-083) with the
/// repository statements it runs (`transactionRepository.ts`, `transferCandidatesSql.ts`):
/// release auto pairs that no longer match and orphaned legs, then auto-pair every mutually
/// unique outflow and inflow across the whole corpus, so two legs that arrive in separate
/// imports or manual entries pair up. Manual marks are never overwritten. Idempotent.
enum TransferReconciliation {
    /// `DEFAULT_WINDOW_DAYS`.
    static let defaultWindowDays = 3

    /// `openTransferRow(alias)`.
    static func openRow(_ t: String) -> String {
        "\(t).is_active = 1 AND \(t).is_transfer = 0 AND \(t).transfer_source IS NULL AND \(t).account_id IS NOT NULL"
    }

    /// `transferCandidate(a, b, windowDays)`.
    static func candidate(_ a: String, _ b: String, _ windowDays: Int) -> String {
        """
        \(openRow(b)) AND \(b).amount = dec_neg(\(a).amount) \
        AND COALESCE(\(b).currency, 'EUR') = COALESCE(\(a).currency, 'EUR') \
        AND \(b).account_id <> \(a).account_id \
        AND \(b).date BETWEEN add_days(\(a).date, \(-windowDays)) AND add_days(\(a).date, \(windowDays)) \
        AND NOT EXISTS (SELECT 1 FROM transfer_dismissals d \
        WHERE d.txn_a_id = min(\(a).id, \(b).id) AND d.txn_b_id = max(\(a).id, \(b).id))
        """
    }

    /// `candidateCount(a, b, windowDays)`: the candidates, capped at two.
    static func candidateCount(_ a: String, _ b: String, _ windowDays: Int) -> String {
        """
        (SELECT count(*) FROM (SELECT \(b).id FROM transactions \(b) \
        WHERE \(candidate(a, b, windowDays)) LIMIT 2) candidates)
        """
    }

    struct Pair: Hashable {
        let outId: Int  // lint:allow raw-id the pair SQL binds plain transaction row ids
        let inId: Int  // lint:allow raw-id the pair SQL binds plain transaction row ids
    }

    /// `listUniqueTransferPairs`: only mutually unique pairs.
    static func uniquePairs(_ session: BackendSession, windowDays: Int) throws -> [Pair] {
        try session.rows(
            """
            SELECT first_match.out_id AS out_id, b.id AS in_id
            FROM (
              SELECT a.id AS out_id,
                     \(candidateCount("a", "b", windowDays)) AS n,
                     (SELECT min(candidate.id)
                        FROM (SELECT b.id FROM transactions b WHERE \(candidate("a", "b", windowDays)) LIMIT 2) candidate
                     ) AS in_id
              FROM transactions a
              WHERE \(openRow("a")) AND dec_sign(a.amount) < 0
            ) first_match
            JOIN transactions b ON b.id = first_match.in_id
            WHERE first_match.n = 1 AND \(candidateCount("b", "reverse_out", windowDays)) = 1
            """
        ).map { Pair(outId: try $0.integerId("out_id"), inId: try $0.integerId("in_id")) }
    }

    /// `releaseOrphanedTransfers`: reconciler legs whose peer was deleted (the FK set the
    /// peer NULL). System rows (opening anchors, adjustments, trade cash legs) stay.
    static func releaseOrphaned(_ session: BackendSession) throws {
        _ = try session.rows(
            """
            UPDATE transactions SET is_transfer = 0, transfer_source = NULL
             WHERE is_transfer = 1 AND transfer_peer_id IS NULL AND transfer_source IN ('auto', 'manual')
            """)
    }

    /// `releaseInvalidAutoTransferPairs`: pairs whose legs no longer satisfy the match rule (or
    /// no longer point at each other) are released, both legs together, in one transaction.
    static func releaseInvalid(_ session: BackendSession, windowDays: Int) throws {
        let invalid = """
            t.transfer_source IN ('auto', 'manual') AND t.transfer_peer_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM transactions p
               WHERE p.id = t.transfer_peer_id
                 AND p.transfer_peer_id = t.id
                 AND p.transfer_source = t.transfer_source
                 AND dec_sign(p.amount) * dec_sign(t.amount) < 0
                 AND (t.transfer_source = 'manual' OR (
                   p.amount = dec_neg(t.amount)
                   AND COALESCE(p.currency, 'EUR') = COALESCE(t.currency, 'EUR')
                   AND p.date BETWEEN add_days(t.date, \(-windowDays)) AND add_days(t.date, \(windowDays))
                 ))
                 AND p.account_id IS NOT t.account_id
                 AND p.account_id IS NOT NULL AND t.account_id IS NOT NULL
                 AND p.is_active AND t.is_active
            )
            """
        // Batches of 250 until none is left, so a bulk edit that invalidates more pairs than one
        // batch holds releases all of them (Astra report 4, finding 14). Swift only: the
        // TypeScript runs one batch. Each pass releases what it read, or the loop stops.
        while try releaseInvalidBatch(session, invalid) {}
    }

    /// One batch of `releaseInvalid`: true when the batch was full and released rows, so
    /// another may remain.
    private static func releaseInvalidBatch(_ session: BackendSession, _ invalid: String) throws -> Bool {
        try session.transaction {
            let discovered = try session.rows(
                "SELECT t.id, t.transfer_peer_id FROM transactions t WHERE \(invalid) ORDER BY t.id LIMIT 250")
            guard !discovered.isEmpty else { return false }
            var ids = Set<Int>()
            for row in discovered {
                ids.insert(try row.integerId("id"))
                if let peer = try row.optionalInt64("transfer_peer_id") { ids.insert(Int(peer)) }
            }
            let locked = try session.rows(
                "SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
                [.text(JSValue.array(ids.sorted().map { .int($0) }).jsonText)])
            let lockedIds = JSValue.array(try locked.map { .int(try $0.integerId("id")) }).jsonText
            let released = try session.write(
                """
                UPDATE transactions AS t SET is_transfer = 0, transfer_peer_id = NULL, transfer_source = NULL
                 WHERE t.id IN (SELECT value FROM json_each(?))
                   AND t.transfer_peer_id IN (SELECT value FROM json_each(?))
                   AND \(invalid)
                """,
                [.text(lockedIds), .text(lockedIds)])
            return discovered.count == 250 && released > 0
        }
    }

    /// `markAutoTransferLeg`: guarded against a manual mark or an already-paired row.
    static func markAutoLeg(_ session: BackendSession, _ id: Int, peer: Int) throws -> Int {
        try session.rows(
            """
            UPDATE transactions SET is_transfer = 1, transfer_peer_id = ?, transfer_source = 'auto'
             WHERE id = ? AND is_transfer = 0 AND transfer_source IS NULL RETURNING id
            """,
            [.integer(Int64(peer)), .integer(Int64(id))]
        ).count
    }

    /// `revertAutoTransferLeg`: undo a leg just marked when its sibling's guarded mark missed.
    static func revertAutoLeg(_ session: BackendSession, _ id: Int, peer: Int) throws {
        _ = try session.rows(
            """
            UPDATE transactions SET is_transfer = 0, transfer_peer_id = NULL, transfer_source = NULL
             WHERE id = ? AND transfer_peer_id = ? AND transfer_source = 'auto'
            """,
            [.integer(Int64(id)), .integer(Int64(peer))])
    }

    /// `reconcileTransfers`: the number of pairs created.
    @discardableResult
    static func reconcile(_ session: BackendSession, windowDays: Int = defaultWindowDays) throws -> Int {
        try releaseInvalid(session, windowDays: windowDays)
        try releaseOrphaned(session)
        let pairs = try uniquePairs(session, windowDays: windowDays)
        guard !pairs.isEmpty else { return 0 }
        return try session.transaction {
            // The write transaction holds the single writer; the fresh uniqueness read below
            // sees any edit that committed before it.
            let current = Set(try uniquePairs(session, windowDays: windowDays))
            var created = 0
            for pair in pairs where current.contains(pair) {
                let outMarked = try markAutoLeg(session, pair.outId, peer: pair.inId)
                let inMarked = try markAutoLeg(session, pair.inId, peer: pair.outId)
                if outMarked > 0 && inMarked > 0 {
                    created += 1
                } else {
                    // Never commit a one-way transfer: revert the leg that was marked.
                    if outMarked > 0 { try revertAutoLeg(session, pair.outId, peer: pair.inId) }
                    if inMarked > 0 { try revertAutoLeg(session, pair.inId, peer: pair.outId) }
                }
            }
            return created
        }
    }
}

/// The follow-up work the TypeScript services schedule after ledger writes:
/// `scheduleReconcile` (`transferReconciliationService.ts`), `scheduleAggregationRefresh` and
/// `clearForecastMcCaches` (`aggregationRefresh.ts`), and the import pipeline's sequence after
/// a commit (`importPipeline/index.ts`). The materialized-view refresh is the shared
/// `MaterializedViewRefresher`. A failure is swallowed, as Bun logs it and moves on.
final class LedgerFollowUps: Sendable {
    struct Timing: Sendable {
        /// `RECONCILE_DEBOUNCE_MS` and `RECONCILE_MAX_WAIT_MS`.
        var reconcileDebounce: Duration
        var reconcileMaxWait: Duration
        /// `MC_CLEAR_DEBOUNCE_MS`.
        var cacheClearDebounce: Duration

        static let standard = Timing(
            reconcileDebounce: .milliseconds(5000), reconcileMaxWait: .milliseconds(10000),
            cacheClearDebounce: .milliseconds(1000))
    }

    private struct State {
        var reconcileTimer: Task<Void, Never>?
        var reconcileDeadline: ContinuousClock.Instant?
        var cacheTimer: Task<Void, Never>?
    }

    let database: BackendDatabase
    let views: MaterializedViewRefresher
    private let timing: Timing
    private let state = Mutex(State())

    init(database: BackendDatabase, views: MaterializedViewRefresher, timing: Timing = .standard) {
        self.database = database
        self.views = views
        self.timing = timing
    }

    /// `scheduleReconcile`: a trailing debounce (flushed by the burst's deadline) that runs
    /// the reconcile, then the aggregation refresh whether or not the reconcile failed.
    func scheduleReconcile() {
        let now = ContinuousClock.now
        state.withLock { state in
            state.reconcileTimer?.cancel()
            let deadline = state.reconcileDeadline ?? now + timing.reconcileMaxWait
            state.reconcileDeadline = deadline
            let delay = min(timing.reconcileDebounce, max(.zero, deadline - now))
            state.reconcileTimer = Task { [weak self] in
                try? await Task.sleep(for: delay)
                guard let self else { return }
                let fire = self.state.withLock { (state: inout State) -> Bool in
                    if Task.isCancelled { return false }
                    state.reconcileTimer = nil
                    state.reconcileDeadline = nil
                    return true
                }
                guard fire else { return }
                try? await self.database.run { session in try TransferReconciliation.reconcile(session) }
                self.scheduleAggregationRefresh()
            }
        }
    }

    /// `scheduleAggregationRefresh`: the debounced view refresh and, after one second of
    /// quiet, the forecast cache clear.
    func scheduleAggregationRefresh() {
        views.schedule()
        state.withLock { state in
            state.cacheTimer?.cancel()
            state.cacheTimer = Task { [weak self] in
                try? await Task.sleep(for: self?.timing.cacheClearDebounce ?? .zero)
                guard let self else { return }
                let fire = self.state.withLock { (state: inout State) -> Bool in
                    if Task.isCancelled { return false }
                    state.cacheTimer = nil
                    return true
                }
                if fire { try? await self.database.run { session in try Self.clearForecastCaches(session) } }
            }
        }
    }

    /// `clearForecastMcCaches`: both Monte Carlo cache tables emptied. Each clear is
    /// best-effort on its own, as `Promise.all` over two caught deletes.
    static func clearForecastCaches(_ session: BackendSession) throws {
        _ = try? session.rows("DELETE FROM cashflow_forecast_mc")
        _ = try? session.rows("DELETE FROM cashflow_forecast_mc_rolling")
    }

    /// `commitImport`'s tail, run in the request after the batch is stamped complete: the
    /// reconcile over the whole corpus (non-fatal), the forecast cache clear when rows were
    /// imported, then one coalesced view refresh.
    static func afterImportCommit(_ session: BackendSession, imported: Int, views: MaterializedViewRefresher) {
        _ = try? TransferReconciliation.reconcile(session)
        if imported > 0 { try? clearForecastCaches(session) }
        views.schedule()
    }

    /// The rollback route's tail: cache clear and view refresh when anything was removed.
    static func afterImportRollback(_ session: BackendSession, changed: Bool, views: MaterializedViewRefresher) {
        guard changed else { return }
        try? clearForecastCaches(session)
        views.schedule()
    }
}

import Foundation
import VisionNativeCore

/// `POST /api/transactions/transfers` (`markTransfer`): the client's sticky manual pairing of
/// `transferReconciliationService.markTransfer` — the graph lock, the real-invariant validation
/// and the two-leg write, in one write transaction. The unmark and suggestion routes of the
/// TypeScript module stay on Bun: the client calls only this operation (ADR-270 decision 2).
enum TransfersArea {
    // MARK: - Register

    static func register(_ backend: inout InProcessBackend, database: BackendDatabase) {
        backend.serve(OpenAPIOperations.MarkTransfer.self) { request in
            try await database.run { session in try TransfersArea.mark(session, request: request) }
        }
    }

    // MARK: - Request input

    /// `transferPairBodySchema`: two strict ids — `validateId` with its own accept set — and the
    /// schema answers any failure with the one combined message.
    static func pair(_ request: InProcessRequest) throws -> (TransactionID, TransactionID) {
        let body = try RequestBody.parseJavaScript(request.body)
        var raw = JSObject()
        if case .object(let object)? = body {
            raw = object
        }
        guard
            let a = TransactionsArea.validId(raw["aId"]),
            let b = TransactionsArea.validId(raw["bId"]),
            a != b
        else {
            throw BackendHTTPError.validation(
                "aId and bId must be two distinct transaction ids")
        }
        return (TransactionID(rawValue: a), TransactionID(rawValue: b))
    }

    // MARK: - The mark

    /// One leg as `lockTransferGraphForMark` reads it.
    struct Leg: Sendable {
        let id: Int
        let amount: String
        // lint:allow raw-id the leg carries the row's account id as a plain integer
        let accountId: Int?
        let isActive: Bool
        let transferSource: String?
        // lint:allow raw-id the leg carries the row's peer id as a plain integer
        let transferPeerId: Int?

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            amount = try row.text("amount")
            accountId = try row.optionalInt64("account_id").map { Int($0) }
            isActive = try row.optionalBool("is_active") ?? false
            transferSource = try row.optionalText("transfer_source")
            transferPeerId = try row.optionalInt64("transfer_peer_id").map { Int($0) }
        }
    }

    /// The graph discovery, read in id order: the requested pair, the peers that point at them
    /// and the rows they point at.
    static func discoverGraph(_ session: BackendSession, _ ids: String) throws -> [Leg] {
        try session.rows(
            """
            SELECT id, amount, account_id, is_active, transfer_source, transfer_peer_id
            FROM transactions
            WHERE id IN (SELECT value FROM json_each(?))
               OR transfer_peer_id IN (SELECT value FROM json_each(?))
               OR id IN (SELECT transfer_peer_id FROM transactions
                         WHERE id IN (SELECT value FROM json_each(?)))
            ORDER BY id LIMIT 501
            """, [.text(ids), .text(ids), .text(ids)]).map { try Leg($0) }
    }

    /// `lockTransferGraphForMark`: discover, re-read the known set, discover again, and refuse
    /// when anything moved inside this transaction — the writer connection is the lock, so the
    /// two reads must agree exactly.
    static func lockGraph(_ session: BackendSession, ids: [Int]) throws -> [Leg] {
        let idsText = JSValue.array(ids.map { .int($0) }).jsonText
        let before = try discoverGraph(session, idsText)
        if before.count > 500 {
            throw BackendHTTPError.conflict(
                "Transfer graph is too large; review its links before retrying")
        }
        let locked = try session.rows(
            """
            SELECT id, amount, account_id, is_active, transfer_source, transfer_peer_id
            FROM transactions
            WHERE id IN (SELECT value FROM json_each(?))
            ORDER BY id
            """, [.text(JSValue.array(before.map { .int($0.id) }).jsonText)]).map { try Leg($0) }
        let after = try discoverGraph(session, idsText)
        func signature(_ legs: [Leg]) -> String {
            JSValue.array(legs.map {
                .array([
                    .int($0.id),
                    $0.transferPeerId.map { .int($0) } ?? .null,
                    $0.transferSource.map { JSValue.string($0) } ?? .null,
                ])
            }).jsonText
        }
        if signature(before) != signature(locked) || signature(before) != signature(after) {
            throw BackendHTTPError.conflict("Transfer pairing changed; reload and retry")
        }
        return locked
    }

    /// `markTransfer` and its write transaction.
    static func mark(_ session: BackendSession, request: InProcessRequest) throws -> HandlerResult {
        let (aId, bId) = try pair(request)
        try session.transaction {
            let legs = try lockGraph(session, ids: [aId.rawValue, bId.rawValue])
            guard let a = legs.first(where: { $0.id == aId.rawValue }),
                let b = legs.first(where: { $0.id == bId.rawValue })
            else {
                throw BackendHTTPError.notFound("Both transactions must exist to mark a transfer")
            }
            for leg in [a, b]
            where leg.transferSource != nil && leg.transferSource != ""
                && leg.transferSource != "auto" && leg.transferSource != "manual"
            {
                throw BackendHTTPError.validation(
                    "System-owned transactions must be corrected through their original workflow")
            }
            if !a.isActive || !b.isActive {
                throw BackendHTTPError.validation(
                    "Both transactions must be active to mark a transfer")
            }
            if a.accountId == nil || b.accountId == nil || a.accountId == b.accountId {
                throw BackendHTTPError.validation(
                    "A transfer must link two different accounts")
            }
            let aAmount = Double(a.amount) ?? .nan
            let bAmount = Double(b.amount) ?? .nan
            if !((aAmount < 0 && bAmount > 0) || (aAmount > 0 && bAmount < 0)) {
                throw BackendHTTPError.validation(
                    "A transfer needs one outflow and one inflow (opposite signs)")
            }

            // `releaseTransferPeersOf`: a prior counterpart goes back to open, not dismissed.
            let pairText = JSValue.array([.int(aId.rawValue), .int(bId.rawValue)]).jsonText
            let lockedText = JSValue.array(legs.map { .int($0.id) }).jsonText
            _ = try session.rows(
                """
                UPDATE transactions
                SET is_transfer = 0, transfer_peer_id = NULL, transfer_source = NULL
                WHERE transfer_peer_id IN (SELECT value FROM json_each(?))
                  AND id NOT IN (SELECT value FROM json_each(?))
                  AND transfer_source IN ('auto', 'manual')
                  AND id IN (SELECT value FROM json_each(?))
                """, [.text(pairText), .text(pairText), .text(lockedText)])
            // `markManualTransferLeg`, both legs — the caller released every prior peer.
            for (id, peer) in [(aId.rawValue, bId.rawValue), (bId.rawValue, aId.rawValue)] {
                _ = try session.rows(
                    """
                    UPDATE transactions
                    SET is_transfer = 1, transfer_peer_id = ?, transfer_source = 'manual'
                    WHERE id = ? AND (transfer_source IS NULL OR transfer_source IN ('auto', 'manual'))
                    """, [.integer(Int64(peer)), .integer(Int64(id))])
            }
        }
        return HandlerResult(data: .object(["ok": .bool(true)]))
    }
}

import Foundation

/// `packaging/electron/audit-viewer.ts`: the read range, the snapshot checks the shell
/// applies before the renderer sees a page, and the JSON export.
public enum AuditViewer {
    /// `MAX_PAGE_SIZE`.
    public static let maximumPageSize = 500
    /// `MAX_EXPORT_BYTES`.
    public static let maximumExportBytes = 2_000_000

    public struct ReadRange: Equatable, Sendable {
        public var afterSequence: Int
        public var limit: Int

        public init(afterSequence: Int, limit: Int) {
            self.afterSequence = afterSequence
            self.limit = limit
        }
    }

    public struct ViewerError: Error, Equatable, Sendable, LocalizedError {
        public let message: String

        public init(_ message: String) {
            self.message = message
        }

        public var errorDescription: String? { message }
    }

    private static func isSequence(_ value: JSONValue?) -> Int? {
        guard let number = AuditJSON.safeInteger(value), number >= 0 else { return nil }
        return number
    }

    /// `validateReadOptions`. An absent (`null`) argument is `{}`: the page script passes
    /// `undefined` as `null`.
    public static func validateReadOptions(_ options: JSONValue?) throws -> ReadRange {
        let value = options ?? .object([:])
        guard let fields = value.objectValue,
            fields.keys.allSatisfy({ $0 == "afterSequence" || $0 == "limit" })
        else {
            throw ViewerError("Invalid audit read options")
        }
        func orDefault(_ field: JSONValue?, _ fallback: Int) -> JSONValue {
            guard let field, field != .null else { return .int(fallback) }
            return field
        }
        guard let afterSequence = isSequence(orDefault(fields["afterSequence"], 0)),
            let limit = AuditJSON.safeInteger(orDefault(fields["limit"], 100)), limit >= 1, limit <= maximumPageSize
        else {
            throw ViewerError("Invalid audit read range")
        }
        return ReadRange(afterSequence: afterSequence, limit: limit)
    }

    /// `isVerification`.
    static func isVerification(_ value: JSONValue?) -> Bool {
        guard let value, value.objectValue != nil,
            let status = value["status"]?.stringValue, status == "verified" || status == "partially_verified",
            let sequence = isSequence(value["sequence"]), AuditJSON.isHash(value["hash"]),
            let anchored = isSequence(value["anchoredThrough"]), anchored <= sequence
        else {
            return false
        }
        if let raw = value["retentionThrough"] {
            guard let retention = isSequence(raw), retention >= 1, retention < anchored else { return false }
        }
        if let raw = value["enrollmentSequence"] {
            guard let enrollment = isSequence(raw), enrollment <= anchored else { return false }
        }
        return true
    }

    /// `isEntry`.
    static func isEntry(_ entry: JSONValue, expectedSequence: Int, verification: JSONValue) -> Bool {
        guard entry.objectValue != nil, entry["sequence"]?.intValue == expectedSequence,
            let head = verification["sequence"]?.intValue, expectedSequence <= head,
            AuditJSON.isHash(entry["previousHash"]), AuditJSON.isHash(entry["hash"]),
            AuditJSON.safeInteger(entry["version"]) != nil, entry["payload"]?.objectValue != nil,
            entry["createdAt"]?.stringValue != nil, let anchored = verification["anchoredThrough"]?.intValue
        else {
            return false
        }
        return entry["anchorStatus"]?.stringValue == (expectedSequence <= anchored ? "anchored" : "pending_anchor")
    }

    /// `validateSnapshot`: a complete, contiguous page that reaches the verified head.
    public static func validateSnapshot(_ raw: JSONValue, range: ReadRange) throws -> JSONValue {
        guard raw.objectValue != nil else { throw ViewerError("Audit snapshot is unavailable") }
        guard let verification = raw["verification"], isVerification(verification),
            let entries = raw["entries"]?.arrayValue, entries.count <= range.limit,
            let hasMore = raw["hasMore"]?.boolValue
        else {
            throw ViewerError("Audit history cannot be verified")
        }
        let head = verification["sequence"]?.intValue ?? 0
        if verification["status"]?.stringValue == "verified", verification["anchoredThrough"]?.intValue != head {
            throw ViewerError("Audit status disagrees with anchored prefix")
        }
        var previous = max(range.afterSequence, verification["retentionThrough"]?.intValue ?? 0)
        for entry in entries {
            guard isEntry(entry, expectedSequence: previous + 1, verification: verification) else {
                throw ViewerError("Audit entry is malformed")
            }
            previous += 1
        }
        if hasMore && (entries.isEmpty || previous >= head) { throw ViewerError("Audit page is incomplete") }
        if !hasMore && previous != head { throw ViewerError("Audit page does not reach the verified head") }
        return .object(["verification": verification, "entries": .array(entries), "hasMore": .bool(hasMore)])
    }

    /// `buildExport`: the whole history as `vision-audit-view-v1` JSON (two-space indent and
    /// a trailing newline). Nested keys are sorted; Electron keeps the backend's order.
    public static func buildExport(_ snapshot: JSONValue, now: Date = Date()) throws -> String {
        let verification = snapshot["verification"] ?? .null
        let entries = snapshot["entries"]?.arrayValue ?? []
        let retention = verification["retentionThrough"]?.intValue
        let head = verification["sequence"]?.intValue ?? 0
        if snapshot["hasMore"] == .bool(true) || entries.count != head - (retention ?? 0) {
            throw ViewerError("Audit history exceeds the 500 entry export limit")
        }
        var warning = ""
        if let retention, retention != 0 {
            warning += "Entries through sequence \(retention) were pruned under the one-year retention policy. "
        }
        warning +=
            verification["enrollmentSequence"] == nil
            ? "This export is a snapshot verified against this installation's local receipt and Keychain checkpoint. It is not a signed report or remote attestation."
            : "This export is checked against this installation's receipt and Keychain checkpoint. Entries through the enrollment baseline were accepted at enrollment; their earlier authenticity cannot be proven. This is not a signed report or remote attestation."
        let data = AuditJSON.prettyObject([
            ("format", .string("vision-audit-view-v1")), ("exportedAt", .string(isoTimestamp(now))),
            ("warning", .string(warning)), ("verification", verification), ("entries", .array(entries)),
        ])
        guard data.utf8.count <= maximumExportBytes else { throw ViewerError("Audit export exceeds the 2 MB limit") }
        return data + "\n"
    }
}

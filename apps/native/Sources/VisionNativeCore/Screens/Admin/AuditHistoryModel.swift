import Foundation
import Observation

/// The six audit channels the Audit history card calls. `AuditChannels` implements them
/// (with its confirmations, panels and notices), so the native card needs no web bridge.
@MainActor
public protocol AuditHistoryService: AnyObject {
    func read(_ range: AuditViewer.ReadRange) async -> JSONValue
    func enroll() async -> JSONValue
    func exportSnapshot() async -> JSONValue
    func exportTransfer(password: String) async -> JSONValue
    func importTransfer(password: String) async -> JSONValue
    func rotateKey() async -> JSONValue
}

extension AuditChannels: AuditHistoryService {}

/// `ElectronAuditVerification`.
public struct AuditVerificationSummary: Equatable, Sendable {
    public let verified: Bool
    public let sequence: Int
    public let hash: String
    public let anchoredThrough: Int
    public let retentionThrough: Int?
    public let enrollmentSequence: Int?
    /// `legacyUnverified`: the older unverified row counts as text.
    public let legacyUnverified: [String: String]?

    public init?(_ value: JSONValue?) {
        guard let value, let status = value["status"]?.stringValue,
            status == "verified" || status == "partially_verified", let sequence = value["sequence"]?.intValue,
            let hash = value["hash"]?.stringValue, let anchored = value["anchoredThrough"]?.intValue
        else { return nil }
        verified = status == "verified"
        self.sequence = sequence
        self.hash = hash
        anchoredThrough = anchored
        retentionThrough = value["retentionThrough"]?.intValue
        enrollmentSequence = value["enrollmentSequence"]?.intValue
        if let legacy = value["legacyUnverified"]?.objectValue {
            var counts: [String: String] = [:]
            for (key, count) in legacy {
                if let text = count.stringValue {
                    counts[key] = text
                } else if let number = count.intValue {
                    counts[key] = String(number)
                }
            }
            legacyUnverified = counts
        } else {
            legacyUnverified = nil
        }
    }
}

/// `ElectronAuditEntry`.
public struct AuditEntryRow: Equatable, Sendable, Identifiable {
    public let sequence: Int
    public let previousHash: String
    public let hash: String
    public let payload: JSONValue
    public let createdAt: String
    public let anchored: Bool

    public var id: Int { sequence }

    public init?(_ value: JSONValue) {
        guard let sequence = value["sequence"]?.intValue, let previousHash = value["previousHash"]?.stringValue,
            let hash = value["hash"]?.stringValue, let payload = value["payload"], payload.objectValue != nil,
            let createdAt = value["createdAt"]?.stringValue
        else { return nil }
        self.sequence = sequence
        self.previousHash = previousHash
        self.hash = hash
        self.payload = payload
        self.createdAt = createdAt
        anchored = value["anchorStatus"]?.stringValue == "anchored"
    }

    /// `entryLabel`: `stream · event`, or `#sequence`.
    public var label: String {
        let parts = [payload["stream"]?.stringValue, payload["event"]?.stringValue].compactMap { $0 }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? "#\(sequence)" : joined
    }

    /// The "Entry details" block: `JSON.stringify({ hash, previousHash, payload }, null, 2)`
    /// (nested keys sorted, as `JSONValue` keeps no order).
    public var detailsJSON: String {
        AuditJSON.prettyObject([
            ("hash", .string(hash)), ("previousHash", .string(previousHash)), ("payload", payload),
        ])
    }
}

/// A line of the verification summary: a catalog key and its `t()` variables, and its tone.
public struct AuditSummaryLine: Equatable, Sendable {
    public let key: String
    public let variables: [String: String]

    public init(key: String, variables: [String: String]) {
        self.key = key
        self.variables = variables
    }
}

/// One verified page or more, appended by Load more.
public struct AuditPage: Equatable, Sendable {
    public let verification: AuditVerificationSummary
    public let entries: [AuditEntryRow]
    public let hasMore: Bool

    public init(verification: AuditVerificationSummary, entries: [AuditEntryRow], hasMore: Bool) {
        self.verification = verification
        self.entries = entries
        self.hasMore = hasMore
    }
}

/// The state of `AuditHistoryCard` (apps/frontend/src/pages/admin/AuditHistoryCard.tsx) over
/// the native audit channels.
@MainActor
@Observable
public final class AuditHistoryModel {
    /// `PAGE_SIZE`.
    public static let pageSize = 100
    /// `EXPORT_ENTRY_LIMIT`.
    public static let exportEntryLimit = 500
    /// The transfer password's `minLength` and `maxLength`, in UTF-16 code units like the input.
    public static let passwordMinimum = 16
    public static let passwordMaximum = 1024

    public enum Status: String, Equatable, Sendable {
        case unavailable
        case failed
    }

    public enum Outcome: Equatable, Sendable {
        case success
        case failed
    }

    public enum EntryBadge: Equatable, Sendable, CaseIterable {
        case enrollmentBaseline
        case anchored
        case pending

        public var key: String {
            switch self {
            case .enrollmentBaseline: return "admin.audit.enrollmentBaseline"
            case .anchored: return "admin.audit.anchor"
            case .pending: return "admin.audit.pendingAnchor"
            }
        }

        public static var allKeys: [String] { allCases.map(\.key) }
    }

    public private(set) var page: AuditPage?
    public private(set) var status: Status?
    /// `no_trusted_anchor` with an unavailable status.
    public private(set) var noTrustedAnchor = false
    public private(set) var busy = false
    public private(set) var exportBusy = false
    public private(set) var enrollBusy = false
    public private(set) var enrollFailed = false
    public private(set) var transferBusy = false
    public private(set) var transferMessage: Outcome?
    public private(set) var rotationBusy = false
    public private(set) var rotationMessage: Outcome?
    public private(set) var exportMessage: Outcome?
    /// A Load more read no longer matched the first page.
    public private(set) var changed = false
    /// The transfer password; cleared after every transfer attempt.
    public private(set) var transferPassword = ""

    @ObservationIgnored private let service: any AuditHistoryService
    @ObservationIgnored private var requestId = 0

    public init(service: any AuditHistoryService) {
        self.service = service
    }

    // MARK: Derived state

    /// The skeleton: busy with neither a page nor a status.
    public var showsLoading: Bool { busy && page == nil && status == nil }

    /// The status line's key.
    public var statusKey: String? {
        guard let status else { return nil }
        if status == .unavailable && noTrustedAnchor { return "admin.audit.noTrustedAnchor" }
        return "admin.audit.\(status.rawValue)"
    }

    /// The enrollment block shows only without a trusted anchor.
    public var showsEnroll: Bool { status == .unavailable && noTrustedAnchor }

    public var pendingCount: Int {
        guard let verification = page?.verification else { return 0 }
        return verification.sequence - verification.anchoredThrough
    }

    public var exportTooLarge: Bool {
        guard let verification = page?.verification else { return false }
        return verification.sequence - (verification.retentionThrough ?? 0) > Self.exportEntryLimit
    }

    public var isExportDisabled: Bool { exportBusy || busy || exportTooLarge }

    private var passwordLongEnough: Bool { transferPassword.utf16.count >= Self.passwordMinimum }

    public var isTransferExportDisabled: Bool { transferBusy || !passwordLongEnough || page == nil }
    public var isTransferImportDisabled: Bool { transferBusy || !passwordLongEnough }
    public var isRotateDisabled: Bool { rotationBusy || busy }

    public func badge(for entry: AuditEntryRow) -> EntryBadge {
        if let enrollment = page?.verification.enrollmentSequence, entry.sequence <= enrollment {
            return .enrollmentBaseline
        }
        return entry.anchored ? .anchored : .pending
    }

    /// The verification summary lines: the headline, then the caveats.
    public func summaryLines() -> [AuditSummaryLine] {
        guard let verification = page?.verification else { return [] }
        var lines: [AuditSummaryLine] = []
        if verification.verified {
            lines.append(AuditSummaryLine(key: "admin.audit.verified", variables: ["sequence": String(verification.sequence)]))
        } else {
            lines.append(
                AuditSummaryLine(key: "admin.audit.partial", variables: ["anchored": String(verification.anchoredThrough)]))
        }
        if pendingCount > 0 {
            lines.append(AuditSummaryLine(key: "admin.audit.pending", variables: ["count": String(pendingCount)]))
        }
        if let enrollment = verification.enrollmentSequence {
            lines.append(AuditSummaryLine(key: "admin.audit.enrollmentCaveat", variables: ["sequence": String(enrollment)]))
        }
        if let retention = verification.retentionThrough {
            lines.append(AuditSummaryLine(key: "admin.audit.retentionCaveat", variables: ["sequence": String(retention)]))
        }
        if let legacy = verification.legacyUnverified {
            let counts: [String: String] = [
                "dbEditor": legacy["dbEditor"] ?? "0", "split": legacy["split"] ?? "0",
                "portfolioRetag": legacy["portfolioRetag"] ?? "0",
            ]
            lines.append(AuditSummaryLine(key: "admin.audit.legacy", variables: counts))
        }
        return lines
    }

    // MARK: Actions

    /// The password field: input beyond `maxLength` is dropped, like the browser does.
    public func setTransferPassword(_ value: String) {
        var units = 0
        var kept = ""
        for character in value {
            let width = character.utf16.count
            if units + width > Self.passwordMaximum { break }
            units += width
            kept.append(character)
        }
        transferPassword = kept
    }

    /// The card went away: the typed transfer password does not outlive it.
    public func disappear() {
        transferPassword = ""
    }

    /// `load(previous)`: the first page (Refresh), or the page after `previous` (Load more).
    public func load(after previous: AuditPage? = nil) async {
        requestId += 1
        let id = requestId
        busy = true
        exportMessage = nil
        defer { if id == requestId { busy = false } }
        let afterSequence = previous?.entries.last?.sequence ?? 0
        let result = await service.read(AuditViewer.ReadRange(afterSequence: afterSequence, limit: Self.pageSize))
        guard id == requestId else { return }
        guard result["success"] == .bool(true) else {
            page = nil
            status = result["status"]?.stringValue == "unavailable" ? .unavailable : .failed
            noTrustedAnchor = result["reason"]?.stringValue == "no_trusted_anchor"
            return
        }
        guard let verification = AuditVerificationSummary(result["verification"]),
            let rawEntries = result["entries"]?.arrayValue, let hasMore = result["hasMore"]?.boolValue
        else {
            page = nil
            status = .failed
            noTrustedAnchor = false
            return
        }
        let entries = rawEntries.compactMap(AuditEntryRow.init)
        guard entries.count == rawEntries.count else {
            page = nil
            status = .failed
            noTrustedAnchor = false
            return
        }
        if let previous {
            let before = previous.verification
            if verification.sequence != before.sequence || verification.hash != before.hash
                || verification.anchoredThrough != before.anchoredThrough
                || verification.retentionThrough != before.retentionThrough
                || entries.first?.sequence != afterSequence + 1
            {
                page = nil
                changed = true
                return
            }
        }
        page = AuditPage(
            verification: verification, entries: (previous?.entries ?? []) + entries, hasMore: hasMore)
        changed = false
        status = nil
        noTrustedAnchor = false
    }

    /// Load more.
    public func loadMore() async {
        guard let page else { return }
        await load(after: page)
    }

    public func exportSnapshot() async {
        guard page != nil, !exportBusy else { return }
        exportBusy = true
        exportMessage = nil
        let result = await service.exportSnapshot()
        if result["success"] == .bool(true) {
            exportMessage = .success
        } else if result["cancelled"] != .bool(true) {
            exportMessage = .failed
        }
        exportBusy = false
    }

    public func enroll() async {
        guard !enrollBusy else { return }
        enrollBusy = true
        enrollFailed = false
        let result = await service.enroll()
        if result["success"] == .bool(true) {
            await load()
        } else if result["cancelled"] != .bool(true) {
            enrollFailed = true
        }
        enrollBusy = false
    }

    public enum TransferKind: Equatable, Sendable {
        case exportTransfer
        case importTransfer
    }

    public func transfer(_ kind: TransferKind) async {
        guard !transferBusy, passwordLongEnough else { return }
        transferBusy = true
        transferMessage = nil
        let password = transferPassword
        let result: JSONValue
        switch kind {
        case .exportTransfer: result = await service.exportTransfer(password: password)
        case .importTransfer: result = await service.importTransfer(password: password)
        }
        let succeeded = result["success"] == .bool(true)
        if result["cancelled"] != .bool(true) { transferMessage = succeeded ? .success : .failed }
        if succeeded && kind == .importTransfer { await load() }
        transferPassword = ""
        transferBusy = false
    }

    public func rotateKey() async {
        guard !rotationBusy else { return }
        rotationBusy = true
        rotationMessage = nil
        let result = await service.rotateKey()
        let succeeded = result["success"] == .bool(true)
        if result["cancelled"] != .bool(true) { rotationMessage = succeeded ? .success : .failed }
        if succeeded { await load() }
        rotationBusy = false
    }
}

import CryptoKit
import Foundation

/// An error with the code `AuditAnchorError` carries in `packaging/electron/audit-anchor.ts`
/// (`uninitialized`, `witness_mismatch`, `transfer_invalid` …). The message is Electron's
/// `Audit anchor <code>`.
public struct AuditAnchorError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public let code: String

    public init(_ code: String) {
        self.code = code
    }

    public var errorDescription: String? { "Audit anchor \(code)" }
    public var description: String { "Audit anchor \(code)" }
}

/// Electron throws a `TypeError` for malformed anchor inputs (a head, a cutover or a
/// retention boundary from the bridge). It is not an `AuditAnchorError`.
public struct AuditInputError: Error, Equatable, Sendable, LocalizedError {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// `Checkpoint`: an audit chain head.
public struct AuditCheckpoint: Equatable, Sendable {
    public var sequence: Int
    public var hash: String

    public init(sequence: Int, hash: String) {
        self.sequence = sequence
        self.hash = hash
    }

    /// `requireHead`.
    public static func parse(_ value: JSONValue?) throws -> AuditCheckpoint {
        guard let value, value.objectValue != nil, let sequence = AuditJSON.safeInteger(value["sequence"]),
            sequence >= 0, AuditJSON.isHash(value["hash"]), let hash = value["hash"]?.stringValue
        else {
            throw AuditInputError("Invalid audit chain head")
        }
        return AuditCheckpoint(sequence: sequence, hash: hash)
    }

    public var jsonValue: JSONValue {
        .object(["sequence": .int(sequence), "hash": .string(hash)])
    }
}

/// `LegacyCutover`.
public struct AuditLegacyCutover: Equatable, Sendable {
    public var dbEditorMaxId: Int
    public var splitMaxId: Int
    public var retagMaxId: Int

    public init(dbEditorMaxId: Int, splitMaxId: Int, retagMaxId: Int) {
        self.dbEditorMaxId = dbEditorMaxId
        self.splitMaxId = splitMaxId
        self.retagMaxId = retagMaxId
    }

    public static let fieldNames = ["dbEditorMaxId", "splitMaxId", "retagMaxId"]

    /// `requireLegacyCutover`: three non-negative safe integers; other fields are ignored.
    public static func parse(_ value: JSONValue?) throws -> AuditLegacyCutover {
        guard let value, value.objectValue != nil,
            let dbEditor = AuditJSON.safeInteger(value["dbEditorMaxId"]), dbEditor >= 0,
            let split = AuditJSON.safeInteger(value["splitMaxId"]), split >= 0,
            let retag = AuditJSON.safeInteger(value["retagMaxId"]), retag >= 0
        else {
            throw AuditInputError("Invalid audit legacy cutover")
        }
        return AuditLegacyCutover(dbEditorMaxId: dbEditor, splitMaxId: split, retagMaxId: retag)
    }

    var ordered: OrderedJSON {
        .object([("dbEditorMaxId", .int(dbEditorMaxId)), ("splitMaxId", .int(splitMaxId)), ("retagMaxId", .int(retagMaxId))])
    }

    public var jsonValue: JSONValue {
        .object([
            "dbEditorMaxId": .int(dbEditorMaxId), "splitMaxId": .int(splitMaxId), "retagMaxId": .int(retagMaxId),
        ])
    }

    func value(_ field: String) -> Int {
        switch field {
        case "dbEditorMaxId": return dbEditorMaxId
        case "splitMaxId": return splitMaxId
        default: return retagMaxId
        }
    }
}

/// `RetentionBoundary`: the signed one-year retention cut.
public struct AuditRetentionBoundary: Equatable, Sendable {
    public var through: Int
    public var hash: String
    public var dbEditor: Int
    public var split: Int
    public var retag: Int
    public var migrationHeads: [String]

    public init(through: Int, hash: String, dbEditor: Int, split: Int, retag: Int, migrationHeads: [String]) {
        self.through = through
        self.hash = hash
        self.dbEditor = dbEditor
        self.split = split
        self.retag = retag
        self.migrationHeads = migrationHeads
    }

    /// `isMigrationHeads`: at most 16 sorted `[0-9a-z_]{1,64}` names.
    static func isMigrationHeads(_ value: JSONValue?) -> [String]? {
        guard let items = value?.arrayValue, items.count <= 16 else { return nil }
        var heads: [String] = []
        for item in items {
            guard let text = item.stringValue, PathUtilities.fullMatch(text, "[0-9a-z_]{1,64}") else { return nil }
            heads.append(text)
        }
        // JavaScript's default sort compares UTF-16 code units; for this alphabet that is
        // the byte order Swift's `<` uses.
        return heads == heads.sorted() ? heads : nil
    }

    /// `parseRetention`.
    public static func parse(_ value: JSONValue?) throws -> AuditRetentionBoundary {
        guard let value, value.objectValue != nil, let through = AuditJSON.safeInteger(value["through"]), through >= 1,
            AuditJSON.isHash(value["hash"]), let hash = value["hash"]?.stringValue,
            let heads = isMigrationHeads(value["migrationHeads"]),
            let domainMax = value["domainMax"], domainMax.objectValue != nil,
            let dbEditor = AuditJSON.safeInteger(domainMax["dbEditor"]), dbEditor >= 0,
            let split = AuditJSON.safeInteger(domainMax["split"]), split >= 0,
            let retag = AuditJSON.safeInteger(domainMax["retag"]), retag >= 0
        else {
            throw AuditInputError("Invalid audit retention boundary")
        }
        return AuditRetentionBoundary(
            through: through, hash: hash, dbEditor: dbEditor, split: split, retag: retag, migrationHeads: heads)
    }

    var ordered: OrderedJSON {
        .object([
            ("through", .int(through)), ("hash", .string(hash)),
            ("domainMax", .object([("dbEditor", .int(dbEditor)), ("split", .int(split)), ("retag", .int(retag))])),
            ("migrationHeads", .array(migrationHeads.map { .string($0) })),
        ])
    }

    public var jsonValue: JSONValue {
        .object([
            "through": .int(through), "hash": .string(hash),
            "domainMax": .object(["dbEditor": .int(dbEditor), "split": .int(split), "retag": .int(retag)]),
            "migrationHeads": .array(migrationHeads.map { .string($0) }),
        ])
    }

    /// `RETENTION_DOMAINS` with `RETENTION_LEGACY_FIELD`.
    static let domains: [(String, String)] = [
        ("dbEditor", "dbEditorMaxId"), ("split", "splitMaxId"), ("retag", "retagMaxId"),
    ]

    func domainValue(_ field: String) -> Int {
        switch field {
        case "dbEditor": return dbEditor
        case "split": return split
        default: return retag
        }
    }
}

/// `AnchorMetadata`.
public struct AuditAnchorMetadata: Equatable, Sendable {
    public var sequence: Int
    public var headHash: String
    public var anchorKind: String
    public var receiptId: String
    public var receiptHash: String
    public var enrollmentSequence: Int?
    public var retention: AuditRetentionBoundary?

    /// `checkpointBridgePayload`: the five fields `/api/internal/audit/checkpoint` accepts.
    public var bridgePayload: JSONValue {
        .object([
            "sequence": .int(sequence), "headHash": .string(headHash), "anchorKind": .string(anchorKind),
            "receiptId": .string(receiptId), "receiptHash": .string(receiptHash),
        ])
    }
}

/// `TrustedCheckpoint`.
public struct AuditTrustedCheckpoint: Equatable, Sendable {
    public var sequence: Int
    public var hash: String
    public var legacyCutover: AuditLegacyCutover
    public var retention: AuditRetentionBoundary?
    public var metadata: AuditAnchorMetadata

    /// `trustedBridgePayload`: `{ sequence, hash, retention? }`.
    public var bridgePayload: JSONValue {
        var fields: [String: JSONValue] = ["sequence": .int(sequence), "hash": .string(hash)]
        if let retention { fields["retention"] = retention.jsonValue }
        return .object(fields)
    }
}

/// `WitnessValue`: what the Keychain item holds.
public struct AuditWitnessValue: Equatable, Sendable {
    public var version: Int
    public var keyId: String
    public var sequence: Int
    public var hash: String
    public var receiptHash: String

    public init(version: Int, keyId: String, sequence: Int, hash: String, receiptHash: String) {
        self.version = version
        self.keyId = keyId
        self.sequence = sequence
        self.hash = hash
        self.receiptHash = receiptHash
    }

    /// `JSON.stringify(value)` as the Electron helper receives it on stdin.
    public var serialized: String {
        OrderedJSON.object([
            ("version", .int(version)), ("keyId", .string(keyId)), ("sequence", .int(sequence)),
            ("hash", .string(hash)), ("receiptHash", .string(receiptHash)),
        ]).compact
    }

    /// `witnessMatches`: a stored record whose five fields are strictly equal.
    public func matches(_ stored: JSONValue?) -> Bool {
        guard let stored, stored.objectValue != nil else { return false }
        return stored["version"]?.intValue == version && stored["keyId"]?.stringValue == keyId
            && stored["sequence"]?.intValue == sequence && stored["hash"]?.stringValue == hash
            && stored["receiptHash"]?.stringValue == receiptHash
    }
}

/// A version 3 receipt (`checkpoint.json`).
public struct AuditReceipt: Equatable, Sendable {
    public static let version = 3
    /// `ANCHOR_KIND`.
    public static let anchorKind = "macos_keychain_witness_hmac_v3"
    public static let genesisHash = String(repeating: "0", count: 64)

    public var keyId: String
    public var sequence: Int
    public var hash: String
    public var legacyCutover: AuditLegacyCutover
    public var createdAt: String
    public var enrollmentSequence: Int?
    public var retention: AuditRetentionBoundary?
    public var mac: String

    public init(
        keyId: String, sequence: Int, hash: String, legacyCutover: AuditLegacyCutover, createdAt: String,
        enrollmentSequence: Int? = nil, retention: AuditRetentionBoundary? = nil, mac: String = ""
    ) {
        self.keyId = keyId
        self.sequence = sequence
        self.hash = hash
        self.legacyCutover = legacyCutover
        self.createdAt = createdAt
        self.enrollmentSequence = enrollmentSequence
        self.retention = retention
        self.mac = mac
    }

    /// `RECEIPT_TIME`: `toISOString()` output.
    static func isReceiptTime(_ value: JSONValue?) -> Bool {
        guard let text = value?.stringValue else { return false }
        return PathUtilities.fullMatch(text, #"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"#)
    }

    /// `signedBytes`: the MAC input. Receipts without `enrollmentSequence` keep the
    /// encoding of v3 receipts written before explicit enrollment existed.
    public var signedBytes: Data {
        var fields: [OrderedJSON] = [
            .int(Self.version), .string(keyId), .int(sequence), .string(hash), legacyCutover.ordered,
            .string(createdAt),
        ]
        if let enrollmentSequence { fields.append(.int(enrollmentSequence)) }
        if let retention { fields.append(retention.ordered) }
        return Data(OrderedJSON.array(fields).compact.utf8)
    }

    /// `macFor`: lowercase hex HMAC-SHA256.
    public func computeMAC(key: Data) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: signedBytes, using: SymmetricKey(data: key))
        return Data(code).auditHex
    }

    /// The receipt with its MAC.
    public func signed(key: Data) -> AuditReceipt {
        var receipt = self
        receipt.mac = computeMAC(key: key)
        return receipt
    }

    /// `sha256(signedBytes || mac bytes)`, the receipt hash the witness and backend record.
    public func receiptHash(macBytes: Data) -> String {
        var hasher = SHA256()
        hasher.update(data: signedBytes)
        hasher.update(data: macBytes)
        return Data(hasher.finalize()).auditHex
    }

    var ordered: OrderedJSON {
        var fields: [(String, OrderedJSON)] = [
            ("version", .int(Self.version)), ("keyId", .string(keyId)), ("sequence", .int(sequence)),
            ("hash", .string(hash)), ("legacyCutover", legacyCutover.ordered), ("createdAt", .string(createdAt)),
        ]
        if let enrollmentSequence { fields.append(("enrollmentSequence", .int(enrollmentSequence))) }
        if let retention { fields.append(("retention", retention.ordered)) }
        fields.append(("mac", .string(mac)))
        return .object(fields)
    }

    /// `JSON.stringify(receipt)`; the file adds a trailing newline.
    public var serialized: String { ordered.compact }

    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = [
            "version": .int(Self.version), "keyId": .string(keyId), "sequence": .int(sequence), "hash": .string(hash),
            "legacyCutover": legacyCutover.jsonValue, "createdAt": .string(createdAt), "mac": .string(mac),
        ]
        if let enrollmentSequence { fields["enrollmentSequence"] = .int(enrollmentSequence) }
        if let retention { fields["retention"] = retention.jsonValue }
        return .object(fields)
    }

    /// `requireStoredReceipt`: a parsed `checkpoint.json`, normalized. A version 2 receipt
    /// is `legacy_anchor_unverified`; anything malformed is `receipt_invalid`.
    public static func parseStored(_ parsed: JSONValue) throws -> AuditReceipt {
        if parsed.objectValue != nil, parsed["version"]?.intValue == 2 {
            throw AuditAnchorError("legacy_anchor_unverified")
        }
        guard parsed.objectValue != nil, parsed["version"]?.intValue == version,
            AuditJSON.isHash(parsed["keyId"]), let keyId = parsed["keyId"]?.stringValue,
            let sequence = AuditJSON.safeInteger(parsed["sequence"]), sequence >= 0,
            AuditJSON.isHash(parsed["hash"]), let hash = parsed["hash"]?.stringValue,
            let rawCutover = parsed["legacyCutover"], rawCutover.isTruthy,
            isReceiptTime(parsed["createdAt"]), let createdAt = parsed["createdAt"]?.stringValue,
            AuditJSON.isHash(parsed["mac"]), let mac = parsed["mac"]?.stringValue
        else {
            throw AuditAnchorError("receipt_invalid")
        }
        var enrollment: Int?
        if let raw = parsed["enrollmentSequence"] {
            guard let value = AuditJSON.safeInteger(raw), value >= 0, value <= sequence else {
                throw AuditAnchorError("receipt_invalid")
            }
            enrollment = value
        }
        if let raw = parsed["retention"] {
            guard raw.objectValue != nil, let through = AuditJSON.safeInteger(raw["through"]), through < sequence else {
                throw AuditAnchorError("receipt_invalid")
            }
        }
        let cutover: AuditLegacyCutover
        var retention: AuditRetentionBoundary?
        do {
            cutover = try AuditLegacyCutover.parse(rawCutover)
            if let raw = parsed["retention"] { retention = try AuditRetentionBoundary.parse(raw) }
        } catch {
            throw AuditAnchorError("receipt_invalid")
        }
        return AuditReceipt(
            keyId: keyId, sequence: sequence, hash: hash, legacyCutover: cutover, createdAt: createdAt,
            enrollmentSequence: enrollment, retention: retention, mac: mac)
    }

    /// `validateTransferredReceipt`: the receipt a transfer carries must belong to `key`
    /// and be authentic. Every failure is `transfer_invalid`.
    public static func parseTransferred(_ value: JSONValue?, key: Data) throws -> AuditReceipt {
        let invalid = AuditAnchorError("transfer_invalid")
        guard key.count == 32, let value, value.objectValue != nil, value["version"]?.intValue == version,
            value["keyId"]?.stringValue == AuditKeyMaterial.keyId(key),
            let sequence = AuditJSON.safeInteger(value["sequence"]), sequence >= 0,
            AuditJSON.isHash(value["hash"]), let hash = value["hash"]?.stringValue,
            isReceiptTime(value["createdAt"]), let createdAt = value["createdAt"]?.stringValue,
            AuditJSON.isHash(value["mac"]), let mac = value["mac"]?.stringValue,
            let keyId = value["keyId"]?.stringValue
        else {
            throw invalid
        }
        var enrollment: Int?
        if let raw = value["enrollmentSequence"] {
            guard let number = AuditJSON.safeInteger(raw), number >= 0, number <= sequence else { throw invalid }
            enrollment = number
        }
        let cutover: AuditLegacyCutover
        var retention: AuditRetentionBoundary?
        do {
            cutover = try AuditLegacyCutover.parse(value["legacyCutover"])
            if let raw = value["retention"] { retention = try AuditRetentionBoundary.parse(raw) }
        } catch {
            throw invalid
        }
        if let retention, retention.through >= sequence { throw invalid }
        let receipt = AuditReceipt(
            keyId: keyId, sequence: sequence, hash: hash, legacyCutover: cutover, createdAt: createdAt,
            enrollmentSequence: enrollment, retention: retention, mac: mac)
        guard AuditKeyMaterial.constantTimeEqual(receipt.computeMAC(key: key), mac) else { throw invalid }
        return receipt
    }
}

/// Key identities and comparisons.
public enum AuditKeyMaterial {
    /// `sha256(key)` in hex: the receipt's `keyId`.
    public static func keyId(_ key: Data) -> String {
        Data(SHA256.hash(data: key)).auditHex
    }

    /// `crypto.timingSafeEqual` over the hex-decoded values.
    public static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8)
        let right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    /// 32 bytes from the system random source.
    public static func randomKey() throws -> Data {
        Data(try BackupFiles.randomBytes(32))
    }
}

extension Data {
    var auditHex: String { map { String(format: "%02x", $0) }.joined() }

    init?(auditHex text: String) {
        guard text.count % 2 == 0, PathUtilities.fullMatch(text, "[0-9a-fA-F]*") else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }
}

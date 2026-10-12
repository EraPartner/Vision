import CryptoKit
import Foundation
import Testing
@testable import VisionNativeCore

// The audit anchor against real files, a fake Keychain witness and an in-memory wrapping
// key, plus the receipt written by Electron's audit-anchor.ts (Fixtures/audit).

/// The Keychain witness, held in memory as the JSON text the Keychain item stores.
final class MemoryAuditWitness: AuditWitness, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    private var failing = false
    private var writes = 0

    init(_ stored: String? = nil) {
        self.stored = stored
    }

    var text: String? { lock.withLock { stored } }
    var writeCount: Int { lock.withLock { writes } }

    func set(_ text: String?) { lock.withLock { stored = text } }
    func failWrites(_ fail: Bool) { lock.withLock { failing = fail } }

    func read() async throws -> JSONValue? {
        guard let text = lock.withLock({ stored }) else { return nil }
        return try JSONValue.parse(Data(text.utf8))
    }

    func create(_ value: AuditWitnessValue) async throws {
        try lock.withLock {
            if failing { throw AuditWitnessError.unavailable }
            if stored != nil { throw AuditWitnessError.alreadyExists }
            stored = value.serialized
            writes += 1
        }
    }

    func replace(_ value: AuditWitnessValue) async throws {
        try lock.withLock {
            if failing { throw AuditWitnessError.unavailable }
            stored = value.serialized
            writes += 1
        }
    }
}

/// The Keychain-held wrapping key, in memory.
final class MemoryWrappingKeyStore: AuditWrappingKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Data?

    func load() throws -> Data? { lock.withLock { key } }

    func loadOrCreate() throws -> Data {
        try lock.withLock {
            if let key { return key }
            let created = try AuditKeyMaterial.randomKey()
            key = created
            return created
        }
    }
}

/// A clock that advances one millisecond per reading, so receipts differ in `createdAt`.
final class TickingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_760_000_000)

    func now() -> Date {
        lock.withLock {
            current = current.addingTimeInterval(0.001)
            return current
        }
    }
}

struct AnchorFixture {
    let directory: String
    let witness: MemoryAuditWitness
    let store: MemoryWrappingKeyStore
    let anchor: AuditAnchor

    init(
        directory: String? = nil, witness: MemoryAuditWitness = MemoryAuditWitness(),
        store: MemoryWrappingKeyStore = MemoryWrappingKeyStore(), electronPassword: String? = nil
    ) throws {
        let root = try directory ?? makeBackupScratchDirectory()
        let clock = TickingClock()
        var reader: (@Sendable () throws -> String?)?
        if let electronPassword { reader = { electronPassword } }
        self.directory = root
        self.witness = witness
        self.store = store
        anchor = try AuditAnchor(
            userDataDirectory: root,
            keyProtector: NativeAuditKeyProtector(store: store, electronSafeStoragePassword: reader),
            witness: witness, now: { clock.now() })
    }

    var anchorDirectory: String { directory + "/audit-anchor" }

    func read(_ name: String) throws -> String {
        try String(contentsOfFile: anchorDirectory + "/" + name, encoding: .utf8)
    }

    func write(_ name: String, _ text: String) throws {
        try BackupFiles.createDirectory(anchorDirectory)
        try writeBytes(anchorDirectory + "/" + name, Array(text.utf8))
    }

    func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: anchorDirectory + "/" + name)
    }

    func remove() {
        try? FileManager.default.removeItem(atPath: directory)
    }
}

func auditHash(_ label: String) -> String {
    sha256Hex(Data(label.utf8))
}

func auditHead(_ sequence: Int, _ label: String? = nil) -> JSONValue {
    .object(["sequence": .int(sequence), "hash": .string(auditHash(label ?? "head \(sequence)"))])
}

let auditCutover = JSONValue.object(["dbEditorMaxId": .int(3), "splitMaxId": .int(1), "retagMaxId": .int(0)])

func auditRetention(through: Int, dbEditor: Int = 7, split: Int = 2, retag: Int = 0) -> JSONValue {
    .object([
        "through": .int(through), "hash": .string(auditHash("retention \(through)")),
        "domainMax": .object(["dbEditor": .int(dbEditor), "split": .int(split), "retag": .int(retag)]),
        "migrationHeads": .array([.string("0158_audit_chain"), .string("0161_audit_retention")]),
    ])
}

/// Expects `operation` to throw the `AuditAnchorError` with `code`.
func expectAnchorError(
    _ code: String, sourceLocation: SourceLocation = #_sourceLocation, _ operation: () async throws -> Void
) async {
    do {
        try await operation()
        Issue.record("expected Audit anchor \(code)", sourceLocation: sourceLocation)
    } catch let error as AuditAnchorError {
        #expect(error.code == code, sourceLocation: sourceLocation)
    } catch {
        Issue.record("expected Audit anchor \(code), got \(error)", sourceLocation: sourceLocation)
    }
}

/// The Electron fixture (Fixtures/audit/README.md).
enum ElectronAuditFixture {
    static func directory() throws -> String {
        guard let path = Bundle.module.path(forResource: "audit", ofType: nil) else {
            throw BackupFailure("The audit fixture is missing from the test resources")
        }
        return path
    }

    static func text(_ name: String) throws -> String {
        try String(contentsOfFile: try directory() + "/" + name, encoding: .utf8)
    }

    static func expected() throws -> JSONValue {
        try JSONValue.parse(Data(try text("expected.json").utf8))
    }
}

@Suite struct AuditReceiptFormatTests {
    @Test func stringsAreEscapedLikeJSONStringify() {
        #expect(AuditJSON.quoted("a\"b\\c") == #""a\"b\\c""#)
        #expect(AuditJSON.quoted("\u{08}\u{0C}\n\r\t\u{01}\u{1F}") == #""\b\f\n\r\t\u0001\u001f""#)
        #expect(AuditJSON.quoted("é/€") == "\"é/€\"")
        #expect(OrderedJSON.array([.int(3), .string("x"), .object([("b", .int(1)), ("a", .null)])]).compact == #"[3,"x",{"b":1,"a":null}]"#)
    }

    @Test func theElectronReceiptReserializesByteForByte() throws {
        let text = try ElectronAuditFixture.text("checkpoint.json")
        let receipt = try AuditReceipt.parseStored(try JSONValue.parse(Data(text.utf8)))
        #expect(receipt.serialized + "\n" == text)
        #expect(receipt.enrollmentSequence == 5)
        #expect(receipt.retention?.through == 4)
    }

    @Test func theElectronKeyDecodesAndSignsTheReceipt() throws {
        let expected = try ElectronAuditFixture.expected()
        let password = try #require(expected["safeStoragePassword"]?.stringValue)
        let encoded = try ElectronAuditFixture.text("key.enc")
        let encrypted = try #require(AuditJSON.base64Bytes(encoded))
        #expect(encrypted.starts(with: ElectronSafeStorage.prefix))
        let key = try #require(AuditJSON.base64Bytes(try ElectronSafeStorage.decrypt(encrypted, password: password)))
        #expect(key.count == 32)
        let receipt = try AuditReceipt.parseStored(
            try JSONValue.parse(Data(try ElectronAuditFixture.text("checkpoint.json").utf8)))
        #expect(AuditKeyMaterial.keyId(key) == receipt.keyId)
        #expect(receipt.computeMAC(key: key) == receipt.mac)
        let macBytes = try #require(Data(auditHex: receipt.mac))
        #expect(receipt.receiptHash(macBytes: macBytes) == expected["trusted"]?["metadata"]?["receiptHash"]?.stringValue)
        let witness = AuditWitnessValue(
            version: 3, keyId: receipt.keyId, sequence: receipt.sequence, hash: receipt.hash,
            receiptHash: receipt.receiptHash(macBytes: macBytes))
        #expect(witness.serialized == (try ElectronAuditFixture.text("witness.json")))
    }

    @Test func electronSafeStorageRoundTripsAndRefusesAWrongPassword() throws {
        let encrypted = try ElectronSafeStorage.encrypt("c2VjcmV0", password: "fixture password")
        #expect(encrypted.starts(with: ElectronSafeStorage.prefix))
        #expect(try ElectronSafeStorage.decrypt(encrypted, password: "fixture password") == "c2VjcmV0")
        #expect(throws: AuditAnchorError.self) { try ElectronSafeStorage.decrypt(encrypted, password: "other") }
    }

    @Test func theNativeProtectorIsVersionedAndReadsV10OnlyWithThePassword() throws {
        let store = MemoryWrappingKeyStore()
        let protector = NativeAuditKeyProtector(store: store)
        let sealed = try protector.encrypt("payload")
        #expect(sealed.starts(with: NativeAuditKeyProtector.prefix))
        #expect(sealed.count == 3 + 12 + "payload".utf8.count + 16)
        #expect(try protector.decrypt(sealed) == "payload")
        let other = NativeAuditKeyProtector(store: MemoryWrappingKeyStore())
        #expect(throws: (any Error).self) { try other.decrypt(sealed) }
        let electron = try ElectronSafeStorage.encrypt("payload", password: "safe storage")
        #expect(throws: AuditAnchorError("key_unavailable")) { try protector.decrypt(electron) }
        let reader = NativeAuditKeyProtector(store: store, electronSafeStoragePassword: { "safe storage" })
        #expect(try reader.decrypt(electron) == "payload")
    }

    @Test func receiptsWithoutOptionalFieldsKeepTheShortMACEncoding() {
        let receipt = AuditReceipt(
            keyId: auditHash("key"), sequence: 0, hash: AuditReceipt.genesisHash,
            legacyCutover: AuditLegacyCutover(dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0),
            createdAt: "2026-01-01T00:00:00.000Z")
        let signed = String(decoding: receipt.signedBytes, as: UTF8.self)
        #expect(
            signed
                == #"[3,""# + auditHash("key") + #"",0,""# + AuditReceipt.genesisHash
                + #"",{"dbEditorMaxId":0,"splitMaxId":0,"retagMaxId":0},"2026-01-01T00:00:00.000Z"]"#)
    }
}

@Suite struct AuditAnchorTests {
    @Test func theElectronAnchorLoadsWithItsWitness() async throws {
        let expected = try ElectronAuditFixture.expected()
        let fixture = try AnchorFixture(
            witness: MemoryAuditWitness(try ElectronAuditFixture.text("witness.json")),
            electronPassword: expected["safeStoragePassword"]?.stringValue)
        defer { fixture.remove() }
        try fixture.write("key.enc", try ElectronAuditFixture.text("key.enc"))
        try fixture.write("checkpoint.json", try ElectronAuditFixture.text("checkpoint.json"))
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        let metadata = try #require(expected["trusted"]?["metadata"])
        #expect(trusted.sequence == 12)
        #expect(trusted.metadata.receiptId == metadata["receiptId"]?.stringValue)
        #expect(trusted.metadata.receiptHash == metadata["receiptHash"]?.stringValue)
        #expect(trusted.metadata.anchorKind == "macos_keychain_witness_hmac_v3")
        #expect(trusted.metadata.enrollmentSequence == 5)
        #expect(trusted.retention.map { $0.jsonValue } == expected["trusted"]?["retention"])
        #expect(trusted.legacyCutover.jsonValue == expected["trusted"]?["legacyCutover"])
    }

    @Test func theElectronAnchorNeedsTheSafeStoragePassword() async throws {
        let fixture = try AnchorFixture(witness: MemoryAuditWitness(try ElectronAuditFixture.text("witness.json")))
        defer { fixture.remove() }
        try fixture.write("key.enc", try ElectronAuditFixture.text("key.enc"))
        try fixture.write("checkpoint.json", try ElectronAuditFixture.text("checkpoint.json"))
        await expectAnchorError("key_unavailable") { _ = try await fixture.anchor.readTrustedCheckpoint() }
    }

    @Test func theElectronTransferImportsIntoAFreshAnchor() async throws {
        let expected = try ElectronAuditFixture.expected()
        let password = try #require(expected["transferPassword"]?.stringValue)
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        let contents = Data(try ElectronAuditFixture.text("transfer.vat").utf8)
        let metadata = try await fixture.anchor.importProtectedTransfer(
            contents, password: password, expectedCurrent: nil)
        #expect(metadata.receiptHash == expected["trusted"]?["metadata"]?["receiptHash"]?.stringValue)
        #expect(metadata.receiptId == expected["trusted"]?["metadata"]?["receiptId"]?.stringValue)
        // The key is now protected the Vision Native way; the receipt is Electron's.
        let encrypted = try #require(AuditJSON.base64Bytes(try fixture.read("key.enc")))
        #expect(encrypted.starts(with: NativeAuditKeyProtector.prefix))
        #expect(try fixture.read("checkpoint.json") == (try ElectronAuditFixture.text("checkpoint.json")))
        #expect(fixture.witness.text == (try ElectronAuditFixture.text("witness.json")))
    }

    @Test func aFirstCheckpointWritesTheReceiptKeyAndWitness() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        await expectAnchorError("uninitialized") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        let metadata = try await fixture.anchor.initializeFirstCheckpoint(
            head: auditHead(5), legacyCutover: auditCutover, enrollment: true)
        #expect(metadata.sequence == 5)
        #expect(metadata.enrollmentSequence == 5)
        #expect(metadata.receiptId.hasSuffix(":5"))
        let receipt = try AuditReceipt.parseStored(try JSONValue.parse(Data(try fixture.read("checkpoint.json").utf8)))
        #expect(try fixture.read("checkpoint.json") == receipt.serialized + "\n")
        let witness = try #require(fixture.witness.text)
        #expect(witness.hasPrefix(#"{"version":3,"keyId":""# + receipt.keyId))
        let attributes = try FileManager.default.attributesOfItem(atPath: fixture.anchorDirectory + "/key.enc")
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        // A second initialization keeps the existing anchor.
        let again = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(9), legacyCutover: auditCutover)
        #expect(again == metadata)
        let genesis = try AnchorFixture()
        defer { genesis.remove() }
        let zero = try await genesis.anchor.initializeGenesis(legacyCutover: auditCutover)
        #expect(zero.headHash == AuditReceipt.genesisHash)
        #expect(zero.enrollmentSequence == nil)
    }

    @Test func checkpointsOnlyMoveForward() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(5), legacyCutover: auditCutover)
        let advanced = try await fixture.anchor.persistCheckpoint(head: auditHead(9))
        #expect(advanced.sequence == 9)
        let same = try await fixture.anchor.persistCheckpoint(head: auditHead(9))
        #expect(same == advanced)
        await expectAnchorError("rollback") { _ = try await fixture.anchor.persistCheckpoint(head: auditHead(8)) }
        await expectAnchorError("fork") { _ = try await fixture.anchor.persistCheckpoint(head: auditHead(9, "other")) }
        let compared = try await fixture.anchor.compareHead(auditHead(12))
        #expect(compared.status == .aheadOfAnchor)
        #expect(compared.checkpoint.sequence == 9)
        #expect(throws: AuditInputError.self) { try AuditCheckpoint.parse(.object(["sequence": .int(-1)])) }
    }

    @Test func theWitnessAndTheFilesMustAgree() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(5), legacyCutover: auditCutover)
        let original = fixture.witness.text
        fixture.witness.set(nil)
        await expectAnchorError("witness_missing") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        fixture.witness.set(original?.replacingOccurrences(of: #""sequence":5"#, with: #""sequence":4"#))
        await expectAnchorError("witness_mismatch") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        fixture.witness.set(original)

        let receipt = try fixture.read("checkpoint.json")
        try fixture.write("checkpoint.json", receipt.replacingOccurrences(of: #""sequence":5"#, with: #""sequence":6"#))
        await expectAnchorError("receipt_tampered") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        try fixture.write("checkpoint.json", receipt.replacingOccurrences(of: #""version":3"#, with: #""version":2"#))
        await expectAnchorError("legacy_anchor_unverified") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        try fixture.write("checkpoint.json", "{")
        await expectAnchorError("receipt_invalid") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        try fixture.write("checkpoint.json", receipt)

        try FileManager.default.removeItem(atPath: fixture.anchorDirectory + "/key.enc")
        await expectAnchorError("key_missing") { _ = try await fixture.anchor.readTrustedCheckpoint() }
        try FileManager.default.removeItem(atPath: fixture.anchorDirectory + "/checkpoint.json")
        await expectAnchorError("local_anchor_missing") { _ = try await fixture.anchor.readTrustedCheckpoint() }
    }

    @Test func aWitnessFailureIsWitnessUnavailable() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(5), legacyCutover: auditCutover)
        fixture.witness.failWrites(true)
        await expectAnchorError("witness_unavailable") { _ = try await fixture.anchor.persistCheckpoint(head: auditHead(6)) }
    }

    @Test func theRetentionBoundaryIsSignedAndNeverRegresses() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(12), legacyCutover: auditCutover)
        await expectAnchorError("retention_regression") {
            _ = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 12))
        }
        await expectAnchorError("retention_regression") {
            _ = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 4, dbEditor: 2))
        }
        let first = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 4))
        #expect(first.receiptId.hasSuffix(":12:4"))
        #expect(first.retention?.through == 4)
        await expectAnchorError("retention_regression") {
            _ = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 4))
        }
        await expectAnchorError("retention_regression") {
            _ = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 6, dbEditor: 6))
        }
        let second = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 6, dbEditor: 9))
        #expect(second.receiptId.hasSuffix(":12:6"))
        // The boundary rides along with later checkpoints.
        let next = try await fixture.anchor.persistCheckpoint(head: auditHead(15))
        #expect(next.retention?.through == 6)
        #expect(next.receiptId.hasSuffix(":15:6"))
        #expect(throws: AuditInputError.self) {
            try AuditRetentionBoundary.parse(
                .object([
                    "through": .int(1), "hash": .string(auditHash("x")),
                    "domainMax": .object(["dbEditor": .int(0), "split": .int(0), "retag": .int(0)]),
                    "migrationHeads": .array([.string("b"), .string("a")]),
                ]))
        }
    }

    @Test func rotatingTheKeyKeepsTheHeadAndMovesTheWitness() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        let before = try await fixture.anchor.initializeFirstCheckpoint(
            head: auditHead(7), legacyCutover: auditCutover, enrollment: true)
        _ = try await fixture.anchor.persistRetentionBoundary(auditRetention(through: 3))
        let oldReceipt = try AuditReceipt.parseStored(
            try JSONValue.parse(Data(try fixture.read("checkpoint.json").utf8)))
        let rotated = try await fixture.anchor.rotateKey()
        let newReceipt = try AuditReceipt.parseStored(
            try JSONValue.parse(Data(try fixture.read("checkpoint.json").utf8)))
        #expect(rotated.sequence == before.sequence)
        #expect(rotated.headHash == before.headHash)
        #expect(rotated.enrollmentSequence == 7)
        #expect(rotated.retention?.through == 3)
        #expect(newReceipt.keyId != oldReceipt.keyId)
        #expect(fixture.witness.text?.contains(newReceipt.keyId) == true)
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.metadata == rotated)
    }

    @Test func aTransferRoundTripsBetweenTwoAnchors() async throws {
        let source = try AnchorFixture()
        let target = try AnchorFixture()
        defer {
            source.remove()
            target.remove()
        }
        _ = try await source.anchor.initializeFirstCheckpoint(
            head: auditHead(5), legacyCutover: auditCutover, enrollment: true)
        _ = try await source.anchor.persistCheckpoint(head: auditHead(12))
        let sent = try await source.anchor.persistRetentionBoundary(auditRetention(through: 4))
        let password = "a transfer password"
        let contents = try await source.anchor.exportProtectedTransfer(password: password)
        let envelope = try JSONValue.parse(contents)
        #expect(envelope["format"] == .string("vision-audit-transfer"))
        #expect(envelope["kdf"] == .string("scrypt-n32768-r8-p1"))
        #expect(String(decoding: contents, as: UTF8.self).hasPrefix(#"{"format":"vision-audit-transfer","version":1,"#))

        await expectAnchorError("transfer_invalid_or_password") {
            _ = try await target.anchor.importProtectedTransfer(
                contents, password: "not the password at all", expectedCurrent: nil)
        }
        await expectAnchorError("transfer_password_invalid") {
            _ = try await target.anchor.importProtectedTransfer(contents, password: "short", expectedCurrent: nil)
        }
        await expectAnchorError("transfer_invalid") {
            _ = try await target.anchor.importProtectedTransfer(
                Data(count: AuditAnchor.transferMaximumBytes + 1), password: password, expectedCurrent: nil)
        }
        let fresh = try await target.anchor.initializeFirstCheckpoint(head: auditHead(1), legacyCutover: auditCutover)
        await expectAnchorError("transfer_target_not_fresh") {
            _ = try await target.anchor.importProtectedTransfer(contents, password: password, expectedCurrent: nil)
        }
        let received = try await target.anchor.importProtectedTransfer(
            contents, password: password,
            expectedCurrent: AuditCheckpoint(sequence: fresh.sequence, hash: fresh.headHash))
        #expect(received == sent)
        #expect(try target.read("checkpoint.json") == (try source.read("checkpoint.json")))
        #expect(target.witness.text == source.witness.text)
        #expect(!target.exists("key.before-transfer.enc"))
        #expect(!target.exists("checkpoint.before-transfer.json"))
    }

    @Test func anInterruptedImportRestoresThePreviousPair() async throws {
        let fixture = try AnchorFixture()
        let other = try AnchorFixture()
        defer {
            fixture.remove()
            other.remove()
        }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(3), legacyCutover: auditCutover)
        let previous = try await fixture.anchor.readTrustedCheckpoint()
        let previousKey = try fixture.read("key.enc")
        let previousReceipt = try fixture.read("checkpoint.json")
        // The import saved the journal and wrote the incoming receipt, then stopped
        // before the witness moved. The incoming receipt is another anchor's.
        _ = try await other.anchor.initializeFirstCheckpoint(head: auditHead(8), legacyCutover: auditCutover)
        try fixture.write("key.before-transfer.enc", previousKey)
        try fixture.write("checkpoint.before-transfer.json", previousReceipt)
        try fixture.write("checkpoint.json", try other.read("checkpoint.json"))
        let recovered = try await fixture.anchor.readTrustedCheckpoint()
        #expect(recovered.metadata == previous.metadata)
        #expect(try fixture.read("checkpoint.json") == previousReceipt)
        #expect(!fixture.exists("key.before-transfer.enc"))
        #expect(!fixture.exists("checkpoint.before-transfer.json"))
    }

    @Test func anImportThatReachedTheWitnessOnlyClearsTheJournal() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(3), legacyCutover: auditCutover)
        let current = try await fixture.anchor.readTrustedCheckpoint()
        try fixture.write("key.before-transfer.enc", "stale")
        try fixture.write("checkpoint.before-transfer.json", "stale")
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.metadata == current.metadata)
        #expect(!fixture.exists("key.before-transfer.enc"))
    }

    @Test func anUnrecoverableJournalIsImportIncomplete() async throws {
        let fixture = try AnchorFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(3), legacyCutover: auditCutover)
        fixture.witness.set(fixture.witness.text?.replacingOccurrences(of: #""sequence":3"#, with: #""sequence":2"#))
        try fixture.write("checkpoint.before-transfer.json", "stale")
        await expectAnchorError("transfer_import_incomplete") { _ = try await fixture.anchor.readTrustedCheckpoint() }
    }

    @Test func transferPasswordsCountUTF16CodeUnits() {
        #expect(!AuditAnchor.isValidTransferPassword(String(repeating: "a", count: 15)))
        #expect(AuditAnchor.isValidTransferPassword(String(repeating: "a", count: 16)))
        // Eight astral characters are sixteen UTF-16 code units, like JavaScript's length.
        #expect(AuditAnchor.isValidTransferPassword(String(repeating: "😀", count: 8)))
        #expect(AuditAnchor.isValidTransferPassword(String(repeating: "a", count: 1024)))
        #expect(!AuditAnchor.isValidTransferPassword(String(repeating: "a", count: 1025)))
    }
}

/// A wrapping-key store whose Keychain access can fail, as a Keychain error or a denied
/// access prompt does.
final class FailingWrappingKeyStore: AuditWrappingKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Data?
    private var failing = false

    func fail(_ value: Bool) { lock.withLock { failing = value } }

    func load() throws -> Data? {
        try lock.withLock {
            // errSecAuthFailed: the user denied the access prompt.
            if failing { throw KeychainError(status: -25293) }
            return key
        }
    }

    func loadOrCreate() throws -> Data {
        try lock.withLock {
            if failing { throw KeychainError(status: -25293) }
            if let key { return key }
            let created = try AuditKeyMaterial.randomKey()
            key = created
            return created
        }
    }
}

@Suite struct AuditKeyProtectionTests {
    @Test func aFailingKeychainIsSecureStorageUnavailable() async throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let store = FailingWrappingKeyStore()
        let anchor = try AuditAnchor(
            userDataDirectory: directory, keyProtector: NativeAuditKeyProtector(store: store),
            witness: MemoryAuditWitness())

        store.fail(true)
        await expectAnchorError("secure_storage_unavailable") {
            _ = try await anchor.initializeFirstCheckpoint(head: auditHead(5), legacyCutover: auditCutover)
        }
        #expect(!FileManager.default.fileExists(atPath: anchor.keyPath))

        store.fail(false)
        _ = try await anchor.initializeFirstCheckpoint(head: auditHead(5), legacyCutover: auditCutover)
        store.fail(true)
        // A denied read leaves the key in place: the protection is unavailable, not lost.
        await expectAnchorError("secure_storage_unavailable") { _ = try await anchor.readTrustedCheckpoint() }
        await expectAnchorError("secure_storage_unavailable") { _ = try await anchor.rotateKey() }

        store.fail(false)
        let trusted = try await anchor.readTrustedCheckpoint()
        #expect(trusted.sequence == 5)
    }

    @Test func aFailingKeychainLeavesANewClusterUnavailable() async throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let store = FailingWrappingKeyStore()
        store.fail(true)
        let anchor = try AuditAnchor(
            userDataDirectory: directory, keyProtector: NativeAuditKeyProtector(store: store),
            witness: MemoryAuditWitness())
        let backend = FakeAuditBackend()
        backend.answer(
            "verify",
            .object([
                "status": .string("unavailable"), "sequence": .int(4), "hash": .string(auditHash("head 4")),
                "legacyCutover": auditCutover,
                "legacyUnverified": .object([
                    "db_editor": .string("0"), "split": .string("0"), "retag": .string("0"),
                ]),
            ]))
        let runtime = AuditRuntime(anchor: anchor, transport: backend, newClusterCreatedThisLaunch: { true })
        let result = try await runtime.verifyAuditHistory(establishSession: true)
        #expect(result == .object(["status": .string("unavailable"), "reason": .string("secure_storage_unavailable")]))
    }

    @Test func theVn1KeyIsBoundToItsAuthenticatedData() throws {
        let store = MemoryWrappingKeyStore()
        let protector = NativeAuditKeyProtector(store: store)
        let encrypted = try protector.encrypt("a key")
        #expect(encrypted.starts(with: NativeAuditKeyProtector.prefix))
        #expect(try protector.decrypt(encrypted) == "a key")

        // The same wrapping key without the additional data does not open.
        let sealed = try AES.GCM.seal(
            Data("a key".utf8), using: SymmetricKey(data: try store.loadOrCreate()), nonce: AES.GCM.Nonce())
        var unbound = NativeAuditKeyProtector.prefix
        sealed.nonce.withUnsafeBytes { unbound.append(contentsOf: $0) }
        unbound.append(sealed.ciphertext)
        unbound.append(sealed.tag)
        let withoutAuthenticatedData = unbound
        #expect(throws: (any Error).self) { try protector.decrypt(withoutAuthenticatedData) }
    }
}

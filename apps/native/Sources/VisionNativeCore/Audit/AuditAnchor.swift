import CryptoKit
import Foundation

/// The local audit checkpoint of `packaging/electron/audit-anchor.ts`: an HMAC-signed
/// receipt (`audit-anchor/checkpoint.json`), its protected key (`audit-anchor/key.enc`)
/// and an independent Keychain witness. The receipt format, its MAC and the witness value
/// are Electron's byte for byte; only the key protection differs (`AuditKeyProtector`).
/// Callers verify the database chain separately (`AuditRuntime`).
public actor AuditAnchor {
    /// `TRANSFER_AAD`.
    static let transferAAD = Data("vision-audit-transfer-v1".utf8)
    /// `TRANSFER_MAX_BYTES`.
    public static let transferMaximumBytes = 16 * 1024
    public static let transferFormat = "vision-audit-transfer"
    public static let transferKDF = "scrypt-n32768-r8-p1"

    public nonisolated let directory: String
    public nonisolated let keyPath: String
    public nonisolated let receiptPath: String
    public nonisolated let transferOldKeyPath: String
    public nonisolated let transferOldReceiptPath: String
    private let keyProtector: (any AuditKeyProtector)?
    private let witness: any AuditWitness
    private let now: @Sendable () -> Date
    private var tail: Task<Void, Never>?

    /// The loaded, authenticated pair (`AnchorState`).
    struct State: Sendable {
        let key: Data
        let receipt: AuditReceipt
        let metadata: AuditAnchorMetadata

        var checkpoint: AuditCheckpoint { AuditCheckpoint(sequence: receipt.sequence, hash: receipt.hash) }

        /// `witnessValue`.
        var witnessValue: AuditWitnessValue {
            AuditWitnessValue(
                version: AuditReceipt.version, keyId: receipt.keyId, sequence: receipt.sequence, hash: receipt.hash,
                receiptHash: metadata.receiptHash)
        }
    }

    /// `createAuditAnchor`. `userDataDirectory` must be absolute; the files live in its
    /// `audit-anchor/` folder.
    public init(
        userDataDirectory: String, keyProtector: (any AuditKeyProtector)?, witness: any AuditWitness,
        now: @escaping @Sendable () -> Date = { Date() }
    ) throws {
        guard userDataDirectory.hasPrefix("/") else { throw AuditInputError("userDataDir must be an absolute path") }
        directory = PathUtilities.join(userDataDirectory, "audit-anchor")
        keyPath = PathUtilities.join(directory, "key.enc")
        receiptPath = PathUtilities.join(directory, "checkpoint.json")
        transferOldKeyPath = PathUtilities.join(directory, "key.before-transfer.enc")
        transferOldReceiptPath = PathUtilities.join(directory, "checkpoint.before-transfer.json")
        self.keyProtector = keyProtector
        self.witness = witness
        self.now = now
    }

    // MARK: - Helpers

    /// `serialize`: one mutating operation at a time, in call order.
    private func serialize<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task<T, Error> {
            await previous?.value
            return try await operation()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }

    /// `assertSecureStorage` (Vision Native runs only on macOS).
    private func requireProtector() throws -> any AuditKeyProtector {
        guard let keyProtector, keyProtector.isAvailable() else {
            throw AuditAnchorError("secure_storage_unavailable")
        }
        return keyProtector
    }

    private func readWitness() async throws -> JSONValue? {
        do {
            return try await witness.read()
        } catch {
            throw AuditAnchorError("witness_unavailable")
        }
    }

    /// A reload right after this anchor wrote both files; Electron failed with a
    /// `TypeError` if they vanished in between.
    private func requireLoaded(_ state: State?) throws -> State {
        guard let state else { throw AuditInputError("Audit anchor files disappeared") }
        return state
    }

    private func requireMatchingWitness(_ current: State) async throws -> State {
        let stored = try await readWitness()
        guard let stored, stored.isTruthy else { throw AuditAnchorError("witness_missing") }
        guard current.witnessValue.matches(stored) else { throw AuditAnchorError("witness_mismatch") }
        return current
    }

    private func createdAt() -> String { isoTimestamp(now()) }

    /// A protector failure (a Keychain error or a denied prompt) is
    /// `secure_storage_unavailable`, as a failing `safeStorage.encryptString` is in Electron.
    private func encryptedKey(_ key: Data) throws -> String {
        let protector = try requireProtector()
        let encrypted: Data
        do {
            encrypted = try protector.encrypt(key.base64EncodedString())
        } catch {
            throw AuditAnchorError("secure_storage_unavailable")
        }
        guard !encrypted.isEmpty else { throw AuditAnchorError("secure_storage_unavailable") }
        return encrypted.base64EncodedString()
    }

    private func writeReceipt(_ receipt: AuditReceipt) throws {
        try AuditFiles.atomicPrivateWrite(receiptPath, "\(receipt.serialized)\n")
    }

    /// `loadPair`.
    private func loadPair(verifyWitness: Bool = true, keyFile: String? = nil, receiptFile: String? = nil)
        async throws -> State?
    {
        let keyFile = keyFile ?? keyPath
        let receiptFile = receiptFile ?? receiptPath
        let hasKey = try AuditFiles.exists(keyFile)
        let hasReceipt = try AuditFiles.exists(receiptFile)
        if !hasKey && !hasReceipt {
            if let stored = try await readWitness(), stored.isTruthy {
                throw AuditAnchorError("local_anchor_missing")
            }
            return nil
        }
        guard hasKey else { throw AuditAnchorError("key_missing") }
        guard hasReceipt else { throw AuditAnchorError("receipt_missing") }
        let protector = try requireProtector()
        let key: Data
        do {
            let encoded = try AuditFiles.readRegular(keyFile)
            guard let encrypted = AuditJSON.base64Bytes(encoded) else { throw AuditAnchorError("key_unavailable") }
            let plaintext = try protector.decrypt(encrypted)
            key = AuditJSON.base64Bytes(plaintext) ?? Data()
        } catch let error as AuditAnchorError {
            throw error
        } catch {
            throw AuditAnchorError("key_unavailable")
        }
        guard key.count == 32 else { throw AuditAnchorError("key_unavailable") }
        let parsed: JSONValue
        do {
            parsed = try JSONValue.parse(Data(try AuditFiles.readRegular(receiptFile).utf8))
        } catch let error as AuditAnchorError {
            throw error
        } catch {
            throw AuditAnchorError("receipt_invalid")
        }
        let receipt = try AuditReceipt.parseStored(parsed)
        guard receipt.keyId == AuditKeyMaterial.keyId(key) else { throw AuditAnchorError("key_changed") }
        let expected = receipt.computeMAC(key: key)
        guard AuditKeyMaterial.constantTimeEqual(receipt.mac, expected), let macBytes = Data(auditHex: expected) else {
            throw AuditAnchorError("receipt_tampered")
        }
        var receiptId = "\(receipt.keyId):\(receipt.sequence)"
        if let retention = receipt.retention { receiptId += ":\(retention.through)" }
        let metadata = AuditAnchorMetadata(
            sequence: receipt.sequence, headHash: receipt.hash, anchorKind: AuditReceipt.anchorKind,
            receiptId: receiptId, receiptHash: receipt.receiptHash(macBytes: macBytes),
            enrollmentSequence: receipt.enrollmentSequence, retention: receipt.retention)
        let current = State(key: key, receipt: receipt, metadata: metadata)
        return verifyWitness ? try await requireMatchingWitness(current) : current
    }

    private func clearTransferJournal() throws {
        try AuditFiles.remove(transferOldKeyPath)
        try AuditFiles.remove(transferOldReceiptPath)
        try AuditFiles.syncDirectory(directory)
    }

    /// `recoverTransfer`: settles an import interrupted after it saved the previous pair.
    private func recoverTransfer() async throws {
        let hasOldKey = try AuditFiles.exists(transferOldKeyPath)
        let hasOldReceipt = try AuditFiles.exists(transferOldReceiptPath)
        if !hasOldKey && !hasOldReceipt { return }
        let stored = try await readWitness()
        func matches(_ candidate: State?) -> Bool {
            guard let candidate else { return false }
            return candidate.witnessValue.matches(stored)
        }
        let current: State? = (try? await loadPair(verifyWitness: false)) ?? nil
        if matches(current) {
            try clearTransferJournal()
            return
        }
        if hasOldKey && hasOldReceipt {
            let previous: State? =
                (try? await loadPair(
                    verifyWitness: false, keyFile: transferOldKeyPath, receiptFile: transferOldReceiptPath)) ?? nil
            if matches(previous) {
                try AuditFiles.atomicPrivateWrite(keyPath, try AuditFiles.readRegular(transferOldKeyPath))
                try AuditFiles.atomicPrivateWrite(receiptPath, try AuditFiles.readRegular(transferOldReceiptPath))
                try clearTransferJournal()
                return
            }
        }
        throw AuditAnchorError("transfer_import_incomplete")
    }

    private func load(verifyWitness: Bool = true) async throws -> State? {
        try await recoverTransfer()
        return try await loadPair(verifyWitness: verifyWitness)
    }

    // MARK: - Operations

    /// `initializeFirstCheckpoint`: the first receipt for `head`, unless one exists.
    /// `enrollment` signs the head as the accepted baseline of an existing history.
    public func initializeFirstCheckpoint(head: JSONValue?, legacyCutover: JSONValue?, enrollment: Bool = false)
        async throws -> AuditAnchorMetadata
    {
        try await serialize { [self] in
            try await self.performInitialize(head: head, legacyCutover: legacyCutover, enrollment: enrollment)
        }
    }

    private func performInitialize(head: JSONValue?, legacyCutover: JSONValue?, enrollment: Bool) async throws
        -> AuditAnchorMetadata
    {
        if let current = try await load() { return current.metadata }
        let initial = try AuditCheckpoint.parse(head)
        let cutover = try AuditLegacyCutover.parse(legacyCutover)
        _ = try requireProtector()
        let key = try AuditKeyMaterial.randomKey()
        // A partial first write is a hard error on restart, never a new key.
        try AuditFiles.atomicPrivateWrite(keyPath, try encryptedKey(key))
        let receipt = AuditReceipt(
            keyId: AuditKeyMaterial.keyId(key), sequence: initial.sequence, hash: initial.hash, legacyCutover: cutover,
            createdAt: createdAt(), enrollmentSequence: enrollment ? initial.sequence : nil
        ).signed(key: key)
        try writeReceipt(receipt)
        let initialized = try requireLoaded(try await load(verifyWitness: false))
        do {
            try await witness.create(initialized.witnessValue)
        } catch {
            throw AuditAnchorError("witness_unavailable")
        }
        return try requireLoaded(try await load()).metadata
    }

    /// `initializeGenesis`.
    public func initializeGenesis(legacyCutover: JSONValue?) async throws -> AuditAnchorMetadata {
        try await initializeFirstCheckpoint(
            head: AuditCheckpoint(sequence: 0, hash: AuditReceipt.genesisHash).jsonValue, legacyCutover: legacyCutover)
    }

    /// `readTrustedCheckpoint`.
    public func readTrustedCheckpoint() async throws -> AuditTrustedCheckpoint {
        guard let current = try await load() else { throw AuditAnchorError("uninitialized") }
        return AuditTrustedCheckpoint(
            sequence: current.receipt.sequence, hash: current.receipt.hash, legacyCutover: current.receipt.legacyCutover,
            retention: current.receipt.retention, metadata: current.metadata)
    }

    /// `persistCheckpoint`: advances the receipt to a newer head.
    public func persistCheckpoint(head: JSONValue?) async throws -> AuditAnchorMetadata {
        let next = try AuditCheckpoint.parse(head)
        return try await serialize { [self] in try await self.performPersist(next) }
    }

    private func performPersist(_ next: AuditCheckpoint) async throws -> AuditAnchorMetadata {
        guard let current = try await load() else { throw AuditAnchorError("uninitialized") }
        if next.sequence < current.checkpoint.sequence { throw AuditAnchorError("rollback") }
        if next.sequence == current.checkpoint.sequence {
            guard next.hash == current.checkpoint.hash else { throw AuditAnchorError("fork") }
            return current.metadata
        }
        let receipt = AuditReceipt(
            keyId: current.receipt.keyId, sequence: next.sequence, hash: next.hash,
            legacyCutover: current.receipt.legacyCutover, createdAt: createdAt(),
            enrollmentSequence: current.receipt.enrollmentSequence, retention: current.receipt.retention
        ).signed(key: current.key)
        try writeReceipt(receipt)
        try await replaceWitness()
        return try requireLoaded(try await load()).metadata
    }

    private func replaceWitness() async throws {
        do {
            let written = try requireLoaded(try await load(verifyWitness: false))
            try await witness.replace(written.witnessValue)
        } catch {
            throw AuditAnchorError("witness_unavailable")
        }
    }

    /// `persistRetentionBoundary`: signs a newer retention boundary into the receipt.
    public func persistRetentionBoundary(_ candidate: JSONValue?) async throws -> AuditAnchorMetadata {
        let retention = try AuditRetentionBoundary.parse(candidate)
        return try await serialize { [self] in try await self.performRetention(retention) }
    }

    private func performRetention(_ retention: AuditRetentionBoundary) async throws -> AuditAnchorMetadata {
        guard let current = try await load() else { throw AuditAnchorError("uninitialized") }
        let previous = current.receipt.retention
        let regressed = AuditRetentionBoundary.domains.contains { field, legacyField in
            retention.domainValue(field)
                < (previous?.domainValue(field) ?? current.receipt.legacyCutover.value(legacyField))
        }
        if retention.through >= current.receipt.sequence || retention.through <= (previous?.through ?? 0) || regressed {
            throw AuditAnchorError("retention_regression")
        }
        let receipt = AuditReceipt(
            keyId: current.receipt.keyId, sequence: current.receipt.sequence, hash: current.receipt.hash,
            legacyCutover: current.receipt.legacyCutover, createdAt: createdAt(),
            enrollmentSequence: current.receipt.enrollmentSequence, retention: retention
        ).signed(key: current.key)
        try writeReceipt(receipt)
        try await replaceWitness()
        return try requireLoaded(try await load()).metadata
    }

    public enum HeadStatus: String, Sendable {
        case anchored
        case aheadOfAnchor = "ahead_of_anchor"
    }

    /// `compareHead`.
    public func compareHead(_ head: JSONValue?) async throws -> (status: HeadStatus, checkpoint: AuditCheckpoint) {
        let current = try await readTrustedCheckpoint()
        let candidate = try AuditCheckpoint.parse(head)
        if candidate.sequence < current.sequence { throw AuditAnchorError("rollback") }
        if candidate.sequence == current.sequence && candidate.hash != current.hash { throw AuditAnchorError("fork") }
        return (
            candidate.sequence == current.sequence ? .anchored : .aheadOfAnchor,
            AuditCheckpoint(sequence: current.sequence, hash: current.hash)
        )
    }

    /// `requireTransferPassword`: 16 to 1024 UTF-16 code units, like JavaScript's `length`.
    public static func isValidTransferPassword(_ password: String) -> Bool {
        (16...1024).contains(password.utf16.count)
    }

    private static func requireTransferPassword(_ password: String) throws {
        guard isValidTransferPassword(password) else { throw AuditAnchorError("transfer_password_invalid") }
    }

    /// `deriveTransferKey`: scrypt N=32768, r=8, p=1 to 32 bytes.
    static func transferKey(password: String, salt: Data) throws -> SymmetricKey {
        SymmetricKey(
            data: try Scrypt.derive(password: Array(password.utf8), salt: Array(salt), parameters: Scrypt.v2, length: 32))
    }

    /// `exportProtectedTransfer`: the key and receipt, AES-256-GCM encrypted under a
    /// password, as the JSON envelope Electron writes (`.vat`).
    public func exportProtectedTransfer(password: String) async throws -> Data {
        try Self.requireTransferPassword(password)
        guard let current = try await load() else { throw AuditAnchorError("uninitialized") }
        let salt = Data(try BackupFiles.randomBytes(16))
        let nonce = Data(try BackupFiles.randomBytes(12))
        let plaintext = Data(
            OrderedJSON.object([("key", .string(current.key.base64EncodedString())), ("receipt", current.receipt.ordered)])
                .compact.utf8)
        let sealed = try AES.GCM.seal(
            plaintext, using: try Self.transferKey(password: password, salt: salt),
            nonce: try AES.GCM.Nonce(data: nonce), authenticating: Self.transferAAD)
        let envelope = OrderedJSON.object([
            ("format", .string(Self.transferFormat)), ("version", .int(1)), ("kdf", .string(Self.transferKDF)),
            ("salt", .string(salt.base64EncodedString())), ("nonce", .string(nonce.base64EncodedString())),
            ("ciphertext", .string(sealed.ciphertext.base64EncodedString())),
            ("tag", .string(sealed.tag.base64EncodedString())),
        ])
        return Data(envelope.compact.utf8)
    }

    /// Decrypts a transfer envelope; any failure is `transfer_invalid_or_password`.
    static func openTransfer(_ contents: Data, password: String) throws -> JSONValue {
        do {
            let envelope = try JSONValue.parse(contents)
            guard envelope.objectValue != nil, envelope["format"]?.stringValue == transferFormat,
                envelope["version"]?.intValue == 1, envelope["kdf"]?.stringValue == transferKDF
            else {
                throw AuditAnchorError("transfer_invalid_or_password")
            }
            func decode(_ field: String, length: Int? = nil) throws -> Data {
                guard let text = envelope[field]?.stringValue, let bytes = AuditJSON.base64Bytes(text),
                    length.map({ bytes.count == $0 }) ?? true
                else {
                    throw AuditAnchorError("transfer_invalid_or_password")
                }
                return bytes
            }
            let salt = try decode("salt", length: 16)
            let nonce = try decode("nonce", length: 12)
            let tag = try decode("tag", length: 16)
            let ciphertext = try decode("ciphertext")
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
            let plaintext = try AES.GCM.open(
                box, using: try transferKey(password: password, salt: salt), authenticating: transferAAD)
            return try JSONValue.parse(plaintext)
        } catch {
            throw AuditAnchorError("transfer_invalid_or_password")
        }
    }

    /// `importProtectedTransfer`: installs a transferred key and receipt. An existing
    /// anchor is replaced only when it is still the fresh checkpoint `expectedCurrent`;
    /// the previous pair is journalled so an interrupted import can be settled.
    public func importProtectedTransfer(_ contents: Data, password: String, expectedCurrent: AuditCheckpoint?)
        async throws -> AuditAnchorMetadata
    {
        try Self.requireTransferPassword(password)
        guard contents.count <= Self.transferMaximumBytes else { throw AuditAnchorError("transfer_invalid") }
        return try await serialize { [self] in
            try await self.performImport(contents, password: password, expectedCurrent: expectedCurrent)
        }
    }

    private func performImport(_ contents: Data, password: String, expectedCurrent: AuditCheckpoint?) async throws
        -> AuditAnchorMetadata
    {
        let current = try await load()
        if let current, current.checkpoint != expectedCurrent {
            throw AuditAnchorError("transfer_target_not_fresh")
        }
        let payload = try Self.openTransfer(contents, password: password)
        do {
            guard payload.objectValue != nil, let encodedKey = payload["key"]?.stringValue,
                let key = AuditJSON.base64Bytes(encodedKey)
            else {
                throw AuditInputError("key")
            }
            let receipt = try AuditReceipt.parseTransferred(payload["receipt"], key: key)
            let encrypted = try encryptedKey(key)
            if current != nil {
                try AuditFiles.atomicPrivateWrite(transferOldKeyPath, try AuditFiles.readRegular(keyPath))
                try AuditFiles.atomicPrivateWrite(transferOldReceiptPath, try AuditFiles.readRegular(receiptPath))
            }
            try AuditFiles.atomicPrivateWrite(keyPath, encrypted)
            try writeReceipt(receipt)
            let imported = try requireLoaded(try await loadPair(verifyWitness: false))
            if current != nil {
                try await witness.replace(imported.witnessValue)
            } else {
                try await witness.create(imported.witnessValue)
            }
            if current != nil { try clearTransferJournal() }
            return try requireLoaded(try await load()).metadata
        } catch {
            if current != nil { try await recoverTransfer() }
            if let anchorError = error as? AuditAnchorError { throw anchorError }
            throw AuditAnchorError("transfer_import_incomplete")
        }
    }

    /// `rotateKey`: a new key signs the same head; the witness follows.
    public func rotateKey() async throws -> AuditAnchorMetadata {
        try await serialize { [self] in try await self.performRotate() }
    }

    private func performRotate() async throws -> AuditAnchorMetadata {
        guard let current = try await load() else { throw AuditAnchorError("uninitialized") }
        _ = try requireProtector()
        let key = try AuditKeyMaterial.randomKey()
        let encrypted = try encryptedKey(key)
        let receipt = AuditReceipt(
            keyId: AuditKeyMaterial.keyId(key), sequence: current.receipt.sequence, hash: current.receipt.hash,
            legacyCutover: current.receipt.legacyCutover, createdAt: createdAt(),
            enrollmentSequence: current.receipt.enrollmentSequence, retention: current.receipt.retention
        ).signed(key: key)
        try AuditFiles.atomicPrivateWrite(keyPath, encrypted)
        try writeReceipt(receipt)
        try await replaceWitness()
        return try requireLoaded(try await load()).metadata
    }
}

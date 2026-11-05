import CryptoKit
import Darwin
import Foundation

/// One file of a directory fingerprint.
public struct FingerprintEntry: Codable, Equatable, Sendable {
    public let path: String
    public let size: UInt64
    public let sha256: String
}

/// `DirectorySwitchToken`: the fingerprint of the staged tree plus where the previous tree
/// was kept. Persisted as `pendingAttachmentSwitch` in the runtime marker.
public struct DirectorySwitchToken: Codable, Equatable, Sendable {
    public let count: Int
    public let digest: String
    public let entries: [FingerprintEntry]
    public let previousDirectory: String?
    public let destinationDirectory: String
}

/// The attachment-directory switch of `packaging/electron/runtime/native.ts`
/// (`directoryFingerprint`, `atomicReplaceDirectory`, `rollbackDirectorySwitch`,
/// `finalizeDirectorySwitch`) on the real file system.
public enum DirectorySwitch {
    public enum RollbackResult: Equatable, Sendable {
        case nothingToRollback
        case rolledBack(preservedFailedDirectory: String)
    }

    /// `directoryFingerprint`: every regular file below `root` with its size and SHA-256 in
    /// name order, and a digest over the list. A symlink anywhere fails; a missing root is empty.
    public static func fingerprint(_ root: String) throws -> (count: Int, digest: String, entries: [FingerprintEntry]) {
        var entries: [FingerprintEntry] = []
        try visit(root, relative: "", into: &entries)
        var json = "["
        for (index, entry) in entries.enumerated() {
            if index > 0 { json += "," }
            json += "{\"path\":\(BackupBundle.jsonString(entry.path)),\"size\":\(entry.size),\"sha256\":\"\(entry.sha256)\"}"
        }
        json += "]"
        let digest = SHA256.hash(data: Data(json.utf8)).map { String(format: "%02x", $0) }.joined()
        return (entries.count, digest, entries)
    }

    private static func visit(_ directory: String, relative: String, into entries: inout [FingerprintEntry]) throws {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory)
        } catch {
            if !BackupFiles.exists(directory) { return }
            throw error
        }
        for name in names.sorted() {
            let absolute = PathUtilities.join(directory, name)
            let childRelative = relative.isEmpty ? name : "\(relative)/\(name)"
            var status = stat()
            guard lstat(absolute, &status) == 0 else { continue }
            switch status.st_mode & S_IFMT {
            case S_IFLNK:
                throw BackupFailure("Attachment tree contains a symlink: \(childRelative)")
            case S_IFDIR:
                try visit(absolute, relative: childRelative, into: &entries)
            case S_IFREG:
                let hash = try sha256(absolute)
                entries.append(FingerprintEntry(path: childRelative, size: hash.bytes, sha256: hash.hex))
            default:
                continue
            }
        }
    }

    static func sha256(_ path: String) throws -> (bytes: UInt64, hex: String) {
        let handle = try BackupFiles.openForReading(path)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes: UInt64 = 0
        while true {
            let chunk = try BackupFiles.read(handle, upTo: BackupFiles.chunkSize)
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
            bytes += UInt64(chunk.count)
        }
        return (bytes, hasher.finalize().map { String(format: "%02x", $0) }.joined())
    }

    /// `fs.promises.cp(source, destination, { recursive: true })` into a new directory.
    static func copyTree(_ source: String, to destination: String) throws {
        BackupFiles.remove(destination)
        try FileManager.default.copyItem(atPath: source, toPath: destination)
    }

    /// `exportAttachments`: a fresh private copy of `source` (empty when it does not exist).
    public static func export(_ source: String, to destination: String) throws {
        BackupFiles.remove(destination)
        if BackupFiles.isDirectory(source) {
            try copyTree(source, to: destination)
            _ = chmod(destination, 0o700)
        } else if BackupFiles.exists(source) {
            throw BackupFailure("Attachment directory is not a directory: \(source)")
        } else {
            try BackupFiles.createDirectory(destination)
        }
        _ = try fingerprint(destination)
    }

    /// `atomicReplaceDirectory`: copies `source` to `<dest>.staging-<nonce>`, verifies the
    /// copy against the source fingerprint, renames the live tree to
    /// `<dest>.previous-<nonce>` and the staging tree into place. With `preservePrevious`
    /// the previous tree stays for rollback. `beforeSwitch` receives the switch token
    /// before either rename (ADR-207), so a journal written there covers every
    /// interruption point, including an absent old tree; when it throws, nothing is renamed.
    public static func replace(
        source: String, destination: String, preservePrevious: Bool, nonce: String,
        beforeSwitch: ((DirectorySwitchToken) throws -> Void)? = nil
    ) throws -> DirectorySwitchToken {
        let parent = PathUtilities.dirname(destination)
        let base = PathUtilities.basename(destination)
        let staging = PathUtilities.join(parent, "\(base).staging-\(nonce)")
        let previous = PathUtilities.join(parent, "\(base).previous-\(nonce)")
        try BackupFiles.createDirectory(parent)
        BackupFiles.remove(staging)
        try copyTree(source, to: staging)
        let sourceFingerprint = try fingerprint(source)
        let stagingFingerprint = try fingerprint(staging)
        guard sourceFingerprint.count == stagingFingerprint.count, sourceFingerprint.digest == stagingFingerprint.digest
        else {
            BackupFiles.remove(staging)
            throw BackupFailure("Attachment staging verification failed")
        }
        let hadDestination = BackupFiles.exists(destination)
        let token = DirectorySwitchToken(
            count: stagingFingerprint.count, digest: stagingFingerprint.digest, entries: stagingFingerprint.entries,
            previousDirectory: preservePrevious && hadDestination ? previous : nil, destinationDirectory: destination)
        do {
            try beforeSwitch?(token)
        } catch {
            BackupFiles.remove(staging)
            throw error
        }
        do {
            if hadDestination { try move(destination, previous) }
            try move(staging, destination)
            guard chmod(destination, 0o700) == 0 else { throw BackupFailure(String(cString: strerror(errno))) }
        } catch {
            BackupFiles.remove(staging)
            if hadDestination, !BackupFiles.exists(destination) { try? move(previous, destination) }
            throw error
        }
        if !preservePrevious { BackupFiles.remove(previous) }
        return token
    }

    static func move(_ source: String, _ destination: String) throws {
        guard rename(source, destination) == 0 else {
            throw BackupFailure("rename \(PathUtilities.basename(source)) failed: \(String(cString: strerror(errno)))")
        }
    }

    /// Whether `path` exists without following a final symlink; any error but ENOENT throws.
    static func entryExists(_ path: String) throws -> Bool {
        var status = stat()
        if lstat(path, &status) == 0 { return true }
        if errno == ENOENT { return false }
        throw BackupFailure("lstat \(PathUtilities.basename(path)) failed: \(String(cString: strerror(errno)))")
    }

    /// `rollbackDirectorySwitch`: keeps the restored tree as `<dest>.failed-<nonce>` and puts
    /// the previous tree back. Safe to repeat at every rename boundary of `replace`: a
    /// previous tree that is already gone while the destination exists means the rollback
    /// (or the switch) never moved it, so there is nothing to do; both trees missing is
    /// ambiguous and fails closed. A token without a previous tree moves the restored
    /// tree aside.
    public static func rollback(_ token: DirectorySwitchToken?, nonce: String) throws -> RollbackResult {
        guard let token, !token.destinationDirectory.isEmpty else { return .nothingToRollback }
        let destination = PathUtilities.normalize(token.destinationDirectory)
        let previous = token.previousDirectory.flatMap { $0.isEmpty ? nil : PathUtilities.normalize($0) }
        if let previous, PathUtilities.dirname(previous) != PathUtilities.dirname(destination) {
            throw BackupFailure("Attachment rollback directories must share a parent")
        }
        let destinationExists = try entryExists(destination)
        let previousExists = try previous.map(entryExists) ?? false
        if previous != nil, !previousExists {
            if !destinationExists { throw BackupFailure("Both attachment generations are missing") }
            return .nothingToRollback
        }
        let failed = "\(destination).failed-\(nonce)"
        if destinationExists { try move(destination, failed) }
        do {
            if let previous { try move(previous, destination) }
        } catch {
            if destinationExists { try? move(failed, destination) }
            throw error
        }
        return .rolledBack(preservedFailedDirectory: failed)
    }

    /// `finalizeDirectorySwitch`: removes the previous tree.
    @discardableResult
    public static func finalize(_ token: DirectorySwitchToken?) throws -> Bool {
        guard let previous = token?.previousDirectory, !previous.isEmpty else { return false }
        let path = PathUtilities.normalize(previous)
        if BackupFiles.exists(path) { try FileManager.default.removeItem(atPath: path) }
        return true
    }
}

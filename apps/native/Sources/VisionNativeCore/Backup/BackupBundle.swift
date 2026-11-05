import Darwin
import Foundation

/// A bundle opened for restore (`OpenedBundle`). `cleanup()` removes its temporary directory.
public struct OpenedBundle: Sendable {
    public let metadata: [String: JSONValue]
    public let dbSqlPath: String
    public let attachmentsDirectory: String?
    public let frontendState: JSONValue?
    public let temporaryDirectory: String

    public func cleanup() {
        BackupFiles.remove(temporaryDirectory)
    }
}

/// Vision backup bundles (`packaging/electron/backup/bundle.ts`): a zip archive
///
///     metadata.json        bundleVersion, schemaHead, appVersion, deviceId, createdAt, encrypted
///     db.sql               pg_dump plain SQL
///     attachments/         the attachments tree (when the runtime has one)
///     frontend-state.json  the localStorage snapshot { keys: { … } } (optional)
///
/// named `vision_backup_<deviceId>_<YYYY-MM-DD_HH-MM-SS>.visionbak`, optionally encrypted
/// with the v2 (GCM) format as `<name>.visionbak.enc`.
public enum BackupBundle {
    public static let encryptedMagicV1 = Array("VISIONBAK1".utf8)
    public static let encryptedMagicV2 = Array("VISIONBAK2".utf8)
    public static let bundleVersion = 1
    /// `MAX_RESTORE_BYTES`: 10 GiB of uncompressed output across all entries.
    public static let maximumRestoreBytes: UInt64 = 10 * 1024 * 1024 * 1024
    /// `MAX_RESTORE_ENTRIES`.
    public static let maximumRestoreEntries = 100_000

    /// The `decryptToTemp` options.
    public static let format = EncryptedFile.Format(
        retiredV1Magic: encryptedMagicV1,
        v2Magic: encryptedMagicV2,
        requiredError: "Invalid passphrase.",
        invalidError: "Invalid passphrase: unable to authenticate encrypted bundle.",
        invalidHeaderMessage: "Invalid encrypted bundle header.",
        unsupportedFormatMessage: "Bundle is not in a recognised encrypted format.")

    /// `new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)`.
    public static func fileTimestamp(_ date: Date) -> String {
        let iso = isoTimestamp(date)
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let underscored = iso.replacingOccurrences(of: "T", with: "_")
        return String(underscored.prefix(19))
    }

    public static func fileName(deviceId: String, date: Date) -> String {
        "vision_backup_\(deviceId)_\(fileTimestamp(date)).visionbak"
    }

    /// A JSON string literal, as `JSON.stringify` writes it.
    static func jsonString(_ value: String) -> String {
        (try? JSONValue.string(value).compactJSONString()) ?? "\"\""
    }

    /// `JSON.stringify(metadata, null, 2)` with Electron's field order.
    public static func metadataJSON(
        schemaHead: String, appVersion: String, deviceId: String, createdAt: String
    ) -> String {
        """
        {
          "bundleVersion": \(bundleVersion),
          "schemaHead": \(jsonString(schemaHead)),
          "appVersion": \(jsonString(appVersion)),
          "deviceId": \(jsonString(deviceId)),
          "createdAt": \(jsonString(createdAt)),
          "encrypted": false
        }
        """
    }

    /// `createBundle`: writes `<name>.partial` and renames it once the archive is complete,
    /// so an interrupted backup never leaves a truncated file at the restorable name.
    public static func create(
        destinationDirectory: String,
        deviceId: String,
        schemaHead: String?,
        appVersion: String?,
        dbSqlPath: String,
        attachmentsDirectory: String?,
        frontendState: JSONValue?,
        now: Date
    ) throws -> String {
        let bundlePath = PathUtilities.join(destinationDirectory, fileName(deviceId: deviceId, date: now))
        try BackupFiles.createDirectory(destinationDirectory, mode: 0o755)
        let partialPath = "\(bundlePath).partial"
        do {
            let writer = try ZipWriter(path: partialPath)
            let metadata = metadataJSON(
                schemaHead: (schemaHead?.isEmpty == false ? schemaHead : nil) ?? "",
                appVersion: (appVersion?.isEmpty == false ? appVersion : nil) ?? "unknown",
                deviceId: deviceId, createdAt: isoTimestamp(now))
            try writer.addData(name: "metadata.json", data: Data(metadata.utf8), modified: now)
            try writer.addFile(name: "db.sql", path: dbSqlPath)
            if let attachmentsDirectory, BackupFiles.exists(attachmentsDirectory) {
                try addTree(writer, root: attachmentsDirectory, prefix: "attachments")
            }
            if let frontendState, frontendState.isTruthy {
                try writer.addData(name: "frontend-state.json", data: try frontendState.serialized(), modified: now)
            }
            try writer.finish()
            guard rename(partialPath, bundlePath) == 0 else {
                throw BackupFailure("Could not rename the finished backup: \(String(cString: strerror(errno)))")
            }
        } catch {
            BackupFiles.remove(partialPath)
            throw error
        }
        return bundlePath
    }

    /// `archive.directory(dir, prefix)`: a directory entry for every subdirectory and a file
    /// entry for every regular file, in name order. A symlink fails the backup, like the
    /// attachment fingerprint.
    static func addTree(_ writer: ZipWriter, root: String, prefix: String) throws {
        guard BackupFiles.isDirectory(root) else { throw BackupFailure("Attachment directory is not a directory") }
        let names = try FileManager.default.contentsOfDirectory(atPath: root).sorted()
        for name in names {
            let path = PathUtilities.join(root, name)
            let entryName = "\(prefix)/\(name)"
            var status = stat()
            guard lstat(path, &status) == 0 else { continue }
            switch status.st_mode & S_IFMT {
            case S_IFDIR:
                try writer.addDirectory(
                    name: entryName + "/", modified: BackupFiles.modificationDate(path) ?? Date())
                try addTree(writer, root: path, prefix: entryName)
            case S_IFREG:
                try writer.addFile(name: entryName, path: path)
            case S_IFLNK:
                throw BackupFailure("Attachment tree contains a symlink: \(entryName)")
            default:
                continue
            }
        }
    }

    /// `encryptBundle`: `<bundle>.enc` in the v2 format, then removes the plain bundle.
    public static func encrypt(_ bundlePath: String, passphrase: String) throws -> String {
        guard !passphrase.isEmpty else { throw BackupFailure("encryptBundle requires a passphrase") }
        let encryptedPath = "\(bundlePath).enc"
        try EncryptedFile.encryptV2(
            source: bundlePath, destination: encryptedPath, passphrase: passphrase, magic: encryptedMagicV2)
        guard unlink(bundlePath) == 0 else {
            throw BackupFailure("Could not remove the unencrypted bundle: \(String(cString: strerror(errno)))")
        }
        return encryptedPath
    }

    /// `isBundleEncrypted`.
    public static func isEncrypted(_ path: String) -> Bool {
        EncryptedFile.isEncrypted(path, magics: [encryptedMagicV1, encryptedMagicV2])
    }

    /// `openBundle`: decrypts when needed, extracts into a private temporary directory with
    /// the zip-bomb and path-traversal guards, and parses metadata and frontend state.
    public static func open(_ bundlePath: String, passphrase: String?, temporaryParent: String? = nil) throws
        -> OpenedBundle
    {
        let temporary = try BackupFiles.makeTemporaryDirectory(prefix: "vision_restore_", in: temporaryParent)
        do {
            var zipPath = bundlePath
            if isEncrypted(bundlePath) {
                guard let passphrase, !passphrase.isEmpty else {
                    throw BackupFailure("This bundle is encrypted. Set a backup passphrase to restore it.")
                }
                let decrypted = PathUtilities.join(temporary, "bundle.visionbak")
                try EncryptedFile.decrypt(
                    encryptedPath: bundlePath, destinationPath: decrypted, passphrase: passphrase, format: format)
                zipPath = decrypted
            }
            let contents = PathUtilities.join(temporary, "contents")
            try BackupFiles.createDirectory(contents)
            try extract(zipPath, into: contents)
            if zipPath != bundlePath { BackupFiles.remove(zipPath) }

            let metadataPath = PathUtilities.join(contents, "metadata.json")
            guard BackupFiles.isRegularFile(metadataPath),
                let metadataData = FileManager.default.contents(atPath: metadataPath),
                let metadata = (try? JSONValue.parse(metadataData))?.objectValue
            else {
                throw BackupFailure("Bundle is missing metadata.json — file may be corrupt.")
            }
            let dbSqlPath = PathUtilities.join(contents, "db.sql")
            guard BackupFiles.exists(dbSqlPath) else {
                throw BackupFailure("Bundle is missing db.sql — file may be corrupt.")
            }
            let attachments = PathUtilities.join(contents, "attachments")
            var frontendState: JSONValue?
            let statePath = PathUtilities.join(contents, "frontend-state.json")
            if BackupFiles.isRegularFile(statePath), let data = FileManager.default.contents(atPath: statePath) {
                frontendState = try? JSONValue.parse(data)
            }
            return OpenedBundle(
                metadata: metadata, dbSqlPath: dbSqlPath,
                attachmentsDirectory: BackupFiles.exists(attachments) ? attachments : nil,
                frontendState: frontendState, temporaryDirectory: temporary)
        } catch {
            BackupFiles.remove(temporary)
            throw error
        }
    }

    /// `extractZip`: every entry below `destination`, at most `maximumRestoreEntries`
    /// entries and `maximumRestoreBytes` of actual output.
    static func extract(_ zipPath: String, into destination: String) throws {
        let reader = try ZipReader(path: zipPath)
        defer { reader.close() }
        guard reader.entries.count <= maximumRestoreEntries else {
            throw BackupFailure(
                "Restore bundle has too many entries (> \(maximumRestoreEntries)) — refusing to extract.")
        }
        let bombMessage =
            "Restore bundle exceeds the maximum uncompressed size (\(maximumRestoreBytes) bytes) — possible zip bomb."
        let total = TotalBytes()
        for entry in reader.entries {
            let target = PathUtilities.join(destination, entry.name)
            guard target.hasPrefix(destination + "/") || target == destination else {
                throw BackupFailure("Unsafe zip entry path: \(entry.name)")
            }
            if entry.isDirectory {
                try BackupFiles.createDirectory(target)
                continue
            }
            guard entry.uncompressedSize <= maximumRestoreBytes - total.value else {
                throw BackupFailure(bombMessage)
            }
            try BackupFiles.createDirectory(PathUtilities.dirname(target))
            guard !BackupFiles.isDirectory(target) else { throw BackupFailure("Unsafe zip entry path: \(entry.name)") }
            try reader.extract(entry, to: target) { count in
                total.value += UInt64(count)
                if total.value > maximumRestoreBytes { throw BackupFailure(bombMessage) }
            }
        }
    }

    private final class TotalBytes {
        var value: UInt64 = 0
    }
}

import Darwin
import Foundation

/// A bundle opened for restore (`OpenedBundle`). `cleanup()` removes its temporary directory.
public struct OpenedBundle: Sendable {
    public let metadata: [String: JSONValue]
    /// The extracted `db.sqlite3`.
    public let databasePath: String
    public let attachmentsDirectory: String?
    public let frontendState: JSONValue?
    public let temporaryDirectory: String

    public func cleanup() {
        BackupFiles.remove(temporaryDirectory)
    }
}

/// Facts about the snapshot that `metadata.json` records for restore checks
/// (`BundleDatabaseInfo`).
public struct BundleDatabaseInfo: Sendable, Equatable {
    /// Latest migration version in the snapshot's ledger.
    public let schemaVersion: Int
    /// SQLite library version that wrote the snapshot.
    public let sqliteVersion: String?
    /// SHA-256 of `db.sqlite3`; restore refuses a member that does not match.
    public let sha256: String?
    public let bytes: Int?

    public init(schemaVersion: Int, sqliteVersion: String?, sha256: String?, bytes: Int?) {
        self.schemaVersion = schemaVersion
        self.sqliteVersion = sqliteVersion
        self.sha256 = sha256
        self.bytes = bytes
    }

    public init(report: DatabaseFileReport) {
        self.init(
            schemaVersion: report.schemaVersion, sqliteVersion: report.sqliteVersion, sha256: report.sha256,
            bytes: report.bytes)
    }
}

/// Vision backup bundles (`packaging/electron/backup/bundle.ts`, format 2): a zip archive
///
///     metadata.json        bundle format, database schema version, app version, device id,
///                          timestamps, database checksum
///     db.sqlite3           a verified SQLite snapshot of the database (ADR-263)
///     attachments/         the attachments tree (when the runtime has one)
///     frontend-state.json  the localStorage snapshot { keys: { … } } (optional)
///
/// named `vision_backup_<deviceId>_<YYYY-MM-DD_HH-MM-SS>.visionbak`, optionally encrypted
/// with the v2 (GCM) format as `<name>.visionbak.enc`. Older bundle formats are refused
/// (`BACKUP_FORMAT_UNSUPPORTED`).
public enum BackupBundle {
    public static let encryptedMagicV1 = Array("VISIONBAK1".utf8)
    public static let encryptedMagicV2 = Array("VISIONBAK2".utf8)
    /// `BUNDLE_VERSION` (2: SQLite database).
    public static let bundleVersion = 2
    /// `BUNDLE_DATABASE_MEMBER`.
    public static let databaseMember = "db.sqlite3"
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

    private static func jsonStringOrNull(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "null" }
        return jsonString(value)
    }

    /// `JSON.stringify(metadata, null, 2)` with Electron's field order.
    public static func metadataJSON(
        database: BundleDatabaseInfo, appVersion: String, deviceId: String, createdAt: String
    ) -> String {
        """
        {
          "bundleVersion": \(bundleVersion),
          "database": "sqlite",
          "schemaVersion": \(database.schemaVersion),
          "sqliteVersion": \(jsonStringOrNull(database.sqliteVersion)),
          "databaseSha256": \(jsonStringOrNull(database.sha256)),
          "databaseBytes": \(database.bytes.map(String.init) ?? "null"),
          "appVersion": \(jsonString(appVersion)),
          "deviceId": \(jsonString(deviceId)),
          "createdAt": \(jsonString(createdAt)),
          "encrypted": false
        }
        """
    }

    /// `assertSqliteFile`: the member must start with the SQLite magic.
    static func assertSqliteFile(_ path: String) throws {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw BackupFailure("The backup database is not a SQLite database file.")
        }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: DatabaseStatistics.headerMagic.count)) ?? Data()
        guard head == DatabaseStatistics.headerMagic else {
            throw BackupFailure("The backup database is not a SQLite database file.")
        }
    }

    /// `createBundle`: writes `<name>.partial` and renames it once the archive is complete,
    /// so an interrupted backup never leaves a truncated file at the restorable name.
    public static func create(
        destinationDirectory: String,
        deviceId: String,
        appVersion: String?,
        databasePath: String,
        database: BundleDatabaseInfo,
        attachmentsDirectory: String?,
        frontendState: JSONValue?,
        now: Date
    ) throws -> String {
        guard database.schemaVersion >= 1 else {
            throw BackupFailure("createBundle requires the database schema version")
        }
        try assertSqliteFile(databasePath)
        let bundlePath = PathUtilities.join(destinationDirectory, fileName(deviceId: deviceId, date: now))
        try BackupFiles.createDirectory(destinationDirectory, mode: 0o755)
        let partialPath = "\(bundlePath).partial"
        do {
            let writer = try ZipWriter(path: partialPath)
            let metadata = metadataJSON(
                database: database,
                appVersion: (appVersion?.isEmpty == false ? appVersion : nil) ?? "unknown",
                deviceId: deviceId, createdAt: isoTimestamp(now))
            try writer.addData(name: "metadata.json", data: Data(metadata.utf8), modified: now)
            try writer.addFile(name: databaseMember, path: databasePath)
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

    /// `encryptBundle`: `<destinationDirectory>/<bundle name>.enc` in the v2 format through a
    /// `.partial` sidecar, so an interrupted write never leaves a truncated file at the
    /// restorable name, then removes the plain bundle. Building the plain bundle in a private
    /// staging directory and passing the backup folder as `destinationDirectory` keeps the
    /// unencrypted archive out of that folder (for example iCloud Drive).
    public static func encrypt(_ bundlePath: String, passphrase: String, destinationDirectory: String? = nil) throws
        -> String
    {
        guard !passphrase.isEmpty else { throw BackupFailure("encryptBundle requires a passphrase") }
        let directory = destinationDirectory ?? PathUtilities.dirname(bundlePath)
        try BackupFiles.createDirectory(directory, mode: 0o755)
        let encryptedPath = PathUtilities.join(directory, "\(PathUtilities.basename(bundlePath)).enc")
        let partialPath = "\(encryptedPath).partial"
        do {
            try EncryptedFile.encryptV2(
                source: bundlePath, destination: partialPath, passphrase: passphrase, magic: encryptedMagicV2)
            guard rename(partialPath, encryptedPath) == 0 else {
                throw BackupFailure("Could not rename the encrypted backup: \(String(cString: strerror(errno)))")
            }
        } catch {
            BackupFiles.remove(partialPath)
            throw error
        }
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
            // db.sqlite3 is required. A bundle of an older format holds no SQLite database
            // and is refused by its declared format.
            let databasePath = PathUtilities.join(contents, databaseMember)
            guard BackupFiles.exists(databasePath) else {
                if let format = metadata["bundleVersion"]?.intValue, format < bundleVersion {
                    throw NativeRuntimeError(
                        "BACKUP_FORMAT_UNSUPPORTED",
                        "This backup uses backup format \(format), which this version of Vision cannot restore.")
                }
                throw BackupFailure("Bundle is missing \(databaseMember) — file may be corrupt.")
            }
            let attachments = PathUtilities.join(contents, "attachments")
            var frontendState: JSONValue?
            let statePath = PathUtilities.join(contents, "frontend-state.json")
            if BackupFiles.isRegularFile(statePath), let data = FileManager.default.contents(atPath: statePath) {
                frontendState = try? JSONValue.parse(data)
            }
            return OpenedBundle(
                metadata: metadata, databasePath: databasePath,
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

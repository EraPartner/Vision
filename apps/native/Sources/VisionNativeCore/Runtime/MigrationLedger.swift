import Foundation

/// The migration version of a payload and of a database, ported from
/// `packagedMigrationVersion` and `PendingSchemaUpgrade` in
/// `packaging/electron/runtime/native.ts`.
///
/// Migrations are `db/migrations/NNNN_name.sql` files the backend applies in-process at boot
/// (ADR-263). Their numbers are the schema version: the database records the latest applied
/// one in its ledger and in the SQLite header's `user_version`. These names are persistence
/// contracts (packaging/AGENTS.md): change them only together with the Electron runtime.
public enum MigrationLedger {
    /// `packagedMigrationVersion`: the highest `NNNN_name.sql` version in a migrations
    /// directory (rollback files excluded); 0 when the directory is absent or holds none.
    public static func packagedVersion(migrationsDirectory: String, fileSystem: any RuntimeFileSystem) throws
        -> Int
    {
        let names: [String]
        do {
            names = try fileSystem.contentsOfDirectory(migrationsDirectory)
        } catch FileSystemError.notFound {
            return 0
        }
        var highest = 0
        for name in names where !name.hasSuffix(".down.sql") {
            guard let digits = PathUtilities.firstMatchGroups(name, #"^(\d{4})_[a-z0-9_]+\.sql$"#)?[1],
                let version = Int(digits)
            else { continue }
            highest = max(highest, version)
        }
        return highest
    }
}

/// A database the backend migrates forward at its next start (`PendingSchemaUpgrade`). The
/// backend writes its own pre-migration copy to `database/pre-migration-backups` first, so
/// the shell only reports it.
public struct PendingSchemaUpgrade: Sendable, Equatable {
    /// The schema version the live database records.
    public let databaseVersion: Int
    /// The newest migration this install ships.
    public let packagedVersion: Int

    public init(databaseVersion: Int, packagedVersion: Int) {
        self.databaseVersion = databaseVersion
        self.packagedVersion = packagedVersion
    }
}

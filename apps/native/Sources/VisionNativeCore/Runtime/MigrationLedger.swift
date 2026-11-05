import Foundation

/// The Kysely migration ledger (`public.kysely_migration`), ported from
/// `packaging/electron/runtime/native.ts` (`SCHEMA_LEDGER_SQL`, `SCHEMA_HEAD_SQL`,
/// `APPLIED_MIGRATIONS_SQL`, `migrationChainHead`, `preBaselineBackupError`).
///
/// Migrations are TypeScript/Kysely. The backend applies `VISION_RUNTIME_ROOT/db/migrations`
/// at boot; the schema version is the highest applied migration name. Names are zero-padded
/// `NNNN_name`, so text ordering is migration order. These strings are persistence contracts
/// (packaging/AGENTS.md): change them only together with the Electron runtime.
public enum MigrationLedger {
    /// Reports whether the ledger exists, so a missing table is not an error (`t` or `f`).
    public static let ledgerExistsSQL = "SELECT to_regclass('public.kysely_migration') IS NOT NULL;"
    public static let headSQL = "SELECT max(name) FROM public.kysely_migration;"
    public static let appliedSQL = "SELECT name FROM public.kysely_migration ORDER BY name;"

    /// `PRE_BASELINE_BACKUP_CODE`.
    public static let preBaselineBackupCode = "BACKUP_PRE_BASELINE"
    /// `PRE_BASELINE_BACKUP_MESSAGE`.
    public static let preBaselineBackupMessage =
        "This backup was taken before Vision switched to the TypeScript migration baseline. "
        + "Only backups taken after that switch can be restored."

    /// `preBaselineBackupError`: a backup without the Kysely ledger predates the squashed
    /// TypeScript baseline and is refused.
    public static func preBaselineBackupError() -> NativeRuntimeError {
        NativeRuntimeError(preBaselineBackupCode, "\(preBaselineBackupCode): \(preBaselineBackupMessage)")
    }

    /// `^(\d+)_` of a migration name, as `revisionNumericPrefix` in `backup/restore.ts`.
    public static func numericPrefix(_ name: String) -> Int? {
        guard let groups = PathUtilities.firstMatchGroups(name, #"^(\d+)_"#), let digits = groups[1] else {
            return nil
        }
        return Int(digits)
    }

    /// `migrationChainHead`: the highest `NNNN_name` migration in a `db/migrations` directory
    /// (rollback files excluded), or "" when the directory is absent or holds none.
    public static func chainHead(migrationsDirectory: String, fileSystem: any RuntimeFileSystem) throws -> String {
        let names: [String]
        do {
            names = try fileSystem.contentsOfDirectory(migrationsDirectory)
        } catch FileSystemError.notFound {
            return ""
        }
        return names
            .filter { PathUtilities.fullMatch($0, #"\d{4}_[a-z0-9_]+\.sql"#) }
            .filter { !$0.hasSuffix(".down.sql") }
            .map { String($0.dropLast(".sql".count)) }
            .max() ?? ""
    }
}

/// Migrations the packaged backend will apply to an existing database at boot
/// (`PendingMigrations`).
public struct PendingMigrations: Sendable, Equatable {
    /// Highest migration recorded in the database's ledger.
    public let appliedHead: String
    /// Highest migration shipped with this install.
    public let packagedHead: String

    public init(appliedHead: String, packagedHead: String) {
        self.appliedHead = appliedHead
        self.packagedHead = packagedHead
    }
}

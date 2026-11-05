import Foundation

/// The runtime operations backup and restore drive (`NativeBackupRuntime` in
/// `packaging/electron/backup/restore.ts`). `NativeRuntime` conforms; tests use a fake.
public protocol BackupRuntime: Sendable {
    /// `dumpDatabase(destination, { format: "plain" })`.
    func dumpDatabase(to destination: String) async throws
    /// `exportAttachments(destination)`: a copy of the attachments tree (empty when none).
    func exportAttachments(to destination: String) async throws
    /// `stop({ keepPostgres })`: the backend writer, and PostgreSQL unless `keepPostgres`.
    func stop(keepPostgres: Bool) async throws
    /// `getSchemaHead()`: the highest `public.kysely_migration` name of the live database.
    func schemaHead() async throws -> String
    /// `getLocalMigrationChainHead()`: the newest migration the installed payload carries;
    /// empty when it has no migration files.
    func migrationChainHead() async -> String
    /// `activateRestoredDatabase(source, { format, expectedSchemaHead })`: restores into a
    /// staging database, stops the backend and switches it in, keeping the previous one.
    func activateRestoredDatabase(_ path: String, format: RestoreFormat, expectedSchemaHead: String) async throws
        -> DatabaseSwitchToken
    /// `replaceAttachments(source, { preservePrevious: true })`.
    func replaceAttachments(from source: String) async throws -> DirectorySwitchToken
    /// `start()` then `waitUntilReady({ detailed: true })`.
    func startBackendAndWait() async throws
    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws
    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws
    func finalizeAttachmentSwitch(_ token: DirectorySwitchToken) async throws
    func rollbackAttachmentSwitch(_ token: DirectorySwitchToken) async throws
}

/// The dump formats `restoreIntoDatabase` accepts.
public enum RestoreFormat: String, Sendable, Equatable {
    case plain
    case custom
}

/// Schema-revision checks and the restore transaction of `restore.ts` and
/// `native-transport.ts`.
public enum BackupRestore {
    /// `revisionNumericPrefix`: the number of an `NNNN_name` migration.
    public static func revisionNumericPrefix(_ revision: String) -> Int? {
        MigrationLedger.numericPrefix(revision)
    }

    /// `assertBackupSchemaCompatible`: refuses a backup from a newer schema.
    public static func assertSchemaCompatible(_ candidate: String, current: String, noun: String = "backup") throws {
        guard let candidateNumber = revisionNumericPrefix(candidate),
            let currentNumber = revisionNumericPrefix(current), candidateNumber > currentNumber
        else {
            return
        }
        throw BackupFailure(
            "BUNDLE_SCHEMA_NEWER: This \(noun) was created on schema revision \"\(candidate)\" "
                + "but this Vision install is at \"\(current)\". Update Vision to a newer version and retry.")
    }

    private static let kyselyCopyPattern =
        #"^COPY\s+(?:"?public"?\.)?"?kysely_migration"?\s*\(\s*"?name"?\s*,[^)]*\)\s+FROM\s+stdin;"#
    private static let kyselyInsertPattern =
        #"^INSERT INTO\s+(?:"?public"?\.)?"?kysely_migration"?\s*(?:\([^)]*\)\s*)?VALUES\s*\('([^']+)'"#
    private static let anyCopyPattern = #"^COPY\s+\S.*\s+FROM\s+stdin;$"#

    /// `readDumpSchemaLedger`: the highest `public.kysely_migration` name of a plain dump,
    /// or "" when the dump has no ledger. A plain dump writes one COPY block per table, so
    /// the whole file is scanned, line by line. COPY rows are table data: only statements
    /// outside them are parsed, and the rows of the ledger's own COPY block are its names
    /// (the first tab-separated column). Throws when the file cannot be read.
    public static func readDumpSchemaLedger(_ path: String) throws -> String {
        let handle = try BackupFiles.openForReading(path)
        defer { try? handle.close() }
        let copy = try NSRegularExpression(pattern: kyselyCopyPattern, options: [.caseInsensitive])
        let insert = try NSRegularExpression(pattern: kyselyInsertPattern, options: [.caseInsensitive])
        let anyCopy = try NSRegularExpression(pattern: anyCopyPattern, options: [.caseInsensitive])
        enum CopyBlock { case kysely, other }
        var head = ""
        var block: CopyBlock?

        func record(_ name: String?) {
            if let name, !name.isEmpty, name > head { head = name }
        }

        func consume(_ rawLine: Data) {
            var line = String(decoding: rawLine, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }
            if let current = block {
                if line == "\\." {
                    block = nil
                } else if current == .kysely {
                    record(line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init))
                }
                return
            }
            let range = NSRange(line.startIndex..., in: line)
            if copy.firstMatch(in: line, range: range) != nil {
                block = .kysely
            } else if anyCopy.firstMatch(in: line, range: range) != nil {
                block = .other
            } else if let match = insert.firstMatch(in: line, range: range), let value = Range(match.range(at: 1), in: line) {
                record(String(line[value]))
            }
        }

        var pending = Data()
        while true {
            let chunk = try BackupFiles.read(handle, upTo: 256 * 1024)
            if chunk.isEmpty { break }
            pending.append(chunk)
            var start = pending.startIndex
            while let newline = pending[start...].firstIndex(of: 0x0A) {
                consume(Data(pending[start..<newline]))
                start = newline + 1
            }
            pending = Data(pending[start...])
        }
        if !pending.isEmpty { consume(pending) }
        return head
    }

    /// `assertPostBaselineBackup`: a dump without the Kysely ledger predates the
    /// TypeScript migration baseline and is refused (`BACKUP_PRE_BASELINE`).
    public static func assertPostBaselineBackup(_ head: String) throws -> String {
        if head.isEmpty { throw MigrationLedger.preBaselineBackupError() }
        return head
    }

    /// `rollbackNativeRestore`: attachments, then the database, then (unless the database
    /// switch could not be recovered) a backend restart. Returns the rollback failures.
    static func rollback(
        _ runtime: any BackupRuntime, databaseSwitch: DatabaseSwitchToken?, attachmentSwitch: DirectorySwitchToken?,
        restart: Bool
    ) async -> [Error] {
        var errors: [Error] = []
        if let attachmentSwitch {
            do { try await runtime.rollbackAttachmentSwitch(attachmentSwitch) } catch { errors.append(error) }
        }
        if let databaseSwitch {
            do {
                try await runtime.rollbackDatabaseSwitch(try JSONValue(encoding: databaseSwitch))
            } catch {
                errors.append(error)
            }
        }
        if restart {
            do { try await runtime.startBackendAndWait() } catch { errors.append(error) }
        }
        return errors
    }

    private static func restartsAfter(_ error: Error) -> Bool {
        (error as? NativeRuntimeError)?.code != "DATABASE_SWITCH_RECOVERY_FAILED"
    }

    /// `restoreNativeDatabase`: a database-only restore (legacy SQL files).
    public static func restoreDatabase(
        _ runtime: any BackupRuntime, source: String, format: RestoreFormat, expectedSchemaHead: String?,
        log: @Sendable (String) -> Void = { _ in }
    ) async throws {
        var databaseSwitch: DatabaseSwitchToken?
        do {
            let token = try await runtime.activateRestoredDatabase(
                source, format: format, expectedSchemaHead: expectedSchemaHead ?? "")
            databaseSwitch = token
            try await runtime.startBackendAndWait()
            try await runtime.finalizeDatabaseSwitch(token)
        } catch {
            let failures = await rollback(
                runtime, databaseSwitch: databaseSwitch, attachmentSwitch: nil, restart: restartsAfter(error))
            for failure in failures { log("restore rollback failed: \(backupErrorMessage(failure))") }
            throw error
        }
    }

    /// `restoreNativeBundle`: database, then attachments, restart and readiness, then the
    /// database finalization as the commit point. Removing the previous attachment tree
    /// afterwards is cleanup only; its failure is returned as a warning.
    public static func restoreBundle(
        _ runtime: any BackupRuntime, dbSqlPath: String, attachmentsDirectory: String?, expectedSchemaHead: String?,
        log: @Sendable (String) -> Void = { _ in }
    ) async throws -> String? {
        var databaseSwitch: DatabaseSwitchToken?
        var attachmentSwitch: DirectorySwitchToken?
        do {
            let token = try await runtime.activateRestoredDatabase(
                dbSqlPath, format: .plain, expectedSchemaHead: expectedSchemaHead ?? "")
            databaseSwitch = token
            if let attachmentsDirectory {
                attachmentSwitch = try await runtime.replaceAttachments(from: attachmentsDirectory)
            }
            try await runtime.startBackendAndWait()
            try await runtime.finalizeDatabaseSwitch(token)
        } catch {
            let failures = await rollback(
                runtime, databaseSwitch: databaseSwitch, attachmentSwitch: attachmentSwitch,
                restart: restartsAfter(error))
            for failure in failures { log("restore rollback failed: \(backupErrorMessage(failure))") }
            throw error
        }
        guard let attachmentSwitch else { return nil }
        do {
            try await runtime.finalizeAttachmentSwitch(attachmentSwitch)
            return nil
        } catch {
            return backupErrorMessage(error)
        }
    }

    /// `String(value)` of an untrusted metadata field, for `schemaHead`.
    static func javaScriptString(_ value: JSONValue) -> String {
        switch value {
        case .string(let text): return text
        case .int(let number): return String(number)
        case .double(let number): return number == number.rounded() && abs(number) < 1e21 ? String(Int(number)) : String(number)
        case .bool(let flag): return flag ? "true" : "false"
        case .null: return "null"
        case .array(let items): return items.map(javaScriptString).joined(separator: ",")
        case .object: return "[object Object]"
        }
    }
}

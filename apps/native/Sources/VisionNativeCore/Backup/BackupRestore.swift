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
    /// `getSchemaHead()`: the highest Alembic revision of the live database.
    func schemaHead() async throws -> String
    /// `getLocalMigrationChainHead()`: the newest revision the installed payload carries;
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
    /// `revisionNumericPrefix`.
    public static func revisionNumericPrefix(_ revision: String) -> Int? {
        let digits = revision.prefix { $0.isASCII && $0.isNumber }
        return digits.isEmpty ? nil : Int(digits)
    }

    /// `pickHighestRevision`: the highest numeric prefix, ties broken by the larger string.
    public static func pickHighestRevision(_ revisions: [String]) -> String {
        let rows = revisions.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard var best = rows.first else { return "" }
        for candidate in rows.dropFirst() {
            let candidatePrefix = revisionNumericPrefix(candidate)
            let bestPrefix = revisionNumericPrefix(best)
            if let candidatePrefix, bestPrefix.map({ candidatePrefix > $0 }) ?? true {
                best = candidate
            } else if candidatePrefix == bestPrefix, candidate > best {
                best = candidate
            }
        }
        return best
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

    private static let copyPattern =
        #"^COPY\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*\("?version_num"?\)\s+FROM\s+stdin;"#
    private static let insertPattern =
        #"^INSERT INTO\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*(?:\("?version_num"?\)\s*)?VALUES\s*\('([^']+)'\)"#

    /// `readDumpSchemaHead`: the `alembic_version` row of a plain dump, read line by line
    /// until it is found; empty when there is none or the file cannot be read.
    public static func readDumpSchemaHead(_ path: String) -> String {
        guard let handle = try? BackupFiles.openForReading(path) else { return "" }
        defer { try? handle.close() }
        let copy = try? NSRegularExpression(pattern: copyPattern, options: [.caseInsensitive])
        let insert = try? NSRegularExpression(pattern: insertPattern, options: [.caseInsensitive])
        var buffer = Data()
        var inCopyBlock = false
        var reachedEnd = false

        func check(_ rawLine: Data) -> String? {
            var line = String(decoding: rawLine, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }
            if inCopyBlock {
                let value = line.trimmingCharacters(in: .whitespaces)
                return value == "\\." ? "" : value
            }
            let range = NSRange(line.startIndex..., in: line)
            if copy?.firstMatch(in: line, range: range) != nil {
                inCopyBlock = true
                return nil
            }
            if let match = insert?.firstMatch(in: line, range: range), let value = Range(match.range(at: 1), in: line) {
                return String(line[value])
            }
            return nil
        }

        var start = 0
        while true {
            if let newline = buffer[start...].firstIndex(of: 0x0A) {
                let line = buffer[start..<newline]
                start = newline + 1
                if let found = check(Data(line)) { return found }
                continue
            }
            if reachedEnd {
                if start < buffer.count, let found = check(Data(buffer[start...])) { return found }
                return ""
            }
            guard let chunk = try? BackupFiles.read(handle, upTo: 256 * 1024), !chunk.isEmpty else {
                reachedEnd = true
                continue
            }
            buffer = Data(buffer[start...]) + chunk
            start = 0
        }
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

    /// `markRollbackErrors`: a failed rollback makes the audit recovery unsafe, so
    /// `restoreWithAuditRecovery` does not offer it.
    private static func marked(_ error: Error, rollbackFailures: [Error]) -> Error {
        guard !rollbackFailures.isEmpty, var audit = error as? AuditRestoreError else { return error }
        audit.recoveryUnsafe = true
        return audit
    }

    /// `restoreNativeDatabase`: a database-only restore (legacy SQL files). With `audit`,
    /// the live closure pauses for the switch and the restored history must verify
    /// (`assertRestoredAuditHistory`) before the switch is finalized.
    public static func restoreDatabase(
        _ runtime: any BackupRuntime, source: String, format: RestoreFormat, expectedSchemaHead: String?,
        audit: (any AuditRestoreGuard)? = nil, allowUnverifiedAudit: Bool = false,
        log: @Sendable (String) -> Void = { _ in }
    ) async throws {
        var databaseSwitch: DatabaseSwitchToken?
        await audit?.pauseAuditClosure()
        do {
            let token = try await runtime.activateRestoredDatabase(
                source, format: format, expectedSchemaHead: expectedSchemaHead ?? "")
            databaseSwitch = token
            try await runtime.startBackendAndWait()
            if let audit { _ = try await audit.assertRestoredAuditHistory(allowUnverifiedAudit: allowUnverifiedAudit) }
            try await runtime.finalizeDatabaseSwitch(token)
        } catch {
            let failures = await rollback(
                runtime, databaseSwitch: databaseSwitch, attachmentSwitch: nil, restart: restartsAfter(error))
            for failure in failures { log("restore rollback failed: \(backupErrorMessage(failure))") }
            await audit?.resumeAuditClosure()
            throw marked(error, rollbackFailures: failures)
        }
        await audit?.resumeAuditClosure()
    }

    /// `restoreNativeBundle`: database, then attachments, restart and readiness, then the
    /// database finalization as the commit point. Removing the previous attachment tree
    /// afterwards is cleanup only; its failure is returned as a warning.
    public static func restoreBundle(
        _ runtime: any BackupRuntime, dbSqlPath: String, attachmentsDirectory: String?, expectedSchemaHead: String?,
        audit: (any AuditRestoreGuard)? = nil, allowUnverifiedAudit: Bool = false,
        log: @Sendable (String) -> Void = { _ in }
    ) async throws -> String? {
        var databaseSwitch: DatabaseSwitchToken?
        var attachmentSwitch: DirectorySwitchToken?
        await audit?.pauseAuditClosure()
        do {
            let token = try await runtime.activateRestoredDatabase(
                dbSqlPath, format: .plain, expectedSchemaHead: expectedSchemaHead ?? "")
            databaseSwitch = token
            if let attachmentsDirectory {
                attachmentSwitch = try await runtime.replaceAttachments(from: attachmentsDirectory)
            }
            try await runtime.startBackendAndWait()
            if let audit { _ = try await audit.assertRestoredAuditHistory(allowUnverifiedAudit: allowUnverifiedAudit) }
            try await runtime.finalizeDatabaseSwitch(token)
        } catch {
            let failures = await rollback(
                runtime, databaseSwitch: databaseSwitch, attachmentSwitch: attachmentSwitch,
                restart: restartsAfter(error))
            for failure in failures { log("restore rollback failed: \(backupErrorMessage(failure))") }
            await audit?.resumeAuditClosure()
            throw marked(error, rollbackFailures: failures)
        }
        await audit?.resumeAuditClosure()
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

import Foundation

/// The runtime operations backup and restore drive (`NativeBackupRuntime` in
/// `packaging/electron/backup/restore.ts` and `NativeRestoreRuntime` in
/// `native-transport.ts`). `NativeRuntime` conforms; tests use a fake.
public protocol BackupRuntime: Sendable {
    /// `snapshotDatabase(destination)`: a verified consistent copy of the live database.
    func snapshotDatabase(to destination: String) async throws -> DatabaseFileReport
    /// `exportAttachments(destination)`: a copy of the attachments tree (empty when none).
    func exportAttachments(to destination: String) async throws
    /// `stop()`: the backend, the only writer of the database file.
    func stop() async throws
    /// The newest migration the installed payload carries (`getLocalMigrationVersion`); 0
    /// when it has none.
    func packagedMigrationVersion() async -> Int
    /// `activateRestoredDatabase(source, { expectedSchemaVersion, expectedSha256 })`: stages
    /// and verifies the file as the next database generation, stops the backend and
    /// switches it in, keeping the previous generation.
    func activateRestoredDatabase(_ path: String, expectedSchemaVersion: Int?, expectedSha256: String?) async throws
        -> DatabaseActivation
    /// `replaceAttachments(source, { preservePrevious: true })`.
    func replaceAttachments(from source: String) async throws -> DirectorySwitchToken
    /// `start()`, without waiting for readiness (a rollback's restart).
    func startBackend() async throws
    /// `start()` then `waitUntilReady({ detailed: true })`.
    func startBackendAndWait() async throws
    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws
    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws
    func finalizeAttachmentSwitch(_ token: DirectorySwitchToken) async throws
    func rollbackAttachmentSwitch(_ token: DirectorySwitchToken) async throws
}

/// Schema checks and the restore transaction of `restore.ts` and `native-transport.ts`.
public enum BackupRestore {
    /// `assertBackupSchemaCompatible`: refuses a backup from a newer schema with the marker
    /// the screens turn into an "update Vision" message. Restore verification enforces the
    /// same rule on the database itself.
    public static func assertSchemaCompatible(_ candidate: Int, current: Int, noun: String = "backup") throws {
        guard current > 0, candidate > current else { return }
        throw BackupFailure(
            "BUNDLE_SCHEMA_NEWER: This \(noun) was created on schema version \(candidate) "
                + "but this Vision install is at \(current). Update Vision to a newer version and retry.")
    }

    /// `metadataSchemaVersion`: metadata.json is untrusted, so only a positive integer
    /// becomes a restore expectation.
    public static func metadataSchemaVersion(_ metadata: [String: JSONValue]) -> Int? {
        guard let value = metadata["schemaVersion"]?.intValue, value > 0 else { return nil }
        return value
    }

    /// `metadataSha256`.
    public static func metadataSha256(_ metadata: [String: JSONValue]) -> String? {
        guard let value = metadata["databaseSha256"]?.stringValue, PathUtilities.isSHA256(value) else { return nil }
        return value
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
            do { try await runtime.startBackend() } catch { errors.append(error) }
        }
        return errors
    }

    private static func restartsAfter(_ error: Error) -> Bool {
        (error as? NativeRuntimeError)?.code != "DATABASE_SWITCH_RECOVERY_FAILED"
    }

    /// `restoreNativeDatabase`: a bare database file.
    public static func restoreDatabase(
        _ runtime: any BackupRuntime, source: String, expectedSchemaVersion: Int? = nil,
        expectedSha256: String? = nil, log: @Sendable (String) -> Void = { _ in }
    ) async throws {
        var databaseSwitch: DatabaseSwitchToken?
        do {
            let activation = try await runtime.activateRestoredDatabase(
                source, expectedSchemaVersion: expectedSchemaVersion, expectedSha256: expectedSha256)
            databaseSwitch = activation.switchToken
            try await runtime.startBackendAndWait()
            try await runtime.finalizeDatabaseSwitch(activation.switchToken)
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
        _ runtime: any BackupRuntime, databasePath: String, attachmentsDirectory: String?,
        expectedSchemaVersion: Int?, expectedSha256: String?, log: @Sendable (String) -> Void = { _ in }
    ) async throws -> String? {
        var databaseSwitch: DatabaseSwitchToken?
        var attachmentSwitch: DirectorySwitchToken?
        do {
            let activation = try await runtime.activateRestoredDatabase(
                databasePath, expectedSchemaVersion: expectedSchemaVersion, expectedSha256: expectedSha256)
            databaseSwitch = activation.switchToken
            if let attachmentsDirectory {
                attachmentSwitch = try await runtime.replaceAttachments(from: attachmentsDirectory)
            }
            try await runtime.startBackendAndWait()
            try await runtime.finalizeDatabaseSwitch(activation.switchToken)
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
}

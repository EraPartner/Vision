import Foundation

/// The runtime half a consistent backup capture drives (`SnapshotRuntime` in
/// `packaging/electron/backup/quiescent-snapshot.ts`).
public protocol SnapshotRuntime: Sendable {
    /// `pauseAuditClosure`: no closure starts, and the running one is awaited.
    func pauseAuditClosure() async
    func stop(keepPostgres: Bool) async throws
    /// `start()` then `waitUntilReady({ detailed: true })`.
    func startBackendAndWait() async throws
    func resumeAuditClosure() async
}

/// `captureQuiescentSnapshot` (ADR-207): the audit closure is drained and paused and the
/// backend writer stopped (PostgreSQL keeps running for the dump), so the SQL, the
/// attachments and the schema head describe one application state. The backend restarts
/// and must reach detailed readiness even when the capture failed; a failed restart is
/// the error then. The audit pause is always released, which preserves the existing
/// trusted session across this intentional pause.
public enum QuiescentSnapshot {
    public static func capture<T: Sendable>(
        _ runtime: any SnapshotRuntime, _ capture: @Sendable () async throws -> T
    ) async throws -> T {
        await runtime.pauseAuditClosure()
        let captured: Result<T, Error>
        do {
            try await runtime.stop(keepPostgres: true)
            captured = .success(try await capture())
        } catch {
            captured = .failure(error)
        }
        // A failed dump or partial stop must not leave the application stopped.
        do {
            try await runtime.startBackendAndWait()
        } catch {
            await runtime.resumeAuditClosure()
            throw error
        }
        await runtime.resumeAuditClosure()
        return try captured.get()
    }
}

/// The native runtime and this launch's audit hooks as one `SnapshotRuntime`; without
/// audit protection only the backend is paused.
struct BackupSnapshotRuntime: SnapshotRuntime {
    let runtime: any BackupRuntime
    let audit: (any AuditRestoreGuard)?

    func pauseAuditClosure() async { await audit?.pauseAuditClosure() }
    func stop(keepPostgres: Bool) async throws { try await runtime.stop(keepPostgres: keepPostgres) }
    func startBackendAndWait() async throws { try await runtime.startBackendAndWait() }
    func resumeAuditClosure() async { await audit?.resumeAuditClosure() }
}

/// What the app does around a native backup, restore or update (`beginNativeMaintenance`
/// and `endNativeMaintenance` with the health watchdog in `packaging/electron/main.ts`):
/// `willBeginSnapshot` pauses the watchdog and tells the page that changes are briefly
/// paused; `didEndSnapshot` restarts the watchdog and announces the backend again once it
/// answers.
public struct BackupMaintenanceHooks: Sendable {
    public var willBeginSnapshot: @Sendable () async -> Void
    public var didEndSnapshot: @Sendable () async -> Void

    public init(
        willBeginSnapshot: @escaping @Sendable () async -> Void = {},
        didEndSnapshot: @escaping @Sendable () async -> Void = {}
    ) {
        self.willBeginSnapshot = willBeginSnapshot
        self.didEndSnapshot = didEndSnapshot
    }
}

import Darwin
import Foundation

/// A warning dialog with Cancel as the default button (`defaultId: 1, cancelId: 1`).
public struct AuditConfirmation: Equatable, Sendable {
    public var title: String
    public var message: String
    public var detail: String?
    public var confirmLabel: String
    public var cancelLabel: String

    public init(title: String, message: String, detail: String? = nil, confirmLabel: String, cancelLabel: String) {
        self.title = title
        self.message = message
        self.detail = detail
        self.confirmLabel = confirmLabel
        self.cancelLabel = cancelLabel
    }
}

/// A save or open panel for the audit channels.
public struct AuditFilePanel: Equatable, Sendable {
    public var title: String
    public var defaultName: String?
    public var filterName: String
    public var extensions: [String]
}

/// What the audit channels need from the app: dialogs, panels and notices.
@MainActor
public protocol AuditShell: AnyObject {
    var strings: ShellStrings { get }
    func confirm(_ confirmation: AuditConfirmation) async -> Bool
    /// The chosen path, `nil` when cancelled.
    func chooseSaveLocation(_ panel: AuditFilePanel) async -> String?
    /// The one chosen file, `nil` when cancelled.
    func chooseFile(_ panel: AuditFilePanel) async -> String?
    /// `notify`: shows an audit notice to the user.
    func showAuditNotice(_ message: String)
}

/// `reportAuditStatus`: "verified" clears the notice; any other status is shown once
/// until it changes.
public struct AuditNoticeState: Equatable, Sendable {
    public private(set) var last: String?

    public init() {}

    /// The notice key to show, or `nil`.
    public mutating func report(_ status: String?) -> String? {
        if status == "verified" {
            last = nil
            return nil
        }
        let value = status ?? "undefined"
        if last == value { return nil }
        last = value
        return status == "failed" ? "app.auditFailed" : "app.auditUnavailable"
    }

    public static func message(_ key: String, strings: ShellStrings) -> String {
        key == "app.auditFailed"
            ? strings.t(
                key,
                fallback: "Audit integrity check failed. Review the audit status before trusting recent changes.")
            : strings.t(
                key,
                fallback:
                    "Audit integrity protection is unavailable. Your data remains accessible, but changes cannot be independently verified."
            )
    }
}

/// The six `electronAudit` channels and the audit side of launch, restore and the closure
/// timer, as the handlers in `packaging/electron/main.ts` implement them.
@MainActor
public final class AuditChannels {
    /// `MAX_AUDIT_STARTUP_RETRIES`.
    public static let maximumStartupRetries = 5
    /// The closure timer interval (30 s).
    public static let closureInterval: Duration = .seconds(30)

    private let runtimeProvider: @Sendable () async -> AuditRuntime?
    private weak var shell: (any AuditShell)?
    private var notices = AuditNoticeState()
    private var closureTask: Task<Void, Never>?
    private var startupRetries = 0
    private let log: @Sendable (String) -> Void

    public init(
        runtimeProvider: @escaping @Sendable () async -> AuditRuntime?, shell: any AuditShell,
        log: @escaping @Sendable (String) -> Void
    ) {
        self.runtimeProvider = runtimeProvider
        self.shell = shell
        self.log = log
    }

    private var strings: ShellStrings { shell?.strings ?? ShellStrings(language: .en, table: [:]) }

    private static let unavailable = JSONValue.object(["success": .bool(false), "status": .string("unavailable")])
    private static let cancelled = JSONValue.object(["success": .bool(false), "cancelled": .bool(true)])

    private static func failed(_ fields: [String: JSONValue]) -> JSONValue {
        var result: [String: JSONValue] = ["success": .bool(false), "status": .string("failed")]
        for (key, value) in fields { result[key] = value }
        return .object(result)
    }

    /// `errorField(error, "message") || String(error)`.
    static func message(_ error: Error) -> String {
        backupErrorMessage(error)
    }

    /// `errorField(error, "code")`.
    static func code(_ error: Error) -> String? {
        switch error {
        case let anchor as AuditAnchorError: return anchor.code
        case let runtime as NativeRuntimeError: return runtime.code
        case let restore as AuditRestoreError: return restore.code
        default: return nil
        }
    }

    /// `reportAuditStatus`.
    public func report(_ status: String?) {
        guard let key = notices.report(status) else { return }
        let message = AuditNoticeState.message(key, strings: strings)
        log("[audit] \(status ?? "unknown"): \(message)")
        shell?.showAuditNotice(message)
    }

    private func confirmation(_ title: String, _ message: String, confirm: String, detail: String? = nil)
        -> AuditConfirmation
    {
        AuditConfirmation(
            title: title, message: message, detail: detail, confirmLabel: confirm,
            cancelLabel: strings.t("settings.restore.cancelButton", fallback: "Cancel"))
    }

    // MARK: - Launch and the closure timer

    /// `checkAuditIntegrity`: verifies the history, reports the status and returns it.
    @discardableResult
    public func checkIntegrity(establishSession: Bool = false) async -> String? {
        guard let runtime = await runtimeProvider() else { return nil }
        let status: String?
        do {
            status = try await runtime.verifyAuditHistory(establishSession: establishSession)["status"]?.stringValue
        } catch {
            status = "unavailable"
        }
        report(status)
        return status
    }

    /// `stopAuditClosureTimer`.
    public func stopClosureTimer() {
        closureTask?.cancel()
        closureTask = nil
    }

    /// `startAuditClosureTimer`: every 30 seconds, close the checkpoint (and run retention
    /// when due) while the live closure is on, or retry establishing the session up to
    /// five times while it is pending.
    public func startClosureTimer() async {
        stopClosureTimer()
        startupRetries = 0
        guard let runtime = await runtimeProvider() else { return }
        let enabled = await runtime.closureEnabled
        let pending = await runtime.sessionPending
        guard enabled || pending else { return }
        closureTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: AuditChannels.closureInterval)
                guard !Task.isCancelled, let self else { return }
                guard await self.closureTick() else { return }
            }
        }
    }

    /// One timer interval; `false` stops the timer.
    func closureTick() async -> Bool {
        guard let runtime = await runtimeProvider() else { return false }
        if !(await runtime.closureEnabled) {
            if !(await runtime.sessionPending) || startupRetries >= Self.maximumStartupRetries {
                closureTask = nil
                return false
            }
            startupRetries += 1
            await checkIntegrity(establishSession: true)
            return true
        }
        do {
            let result = try await runtime.closeAuditCheckpoint()
            if result["reason"]?.stringValue != "live_closure_not_active" {
                report(result["status"]?.stringValue)
            }
            if result["status"]?.stringValue == "verified" {
                do {
                    _ = try await runtime.runAuditRetentionIfDue()
                } catch {
                    log("[audit] Audit retention pass unavailable \(Self.code(error) ?? "unknown")")
                }
            }
        } catch {
            report("unavailable")
        }
        return true
    }

    /// Before a page load: establish the session, then run the closure timer.
    public func applicationWillLoad() async {
        await checkIntegrity(establishSession: true)
        await startClosureTimer()
    }

    /// On quit or when the services stop: the timer stops and the session ends.
    public func endSession() async {
        stopClosureTimer()
        await runtimeProvider()?.endAuditSession()
    }

    // MARK: - Channels

    /// `audit:enroll`.
    public func enroll() async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        do {
            let current = try await runtime.verifyAuditHistory()
            guard current["status"]?.stringValue == "unavailable",
                current["reason"]?.stringValue == "no_trusted_anchor"
            else {
                var fields: [String: JSONValue] = ["success": .bool(false)]
                if let status = current["status"] { fields["status"] = status }
                return .object(fields)
            }
            let confirmed =
                await shell?.confirm(
                    confirmation(
                        strings.t("admin.audit.enrollTitle", fallback: "Start audit protection"),
                        strings.t(
                            "admin.audit.enrollWarning",
                            fallback:
                                "The current history will be checked for internal consistency and saved as a starting point. This cannot prove that older entries were unchanged before enrollment."
                        ),
                        confirm: strings.t("admin.audit.enrollConfirm", fallback: "Start protection"))) ?? false
            guard confirmed else { return Self.cancelled }
            let result = try await runtime.enrollExistingAuditHistory()
            let status = result["status"]?.stringValue
            report(status)
            guard let status, AuditRuntime.verifiedStatuses.contains(status) else {
                var fields: [String: JSONValue] = ["success": .bool(false)]
                if let value = result["status"] { fields["status"] = value }
                return .object(fields)
            }
            await startClosureTimer()
            var fields: [String: JSONValue] = ["success": .bool(true)]
            if let enrollment = result["enrollmentSequence"] { fields["enrollmentSequence"] = enrollment }
            return .object(fields)
        } catch {
            report("failed")
            return Self.failed(["error": .string(Self.message(error))])
        }
    }

    /// `audit:read`.
    public func read(_ range: AuditViewer.ReadRange) async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        do {
            let raw = try await runtime.readVerifiedAuditEntries(afterSequence: range.afterSequence, limit: range.limit)
            if let status = raw["verification"]?["status"]?.stringValue, status == "failed" || status == "unavailable" {
                report(status)
                var fields: [String: JSONValue] = ["success": .bool(false), "status": .string(status)]
                if raw["verification"]?["reason"]?.stringValue == "no_trusted_anchor" {
                    fields["reason"] = .string("no_trusted_anchor")
                }
                return .object(fields)
            }
            let snapshot = try AuditViewer.validateSnapshot(raw, range: range)
            report(snapshot["verification"]?["status"]?.stringValue)
            var fields = snapshot.objectValue ?? [:]
            fields["success"] = .bool(true)
            return .object(fields)
        } catch {
            report("failed")
            return Self.failed(["error": .string(Self.message(error))])
        }
    }

    /// `audit:export`: the verified history as a JSON snapshot, saved where the user says.
    public func exportSnapshot() async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        do {
            let range = AuditViewer.ReadRange(afterSequence: 0, limit: AuditViewer.maximumPageSize)
            let raw = try await runtime.readVerifiedAuditEntries(afterSequence: 0, limit: range.limit)
            if let status = raw["verification"]?["status"]?.stringValue, status == "failed" || status == "unavailable" {
                report(status)
                return .object(["success": .bool(false), "status": .string(status)])
            }
            let snapshot = try AuditViewer.validateSnapshot(raw, range: range)
            let content = try AuditViewer.buildExport(snapshot)
            guard
                let target = await shell?.chooseSaveLocation(
                    AuditFilePanel(
                        title: "Export audit snapshot", defaultName: "vision-audit-snapshot.json", filterName: "JSON",
                        extensions: ["json"]))
            else {
                return Self.cancelled
            }
            try Self.writeExclusive(Data(content.utf8), to: target)
            return .object(["success": .bool(true), "file": .string(target)])
        } catch {
            return Self.failed(["error": .string(Self.message(error))])
        }
    }

    private var transferPanelTitleExport: String {
        strings.t("admin.audit.transferExport", fallback: "Export protected audit transfer")
    }

    private var transferPanelTitleImport: String {
        strings.t("admin.audit.transferImport", fallback: "Import protected audit transfer")
    }

    /// `audit:transfer-export`.
    public func exportTransfer(password: String) async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        do {
            let bytes = try await runtime.exportProtectedAuditTransfer(password: password)
            guard
                let target = await shell?.chooseSaveLocation(
                    AuditFilePanel(
                        title: transferPanelTitleExport, defaultName: "vision-audit-transfer.vat",
                        filterName: "Vision audit transfer", extensions: ["vat"]))
            else {
                return Self.cancelled
            }
            try Self.writeExclusive(bytes, to: target)
            return .object(["success": .bool(true)])
        } catch {
            return Self.failed(["reason": .string(Self.code(error) ?? "transfer_failed")])
        }
    }

    /// `audit:transfer-import`: only on a new install, before restoring the matching backup.
    public func importTransfer(password: String) async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        guard
            let file = await shell?.chooseFile(
                AuditFilePanel(
                    title: transferPanelTitleImport, defaultName: nil, filterName: "Vision audit transfer",
                    extensions: ["vat"]))
        else {
            return Self.cancelled
        }
        let confirmed =
            await shell?.confirm(
                confirmation(
                    transferPanelTitleImport,
                    strings.t(
                        "admin.audit.transferImportWarning",
                        fallback:
                            "Import only on a new Mac before restoring the matching backup. The current fresh audit checkpoint will be replaced."
                    ),
                    confirm: strings.t("admin.audit.transferImportConfirm", fallback: "Import transfer"))) ?? false
        guard confirmed else { return Self.cancelled }
        do {
            guard let bytes = try Self.readTransferFile(file) else {
                return Self.failed(["reason": .string("transfer_invalid")])
            }
            _ = try await runtime.importProtectedAuditTransfer(bytes, password: password)
            report("unavailable")
            return .object(["success": .bool(true)])
        } catch {
            return Self.failed(["reason": .string(Self.code(error) ?? "transfer_failed")])
        }
    }

    /// `audit:rotate-key`.
    public func rotateKey() async -> JSONValue {
        guard let runtime = await runtimeProvider() else { return Self.unavailable }
        let confirmed =
            await shell?.confirm(
                confirmation(
                    strings.t("admin.audit.rotate", fallback: "Rotate audit key"),
                    strings.t(
                        "admin.audit.rotateWarning",
                        fallback:
                            "Vision will replace this device's protected audit key after checking the full history. An interrupted rotation can make audit verification unavailable."
                    ),
                    confirm: strings.t("admin.audit.rotateConfirm", fallback: "Rotate key"))) ?? false
        guard confirmed else { return Self.cancelled }
        do {
            let sequence = try await runtime.rotateAuditKey()
            return .object(["success": .bool(true), "sequence": .int(sequence)])
        } catch {
            report("failed")
            return Self.failed(["reason": .string(Self.code(error) ?? "rotation_failed")])
        }
    }

    // MARK: - Restore

    /// The second confirmation of `restoreWithAuditRecovery`.
    public func confirmAuditRecovery(fileName: String, auditStatus: String?) async -> Bool {
        let status = ["failed", "unavailable", "partially_verified"].contains(auditStatus ?? "")
            ? auditStatus ?? "unavailable" : "unavailable"
        return await shell?.confirm(
            confirmation(
                strings.t("settings.restore.auditContinuityTitle", fallback: "Audit continuity cannot be verified"),
                strings.t(
                    "settings.restore.auditContinuityWarning",
                    fallback:
                        "This backup does not match this device's trusted audit checkpoint. Restoring it will leave audit continuity unverified."
                ),
                confirm: strings.t("settings.restore.runNow", fallback: "Restore"),
                detail: "\(fileName) (\(status))")) ?? false
    }

    // MARK: - Files

    /// A temporary sibling `<target>.<16 hex>.tmp` written with `wx` and mode 0600, then
    /// renamed over the target; the temporary file never survives.
    static func writeExclusive(_ data: Data, to target: String) throws {
        let suffix = (try BackupFiles.randomBytes(8)).hexString
        let temporary = "\(target).\(suffix).tmp"
        defer { _ = Darwin.unlink(temporary) }
        let descriptor = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else {
            throw AuditBridgeError("Could not write \(PathUtilities.basename(target)): \(String(cString: strerror(errno)))")
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.close()
        guard Darwin.rename(temporary, target) == 0 else {
            throw AuditBridgeError("Could not save \(PathUtilities.basename(target)): \(String(cString: strerror(errno)))")
        }
    }

    /// Opens with `O_NOFOLLOW`; `nil` unless it is a regular file of at most 16 KiB.
    static func readTransferFile(_ path: String) throws -> Data? {
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw AuditBridgeError("Could not open \(PathUtilities.basename(path)): \(String(cString: strerror(errno)))")
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var status = stat()
        guard fstat(descriptor, &status) == 0, (status.st_mode & S_IFMT) == S_IFREG,
            status.st_size <= off_t(AuditAnchor.transferMaximumBytes)
        else {
            return nil
        }
        return try handle.readToEnd() ?? Data()
    }
}

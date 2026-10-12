import Foundation

/// GET and PUT against the backend's settings API.
public protocol SettingsTransport: Sendable {
    func get(_ url: URL) async throws -> HTTPResponse
    func put(_ url: URL, body: Data) async throws -> HTTPResponse
}

public struct URLSessionSettingsTransport: SettingsTransport {
    private let session: URLSession
    private let timeout: TimeInterval

    public init(session: URLSession = URLSession(configuration: .ephemeral), timeout: TimeInterval = 5) {
        self.session = session
        self.timeout = timeout
    }

    private func send(_ request: URLRequest) async throws -> HTTPResponse {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return HTTPResponse(status: http.statusCode, body: data)
    }

    public func get(_ url: URL) async throws -> HTTPResponse {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request)
    }

    public func put(_ url: URL, body: Data) async throws -> HTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await send(request)
    }
}

public struct SettingsWriteError: Error, Equatable, LocalizedError, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// `readSettingsResponse`: the API wraps values as `{ ok, data: { key, value, expected } }`
/// (ADR-026).
public struct SettingsResponse: Equatable, Sendable {
    public let ok: Bool
    public let data: JSONValue?
    /// `data.value` when `data` is an object.
    public let stored: JSONValue?

    public init(body: JSONValue?) {
        ok = body?["ok"] == .bool(true)
        data = body?["data"]
        stored = data?["value"]
    }
}

/// `createSettingsWriter` (packaging/electron/settings-conflicts.ts): a write carries the
/// baseline of the load that produced the displayed value, so the backend refuses to
/// replace database state the user never saw. Writes to one key run one after another.
public actor SettingsWriter {
    private let transport: any SettingsTransport
    private var baselines: [String: JSONValue] = [:]
    private var pending: [String: Task<JSONValue, Error>] = [:]

    public init(transport: any SettingsTransport) {
        self.transport = transport
    }

    public static func url(baseURL: URL, key: String) -> URL {
        baseURL.appendingPathComponent("api/settings/\(key)", isDirectory: false)
    }

    /// Keeps the first baseline a load returned for the key.
    public func loaded(_ key: String, data: JSONValue?) {
        guard baselines[key] == nil, let expected = data?["expected"], expected.isTruthy else { return }
        baselines[key] = expected
    }

    public func baseline(_ key: String) -> JSONValue? {
        baselines[key]
    }

    /// Unlike Electron, a failed write does not make every later write to the key fail.
    public func save(_ key: String, value: JSONValue, baseURL: URL) async throws -> JSONValue {
        let previous = pending[key]
        let task = Task {
            _ = try? await previous?.value
            return try await self.write(key, value: value, baseURL: baseURL)
        }
        pending[key] = task
        return try await task.value
    }

    private func write(_ key: String, value: JSONValue, baseURL: URL) async throws -> JSONValue {
        guard let expected = baselines[key] else {
            throw SettingsWriteError("Settings were not loaded. Reopen Vision before saving.")
        }
        let body = try JSONValue.object(["value": value, "expected": expected]).compactJSONString()
        let response = try await transport.put(Self.url(baseURL: baseURL, key: key), body: Data(body.utf8))
        let parsed = try? JSONValue.parse(response.body)
        guard let parsed, parsed["ok"] == .bool(true) else {
            throw SettingsWriteError(parsed?["error"]?["message"]?.stringValue ?? "Could not save settings")
        }
        guard let data = parsed["data"], data != .null else { throw SettingsWriteError("Could not save settings") }
        var next: [String: JSONValue] = ["exists": .bool(true)]
        if data.objectValue != nil, let stored = data["value"] { next["value"] = stored }
        baselines[key] = .object(next)
        return parsed
    }
}

/// `services:load-settings` and `services:save-settings`: the database is the source of
/// truth and `settings.json` keeps a mirror for the quit path, which may run after the
/// backend stopped answering.
public enum ServicesSettings {
    public static let key = "services_settings"

    /// The stored value when the database answered with an object, else the mirror.
    public static func load(
        baseURL: URL?, transport: any SettingsTransport, writer: SettingsWriter,
        mirror: @Sendable (Bool) async -> Void, fallback: @Sendable () async -> Bool
    ) async -> Bool {
        if let baseURL, let response = try? await transport.get(SettingsWriter.url(baseURL: baseURL, key: key)) {
            let body = SettingsResponse(body: try? JSONValue.parse(response.body))
            if body.ok { await writer.loaded(key, data: body.data) }
            if let stored = body.stored, stored.objectValue != nil || stored.arrayValue != nil {
                let keep = stored["keepServicesOnQuit"] == .bool(true)
                await mirror(keep)
                return keep
            }
        }
        return await fallback()
    }

    public static func save(
        keepServicesOnQuit: Bool, baseURL: URL?, writer: SettingsWriter, mirror: @Sendable (Bool) async throws -> Void
    ) async throws {
        guard let baseURL else { throw SettingsWriteError("The Vision backend is not running.") }
        _ = try await writer.save(key, value: .object(["keepServicesOnQuit": .bool(keepServicesOnQuit)]), baseURL: baseURL)
        try await mirror(keepServicesOnQuit)
    }
}

/// `{ backupDir, backupOnQuit }`, the value of `backup:load-settings` and
/// `backup:save-settings`.
public struct BackupSettingsValue: Equatable, Sendable {
    public var backupDir: String
    public var backupOnQuit: Bool

    public init(backupDir: String, backupOnQuit: Bool) {
        self.backupDir = backupDir
        self.backupOnQuit = backupOnQuit
    }

    public var jsonValue: JSONValue {
        .object(["backupDir": .string(backupDir), "backupOnQuit": .bool(backupOnQuit)])
    }
}

/// `backup:load-settings` and `backup:save-settings` until phase 1d: the same database
/// setting and `settings.json` mirror as Electron, without the iCloud Drive default
/// directory, which arrives with the backup itself.
public enum BackupSettings {
    public static let key = "backup_settings"

    /// `BLOCKED_BACKUP_PREFIXES` in packaging/electron/runtime/ipc-schemas.ts.
    public static let blockedPrefixes = [
        "/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/private/var/db", "/Library",
    ]

    /// `validateBackupDest`: an error message, or `nil` when the directory is acceptable.
    /// Relative paths are refused instead of being resolved against the working directory.
    public static func destinationError(_ directory: String) -> String? {
        guard !directory.isEmpty else { return "Invalid backup directory" }
        guard directory.hasPrefix("/") else { return "Backup directory must be an absolute path" }
        let resolved = normalizedPath(directory)
        if blockedPrefixes.contains(where: { resolved == $0 || resolved.hasPrefix($0 + "/") }) {
            return "Backup to system directories is not allowed"
        }
        return nil
    }

    /// `path.resolve` for an absolute path: removes empty and `.` components and applies `..`.
    static func normalizedPath(_ path: String) -> String {
        var components: [Substring] = []
        for component in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch component {
            case ".": continue
            case "..": _ = components.popLast()
            default: components.append(component)
            }
        }
        return "/" + components.joined(separator: "/")
    }

    /// `resolveBackupSettingsWithDefaults` without the iCloud Drive fallback: the toggle
    /// counts only with a configured directory.
    public static func resolved(_ raw: JSONValue?) -> BackupSettingsValue {
        let directory = raw?["backupDir"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return BackupSettingsValue(
            backupDir: directory, backupOnQuit: !directory.isEmpty && raw?["backupOnQuit"] == .bool(true))
    }

    /// The stored value when the database answered with an object, else the mirror. The
    /// mirror receives the raw stored value, not the resolved one, like Electron.
    public static func load(
        baseURL: URL?, transport: any SettingsTransport, writer: SettingsWriter,
        mirror: @Sendable (BackupSettingsValue) async -> Void, fallback: @Sendable () async -> [String: JSONValue]
    ) async -> BackupSettingsValue {
        if let baseURL, let response = try? await transport.get(SettingsWriter.url(baseURL: baseURL, key: key)) {
            let body = SettingsResponse(body: try? JSONValue.parse(response.body))
            if body.ok { await writer.loaded(key, data: body.data) }
            if let stored = body.stored, stored.objectValue != nil || stored.arrayValue != nil {
                await mirror(
                    BackupSettingsValue(
                        backupDir: stored["backupDir"]?.stringValue ?? "",
                        backupOnQuit: stored["backupOnQuit"] == .bool(true)))
                return resolved(stored)
            }
        }
        return resolved(.object(await fallback()))
    }

    public static func save(
        _ settings: BackupSettingsValue, baseURL: URL?, writer: SettingsWriter,
        mirror: @Sendable (BackupSettingsValue) async throws -> Void
    ) async throws {
        guard let baseURL else { throw SettingsWriteError("The Vision backend is not running.") }
        _ = try await writer.save(key, value: settings.jsonValue, baseURL: baseURL)
        try await mirror(settings)
    }
}

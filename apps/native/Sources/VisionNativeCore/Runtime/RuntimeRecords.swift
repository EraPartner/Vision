import Foundation

/// `runtime-state.json`, the runtime marker (`readState`, `writeState` and
/// `assertNativeActive` in `packaging/electron/runtime/native.ts`).
public enum RuntimeMarker {
    /// `{ version: 1, runtimeId, ...current, ...set, updatedAt }`, minus `remove`
    /// (the keys the Electron runtime sets to `undefined`).
    public static func merged(
        current: [String: JSONValue]?,
        runtimeId: String,
        set: [String: JSONValue],
        remove: [String] = [],
        now: Date
    ) -> [String: JSONValue] {
        var state: [String: JSONValue] = ["version": .int(1), "runtimeId": .string(runtimeId)]
        state.merge(current ?? [:]) { _, new in new }
        state.merge(set) { _, new in new }
        for key in remove { state.removeValue(forKey: key) }
        state["updatedAt"] = .string(isoTimestamp(now))
        return state
    }

    /// The marker only counts when it is a JSON object.
    public static func parse(_ data: Data?) throws -> [String: JSONValue]? {
        guard let data else { return nil }
        return try JSONValue.parse(data).objectValue
    }

    public static func isNativeActive(_ state: [String: JSONValue]?) -> Bool {
        state?["activeRuntime"] == .string("native")
    }
}

/// `backend.pid.json` and `postgres.pid.json`.
public enum PIDRecord {
    /// `probeableProcessId`: an integer above 1, never a group or `init`.
    public static func probeablePID(_ value: JSONValue?) -> Int32? {
        guard let pid = value?.intValue, pid > 1, pid <= Int(Int32.max) else { return nil }
        return Int32(pid)
    }

    /// The recorded process id, or `nil` when the record is missing or unreadable.
    public static func recordedPID(_ data: Data?) -> Int32? {
        guard let data, let record = try? JSONValue.parse(data) else { return nil }
        return probeablePID(record["pid"])
    }

    public static func backend(pid: Int32, port: Int, runtimeId: String, command: String, now: Date) -> JSONValue {
        .object([
            "pid": .int(Int(pid)),
            "port": .int(port),
            "runtimeId": .string(runtimeId),
            "startedAt": .string(isoTimestamp(now)),
            "command": .string(PathUtilities.basename(command)),
        ])
    }

    public static func postgres(pid: Int32, port: Int, runtimeId: String, dataDirectory: String, now: Date)
        -> JSONValue
    {
        .object([
            "pid": .int(Int(pid)),
            "runtimeId": .string(runtimeId),
            "port": .int(port),
            "dataDirectory": .string(dataDirectory),
            "startedAt": .string(isoTimestamp(now)),
        ])
    }

    /// `processMatchesBackend`: the `ps -o command=` line of the recorded process must
    /// contain the backend executable path before Vision may signal it.
    public static func commandMatchesBackend(psOutput: String, backendExecutable: String) -> Bool {
        let actual = psOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actual.isEmpty, !backendExecutable.isEmpty else { return false }
        return actual.contains(backendExecutable)
    }
}

/// Backend health parsing.
public enum HealthReadiness {
    /// `isDetailedHealthReady`: `/health/detailed` reports a connected database.
    public static func isDetailedReady(_ result: JSONValue?) -> Bool {
        result?["database"]?["connected"] == .bool(true)
    }

    /// `pingReady` in `packaging/electron/main.ts`, which gates the first navigation:
    /// `nil` while the server is not up (a failed request or a status outside 200–399),
    /// otherwise whether the dashboard data is ready. A 404 (older backend), JSON `null`
    /// or an unparseable body count as ready so startup never waits longer than the
    /// liveness check would.
    public static func navigationReadiness(status: Int, body: Data) -> Bool? {
        if status == 404 { return true }
        if status < 200 || status >= 400 { return nil }
        guard let parsed = try? JSONValue.parse(body) else { return true }
        if parsed == .null { return true }
        return parsed["status"] == .string("ready") || parsed["caches"]?["materializedViews"] == .bool(true)
    }
}

/// Vision Native's `settings.json` (only the fields the runtime uses).
public enum AppSettings {
    /// `resolveAppPort`: the persisted `appPort` when `Number(appPort)` is an integer
    /// from 1024 to 65535.
    public static func persistedAppPort(_ settings: [String: JSONValue]) -> Int? {
        guard let number = settings["appPort"]?.numberCoercion, number.rounded() == number,
            number >= Double(RuntimeConstants.persistedAppPortRange.lowerBound),
            number <= Double(RuntimeConstants.persistedAppPortRange.upperBound)
        else {
            return nil
        }
        return Int(number)
    }

    /// `pickRandomFreePort`: up to 64 random ports from 20000 to 59999, else 3002.
    public static func pickRandomFreePort(ports: any PortProbing, random: any RandomSource) async -> Int {
        for _ in 0..<RuntimeConstants.randomAppPortAttempts {
            let candidate = random.integer(in: RuntimeConstants.randomAppPortRange)
            if await ports.isPortFree(candidate) { return candidate }
        }
        return RuntimeConstants.defaultAppPort
    }

    /// `keepServicesOnQuit` from a `GET /api/settings/services_settings` body
    /// (`{ ok, data: { key, value } }`); `nil` when the stored value is not an object.
    public static func keepServicesFromSettingsResponse(_ body: JSONValue) -> Bool? {
        guard let stored = body["data"]?["value"], stored.objectValue != nil else { return nil }
        return stored["keepServicesOnQuit"] == .bool(true)
    }

    public static func keepServicesFromSettings(_ settings: [String: JSONValue]) -> Bool {
        settings["keepServicesOnQuit"] == .bool(true)
    }
}

/// Redacts database credentials and ANSI colours from log text before it is copied
/// into the app log (`redactStartupDiagnostics`).
public func redactDiagnostics(_ text: String) -> String {
    var result = text.replacingOccurrences(
        of: #"(postgres(?:ql)?://[^:\s/@]+:)[^@\s/]+(@)"#,
        with: "$1***$2",
        options: [.regularExpression, .caseInsensitive]
    )
    result = result.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
    return result
}

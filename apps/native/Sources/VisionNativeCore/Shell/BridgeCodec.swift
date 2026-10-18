import Foundation

public enum NativeLanguage: String, Sendable, CaseIterable {
    case en
    case nl
}

/// `RendererFailurePayload`, normalized by `rendererFailureArguments`.
public struct RendererFailure: Equatable, Sendable {
    public var kind: String
    public var name: String
    public var source: String
    public var line: Int

    public init(kind: String, name: String, source: String, line: Int) {
        self.kind = kind
        self.name = name
        self.source = source
        self.line = line
    }
}

/// `SplashThemeColors`: the active theme's HSL component strings ("158 64% 52%").
public struct SplashTheme: Equatable, Sendable {
    public enum Mode: String, Sendable {
        case light
        case dark
    }

    public var mode: Mode?
    public var background: String
    public var foreground: String
    public var surface: String?
    public var text: String?

    public init(mode: Mode?, background: String, foreground: String, surface: String? = nil, text: String? = nil) {
        self.mode = mode
        self.background = background
        self.foreground = foreground
        self.surface = surface
        self.text = text
    }

    /// `isValidHslComponents`: digits, spaces, `%` and dots only, at most 32 characters.
    public static func isValidHSLComponents(_ value: String) -> Bool {
        value.count <= 32
            && value.range(
                of: #"^[0-9]{1,3}(\.[0-9]+)?\s+[0-9]{1,3}(\.[0-9]+)?%\s+[0-9]{1,3}(\.[0-9]+)?%\z"#,
                options: .regularExpression) != nil
    }

    /// `splashThemeArguments` and `readSplashTheme`: `nil` unless every field is valid.
    /// `null` counts as absent, like `!= null`.
    public static func parse(_ value: JSONValue?) -> SplashTheme? {
        guard let value, value.objectValue != nil else { return nil }
        func optional(_ key: String) -> JSONValue? {
            guard let field = value[key], field != .null else { return nil }
            return field
        }
        guard let background = value["background"]?.stringValue, isValidHSLComponents(background),
            let foreground = value["foreground"]?.stringValue, isValidHSLComponents(foreground)
        else {
            return nil
        }
        var mode: Mode?
        if let rawMode = optional("mode") {
            guard let parsed = rawMode.stringValue.flatMap(Mode.init(rawValue:)) else { return nil }
            mode = parsed
        }
        var surface: String?
        if let rawSurface = optional("surface") {
            guard let text = rawSurface.stringValue, isValidHSLComponents(text) else { return nil }
            surface = text
        }
        var text: String?
        if let rawText = optional("text") {
            guard let value = rawText.stringValue, isValidHSLComponents(value) else { return nil }
            text = value
        }
        return SplashTheme(mode: mode, background: background, foreground: foreground, surface: surface, text: text)
    }

    /// The value stored under `splashTheme` in `settings.json`; absent fields are omitted.
    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["background": .string(background), "foreground": .string(foreground)]
        if let mode { fields["mode"] = .string(mode.rawValue) }
        if let surface { fields["surface"] = .string(surface) }
        if let text { fields["text"] = .string(text) }
        return .object(fields)
    }
}

/// A message from the user script: `JSON.stringify({ channel, args })`.
public struct BridgeRequest: Equatable, Sendable {
    public let channel: BridgeChannel
    public let arguments: [JSONValue]

    public init(channel: BridgeChannel, arguments: [JSONValue]) {
        self.channel = channel
        self.arguments = arguments
    }
}

/// The answer to a message: the user script's promise resolves with the value or rejects
/// with an `Error` carrying the message.
public enum BridgeReply: Equatable, Sendable {
    case resolve(JSONValue)
    case reject(String)

    public static let success = BridgeReply.resolve(.object(["success": .bool(true)]))
    public static let failure = BridgeReply.resolve(.object(["success": .bool(false)]))

    public static func failed(_ error: String) -> BridgeReply {
        .resolve(.object(["success": .bool(false), "error": .string(error)]))
    }

    /// The two values `WKScriptMessageHandlerWithReply` returns: JSON text for the user
    /// script to parse, or the error message.
    public var scriptReply: (result: String?, error: String?) {
        switch self {
        case .resolve(let value):
            return ((try? value.compactJSONString()) ?? "null", nil)
        case .reject(let message):
            return (nil, message)
        }
    }
}

public enum BridgeDecodeResult: Equatable, Sendable {
    case request(BridgeRequest)
    case invalid(String)
}

/// A validated call with typed arguments (`runtime/ipc-schemas.ts`).
public enum BridgeCall: Equatable, Sendable {
    case rendererFailure(RendererFailure)
    case rendererReady
    case setBadge(Int)
    case setLanguage(NativeLanguage)
    case setVibrancy(Bool)
    case getAccentColor
    case persistSplashTheme(SplashTheme)
    case saveServicesSettings(keepServicesOnQuit: Bool)
    case loadServicesSettings
    case saveBackupSettings(BackupSettingsValue)
    case loadBackupSettings
    /// `backup:run` with the resolved destination and the optional snapshot.
    case runBackup(destination: String, frontendStateJson: String?)
    case selectBackupDirectory
    case selectRestoreFile
    /// `backup:restore` for a picked, resolved path.
    case restoreBackup(path: String, passphrase: String?)
    case isBackupEncrypted(path: String)
    case getBackupEncryptionStatus
    /// `backup:set-passphrase` with the untrimmed value (the handler trims it).
    case setBackupPassphrase(String)
    case auditEnroll
    case auditRead(AuditViewer.ReadRange)
    case auditExport
    /// `audit:transfer-export` with a password of 16 to 1024 UTF-16 code units.
    case auditTransferExport(password: String)
    case auditTransferImport(password: String)
    case auditRotateKey
    case recoveryRetry
    case recoveryOpenLogs
    case windowDrag
    case windowTitlebarDoubleClick
    /// `shell:route-changed` with a valid app-relative route.
    case routeChanged(NativeRoute)
    /// A pending or removed channel; it rejects without looking at arguments.
    case unavailable(BridgeChannel)
}

public enum BridgeValidation: Equatable, Sendable {
    case call(BridgeCall)
    /// The channel's `invalidResult`.
    case invalid(BridgeReply)
}

public enum BridgeCodec {
    public static let malformedMessage = "Malformed Vision Native bridge message"
    public static let unknownChannelMessage = "Unknown Vision Native bridge channel"

    /// Parses `{ "channel": string, "args"?: array }`. Unknown channels and anything else
    /// are refused, like a channel with no `registerHandler`. Nothing above the payload limit
    /// is parsed; after parsing, the channel's own limit applies.
    public static func decode(_ body: String?) -> BridgeDecodeResult {
        guard let body else { return .invalid(malformedMessage) }
        let size = body.utf8.count
        guard size <= BridgeContract.maximumPayloadMessageBytes,
            let parsed = try? JSONValue.parse(Data(body.utf8)),
            parsed.objectValue != nil,
            let channelName = parsed["channel"]?.stringValue
        else {
            return .invalid(malformedMessage)
        }
        guard let channel = BridgeChannel(rawValue: channelName) else { return .invalid(unknownChannelMessage) }
        guard size <= BridgeContract.maximumMessageBytes(for: channel) else { return .invalid(malformedMessage) }
        let arguments: [JSONValue]
        switch parsed["args"] {
        case .none, .some(.null):
            arguments = []
        case .some(.array(let values)):
            arguments = values
        case .some:
            return .invalid(malformedMessage)
        }
        return .request(BridgeRequest(channel: channel, arguments: arguments))
    }

    private struct InvalidArguments: Error {
        let message: String
        /// `IpcArgumentError.code`, read by the audit transfer `invalidResult`.
        let code: String?
        init(_ message: String, code: String? = nil) {
            self.message = message
            self.code = code
        }
    }

    /// `expectArity`: anything beyond the declared arity must be absent (JSON `null`).
    private static func expectArity(_ arguments: [JSONValue], _ arity: Int) throws {
        if arguments.dropFirst(arity).contains(where: { $0 != .null }) {
            throw InvalidArguments("Unexpected IPC arguments")
        }
    }

    private static func argument(_ arguments: [JSONValue], _ index: Int) -> JSONValue? {
        index < arguments.count && arguments[index] != .null ? arguments[index] : nil
    }

    /// Validates the arguments and answers invalid calls with the channel's `invalidResult`.
    /// `isAllowedRestorePath` is `ALLOWED_RESTORE_PATHS`: the paths the restore picker returned.
    public static func validate(
        _ request: BridgeRequest, isAllowedRestorePath: (String) -> Bool = { _ in false }
    ) -> BridgeValidation {
        let entry = BridgeContract.entry(for: request.channel)
        switch entry.availability {
        case .pending, .removed:
            return .call(.unavailable(request.channel))
        case .implemented, .nativeOnly:
            break
        }
        let arguments = request.arguments
        do {
            return .call(try call(request.channel, arguments, isAllowedRestorePath: isAllowedRestorePath))
        } catch let error as InvalidArguments {
            return .invalid(invalidResult(request.channel, error.message, code: error.code))
        } catch {
            return .invalid(invalidResult(request.channel, "Invalid IPC arguments"))
        }
    }

    private static func call(
        _ channel: BridgeChannel, _ arguments: [JSONValue], isAllowedRestorePath: (String) -> Bool
    ) throws -> BridgeCall {
        switch channel {
        case .rendererFailure:
            return .rendererFailure(rendererFailure(argument(arguments, 0)))
        case .rendererReady:
            try expectArity(arguments, 0)
            return .rendererReady
        case .setBadge:
            try expectArity(arguments, 1)
            // `Number(args[0])`. `JSON.stringify` turns `undefined` into `null`, so a missing
            // count arrives as `null` and gets the invalid result, like `Number(undefined)`.
            guard let number = argument(arguments, 0)?.numberCoercion, number.isFinite else {
                throw InvalidArguments("Invalid badge count")
            }
            return .setBadge(Int(max(0, min(999, number.rounded(.down)))))
        case .setLanguage:
            try expectArity(arguments, 1)
            guard let language = argument(arguments, 0)?.stringValue.flatMap(NativeLanguage.init(rawValue:)) else {
                throw InvalidArguments("Unsupported language")
            }
            return .setLanguage(language)
        case .setVibrancy:
            try expectArity(arguments, 1)
            guard let enabled = argument(arguments, 0)?.boolValue else { throw InvalidArguments("Invalid vibrancy flag") }
            return .setVibrancy(enabled)
        case .getAccentColor:
            try expectArity(arguments, 0)
            return .getAccentColor
        case .persistSplashTheme:
            try expectArity(arguments, 1)
            guard let theme = SplashTheme.parse(argument(arguments, 0)) else {
                throw InvalidArguments("Invalid splash theme colors")
            }
            return .persistSplashTheme(theme)
        case .servicesSaveSettings:
            try expectArity(arguments, 1)
            guard let keep = argument(arguments, 0)?["keepServicesOnQuit"]?.boolValue else {
                throw InvalidArguments("Invalid services settings")
            }
            return .saveServicesSettings(keepServicesOnQuit: keep)
        case .servicesLoadSettings:
            try expectArity(arguments, 0)
            return .loadServicesSettings
        case .backupSaveSettings:
            try expectArity(arguments, 1)
            return .saveBackupSettings(try backupSettings(argument(arguments, 0)))
        case .backupLoadSettings:
            try expectArity(arguments, 0)
            return .loadBackupSettings
        case .backupRun:
            try expectArity(arguments, 2)
            return try backupRun(arguments)
        case .backupSelectDir:
            try expectArity(arguments, 0)
            return .selectBackupDirectory
        case .backupSelectFile:
            try expectArity(arguments, 0)
            return .selectRestoreFile
        case .backupRestore:
            try expectArity(arguments, 2)
            let path = try pickedRestorePath(argument(arguments, 0), isAllowedRestorePath)
            guard hasAllowedRestoreExtension(path) else { throw InvalidArguments("Unsupported backup file extension") }
            var passphrase: String?
            if let options = argument(arguments, 1), options.objectValue != nil,
                let value = options["passphrase"], value != .null
            {
                guard let text = value.stringValue else { throw InvalidArguments("Invalid restore passphrase") }
                passphrase = text
            }
            return .restoreBackup(path: path, passphrase: passphrase)
        case .backupIsEncrypted:
            try expectArity(arguments, 1)
            return .isBackupEncrypted(path: try pickedRestorePath(argument(arguments, 0), isAllowedRestorePath))
        case .backupGetEncryptionStatus:
            try expectArity(arguments, 0)
            return .getBackupEncryptionStatus
        case .backupSetPassphrase:
            try expectArity(arguments, 1)
            guard let passphrase = argument(arguments, 0)?.stringValue else {
                throw InvalidArguments("Invalid backup passphrase")
            }
            return .setBackupPassphrase(passphrase)
        case .auditEnroll:
            try expectArity(arguments, 0)
            return .auditEnroll
        case .auditRead:
            try expectArity(arguments, 1)
            do {
                return .auditRead(try AuditViewer.validateReadOptions(argument(arguments, 0)))
            } catch let error as AuditViewer.ViewerError {
                throw InvalidArguments(error.message)
            }
        case .auditExport:
            try expectArity(arguments, 0)
            return .auditExport
        case .auditTransferExport:
            try expectArity(arguments, 1)
            return .auditTransferExport(password: try transferPassword(argument(arguments, 0)))
        case .auditTransferImport:
            try expectArity(arguments, 1)
            return .auditTransferImport(password: try transferPassword(argument(arguments, 0)))
        case .auditRotateKey:
            try expectArity(arguments, 0)
            return .auditRotateKey
        case .recoveryRetry:
            try expectArity(arguments, 0)
            return .recoveryRetry
        case .recoveryOpenLogs:
            try expectArity(arguments, 0)
            return .recoveryOpenLogs
        case .windowDrag:
            try expectArity(arguments, 0)
            return .windowDrag
        case .windowTitlebarDoubleClick:
            try expectArity(arguments, 0)
            return .windowTitlebarDoubleClick
        case .routeChanged:
            try expectArity(arguments, 1)
            guard let raw = argument(arguments, 0)?.stringValue, let route = NativeRoute(raw) else {
                throw InvalidArguments("Invalid route")
            }
            return .routeChanged(route)
        default:
            return .unavailable(channel)
        }
    }

    /// `auditTransferArguments`: the same bounds as `AuditAnchor.isValidTransferPassword`,
    /// checked first so an invalid password never reaches the verification or the panels.
    private static func transferPassword(_ value: JSONValue?) throws -> String {
        guard let password = value?.stringValue, AuditAnchor.isValidTransferPassword(password) else {
            throw InvalidArguments("Invalid audit transfer password", code: "transfer_password_invalid")
        }
        return password
    }

    /// `invalidResult` per channel in `createIpcArgumentContracts`.
    static func invalidResult(_ channel: BridgeChannel, _ message: String, code: String? = nil) -> BridgeReply {
        switch channel {
        case .auditEnroll, .auditExport, .auditRotateKey:
            return .failed(message)
        case .auditRead:
            return .resolve(
                .object(["success": .bool(false), "status": .string("failed"), "error": .string(message)]))
        case .auditTransferExport, .auditTransferImport:
            return .resolve(
                .object([
                    "success": .bool(false), "status": .string("failed"),
                    "reason": .string(code ?? "transfer_failed"),
                ]))
        case .getAccentColor:
            return .resolve(.null)
        case .servicesLoadSettings, .backupLoadSettings, .backupGetEncryptionStatus:
            return .reject("Invalid arguments for \(channel.rawValue)")
        case .servicesSaveSettings, .backupSaveSettings, .recoveryRetry, .recoveryOpenLogs, .backupRun, .backupRestore:
            return .failed(message)
        case .backupSelectDir, .backupSelectFile:
            return .resolve(.null)
        case .backupIsEncrypted:
            return .resolve(.bool(false))
        case .backupSetPassphrase:
            return .resolve(.object(["success": .bool(false), "available": .bool(false), "error": .string(message)]))
        default:
            return .failure
        }
    }

    /// `backupSettingsArguments`: a string directory and a boolean toggle. An empty directory
    /// clears the setting; any other must pass `validateBackupDest`, because the quit-time
    /// backup writes wherever it points.
    private static func backupSettings(_ value: JSONValue?) throws -> BackupSettingsValue {
        guard let value, value.objectValue != nil, let directory = value["backupDir"]?.stringValue,
            let onQuit = value["backupOnQuit"]?.boolValue
        else {
            throw InvalidArguments("Invalid backup settings")
        }
        if !directory.isEmpty, let error = BackupSettings.destinationError(directory) {
            throw InvalidArguments(error)
        }
        return BackupSettingsValue(backupDir: directory, backupOnQuit: onQuit)
    }

    /// `backupRunArguments`: a destination that passes `validateBackupDest`, resolved, and a
    /// snapshot that is a string or absent.
    private static func backupRun(_ arguments: [JSONValue]) throws -> BridgeCall {
        guard let destination = argument(arguments, 0)?.stringValue else {
            throw InvalidArguments("Invalid backup directory")
        }
        if let error = BackupSettings.destinationError(destination) { throw InvalidArguments(error) }
        var snapshot: String?
        if let value = argument(arguments, 1) {
            guard let text = value.stringValue else { throw InvalidArguments("Invalid frontend state snapshot") }
            snapshot = text
        }
        return .runBackup(destination: BackupSettings.normalizedPath(destination), frontendStateJson: snapshot)
    }

    /// `pickedRestorePath`: a non-empty string that resolves to a path the picker returned.
    /// A relative path cannot have come from the picker.
    private static func pickedRestorePath(_ value: JSONValue?, _ isAllowed: (String) -> Bool) throws -> String {
        guard let path = value?.stringValue, !path.isEmpty else { throw InvalidArguments("Invalid restore path") }
        let resolved = PathUtilities.normalize(path)
        guard path.hasPrefix("/"), isAllowed(resolved) else {
            throw InvalidArguments("Restore path was not selected via the file picker")
        }
        return resolved
    }

    /// `hasAllowedRestoreExt`: `.visionbak`, `.visionbak.enc`, `.enc` or `.sql`, any case.
    public static func hasAllowedRestoreExtension(_ path: String) -> Bool {
        let lower = path.lowercased()
        return [".visionbak.enc", ".visionbak", ".enc", ".sql"].contains { lower.hasSuffix($0) }
    }

    private static let rendererFailureKinds: Set<String> = ["error", "resource", "unhandledrejection"]

    /// `rendererFailureArguments`: never fails; unexpected fields collapse to placeholders so
    /// only structural metadata reaches the log.
    static func rendererFailure(_ payload: JSONValue?) -> RendererFailure {
        func matches(_ value: String, _ pattern: String) -> Bool {
            value.range(of: pattern, options: .regularExpression) != nil
        }
        let kind = payload?["kind"]?.stringValue.flatMap { rendererFailureKinds.contains($0) ? $0 : nil } ?? "error"
        let name =
            payload?["name"]?.stringValue.flatMap { matches($0, #"^[A-Za-z][A-Za-z0-9_.-]{0,63}\z"#) ? $0 : nil }
            ?? "UnknownError"
        let source =
            payload?["source"]?.stringValue.flatMap { matches($0, #"^[A-Za-z0-9_.-]{1,160}\z"#) ? $0 : nil }
            ?? "unknown"
        let maximumSafeInteger = 9_007_199_254_740_991
        var line = 0
        if let value = payload?["line"]?.intValue, value >= -maximumSafeInteger, value <= maximumSafeInteger {
            line = value
        }
        return RendererFailure(kind: kind, name: name, source: source, line: line)
    }
}

extension JSONValue {
    /// Single-line JSON with sorted keys, for replies and injected event payloads.
    public func compactJSONString() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }
}

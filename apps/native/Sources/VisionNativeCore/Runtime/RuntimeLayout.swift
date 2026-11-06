import Foundation

/// Vision Native's application-data layout. Below the data directory it is the same as
/// `createNativeRuntime` in `packaging/electron/runtime/native.ts` (`NativeRuntimePaths`),
/// so a later phase can switch directories without converting files.
///
///     ~/Library/Application Support/Vision Native/
///       settings.json             appPort (the persisted random backend port)
///       vision-native.lock        single-instance lock (flock)
///       demo-reset-request.json   optional request to restore the canonical seed
///       logs/main.log             app lifecycle log (rotated at 2 MB)
///       database/                 one database generation (ADR-263)
///         vision.sqlite3          the backend's VISION_DATABASE_PATH, with -wal and -shm
///         pre-migration-backups/  the backend's copy before it migrates
///       database.previous-*/      earlier generations kept after a restore (3)
///       native/vision_native/
///         runtime.env             market-data keys (0600)
///         runtime-state.json      runtime marker
///         backend.pid.json        backend PID record
///         raw-state.json          native-only mode's browser-storage equivalent (ADR-211)
///         logs/backend.log
///         attachments/, cache/
public struct RuntimeLayout: Sendable, Equatable {
    public let userDataDirectory: String
    public let runtimeId: String  // lint:allow raw-id runtime directory name of the app variant, not an API entity
    public let nativeRoot: String
    public let env: String
    public let state: String
    public let pid: String
    public let logs: String
    public let backendLog: String
    public let attachments: String
    public let cache: String
    /// `<userData>/database`: one database generation.
    public let databaseDirectory: String
    /// `<userData>/database/vision.sqlite3`, the backend's `VISION_DATABASE_PATH`.
    public let database: String
    public let settings: String
    public let appLog: String
    public let instanceLock: String
    public let demoResetRequest: String
    /// `NativeRawStateStore`'s file for the native-only mode (ADR-211).
    public let rawState: String

    /// Refuses any application-data directory other than Vision Native's own.
    public init(userDataDirectory: String, runtimeId: String = VisionNativeIdentity.runtimeId) throws {  // lint:allow raw-id runtime directory name of the app variant, not an API entity
        let root = PathUtilities.normalize(userDataDirectory)
        try RuntimeLayout.assertVisionNativeDirectory(root)
        let id = try RuntimeNames.normalize(runtimeId)
        self.userDataDirectory = root
        self.runtimeId = id
        nativeRoot = PathUtilities.join(root, "native", id)
        env = PathUtilities.join(nativeRoot, "runtime.env")
        state = PathUtilities.join(nativeRoot, "runtime-state.json")
        pid = PathUtilities.join(nativeRoot, "backend.pid.json")
        logs = PathUtilities.join(nativeRoot, "logs")
        backendLog = PathUtilities.join(nativeRoot, "logs", "backend.log")
        rawState = PathUtilities.join(nativeRoot, "raw-state.json")
        attachments = PathUtilities.join(nativeRoot, "attachments")
        cache = PathUtilities.join(nativeRoot, "cache")
        databaseDirectory = PathUtilities.join(root, RuntimeConstants.databaseDirectoryName)
        database = PathUtilities.join(databaseDirectory, RuntimeConstants.databaseFileName)
        settings = PathUtilities.join(root, "settings.json")
        appLog = PathUtilities.join(root, "logs", "main.log")
        instanceLock = PathUtilities.join(root, "vision-native.lock")
        demoResetRequest = PathUtilities.join(root, NativeDemo.resetRequestName)
    }

    /// ADR-204: Vision Native's data directory is named "Vision Native" (or, for the
    /// Demo variant, "Vision Native Demo") and is never one of the Electron apps'
    /// directories.
    public static func assertVisionNativeDirectory(_ userDataDirectory: String) throws {
        let name = PathUtilities.basename(userDataDirectory)
        guard userDataDirectory.hasPrefix("/"), NativeVariant.owning(userDataDirectory: userDataDirectory) != nil,
            !VisionNativeIdentity.foreignUserDataNames.contains(name)
        else {
            throw NativeRuntimeError(
                "NATIVE_DATA_DIRECTORY_UNSAFE",
                "Vision Native only uses its own \"\(VisionNativeIdentity.userDataName)\" application-data directory."
            )
        }
    }
}

import Foundation

/// The two builds of one Vision Native target (phase 1e). "Vision Native Demo" is the
/// synthetic-data variant visual review and agents use; "Vision Native" is the standard
/// one. Each has its own application-data directory, runtime id, PostgreSQL port and
/// Keychain service name, so neither ever reads, locks or mutates the other's state, nor
/// the Electron apps' ("Vision" on 54329, "Vision Demo" on 54330).
///
/// The build setting `VISION_NATIVE_VARIANT` (`standard` or `demo`) picks the product
/// name and bundle id and is copied into `Info.plist` as `VisionNativeVariant`, which the
/// app reads at launch (`NativeVariant.fromInfoPlist`).
public enum NativeVariant: String, Sendable, CaseIterable {
    case standard
    case demo

    /// The `Info.plist` key that carries the variant.
    public static let infoPlistKey = "VisionNativeVariant"

    /// An unknown or missing value is the standard variant: a build without the key
    /// predates phase 1e and owns the "Vision Native" directory.
    // lint:allow explicit-any Info.plist values are untyped
    public static func fromInfoPlist(_ value: Any?) -> NativeVariant {
        (value as? String).flatMap(NativeVariant.init(rawValue:)) ?? .standard
    }

    /// `APP_NAME`: the window title, the iCloud backup folder and the data directory name.
    public var appName: String {
        switch self {
        case .standard: return VisionNativeIdentity.userDataName
        case .demo: return "Vision Native Demo"
        }
    }

    public var userDataName: String { appName }

    /// The folder below iCloud Drive that holds the default backup directory. The standard
    /// variant shares Electron Vision's `Vision/Backups` (ADR-253, Tor's choice); retention
    /// is per device id, which includes the data directory, so neither app prunes the other's
    /// backups.
    public var backupFolderName: String {
        switch self {
        case .standard: return "Vision"
        case .demo: return appName
        }
    }

    public var runtimeId: String {
        switch self {
        case .standard: return VisionNativeIdentity.runtimeId
        case .demo: return "vision_native_demo"
        }
    }

    public var postgresPort: Int {
        switch self {
        case .standard: return VisionNativeIdentity.postgresPort
        case .demo: return 54332
        }
    }

    /// The prefix of every Keychain service name: the bundle id with the runtime id's
    /// underscores as hyphens.
    public var keychainServicePrefix: String {
        "com.vaultvoyager.\(runtimeId.replacingOccurrences(of: "_", with: "-"))"
    }

    /// The backup passphrase (`KeychainPassphraseStore`).
    public var backupPassphraseService: String { "\(keychainServicePrefix).backup-passphrase" }

    /// `~/Library/Application Support/<appName>`.
    public func userDataDirectory(homeDirectory: String) -> String {
        PathUtilities.join(homeDirectory, "Library", "Application Support", userDataName)
    }

    /// The variant a data directory belongs to, by its name.
    public static func owning(userDataDirectory: String) -> NativeVariant? {
        let name = PathUtilities.basename(userDataDirectory)
        return allCases.first { $0.userDataName == name }
    }
}

extension RuntimeLayout {
    /// The layout of a variant's own data directory and runtime id.
    public init(variant: NativeVariant, homeDirectory: String) throws {
        try self.init(
            userDataDirectory: variant.userDataDirectory(homeDirectory: homeDirectory), runtimeId: variant.runtimeId)
    }
}

import Foundation

/// What to do when the web content process terminates. WebKit leaves a blank view, so the
/// shell reloads, but a page that crashes the process on every load must not loop: after
/// `maximumReloads` reloads within `window` seconds the launch error page is shown instead.
public struct CrashReloadPolicy: Sendable {
    public static let maximumReloads = 2
    public static let window: Double = 30

    /// The times of the recent reloads, in seconds on a monotonic clock.
    public private(set) var reloads: [Double] = []

    public init() {}

    /// Records a crash at `now` and returns whether to reload.
    public mutating func shouldReload(at now: Double) -> Bool {
        reloads.removeAll { now - $0 >= Self.window }
        guard reloads.count < Self.maximumReloads else { return false }
        reloads.append(now)
        return true
    }

    /// A load the user or the launch flow started (Try again, a new launch).
    public mutating func reset() {
        reloads = []
    }
}

public struct DownloadReplacementError: Error, Equatable, LocalizedError, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// Where a `WKDownload` writes. WebKit refuses an existing file, so a download that replaces
/// one goes to a temporary file in the same directory and replaces the target only when it
/// finished; a failed or cancelled download leaves the previous file untouched. Directories
/// are never replaced or deleted.
public enum DownloadDestination {
    public enum Plan: Equatable, Sendable {
        /// Nothing exists at the target: download straight to it.
        case direct(URL)
        /// A file exists: download to `temporary`, then replace `destination`.
        case replace(temporary: URL, destination: URL)
        /// A directory (or something unreadable) is in the way.
        case refuse(String)
    }

    /// A hidden sibling of the target, unique per download.
    public static func temporaryURL(for destination: URL, id: UUID) -> URL {
        destination.deletingLastPathComponent().appendingPathComponent(
            ".\(destination.lastPathComponent).\(id.uuidString).download", isDirectory: false)
    }

    public static func plan(for destination: URL, id: UUID, fileManager: FileManager = .default) -> Plan {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: destination.path, isDirectory: &isDirectory) else {
            return .direct(destination)
        }
        if isDirectory.boolValue { return .refuse("a folder with that name already exists") }
        return .replace(temporary: temporaryURL(for: destination, id: id), destination: destination)
    }

    /// `downloadDidFinish` of a `.replace` plan: swaps the finished file in. On failure the
    /// temporary file is removed and the previous file stays.
    public static func finish(temporary: URL, destination: URL, fileManager: FileManager = .default) throws {
        do {
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: destination.path, isDirectory: &isDirectory) {
                if isDirectory.boolValue {
                    throw DownloadReplacementError("a folder with that name already exists")
                }
                _ = try fileManager.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try fileManager.moveItem(at: temporary, to: destination)
            }
        } catch {
            discard(temporary: temporary, fileManager: fileManager)
            throw error
        }
    }

    /// A failed or cancelled `.replace` download: removes the temporary file only if it is a
    /// regular file.
    public static func discard(temporary: URL, fileManager: FileManager = .default) {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: temporary.path, isDirectory: &isDirectory), !isDirectory.boolValue
        else {
            return
        }
        try? fileManager.removeItem(at: temporary)
    }
}

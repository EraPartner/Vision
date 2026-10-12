import Darwin
import Foundation

/// Single-instance semantics: Electron uses `app.requestSingleInstanceLock()` in its
/// userData directory; Vision Native holds an exclusive `flock` on
/// `<userData>/vision-native.lock` for the life of the process.
public protocol InstanceLocking: Sendable {
    /// True when this process holds (or now acquires) the lock; false when another
    /// process holds it.
    func acquire(_ path: String) throws -> Bool
}

/// `flock(LOCK_EX | LOCK_NB)` on a lock file whose descriptor stays open until exit.
public final class FileInstanceLock: InstanceLocking, @unchecked Sendable {
    private let lock = NSLock()
    private var descriptors: [String: Int32] = [:]

    public init() {}

    deinit {
        for descriptor in descriptors.values { Darwin.close(descriptor) }
    }

    public func acquire(_ path: String) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if descriptors[path] != nil { return true }
        let descriptor = Darwin.open(path, O_RDWR | O_CREAT | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else {
            throw FileSystemError.failed(path, String(cString: strerror(errno)))
        }
        if Darwin.flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            Darwin.close(descriptor)
            if code == EWOULDBLOCK { return false }
            throw FileSystemError.failed(path, String(cString: strerror(code)))
        }
        descriptors[path] = descriptor
        return true
    }
}

/// Where lifecycle events are written.
public protocol RuntimeLogging: Sendable {
    func log(_ level: String, _ message: String)
}

/// `<userData>/logs/main.log`, rotated once to `main.log.1` past 2 MB at startup, like
/// `initFileLogger` in `packaging/electron/main.ts`. Best effort: failures are ignored.
public final class FileRuntimeLog: RuntimeLogging, @unchecked Sendable {
    private let lock = NSLock()
    private let path: String
    private var handle: FileHandle?

    public init(path: String) {
        self.path = path
        let manager = FileManager.default
        let directory = PathUtilities.dirname(path)
        try? manager.createDirectory(
            atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let size = (try? manager.attributesOfItem(atPath: path))?[.size] as? NSNumber,
            size.intValue > 2 * 1024 * 1024
        {
            _ = Darwin.rename(path, "\(path).1")
        }
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, mode_t(0o600))
        handle = descriptor >= 0 ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
        log("log", "Vision Native logger started (pid \(ProcessInfo.processInfo.processIdentifier))")
    }

    public func log(_ level: String, _ message: String) {
        let line = "\(isoTimestamp(Date())) [\(level)] \(redactDiagnostics(message))\n"
        lock.lock()
        defer { lock.unlock() }
        try? handle?.write(contentsOf: Data(line.utf8))
    }
}

/// Discards log lines (tests).
public struct NullRuntimeLog: RuntimeLogging {
    public init() {}
    public func log(_ level: String, _ message: String) {}
}

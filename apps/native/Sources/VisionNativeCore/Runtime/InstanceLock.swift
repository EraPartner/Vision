import Darwin
import Foundation

/// `Darwin.flock` resolves to the `struct flock` initializer in Swift, so bind the
/// syscall by symbol name instead.
@_silgen_name("flock") private func c_flock(_ descriptor: Int32, _ operation: Int32) -> Int32

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
        if c_flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
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
    /// Called once the single-instance lock is held, so only the owning instance
    /// rotates the shared log.
    func rotate()
}

extension RuntimeLogging {
    public func rotate() {}
}

/// `<userData>/logs/main.log`, rotated once to `main.log.1` past 2 MB at startup, like
/// `initFileLogger` in `packaging/electron/main.ts`. Best effort: failures are ignored.
/// With `rotate: false` the constructor never renames the file; `rotate()` then does
/// it later, after the caller has taken the single-instance lock.
public final class FileRuntimeLog: RuntimeLogging, @unchecked Sendable {
    public static let rotationThreshold = 2 * 1024 * 1024

    private let lock = NSLock()
    private let path: String
    private var handle: FileHandle?
    private var rotated = false

    public init(path: String, rotate: Bool = true) {
        self.path = path
        try? FileManager.default.createDirectory(
            atPath: PathUtilities.dirname(path), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        lock.withLock {
            if rotate { rotateLocked() }
            handle = Self.open(path)
        }
        log("log", "Vision Native logger started (pid \(ProcessInfo.processInfo.processIdentifier))")
    }

    private static func open(_ path: String) -> FileHandle? {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, mode_t(0o600))
        return descriptor >= 0 ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
    }

    /// Renames a log past the threshold to `main.log.1`, at most once per instance.
    private func rotateLocked() {
        guard !rotated else { return }
        rotated = true
        guard let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber,
            size.intValue > Self.rotationThreshold
        else { return }
        _ = Darwin.rename(path, "\(path).1")
    }

    public func rotate() {
        lock.withLock {
            guard !rotated else { return }
            rotateLocked()
            try? handle?.close()
            handle = Self.open(path)
        }
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

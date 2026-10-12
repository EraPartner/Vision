import Darwin
import Foundation
import Security

/// A backup or restore failure with the message Electron's `Error` carries. The bridge
/// reports it as `String(err)`, that is `"Error: <message>"`.
public struct BackupFailure: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
    public var description: String { message }
}

/// `String(err)` for the `error` field of a `{ success: false, error }` result.
public func backupErrorString(_ error: Error) -> String {
    "Error: \(backupErrorMessage(error))"
}

/// `err.message`.
public func backupErrorMessage(_ error: Error) -> String {
    switch error {
    case let failure as BackupFailure: return failure.message
    case let runtime as NativeRuntimeError: return runtime.message
    case let process as ProcessRunError: return process.message
    case let localized as LocalizedError: return localized.errorDescription ?? String(describing: error)
    default: return (error as NSError).localizedDescription
    }
}

/// File helpers for backup and restore. They work on real paths with streaming I/O, so a
/// large dump or attachment tree is never held in memory.
public enum BackupFiles {
    /// Read and write chunk size.
    public static let chunkSize = 1024 * 1024

    /// `crypto.randomBytes`.
    public static func randomBytes(_ count: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw BackupFailure("Secure random bytes are unavailable") }
        return bytes
    }

    /// `fs.promises.mkdtemp(path.join(os.tmpdir(), prefix))`, private (0700).
    public static func makeTemporaryDirectory(prefix: String, in parent: String? = nil) throws -> String {
        let base = parent ?? NSTemporaryDirectory()
        var template = Array(PathUtilities.join(base, "\(prefix)XXXXXX").utf8CString)
        let created = template.withUnsafeMutableBufferPointer { buffer -> Bool in
            mkdtemp(buffer.baseAddress!) != nil
        }
        guard created else { throw BackupFailure("Could not create a temporary directory: \(String(cString: strerror(errno)))") }
        return template.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
    }

    public static func exists(_ path: String) -> Bool {
        var status = stat()
        return Darwin.lstat(path, &status) == 0
    }

    public static func isDirectory(_ path: String) -> Bool {
        var status = stat()
        return Darwin.lstat(path, &status) == 0 && (status.st_mode & S_IFMT) == S_IFDIR
    }

    public static func isRegularFile(_ path: String) -> Bool {
        var status = stat()
        return Darwin.lstat(path, &status) == 0 && (status.st_mode & S_IFMT) == S_IFREG
    }

    public static func size(_ path: String) -> UInt64? {
        var status = stat()
        guard Darwin.lstat(path, &status) == 0 else { return nil }
        return UInt64(status.st_size)
    }

    public static func modificationDate(_ path: String) -> Date? {
        var status = stat()
        guard Darwin.lstat(path, &status) == 0 else { return nil }
        let spec = status.st_mtimespec
        return Date(timeIntervalSince1970: Double(spec.tv_sec) + Double(spec.tv_nsec) / 1_000_000_000)
    }

    /// `fs.rm(path, { recursive: true, force: true })`.
    public static func remove(_ path: String) {
        guard exists(path) else { return }
        try? FileManager.default.removeItem(atPath: path)
    }

    /// `mkdir -p` with `mode` for the directories it creates.
    public static func createDirectory(_ path: String, mode: Int = 0o700) throws {
        try FileManager.default.createDirectory(
            atPath: path, withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: mode)])
    }

    /// Opens a new (truncated) file for writing with `mode`.
    public static func createFile(_ path: String, mode: Int = 0o600) throws -> FileHandle {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, mode_t(mode))
        guard descriptor >= 0 else {
            throw BackupFailure("Could not create \(PathUtilities.basename(path)): \(String(cString: strerror(errno)))")
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    public static func openForReading(_ path: String) throws -> FileHandle {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw BackupFailure("ENOENT: no such file or directory, open '\(path)'")
        }
        return handle
    }

    /// Reads up to `count` bytes, looping over short reads; empty at end of file.
    public static func read(_ handle: FileHandle, upTo count: Int) throws -> Data {
        var collected = Data()
        while collected.count < count {
            guard let chunk = try handle.read(upToCount: count - collected.count), !chunk.isEmpty else { break }
            collected.append(chunk)
        }
        return collected
    }

    /// Reads exactly `count` bytes at `offset`, or throws `message`.
    public static func read(_ handle: FileHandle, at offset: UInt64, count: Int, message: String) throws -> [UInt8] {
        try handle.seek(toOffset: offset)
        let data = try read(handle, upTo: count)
        guard data.count == count else { throw BackupFailure(message) }
        return [UInt8](data)
    }
}

extension Array where Element == UInt8 {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

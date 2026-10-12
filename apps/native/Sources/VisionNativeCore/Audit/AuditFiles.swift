import Darwin
import Foundation

/// The file operations of `audit-anchor.ts`: `lstat`-based existence, regular-file reads
/// and `atomicPrivateWrite` (0600 temporary sibling, fsync, rename, chmod, directory fsync).
enum AuditFiles {
    private static func failure(_ path: String) -> FileSystemError {
        FileSystemError.failed(path, String(cString: strerror(errno)))
    }

    /// `exists`: `lstat` succeeds; `ENOENT` is false and any other error throws.
    static func exists(_ path: String) throws -> Bool {
        var status = stat()
        if Darwin.lstat(path, &status) == 0 { return true }
        if errno == ENOENT || errno == ENOTDIR { return false }
        throw failure(path)
    }

    /// `readRegular`: the UTF-8 contents of a regular file (not a symlink or directory).
    static func readRegular(_ path: String) throws -> String {
        var status = stat()
        guard Darwin.lstat(path, &status) == 0 else { throw failure(path) }
        guard (status.st_mode & S_IFMT) == S_IFREG else { throw AuditAnchorError("invalid_file_type") }
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw failure(path) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let data = try handle.readToEnd() ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    /// `fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })`.
    static func createDirectory(_ path: String) throws {
        try FileManager.default.createDirectory(
            atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: NSNumber(value: 0o700)])
    }

    /// `fsync` of a directory, which persists a rename across a crash.
    static func syncDirectory(_ path: String) throws {
        let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw failure(path) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw failure(path) }
    }

    /// `atomicPrivateWrite`.
    static func atomicPrivateWrite(_ path: String, _ contents: String) throws {
        let directory = PathUtilities.dirname(path)
        try createDirectory(directory)
        let temporary = "\(path).tmp-\(getpid())-\(UUID().uuidString.lowercased())"
        let descriptor = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw failure(temporary) }
        var written = false
        defer { if !written { _ = Darwin.unlink(temporary) } }
        let bytes = Array(contents.utf8)
        var failed: FileSystemError?
        var offset = 0
        while offset < bytes.count, failed == nil {
            let result = bytes.withUnsafeBytes { raw in
                Darwin.write(descriptor, raw.baseAddress! + offset, bytes.count - offset)
            }
            if result < 0 {
                if errno == EINTR { continue }
                failed = failure(temporary)
            } else {
                offset += result
            }
        }
        if failed == nil, Darwin.fsync(descriptor) != 0 { failed = failure(temporary) }
        Darwin.close(descriptor)
        if let failed { throw failed }
        guard Darwin.rename(temporary, path) == 0 else { throw failure(path) }
        written = true
        guard Darwin.chmod(path, mode_t(0o600)) == 0 else { throw failure(path) }
        try syncDirectory(directory)
    }

    /// `fs.promises.rm(path, { force: true })`.
    static func remove(_ path: String) throws {
        if Darwin.unlink(path) != 0, errno != ENOENT { throw failure(path) }
    }
}

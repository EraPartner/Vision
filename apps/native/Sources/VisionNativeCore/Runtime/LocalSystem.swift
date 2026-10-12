import CryptoKit
import Darwin
import Foundation
import Security

/// A value guarded by a lock, for state shared with Foundation callbacks.
final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

/// Carries a non-Sendable Foundation object across a concurrency boundary. Every use
/// is confined to one callback at a time.
final class UncheckedBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

/// Waits for a `Process` termination without racing the termination handler.
private final class ExitWaiter: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var continuation: CheckedContinuation<Int32, Never>?

    func finish(_ value: Int32) {
        lock.lock()
        status = value
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: value)
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            lock.lock()
            if let status {
                lock.unlock()
                continuation.resume(returning: status)
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
    }
}

/// Runs short-lived tools (`initdb`, `psql`, `pg_ctl`, `ps`) with `Foundation.Process`.
public struct FoundationProcessRunner: ProcessRunning {
    public init() {}

    public func run(_ executable: String, _ arguments: [String], options: RunOptions) async throws -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = options.environment
        if let cwd = options.cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        process.standardInput = FileHandle.nullDevice
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        let waiter = ExitWaiter()
        process.terminationHandler = { finished in
            let status =
                finished.terminationReason == .uncaughtSignal
                ? 128 + finished.terminationStatus : finished.terminationStatus
            waiter.finish(status)
        }
        let name = PathUtilities.basename(executable)
        do {
            try process.run()
        } catch {
            throw ProcessRunError(
                executable: executable,
                exitStatus: nil,
                message: "\(name) failed to start: \(error.localizedDescription)"
            )
        }
        let box = UncheckedBox(process)
        let timedOut = LockedValue(false)
        let timeoutNanoseconds = UInt64(max(options.timeout, 0.001) * 1_000_000_000)
        let timer = Task.detached {
            try await Task.sleep(nanoseconds: timeoutNanoseconds)
            timedOut.withLock { $0 = true }
            if box.value.isRunning { box.value.terminate() }
        }
        let stdoutHandle = UncheckedBox(stdoutPipe.fileHandleForReading)
        let stderrHandle = UncheckedBox(stderrPipe.fileHandleForReading)
        async let stdoutData = Self.readToEnd(stdoutHandle)
        async let stderrData = Self.readToEnd(stderrHandle)
        let status = await waiter.wait()
        timer.cancel()
        let stdout = String(decoding: await stdoutData, as: UTF8.self)
        let stderr = String(decoding: await stderrData, as: UTF8.self)
        if timedOut.withLock({ $0 }) {
            throw ProcessRunError(executable: executable, exitStatus: status, message: "\(name) timed out")
        }
        guard status == 0 else {
            let trimmed = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw ProcessRunError(
                executable: executable,
                exitStatus: status,
                message: trimmed.isEmpty ? "\(name) failed with exit status \(status)" : trimmed
            )
        }
        return RunResult(stdout: stdout, stderr: stderr)
    }

    private static func readToEnd(_ box: UncheckedBox<FileHandle>) async -> Data {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data, Never>) in
            DispatchQueue.global(qos: .utility).async {
                let data = (try? box.value.readToEnd()) ?? Data()
                continuation.resume(returning: data)
            }
        }
    }
}

/// Starts PostgreSQL and the backend as children whose output is appended to a log file.
public struct FoundationProcessSpawner: ProcessSpawning {
    public init() {}

    public func spawn(
        _ executable: String,
        _ arguments: [String],
        cwd: String?,
        environment: [String: String],
        logPath: String,
        onExit: @escaping @Sendable () -> Void
    ) throws -> SpawnedChild {
        let descriptor = Darwin.open(logPath, O_WRONLY | O_CREAT | O_APPEND, mode_t(0o600))
        guard descriptor >= 0 else {
            throw FileSystemError.failed(logPath, String(cString: strerror(errno)))
        }
        let log = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        if let cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log
        // Keeps the Process alive until it exits; cleared by the termination handler.
        let retained = LockedValue<Process?>(process)
        let exited = LockedValue(false)
        process.terminationHandler = { _ in
            exited.withLock { $0 = true }
            retained.withLock { $0 = nil }
            onExit()
        }
        defer { try? log.close() }
        try process.run()
        return SpawnedChild(pid: process.processIdentifier, hasExited: { exited.withLock { $0 } })
    }
}

/// `kill(2)` based PID checks and signals.
public struct DarwinProcessControl: ProcessControlling {
    public init() {}

    public func exists(_ pid: Int32) -> Bool {
        pid > 1 && Darwin.kill(pid, 0) == 0
    }

    public func signal(_ pid: Int32, _ signal: Int32) throws {
        guard pid > 1 else { throw NativeRuntimeError("INVALID_PID", "Refusing to signal process id \(pid)") }
        if Darwin.kill(pid, signal) != 0 {
            throw NativeRuntimeError("SIGNAL_FAILED", "Could not signal process \(pid): \(String(cString: strerror(errno)))")
        }
    }
}

/// Probes a loopback port by binding and listening on it, then closing the socket.
/// It sets `SO_REUSEADDR` like Node's `net.createServer().listen` (libuv), so a port
/// held only by `TIME_WAIT` connections counts as free.
public struct LoopbackPortProbe: PortProbing {
    public init() {}

    public func isPortFree(_ port: Int) async -> Bool {
        Self.canListen(port: port)
    }

    public static func canListen(port: Int) -> Bool {
        guard (1...65535).contains(port) else { return false }
        let socketDescriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else { return false }
        defer { Darwin.close(socketDescriptor) }
        var reuse: Int32 = 1
        _ = Darwin.setsockopt(
            socketDescriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr(RuntimeConstants.loopbackHost)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.bind(socketDescriptor, generic, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return false }
        return Darwin.listen(socketDescriptor, 1) == 0
    }
}

/// `GET` over an ephemeral `URLSession` (no cookies or cache shared with the web view).
public struct URLSessionHTTPClient: HTTPGetting {
    private let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    public func get(_ url: URL, timeout: TimeInterval) async throws -> HTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return HTTPResponse(status: http.statusCode, body: data)
    }
}

public struct SystemClock: RuntimeClock {
    public init() {}

    public func now() -> Date { Date() }

    public func sleep(milliseconds: Int) async {
        try? await Task.sleep(nanoseconds: UInt64(max(milliseconds, 0)) * 1_000_000)
    }
}

/// `SecRandomCopyBytes` for secrets and nonces; the system generator for ports.
public struct SecureRandomSource: RandomSource {
    public init() {}

    public func hex(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public func integer(in range: ClosedRange<Int>) -> Int {
        Int.random(in: range)
    }
}

/// `FileManager` and POSIX calls on the local disk.
public struct LocalFileSystem: RuntimeFileSystem {
    public init() {}

    private var manager: FileManager { FileManager.default }

    public func info(_ path: String) -> FileInfo? {
        guard let attributes = try? manager.attributesOfItem(atPath: path) else { return nil }
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        switch attributes[.type] as? FileAttributeType {
        case .typeRegular?: return FileInfo(kind: .file, size: size)
        case .typeDirectory?: return FileInfo(kind: .directory)
        case .typeSymbolicLink?: return FileInfo(kind: .symlink)
        default: return FileInfo(kind: .other)
        }
    }

    public func readFile(_ path: String) throws -> Data {
        guard info(path) != nil else { throw FileSystemError.notFound(path) }
        do {
            return try Data(contentsOf: URL(fileURLWithPath: path))
        } catch {
            throw FileSystemError.failed(path, error.localizedDescription)
        }
    }

    public func writeFile(_ path: String, _ data: Data, mode: Int) throws {
        let parent = PathUtilities.dirname(path)
        if info(parent) == nil {
            try createDirectory(parent, mode: 0o700)
        }
        let temporary = "\(path).tmp-\(getpid())-\(epochMilliseconds(Date()))"
        guard manager.createFile(atPath: temporary, contents: data, attributes: [.posixPermissions: mode]) else {
            throw FileSystemError.failed(temporary, "could not write file")
        }
        do {
            try move(temporary, path)
            try setMode(path, mode)
        } catch {
            _ = Darwin.unlink(temporary)
            throw error
        }
    }

    public func createDirectory(_ path: String, mode: Int) throws {
        do {
            try manager.createDirectory(
                atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: mode])
        } catch {
            throw FileSystemError.failed(path, error.localizedDescription)
        }
        try setMode(path, mode)
    }

    public func setMode(_ path: String, _ mode: Int) throws {
        if Darwin.chmod(path, mode_t(mode)) != 0 {
            throw FileSystemError.failed(path, String(cString: strerror(errno)))
        }
    }

    public func mode(_ path: String) throws -> Int {
        guard let attributes = try? manager.attributesOfItem(atPath: path) else {
            throw FileSystemError.notFound(path)
        }
        return ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o7777
    }

    public func move(_ source: String, _ destination: String) throws {
        if Darwin.rename(source, destination) != 0 {
            let code = errno
            if code == ENOENT { throw FileSystemError.notFound(source) }
            throw FileSystemError.failed(source, String(cString: strerror(code)))
        }
    }

    public func remove(_ path: String) throws {
        guard info(path) != nil else { return }
        do {
            try manager.removeItem(atPath: path)
        } catch {
            throw FileSystemError.failed(path, error.localizedDescription)
        }
    }

    public func contentsOfDirectory(_ path: String) throws -> [String] {
        do {
            return try manager.contentsOfDirectory(atPath: path).sorted()
        } catch {
            if info(path) == nil { throw FileSystemError.notFound(path) }
            throw FileSystemError.failed(path, error.localizedDescription)
        }
    }

    public func isExecutable(_ path: String) -> Bool {
        !path.isEmpty && Darwin.access(path, X_OK) == 0
    }

    public func realPath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    public func makeTemporaryDirectory(prefix: String) throws -> String {
        let base = NSTemporaryDirectory()
        let separator = base.hasSuffix("/") ? "" : "/"
        var template = Array("\(base)\(separator)\(prefix)XXXXXX".utf8CString)
        let created = template.withUnsafeMutableBufferPointer { buffer -> Bool in
            Darwin.mkdtemp(buffer.baseAddress!) != nil
        }
        guard created else {
            throw FileSystemError.failed(base, String(cString: strerror(errno)))
        }
        return template.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
    }

    public func sha256(_ path: String) throws -> (bytes: Int, hex: String) {
        guard info(path) != nil else { throw FileSystemError.notFound(path) }
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        } catch {
            throw FileSystemError.failed(path, error.localizedDescription)
        }
        defer { try? handle.close() }
        var hasher = SHA256()
        var total = 0
        while true {
            let chunk: Data?
            do {
                chunk = try handle.read(upToCount: 1 << 20)
            } catch {
                throw FileSystemError.failed(path, error.localizedDescription)
            }
            guard let chunk, !chunk.isEmpty else { break }
            total += chunk.count
            hasher.update(data: chunk)
        }
        let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return (total, hex)
    }

    public func readNoFollow(_ path: String) throws -> NoFollowRead {
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if descriptor < 0 {
            let code = errno
            if code == ENOENT { return .missing }
            if code == ELOOP { return .unsafe }
            throw FileSystemError.failed(path, String(cString: strerror(code)))
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            throw FileSystemError.failed(path, String(cString: strerror(errno)))
        }
        guard (Int(status.st_mode) & Int(S_IFMT)) == Int(S_IFREG) else { return .unsafe }
        do {
            return .contents(try handle.readToEnd() ?? Data())
        } catch {
            throw FileSystemError.failed(path, error.localizedDescription)
        }
    }
}

extension RuntimeDependencies {
    /// The real operating-system implementations.
    public static func live() -> RuntimeDependencies {
        RuntimeDependencies(
            fileSystem: LocalFileSystem(),
            runner: FoundationProcessRunner(),
            spawner: FoundationProcessSpawner(),
            processes: DarwinProcessControl(),
            ports: LoopbackPortProbe(),
            http: URLSessionHTTPClient(),
            clock: SystemClock(),
            random: SecureRandomSource()
        )
    }
}

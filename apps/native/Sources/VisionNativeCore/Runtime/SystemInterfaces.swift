import Foundation

// Seams for everything the runtime does to the operating system. The live
// implementations are in LocalSystem.swift; tests inject fakes, as
// packaging/electron/runtime/native.test.ts injects runFile and spawn.

/// Options for a short-lived child process (`RunFileOptions`).
public struct RunOptions: Sendable, Equatable {
    public var cwd: String?
    /// The complete child environment. The runtime always passes one.
    public var environment: [String: String]
    /// Seconds before the child is terminated.
    public var timeout: TimeInterval

    public init(cwd: String? = nil, environment: [String: String], timeout: TimeInterval = 30) {
        self.cwd = cwd
        self.environment = environment
        self.timeout = timeout
    }
}

public struct RunResult: Sendable, Equatable {
    public var stdout: String
    public var stderr: String

    public init(stdout: String = "", stderr: String = "") {
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// A child process that failed to start, exited non-zero or timed out. Its message is
/// the trimmed stderr when there is one, like `defaultRunFile`.
public struct ProcessRunError: Error, Equatable, Sendable, LocalizedError {
    public let executable: String
    public let exitStatus: Int32?
    public let message: String

    public init(executable: String, exitStatus: Int32?, message: String) {
        self.executable = executable
        self.exitStatus = exitStatus
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// Runs a process with an argument array and collects its output (`RunFile`).
public protocol ProcessRunning: Sendable {
    func run(_ executable: String, _ arguments: [String], options: RunOptions) async throws -> RunResult
}

/// A long-running child the runtime supervises (`SpawnedChild`).
public struct SpawnedChild: Sendable {
    public let pid: Int32
    /// True once the child has exited (`child.exitCode !== null`).
    public let hasExited: @Sendable () -> Bool

    public init(pid: Int32, hasExited: @escaping @Sendable () -> Bool) {
        self.pid = pid
        self.hasExited = hasExited
    }
}

/// Starts a long-running child with stdin closed and stdout/stderr appended to a log
/// file created with mode 0600 (`SpawnProcess`). `onExit` runs once when it exits.
public protocol ProcessSpawning: Sendable {
    func spawn(
        _ executable: String,
        _ arguments: [String],
        cwd: String?,
        environment: [String: String],
        logPath: String,
        onExit: @escaping @Sendable () -> Void
    ) throws -> SpawnedChild
}

/// PID probing and signalling (`process.kill`).
public protocol ProcessControlling: Sendable {
    /// `kill(pid, 0) == 0`: false for a dead process and for one we may not signal.
    func exists(_ pid: Int32) -> Bool
    func signal(_ pid: Int32, _ signal: Int32) throws
}

/// Loopback TCP port availability (`isPortFree`).
public protocol PortProbing: Sendable {
    func isPortFree(_ port: Int) async -> Bool
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data = Data()) {
        self.status = status
        self.body = body
    }
}

/// A plain HTTP GET; throws when the request fails or times out.
public protocol HTTPGetting: Sendable {
    func get(_ url: URL, timeout: TimeInterval) async throws -> HTTPResponse
}

/// Time and waiting, so tests do not sleep.
public protocol RuntimeClock: Sendable {
    func now() -> Date
    func sleep(milliseconds: Int) async
}

/// Randomness for generated secrets, nonces and the random backend port.
public protocol RandomSource: Sendable {
    /// `crypto.randomBytes(count).toString("hex")`.
    func hex(byteCount: Int) -> String
    func integer(in range: ClosedRange<Int>) -> Int
}

public enum FileKind: Sendable, Equatable {
    case file
    case directory
    case symlink
    case other
}

/// `lstat` facts: the kind of the entry itself and, for a file, its size.
public struct FileInfo: Sendable, Equatable {
    public var kind: FileKind
    public var size: Int

    public init(kind: FileKind, size: Int = 0) {
        self.kind = kind
        self.size = size
    }
}

public enum FileSystemError: Error, Equatable, Sendable {
    case notFound(String)
    case failed(String, String)
}

/// The outcome of opening a file with `O_NOFOLLOW | O_NONBLOCK` and checking it is regular.
public enum NoFollowRead: Sendable, Equatable {
    case missing
    case unsafe
    case contents(Data)
}

/// File operations the runtime needs, on absolute paths.
public protocol RuntimeFileSystem: Sendable {
    /// `lstat`; `nil` when nothing exists at the path.
    func info(_ path: String) -> FileInfo?
    /// Throws `FileSystemError.notFound` when the file does not exist.
    func readFile(_ path: String) throws -> Data
    /// `writeAtomic`: creates the parent (0700), writes a temporary sibling with `mode`,
    /// renames it over `path` and applies `mode` again.
    func writeFile(_ path: String, _ data: Data, mode: Int) throws
    /// `mkdir -p` with `mode`, then `chmod mode` on the final directory.
    func createDirectory(_ path: String, mode: Int) throws
    func setMode(_ path: String, _ mode: Int) throws
    func mode(_ path: String) throws -> Int
    /// `rename(2)`.
    func move(_ source: String, _ destination: String) throws
    /// Recursive removal; a missing path is not an error.
    func remove(_ path: String) throws
    func contentsOfDirectory(_ path: String) throws -> [String]
    /// `access(path, X_OK) == 0`.
    func isExecutable(_ path: String) -> Bool
    /// `realpath`; `nil` when the path does not resolve.
    func realPath(_ path: String) -> String?
    /// A new private (0700) directory below the temporary directory.
    func makeTemporaryDirectory(prefix: String) throws -> String
    /// Byte count and lowercase hex SHA-256 of a file, streamed.
    func sha256(_ path: String) throws -> (bytes: Int, hex: String)
    func readNoFollow(_ path: String) throws -> NoFollowRead
}

extension RuntimeFileSystem {
    public func exists(_ path: String) -> Bool { info(path) != nil }

    /// Reads a file, `nil` when it is missing; other errors throw.
    public func readIfPresent(_ path: String) throws -> Data? {
        do {
            return try readFile(path)
        } catch FileSystemError.notFound {
            return nil
        }
    }

    public func readText(_ path: String) throws -> String {
        String(decoding: try readFile(path), as: UTF8.self)
    }

    public func writeText(_ path: String, _ text: String, mode: Int = 0o600) throws {
        try writeFile(path, Data(text.utf8), mode: mode)
    }
}

/// Everything the runtime needs from the system, bundled for injection.
public struct RuntimeDependencies: Sendable {
    public var fileSystem: any RuntimeFileSystem
    public var runner: any ProcessRunning
    public var spawner: any ProcessSpawning
    public var processes: any ProcessControlling
    public var ports: any PortProbing
    public var http: any HTTPGetting
    public var clock: any RuntimeClock
    public var random: any RandomSource

    public init(
        fileSystem: any RuntimeFileSystem,
        runner: any ProcessRunning,
        spawner: any ProcessSpawning,
        processes: any ProcessControlling,
        ports: any PortProbing,
        http: any HTTPGetting,
        clock: any RuntimeClock,
        random: any RandomSource
    ) {
        self.fileSystem = fileSystem
        self.runner = runner
        self.spawner = spawner
        self.processes = processes
        self.ports = ports
        self.http = http
        self.clock = clock
        self.random = random
    }
}

/// ISO-8601 with milliseconds, like `Date.prototype.toISOString`.
public func isoTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: date)
}

/// Milliseconds since 1970, like `Date.now()`.
public func epochMilliseconds(_ date: Date) -> Int {
    Int((date.timeIntervalSince1970 * 1000).rounded(.down))
}

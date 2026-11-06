import CryptoKit
import Darwin
import Foundation
import Testing
@testable import VisionNativeCore

/// Test-only string literals for currency codes (`"EUR"`), so fixtures read like the wire. Production
/// code has no such conformance: it takes codes from decoded models or `CurrencyCode(rawValue:)`.
/// Traps on a malformed literal, which a fixture typo should be.
extension CurrencyCode: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        guard let code = CurrencyCode(rawValue: value) else {
            preconditionFailure("\"\(value)\" is not a currency code (^[A-Z]{3}$)")
        }
        self = code
    }
}

/// Test-only string literals for calendar days (`"2026-10-09"`) and timestamps
/// (`"2026-10-09T08:05:00.000Z"`), like the currency code literals above. Production code reads
/// them from decoded models or `CalendarDay(_:)` / `Instant(_:)`. A malformed literal records a
/// test issue and falls back to the epoch, so one run reports every bad fixture instead of trapping.
extension CalendarDay: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        guard let day = CalendarDay(value) else {
            Issue.record("\"\(value)\" is not a calendar day (YYYY-MM-DD)")
            self = CalendarDay(validYear: 1970, month: 1, day: 1)
            return
        }
        self = day
    }
}

extension Instant: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        guard let instant = Instant(value) else {
            Issue.record("\"\(value)\" is not an ISO 8601 timestamp with a zone")
            self = Instant(date: Date(timeIntervalSince1970: 0))
            return
        }
        self = instant
    }
}

extension OpenAPI.SettingBaseline {
    /// A baseline written as the JSON of the wire (`{ exists: false }`, `{ exists: true, value }`),
    /// the way the setting fixtures spell it. Traps on JSON that is not a baseline.
    static func wire(_ json: JSONValue) -> OpenAPI.SettingBaseline {
        do {
            return try OpenAPI.SettingBaseline(json: json)
        } catch {
            preconditionFailure("not a setting baseline: \(error)")
        }
    }
}

/// An in-memory file system with POSIX-like semantics for the calls the runtime makes.
final class FakeFileSystem: RuntimeFileSystem, @unchecked Sendable {
    enum Node: Equatable {
        case file(Data, Int)
        case directory(Int)
        case symlink(String)
        case fifo
    }

    private let lock = NSLock()
    private var nodes: [String: Node] = ["/": .directory(0o755)]
    private var temporaryCounter = 0

    private func locked<Result>(_ body: (inout [String: Node]) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(&nodes)
    }

    private static func ancestors(_ path: String) -> [String] {
        var result: [String] = []
        var current = PathUtilities.dirname(path)
        while current != "/" && current != "." {
            result.insert(current, at: 0)
            current = PathUtilities.dirname(current)
        }
        return result
    }

    private static func makeParents(_ path: String, _ nodes: inout [String: Node], mode: Int = 0o700) {
        for ancestor in ancestors(path) where nodes[ancestor] == nil {
            nodes[ancestor] = .directory(mode)
        }
    }

    // Test helpers.

    func addFile(_ path: String, _ text: String, mode: Int = 0o644) {
        addFile(path, Data(text.utf8), mode: mode)
    }

    func addFile(_ path: String, _ data: Data, mode: Int = 0o644) {
        locked { nodes in
            Self.makeParents(path, &nodes, mode: 0o755)
            nodes[path] = .file(data, mode)
        }
    }

    func addDirectory(_ path: String, mode: Int = 0o755) {
        locked { nodes in
            Self.makeParents(path, &nodes, mode: 0o755)
            nodes[path] = .directory(mode)
        }
    }

    func addNode(_ path: String, _ node: Node) {
        locked { nodes in
            Self.makeParents(path, &nodes, mode: 0o755)
            nodes[path] = node
        }
    }

    func node(_ path: String) -> Node? { locked { $0[path] } }

    func text(_ path: String) -> String? {
        guard case .file(let data, _)? = node(path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    func json(_ path: String) -> JSONValue? {
        guard case .file(let data, _)? = node(path) else { return nil }
        return try? JSONValue.parse(data)
    }

    func paths(withPrefix prefix: String) -> [String] {
        locked { $0.keys.filter { $0.hasPrefix(prefix) }.sorted() }
    }

    // RuntimeFileSystem.

    func info(_ path: String) -> FileInfo? {
        switch node(path) {
        case .file(let data, _)?: return FileInfo(kind: .file, size: data.count)
        case .directory?: return FileInfo(kind: .directory)
        case .symlink?: return FileInfo(kind: .symlink)
        case .fifo?: return FileInfo(kind: .other)
        case nil: return nil
        }
    }

    func readFile(_ path: String) throws -> Data {
        switch node(path) {
        case .file(let data, _)?: return data
        case nil: throw FileSystemError.notFound(path)
        default: throw FileSystemError.failed(path, "not a file")
        }
    }

    func writeFile(_ path: String, _ data: Data, mode: Int) throws {
        try locked { nodes in
            if case .directory? = nodes[path] { throw FileSystemError.failed(path, "is a directory") }
            Self.makeParents(path, &nodes)
            nodes[path] = .file(data, mode)
        }
    }

    func createDirectory(_ path: String, mode: Int) throws {
        try locked { nodes in
            Self.makeParents(path, &nodes, mode: mode)
            switch nodes[path] {
            case .file?, .symlink?, .fifo?: throw FileSystemError.failed(path, "exists")
            default: nodes[path] = .directory(mode)
            }
        }
    }

    func setMode(_ path: String, _ mode: Int) throws {
        try locked { nodes in
            switch nodes[path] {
            case .file(let data, _)?: nodes[path] = .file(data, mode)
            case .directory?: nodes[path] = .directory(mode)
            case nil: throw FileSystemError.notFound(path)
            default: break
            }
        }
    }

    func mode(_ path: String) throws -> Int {
        switch node(path) {
        case .file(_, let mode)?: return mode
        case .directory(let mode)?: return mode
        case nil: throw FileSystemError.notFound(path)
        default: return 0o777
        }
    }

    func move(_ source: String, _ destination: String) throws {
        try locked { nodes in
            guard nodes[source] != nil else { throw FileSystemError.notFound(source) }
            for key in nodes.keys where key == destination || key.hasPrefix(destination + "/") {
                nodes.removeValue(forKey: key)
            }
            Self.makeParents(destination, &nodes)
            for key in nodes.keys where key == source || key.hasPrefix(source + "/") {
                let node = nodes.removeValue(forKey: key)
                nodes[destination + key.dropFirst(source.count)] = node
            }
        }
    }

    func remove(_ path: String) throws {
        locked { nodes in
            for key in nodes.keys where key == path || key.hasPrefix(path + "/") {
                nodes.removeValue(forKey: key)
            }
        }
    }

    func contentsOfDirectory(_ path: String) throws -> [String] {
        try locked { nodes in
            guard case .directory? = nodes[path] else { throw FileSystemError.notFound(path) }
            let prefix = path == "/" ? "/" : path + "/"
            return nodes.keys.filter { $0.hasPrefix(prefix) && $0 != path && !$0.dropFirst(prefix.count).contains("/") }
                .map { String($0.dropFirst(prefix.count)) }.sorted()
        }
    }

    func isExecutable(_ path: String) -> Bool {
        if case .file(_, let mode)? = node(path) { return mode & 0o111 != 0 }
        return false
    }

    func realPath(_ path: String) -> String? {
        node(path) == nil ? nil : path
    }

    func makeTemporaryDirectory(prefix: String) throws -> String {
        let path = locked { nodes -> String in
            temporaryCounter += 1
            let path = "/tmp/\(prefix)\(temporaryCounter)"
            Self.makeParents(path, &nodes, mode: 0o755)
            nodes[path] = .directory(0o700)
            return path
        }
        return path
    }

    func sha256(_ path: String) throws -> (bytes: Int, hex: String) {
        let data = try readFile(path)
        return (data.count, SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }

    func readNoFollow(_ path: String) throws -> NoFollowRead {
        switch node(path) {
        case nil: return .missing
        case .file(let data, _)?: return .contents(data)
        default: return .unsafe
        }
    }

    func readHead(_ path: String, length: Int) throws -> Data {
        switch node(path) {
        case .file(let data, _)?: return data.prefix(length)
        case nil: throw FileSystemError.notFound(path)
        default: throw FileSystemError.failed(path, "not a regular file")
        }
    }

    /// Copies a regular file; like `copyItem` it refuses an existing destination.
    func copyFileDurably(_ source: String, _ destination: String, mode: Int) throws {
        try locked { nodes in
            guard case .file(let data, _)? = nodes[source] else { throw FileSystemError.notFound(source) }
            guard nodes[destination] == nil else { throw FileSystemError.failed(destination, "exists") }
            Self.makeParents(destination, &nodes)
            nodes[destination] = .file(data, mode)
        }
    }

    private var synced: [String] = []
    /// Directories `syncDirectory` flushed, in order.
    var syncedDirectories: [String] { lock.withLock { synced } }

    func syncDirectory(_ path: String) {
        lock.withLock { synced.append(path) }
    }

    private var modified: [String: Date] = [:]

    func setModificationDate(_ path: String, _ date: Date) {
        lock.withLock { modified[path] = date }
    }

    func modificationDate(_ path: String) -> Date? {
        lock.withLock { nodes[path] == nil ? nil : modified[path] }
    }
}

struct FakeProcessFailure: Error {}

/// Records every run and answers through a handler.
final class FakeRunner: ProcessRunning, @unchecked Sendable {
    struct Call: Sendable {
        let executable: String
        let arguments: [String]
        let options: RunOptions
        var name: String { PathUtilities.basename(executable) }
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    var handler: @Sendable (Call) throws -> RunResult = { _ in RunResult() }
    /// Awaited before `handler`, so a test can hold a call in flight.
    var gate: (@Sendable (Call) async -> Void)?

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func calls(named name: String) -> [Call] { calls.filter { $0.name == name } }

    func run(_ executable: String, _ arguments: [String], options: RunOptions) async throws -> RunResult {
        let call = Call(executable: executable, arguments: arguments, options: options)
        lock.withLock { recorded.append(call) }
        if let gate { await gate(call) }
        return try handler(call)
    }
}

/// A one-shot signal that any number of tasks can wait for.
final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            let waiting = waiters
            waiters = []
            return waiting
        }
        for waiter in waiting { waiter.resume() }
    }

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resumeNow = lock.withLock { () -> Bool in
                if isOpen { return true }
                waiters.append(continuation)
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }
}

final class FakeSpawner: ProcessSpawning, @unchecked Sendable {
    struct Spawn: Sendable {
        let executable: String
        let arguments: [String]
        let cwd: String?
        let environment: [String: String]
        let logPath: String
        let pid: Int32
    }

    private let lock = NSLock()
    private var recorded: [Spawn] = []
    private var nextPID: Int32 = 5000
    private var exited = Set<Int32>()
    var onSpawn: @Sendable (Spawn) -> Void = { _ in }

    /// The child has exited (a backend that failed during startup).
    func markExited(_ pid: Int32) {
        lock.lock()
        exited.insert(pid)
        lock.unlock()
    }

    private func hasExited(_ pid: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return exited.contains(pid)
    }

    var spawns: [Spawn] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func spawn(
        _ executable: String,
        _ arguments: [String],
        cwd: String?,
        environment: [String: String],
        logPath: String,
        onExit: @escaping @Sendable () -> Void
    ) throws -> SpawnedChild {
        lock.lock()
        nextPID += 1
        let spawn = Spawn(
            executable: executable, arguments: arguments, cwd: cwd, environment: environment, logPath: logPath,
            pid: nextPID)
        recorded.append(spawn)
        lock.unlock()
        onSpawn(spawn)
        return SpawnedChild(pid: spawn.pid, hasExited: { [self] in hasExited(spawn.pid) })
    }
}

final class FakeProcesses: ProcessControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var alive: Set<Int32> = []
    private var ignoringTerm: Set<Int32> = []
    private var survivingKill: Set<Int32> = []
    private(set) var signals: [(Int32, Int32)] = []

    /// `survivesKill` models a process stuck in the kernel that SIGKILL does not end.
    func add(_ pid: Int32, ignoresTerm: Bool = false, survivesKill: Bool = false) {
        lock.lock()
        alive.insert(pid)
        if ignoresTerm || survivesKill { ignoringTerm.insert(pid) }
        if survivesKill { survivingKill.insert(pid) }
        lock.unlock()
    }

    var sentSignals: [(Int32, Int32)] {
        lock.lock()
        defer { lock.unlock() }
        return signals
    }

    func exists(_ pid: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return alive.contains(pid)
    }

    func signal(_ pid: Int32, _ signal: Int32) throws {
        lock.lock()
        defer { lock.unlock() }
        signals.append((pid, signal))
        if (signal == SIGKILL && !survivingKill.contains(pid)) || (signal == SIGTERM && !ignoringTerm.contains(pid)) {
            alive.remove(pid)
        }
    }
}

final class FakePorts: PortProbing, @unchecked Sendable {
    private let lock = NSLock()
    private var busy: Set<Int> = []
    private(set) var probed: [Int] = []

    func occupy(_ port: Int) {
        lock.lock()
        busy.insert(port)
        lock.unlock()
    }

    func isPortFree(_ port: Int) async -> Bool {
        lock.withLock {
            probed.append(port)
            return !busy.contains(port)
        }
    }
}

final class FakeHTTP: HTTPGetting, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URL] = []
    var handler: @Sendable (URL) throws -> HTTPResponse = { url in
        if url.path.hasSuffix("/health/detailed") {
            return HTTPResponse(status: 200, body: Data(#"{"status":"ready","database":{"connected":true}}"#.utf8))
        }
        if url.path.hasSuffix("/health") { return HTTPResponse(status: 200, body: Data(#"{"status":"ok"}"#.utf8)) }
        return HTTPResponse(status: 404)
    }

    var requests: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func get(_ url: URL, timeout: TimeInterval) async throws -> HTTPResponse {
        lock.withLock { recorded.append(url) }
        return try handler(url)
    }
}

/// Virtual time: `sleep` advances the clock instead of waiting.
final class FakeClock: RuntimeClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_790_000_000)
    private(set) var slept = 0

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func sleep(milliseconds: Int) async {
        lock.withLock {
            current = current.addingTimeInterval(Double(milliseconds) / 1000)
            slept += milliseconds
        }
    }
}

/// Deterministic randomness: secrets are 64 hex characters, ports come from a list.
final class FakeRandom: RandomSource, @unchecked Sendable {
    private let lock = NSLock()
    private var counter = 0
    var ports: [Int] = [41_000]

    func hex(byteCount: Int) -> String {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        let digit = Array("0123456789abcdef")[counter % 16]
        return String(repeating: String(digit), count: byteCount * 2)
    }

    func integer(in range: ClosedRange<Int>) -> Int {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        return ports.isEmpty ? range.lowerBound : ports[(counter - 1) % ports.count]
    }
}

let testHome = "/Users/demo"
let testUserData = "/Users/demo/Library/Application Support/Vision Native"
let testRuntimeRoot = "/payload/native-runtime"
let testSeedRoot = "/payload/demo-seed"

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// The bytes of a SQLite 3 database file: a valid 100-byte header (WAL mode, 4096-byte pages,
/// UTF-8, `user_version` = `userVersion`, written by SQLite 3.43.2) followed by `body`, so
/// two databases with different bodies hash differently.
func sqliteDatabase(userVersion: Int, body: String = "", pages: Int = 2) -> Data {
    var header = [UInt8](repeating: 0, count: DatabaseStatistics.headerBytes)
    header.replaceSubrange(0..<16, with: [UInt8](DatabaseStatistics.headerMagic))
    func put16(_ offset: Int, _ value: Int) {
        header[offset] = UInt8((value >> 8) & 0xff)
        header[offset + 1] = UInt8(value & 0xff)
    }
    func put32(_ offset: Int, _ value: UInt32) {
        header[offset] = UInt8((value >> 24) & 0xff)
        header[offset + 1] = UInt8((value >> 16) & 0xff)
        header[offset + 2] = UInt8((value >> 8) & 0xff)
        header[offset + 3] = UInt8(value & 0xff)
    }
    put16(16, 4096)
    header[18] = 2
    header[19] = 2
    put32(24, 7)
    put32(28, UInt32(pages))
    put32(36, 1)
    put32(44, 4)
    put32(56, 1)
    put32(60, UInt32(bitPattern: Int32(userVersion)))
    put32(92, 7)
    put32(96, 3_043_002)
    return Data(header) + Data(body.utf8)
}

/// The `user_version` a fake database file carries; `nil` when it is not a SQLite file.
func sqliteUserVersion(_ data: Data) -> Int? {
    (try? DatabaseStatistics.parseHeader(data))?.userVersion
}

/// Fakes wired together like a Mac with a prepared payload: the packaged backend answers
/// the database tool (`tools/db-file.js`) from the fake file system.
final class Harness: @unchecked Sendable {
    let fileSystem = FakeFileSystem()
    let runner = FakeRunner()
    let spawner = FakeSpawner()
    let processes = FakeProcesses()
    let ports = FakePorts()
    let http = FakeHTTP()
    let clock = FakeClock()
    let random = FakeRandom()
    let layout: RuntimeLayout

    private let lock = NSLock()
    private var psOutputValue: String?
    private var tableCountsValue: [String: Int] = ["accounts": 3, "transactions": 40, "user_settings": 1]
    private var toolFailures: [String: String] = [:]
    private var toolCommandsValue: [[String]] = []

    /// The newest migration the fake payload ships (`0003_head.sql`).
    static let packagedSchemaVersion = 3

    /// What `ps -o command=` prints for a PID; defaults to our backend.
    var psOutput: String? {
        get { lock.withLock { psOutputValue } }
        set { lock.withLock { psOutputValue = newValue } }
    }

    /// Row counts the database tool reports for any verified file.
    var tableCounts: [String: Int] {
        get { lock.withLock { tableCountsValue } }
        set { lock.withLock { tableCountsValue = newValue } }
    }

    /// The database tool commands run, without the tool path (`["verify", file]`).
    var toolCommands: [[String]] { lock.withLock { toolCommandsValue } }

    /// Makes the database tool print `{ ok: false, error }` and exit 1 for a command.
    func failTool(_ command: String, _ message: String) {
        lock.withLock { toolFailures[command] = message }
    }

    var dependencies: RuntimeDependencies {
        RuntimeDependencies(
            fileSystem: fileSystem, runner: runner, spawner: spawner, processes: processes, ports: ports, http: http,
            clock: clock, random: random)
    }

    init(payload: Bool = true) throws {
        layout = try RuntimeLayout(userDataDirectory: testUserData)
        if payload { installPayload() }
        runner.handler = { [unowned self] call in try self.respond(call) }
        spawner.onSpawn = { [unowned self] spawn in self.processes.add(spawn.pid) }
    }

    func makeRuntime(appPort: Int = 41_000, environment: [String: String] = ["PATH": "/usr/bin", "HOME": testHome])
        throws -> NativeRuntime
    {
        try NativeRuntime(
            layout: layout, runtimeRoot: testRuntimeRoot, appPort: appPort, inheritedEnvironment: environment,
            dependencies: dependencies)
    }

    func installPayload() {
        let fs = fileSystem
        fs.addFile("\(testRuntimeRoot)/vision-backend", "binary", mode: 0o755)
        fs.addFile("\(testRuntimeRoot)/vision-apple-ai", "binary", mode: 0o755)
        fs.addFile("\(testRuntimeRoot)/\(RuntimeConstants.packagedDatabaseTool)", "// db-file\n")
        fs.addFile("\(testRuntimeRoot)/\(RuntimeConstants.packagedAnalysisSandbox)", "// sandbox\n")
        fs.addFile("\(testRuntimeRoot)/db/migrations/0001_baseline.sql", "-- baseline\n")
        fs.addFile("\(testRuntimeRoot)/db/migrations/0003_head.sql", "-- head\n")
        fs.addFile("\(testRuntimeRoot)/dist/index.html", "<html></html>")
        writeManifest()
    }

    func writeManifest() {
        let fs = fileSystem
        var entries: [JSONValue] = []
        for path in fs.paths(withPrefix: testRuntimeRoot + "/") {
            guard case .file(let data, _)? = fs.node(path) else { continue }
            let relative = String(path.dropFirst(testRuntimeRoot.count + 1))
            if relative == "manifest.json" { continue }
            entries.append(
                .object(["path": .string(relative), "bytes": .int(data.count), "sha256": .string(sha256Hex(data))]))
        }
        let manifest = JSONValue.object(["version": .int(1), "entries": .array(entries)])
        fs.addFile("\(testRuntimeRoot)/manifest.json", try! manifest.serialized())
    }

    /// A live database at `userVersion` in the database directory.
    @discardableResult
    func installDatabase(userVersion: Int = Harness.packagedSchemaVersion, body: String = "live") -> Data {
        let data = sqliteDatabase(userVersion: userVersion, body: body)
        fileSystem.addDirectory(layout.databaseDirectory, mode: 0o700)
        fileSystem.addFile(layout.database, data, mode: 0o600)
        return data
    }

    /// The packaged Demo seed database and its version 2 manifest.
    @discardableResult
    func installSeed(
        schemaVersion: Int = Harness.packagedSchemaVersion, tableCounts: [String: Int]? = nil,
        logicalSha256: String = String(repeating: "1", count: 64)
    ) -> Data {
        let data = sqliteDatabase(userVersion: schemaVersion, body: "demo seed")
        fileSystem.addFile("\(testSeedRoot)/\(NativeDemo.seedDatabaseName)", data)
        let counts = tableCounts ?? self.tableCounts
        let manifest = JSONValue.object([
            "version": .int(2),
            "format": .string("sqlite"),
            "logicalSha256": .string(logicalSha256),
            "databaseSha256": .string(sha256Hex(data)),
            "databaseBytes": .int(data.count),
            "schemaVersion": .int(schemaVersion),
            "database": .object(["tableCounts": .object(counts.mapValues { .int($0) })]),
        ])
        fileSystem.addFile("\(testSeedRoot)/\(NativeDemo.seedManifestName)", try! manifest.serialized())
        return data
    }

    func respond(_ call: FakeRunner.Call) throws -> RunResult {
        switch call.name {
        case "ps":
            return RunResult(stdout: psOutput ?? "\(testRuntimeRoot)/vision-backend\n")
        case "vision-backend":
            return try respondDatabaseTool(call)
        default:
            return RunResult()
        }
    }

    private func toolLine(_ object: [String: JSONValue]) -> String {
        // One line, as the tool prints it (`serialized()` pretty-prints).
        String(decoding: try! JSONEncoder().encode(JSONValue.object(object)), as: UTF8.self)
    }

    private func report(_ path: String, counts: Bool) throws -> String {
        let data = try fileSystem.readFile(path)
        guard let version = sqliteUserVersion(data) else {
            throw ProcessRunError(
                executable: "vision-backend", exitStatus: 1, message: "exit 1",
                stdout: toolLine(["ok": .bool(false), "error": .string("file is not a database")]))
        }
        var line: [String: JSONValue] = [
            "ok": .bool(true),
            "file": .string(path),
            "bytes": .int(data.count),
            "sha256": .string(sha256Hex(data)),
            "sqliteVersion": .string("3.43.2"),
            "schemaVersion": .int(version),
            "pendingMigrations": .int(max(0, Self.packagedSchemaVersion - version)),
        ]
        if counts { line["tableCounts"] = .object(tableCounts.mapValues { .int($0) }) }
        return "[logger] tool started\n" + toolLine(line) + "\n"
    }

    private func respondDatabaseTool(_ call: FakeRunner.Call) throws -> RunResult {
        let command = Array(call.arguments.dropFirst())
        lock.withLock { toolCommandsValue.append(command) }
        guard call.arguments.first == "\(testRuntimeRoot)/\(RuntimeConstants.packagedDatabaseTool)",
            call.options.environment["BUN_BE_BUN"] == "1", let verb = command.first
        else { return RunResult() }
        if let message = lock.withLock({ toolFailures[verb] }) {
            throw ProcessRunError(
                executable: call.executable, exitStatus: 1, message: "exit 1",
                stdout: toolLine(["ok": .bool(false), "error": .string(message)]))
        }
        switch (verb, command.count) {
        case ("verify", 2):
            return RunResult(stdout: try report(command[1], counts: true))
        case ("snapshot", 3):
            try fileSystem.writeFile(command[2], try fileSystem.readFile(command[1]), mode: 0o600)
            return RunResult(stdout: try report(command[2], counts: true))
        case ("create", 2), ("create", 3):
            try fileSystem.writeFile(
                command[1], sqliteDatabase(userVersion: Self.packagedSchemaVersion, body: "created"), mode: 0o600)
            return RunResult(stdout: try report(command[1], counts: true))
        default:
            return RunResult()
        }
    }
}

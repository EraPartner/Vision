import CryptoKit
import Darwin
import Foundation
@testable import VisionNativeCore

/// Test-only string literals for currency codes (`"EUR"`), so fixtures read like the wire. Production
/// code has no such conformance: it takes codes from decoded models or `CurrencyCode(rawValue:)`.
/// Traps on a malformed literal, which a fixture typo should be.
extension CurrencyCode: @retroactive ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        guard let code = CurrencyCode(rawValue: value) else {
            preconditionFailure("\"\(value)\" is not a currency code (^[A-Z]{3}$)")
        }
        self = code
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

/// Fakes wired together like a Mac with a prepared payload and a working PostgreSQL.
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
    private var postgresRunningValue = false
    var roles: Set<String> = []
    var databases: Set<String> = []
    var adminSQL: [String] = []
    var psOutput: String? = nil
    var reportedDataDirectory: String? = nil
    var statsOutput = ""
    /// The Kysely ledger of the fake database: `nil` has no `public.kysely_migration` table.
    var ledger: [String]? = ["0001_baseline", "0130_head"]

    var postgresRunning: Bool {
        get { lock.lock(); defer { lock.unlock() }; return postgresRunningValue }
        set { lock.lock(); postgresRunningValue = newValue; lock.unlock() }
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
        spawner.onSpawn = { [unowned self] spawn in
            self.processes.add(spawn.pid)
            if PathUtilities.basename(spawn.executable) == "postgres" {
                self.postgresRunning = true
                self.fileSystem.addFile(PathUtilities.join(self.layout.postgresData, "postmaster.pid"), "\(spawn.pid)\n")
            }
        }
    }

    func makeRuntime(appPort: Int = 41_000, environment: [String: String] = ["PATH": "/usr/bin", "HOME": testHome])
        throws -> NativeRuntime
    {
        try NativeRuntime(
            layout: layout, runtimeRoot: testRuntimeRoot, appPort: appPort, inheritedEnvironment: environment,
            dependencies: dependencies)
    }

    func installPayload(postgresVersion: String = "18.6") {
        let fs = fileSystem
        fs.addFile(
            "\(testRuntimeRoot)/postgres/runtime.json",
            """
            {"version":1,"postgresMajor":18,"postgresVersion":"\(postgresVersion)","platform":"darwin","architecture":"\(RuntimeConstants.payloadArchitecture)","binRelative":"bin","sourceKind":"postgres-app"}
            """)
        for tool in RuntimeConstants.requiredPostgresTools {
            fs.addFile("\(testRuntimeRoot)/postgres/root/bin/\(tool)", "#!/bin/sh\n", mode: 0o755)
        }
        fs.addFile("\(testRuntimeRoot)/vision-backend", "binary", mode: 0o755)
        fs.addFile("\(testRuntimeRoot)/vision-apple-ai", "binary", mode: 0o755)
        fs.addFile("\(testRuntimeRoot)/config/postgres/app-role-grants.sql.tpl", "-- grants\n")
        fs.addFile("\(testRuntimeRoot)/db/migrations/0001_baseline.sql", "-- baseline\n")
        fs.addFile("\(testRuntimeRoot)/db/migrations/0130_head.sql", "-- head\n")
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

    /// A seed manifest whose stats match `statsOutput`.
    func installSeed(schema: String = "0130_head", tableCounts: [String: Int] = ["accounts": 3, "transactions": 40]) {
        let dump = Data("PGDMP synthetic".utf8)
        fileSystem.addFile("\(testSeedRoot)/demo-seed.dump", dump)
        var important: [String: JSONValue] = [:]
        for table in DatabaseStatistics.importantTables {
            if let count = tableCounts[table] { important[table] = .int(count) }
        }
        let manifest = JSONValue.object([
            "version": .int(1),
            "logicalSha256": .string(String(repeating: "1", count: 64)),
            "dumpSha256": .string(sha256Hex(dump)),
            "schemaRevision": .string(schema),
            "database": .object([
                "schema": .string(schema),
                "postgresVersionNum": .int(180_006),
                "tableCount": .int(tableCounts.count),
                "tableCounts": .object(tableCounts.mapValues { .int($0) }),
                "importantRowCounts": .object(important),
                "stableImportantRowCounts": .object(["user_settings": .int(0)]),
            ]),
        ])
        fileSystem.addFile("\(testSeedRoot)/manifest.json", try! manifest.serialized())
        statsOutput =
            "schema\t\(schema)\npostgres_version_num\t180006\nstable:user_settings\t0\n"
            + tableCounts.keys.sorted().map { "table:\($0)\t\(tableCounts[$0]!)" }.joined(separator: "\n")
    }

    private func argument(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    func respond(_ call: FakeRunner.Call) throws -> RunResult {
        let arguments = call.arguments
        if arguments == ["--version"] {
            return RunResult(stdout: "\(call.name) (PostgreSQL) 18.6\n")
        }
        switch call.name {
        case "initdb":
            let data = argument(after: "-D", in: arguments)!
            fileSystem.addDirectory(data, mode: 0o700)
            fileSystem.addFile("\(data)/PG_VERSION", "18\n")
            fileSystem.addFile("\(data)/postgresql.conf", "# generated\n")
            return RunResult()
        case "pg_isready":
            if postgresRunning { return RunResult(stdout: "accepting connections") }
            throw FakeProcessFailure()
        case "pg_ctl":
            postgresRunning = false
            try fileSystem.remove(PathUtilities.join(layout.postgresData, "postmaster.pid"))
            return RunResult()
        case "createdb":
            lock.lock()
            databases.insert(arguments.last!)
            lock.unlock()
            return RunResult()
        case "pg_restore":
            return RunResult()
        case "ps":
            return RunResult(stdout: psOutput ?? "\(testRuntimeRoot)/vision-backend\n")
        case "psql":
            return try respondPsql(arguments)
        default:
            return RunResult()
        }
    }

    private func respondPsql(_ arguments: [String]) throws -> RunResult {
        if let file = argument(after: "--file", in: arguments) {
            let sql = fileSystem.text(file) ?? ""
            lock.lock()
            adminSQL.append(sql)
            if let pattern = try? NSRegularExpression(pattern: #"CREATE ROLE "?([a-z_]+)"?"#) {
                for match in pattern.matches(in: sql, range: NSRange(sql.startIndex..., in: sql)) {
                    if let range = Range(match.range(at: 1), in: sql) { roles.insert(String(sql[range])) }
                }
            }
            // `CREATE DATABASE <name> OWNER ...` runs through \gexec in the bootstrap session.
            if let groups = PathUtilities.firstMatchGroups(sql, #"CREATE DATABASE ([a-z0-9_]+) OWNER"#), let name = groups[1] {
                databases.insert(name)
            }
            lock.unlock()
            return RunResult()
        }
        let command = argument(after: "--command", in: arguments) ?? ""
        if command == PostgresSQL.inspectServerQuery {
            return RunResult(stdout: "180006\n127.0.0.1\n\(reportedDataDirectory ?? layout.postgresData)\n")
        }
        if let groups = PathUtilities.firstMatchGroups(command, "rolname = '([a-z_]+)'"), let role = groups[1] {
            lock.lock()
            defer { lock.unlock() }
            return RunResult(stdout: roles.contains(role) ? "1\n" : "")
        }
        if let groups = PathUtilities.firstMatchGroups(command, "datname = '([a-z0-9_]+)';"), let name = groups[1],
            !command.contains("pg_terminate_backend")
        {
            lock.lock()
            defer { lock.unlock() }
            return RunResult(stdout: databases.contains(name) ? "1\n" : "")
        }
        if let groups = PathUtilities.firstMatchGroups(command, #"ALTER DATABASE "([a-z0-9_]+)" RENAME TO "([a-z0-9_]+)""#),
            let from = groups[1], let to = groups[2]
        {
            lock.lock()
            defer { lock.unlock() }
            guard databases.remove(from) != nil else { throw FakeProcessFailure() }
            databases.insert(to)
            return RunResult()
        }
        if let groups = PathUtilities.firstMatchGroups(command, #"^DROP DATABASE "([a-z0-9_]+)";$"#), let name = groups[1] {
            lock.lock()
            defer { lock.unlock() }
            databases.remove(name)
            return RunResult()
        }
        if command == PostgresSQL.publicTableCountQuery {
            return RunResult(stdout: "42\n")
        }
        if command == MigrationLedger.ledgerExistsSQL {
            lock.lock()
            defer { lock.unlock() }
            return RunResult(stdout: ledger == nil ? "f\n" : "t\n")
        }
        if command == MigrationLedger.headSQL {
            lock.lock()
            defer { lock.unlock() }
            return RunResult(stdout: "\(ledger?.max() ?? "")\n")
        }
        if command == MigrationLedger.appliedSQL {
            lock.lock()
            defer { lock.unlock() }
            return RunResult(stdout: (ledger ?? []).sorted().map { "\($0)\n" }.joined())
        }
        if command == DatabaseStatistics.sql {
            return RunResult(stdout: statsOutput)
        }
        return RunResult()
    }
}

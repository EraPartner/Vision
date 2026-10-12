import Darwin
import Foundation
import Testing
@testable import VisionNativeCore

// The live system implementations, against a real temporary directory, real child
// processes and real loopback sockets.

private func makeScratchDirectory() throws -> String {
    let path = FileManager.default.temporaryDirectory
        .appendingPathComponent("vision-native-system-\(UUID().uuidString)", isDirectory: true).path
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

private func posixMode(_ path: String) -> Int? {
    var status = stat()
    guard Darwin.lstat(path, &status) == 0 else { return nil }
    return Int(status.st_mode) & 0o7777
}

private let childEnvironment = ["PATH": "/usr/bin:/bin"]

@Suite struct LocalFileSystemTests {
    private let fileSystem = LocalFileSystem()

    @Test func writeFileCreatesAPrivateFileAtomicallyWithoutLeftovers() throws {
        let directory = try makeScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let parent = directory + "/nested"
        let target = parent + "/runtime.env"

        try fileSystem.writeFile(target, Data("SECRET=1\n".utf8), mode: 0o600)
        #expect(posixMode(target) == 0o600)
        #expect(posixMode(parent) == 0o700)
        #expect(try String(contentsOfFile: target, encoding: .utf8) == "SECRET=1\n")

        // Replacing a wider file leaves a 0600 file, never the old mode.
        #expect(Darwin.chmod(target, 0o644) == 0)
        try fileSystem.writeFile(target, Data("SECRET=2\n".utf8), mode: 0o600)
        #expect(posixMode(target) == 0o600)
        #expect(try String(contentsOfFile: target, encoding: .utf8) == "SECRET=2\n")

        try fileSystem.writeFile(target, Data(), mode: 0o600)
        #expect(try Data(contentsOf: URL(fileURLWithPath: target)).isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: parent) == ["runtime.env"])
    }

    @Test func createDirectoryAppliesTheModeToAnExistingDirectory() throws {
        let directory = try makeScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let path = directory + "/a/b"
        try fileSystem.createDirectory(path, mode: 0o700)
        #expect(posixMode(path) == 0o700)
        #expect(Darwin.chmod(path, 0o755) == 0)
        try fileSystem.createDirectory(path, mode: 0o700)
        #expect(posixMode(path) == 0o700)
    }

    @Test(.timeLimit(.minutes(1))) func readNoFollowOnlyReadsRegularFiles() throws {
        let directory = try makeScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let file = directory + "/request.json"
        try Data("{\"version\":1}".utf8).write(to: URL(fileURLWithPath: file))
        let link = directory + "/link.json"
        #expect(Darwin.symlink(file, link) == 0)
        let fifo = directory + "/fifo"
        #expect(Darwin.mkfifo(fifo, mode_t(0o600)) == 0)
        let subdirectory = directory + "/sub"
        try FileManager.default.createDirectory(atPath: subdirectory, withIntermediateDirectories: false)

        #expect(try fileSystem.readNoFollow(file) == .contents(Data("{\"version\":1}".utf8)))
        #expect(try fileSystem.readNoFollow(link) == .unsafe)
        // O_NONBLOCK: a FIFO without a writer must not block the read.
        #expect(try fileSystem.readNoFollow(fifo) == .unsafe)
        #expect(try fileSystem.readNoFollow(subdirectory) == .unsafe)
        #expect(try fileSystem.readNoFollow(directory + "/missing") == .missing)
        #expect(fileSystem.info(link)?.kind == .symlink)
        #expect(fileSystem.info(fifo)?.kind == .other)
    }
}

@Suite struct FoundationProcessRunnerTests {
    private let runner = FoundationProcessRunner()

    @Test func collectsStdoutAndStderr() async throws {
        let result = try await runner.run(
            "/bin/sh", ["-c", "echo out; echo err >&2"], options: RunOptions(environment: childEnvironment))
        #expect(result.stdout == "out\n")
        #expect(result.stderr == "err\n")
    }

    @Test func nonZeroExitReportsTrimmedStderr() async throws {
        let error = await #expect(throws: ProcessRunError.self) {
            try await runner.run(
                "/bin/sh", ["-c", "echo broken >&2; exit 3"], options: RunOptions(environment: childEnvironment))
        }
        #expect(error?.exitStatus == 3)
        #expect(error?.message == "broken")
    }

    @Test(.timeLimit(.minutes(1))) func timeoutEscalatesToKillAndBoundsInheritedPipes() async throws {
        let started = Date()
        let error = await #expect(throws: ProcessRunError.self) {
            try await runner.run(
                "/bin/sh", ["-c", "trap \"\" TERM; sleep 30"],
                options: RunOptions(environment: childEnvironment, timeout: 0.5))
        }
        let elapsed = Date().timeIntervalSince(started)
        #expect(error?.message == "sh timed out")
        #expect(error?.exitStatus == 128 + SIGKILL)
        // 0.5 s timeout + 2 s kill grace + at most 2 s for the orphaned sleep's pipe.
        #expect(elapsed < 10)
    }

    @Test(.timeLimit(.minutes(1))) func cancellationTerminatesTheChild() async throws {
        let runner = self.runner
        let task = Task {
            try await runner.run(
                "/bin/sh", ["-c", "sleep 30"], options: RunOptions(environment: childEnvironment, timeout: 60))
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        let started = Date()
        task.cancel()
        let result = await task.result
        guard case .failure(let error) = result else {
            Issue.record("a cancelled run must fail")
            return
        }
        #expect((error as? ProcessRunError)?.message == "sh was cancelled")
        #expect(Date().timeIntervalSince(started) < 10)
    }
}

@Suite struct FoundationProcessSpawnerTests {
    @Test(.timeLimit(.minutes(1))) func appendsOutputToAPrivateLogAndReportsExit() async throws {
        let directory = try makeScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let log = directory + "/child.log"
        let exited = Latch()
        let child = try FoundationProcessSpawner().spawn(
            "/bin/sh", ["-c", "echo spawned; echo problem >&2"], cwd: directory, environment: childEnvironment,
            logPath: log, onExit: { exited.open() })
        #expect(child.pid > 1)
        await exited.wait()
        #expect(child.hasExited())
        let text = try String(contentsOfFile: log, encoding: .utf8)
        #expect(text.contains("spawned\n"))
        #expect(text.contains("problem\n"))
        #expect(posixMode(log) == 0o600)
    }
}

@Suite struct LoopbackPortProbeTests {
    @Test func listeningLoopbackPortIsBusyAndFreeAfterClose() async throws {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        try #require(descriptor >= 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.bind(descriptor, generic, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            Issue.record("could not listen on 127.0.0.1")
            return
        }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actual) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.getsockname(descriptor, generic, &length)
            }
        }
        let port = Int(UInt16(bigEndian: actual.sin_port))
        #expect(named == 0)
        #expect(port > 0)

        let probe = LoopbackPortProbe()
        #expect(await probe.isPortFree(port) == false)
        Darwin.close(descriptor)
        #expect(await probe.isPortFree(port))
    }

    @Test func outOfRangePortsAreNeverFree() async {
        let probe = LoopbackPortProbe()
        #expect(await probe.isPortFree(0) == false)
        #expect(await probe.isPortFree(65_536) == false)
    }
}

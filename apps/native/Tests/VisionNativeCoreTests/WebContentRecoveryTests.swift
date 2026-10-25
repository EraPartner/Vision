import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct CrashReloadPolicyTests {
    @Test func reloadsTwiceWithinThirtySecondsThenGivesUp() {
        var policy = CrashReloadPolicy()
        let decision1 = policy.shouldReload(at: 100)
        #expect(decision1)
        let decision2 = policy.shouldReload(at: 110)
        #expect(decision2)
        let decision3 = policy.shouldReload(at: 120)
        #expect(!decision3)
        let decision4 = policy.shouldReload(at: 129.9)
        #expect(!decision4)
    }

    @Test func oldCrashesAgeOut() {
        var policy = CrashReloadPolicy()
        let decision5 = policy.shouldReload(at: 0)
        #expect(decision5)
        let decision6 = policy.shouldReload(at: 20)
        #expect(decision6)
        // The first reload is 30 s old: one slot is free again.
        let decision7 = policy.shouldReload(at: 30)
        #expect(decision7)
        let decision8 = policy.shouldReload(at: 40)
        #expect(!decision8)
        let decision9 = policy.shouldReload(at: 60)
        #expect(decision9)
    }

    @Test func aFreshLoadResetsTheHistory() {
        var policy = CrashReloadPolicy()
        let decision10 = policy.shouldReload(at: 1)
        #expect(decision10)
        let decision11 = policy.shouldReload(at: 2)
        #expect(decision11)
        let decision12 = policy.shouldReload(at: 3)
        #expect(!decision12)
        policy.reset()
        #expect(policy.reloads.isEmpty)
        let decision13 = policy.shouldReload(at: 4)
        #expect(decision13)
    }
}

@Suite struct DownloadDestinationTests {
    private func makeDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("download-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    @Test func aNewFileDownloadsDirectly() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("export.csv")
        #expect(DownloadDestination.plan(for: target, id: UUID()) == .direct(target))
    }

    @Test func anExistingFileIsReplacedOnlyWhenTheDownloadFinishes() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("export.csv")
        try Data("old".utf8).write(to: target)
        let id = UUID()
        guard case .replace(let temporary, let destination) = DownloadDestination.plan(for: target, id: id) else {
            Issue.record("expected a replacement plan")
            return
        }
        #expect(destination == target)
        #expect(temporary.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL)
        #expect(temporary.lastPathComponent == ".export.csv.\(id.uuidString).download")
        // While the download runs the previous file is untouched.
        #expect(try Data(contentsOf: target) == Data("old".utf8))
        try Data("new".utf8).write(to: temporary)
        try DownloadDestination.finish(temporary: temporary, destination: destination)
        #expect(try Data(contentsOf: target) == Data("new".utf8))
        #expect(!FileManager.default.fileExists(atPath: temporary.path))
    }

    @Test func aFailedDownloadLeavesThePreviousFile() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("export.csv")
        try Data("old".utf8).write(to: target)
        let temporary = DownloadDestination.temporaryURL(for: target, id: UUID())
        try Data("partial".utf8).write(to: temporary)
        DownloadDestination.discard(temporary: temporary)
        #expect(try Data(contentsOf: target) == Data("old".utf8))
        #expect(!FileManager.default.fileExists(atPath: temporary.path))
        // A finish without a downloaded file fails and keeps the previous file.
        #expect(throws: (any Error).self) {
            try DownloadDestination.finish(temporary: temporary, destination: target)
        }
        #expect(try Data(contentsOf: target) == Data("old".utf8))
    }

    @Test func directoriesAreNeverReplacedOrDeleted() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let folder = directory.appendingPathComponent("Reports")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: folder.appendingPathComponent("inside.txt"))
        #expect(DownloadDestination.plan(for: folder, id: UUID()) == .refuse("a folder with that name already exists"))
        let temporary = DownloadDestination.temporaryURL(for: folder, id: UUID())
        try Data("new".utf8).write(to: temporary)
        #expect(throws: DownloadReplacementError("a folder with that name already exists")) {
            try DownloadDestination.finish(temporary: temporary, destination: folder)
        }
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("inside.txt").path))
        #expect(!FileManager.default.fileExists(atPath: temporary.path))
        // discard refuses a directory, too.
        DownloadDestination.discard(temporary: folder)
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("inside.txt").path))
    }
}

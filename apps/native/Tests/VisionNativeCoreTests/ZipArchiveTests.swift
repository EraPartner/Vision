import Foundation
import Testing
@testable import VisionNativeCore

// The zip writer and reader on real files, including interoperability with the system
// zip tools when they are installed.

private func replaceAll(_ haystack: [UInt8], _ needle: [UInt8], with replacement: [UInt8]) -> [UInt8] {
    precondition(needle.count == replacement.count)
    var result = haystack
    var index = 0
    while index + needle.count <= result.count {
        if Array(result[index..<(index + needle.count)]) == needle {
            result.replaceSubrange(index..<(index + needle.count), with: replacement)
            index += needle.count
        } else {
            index += 1
        }
    }
    return result
}

private func firstIndex(of needle: [UInt8], in haystack: [UInt8]) -> Int? {
    guard haystack.count >= needle.count else { return nil }
    for index in 0...(haystack.count - needle.count) where Array(haystack[index..<(index + needle.count)]) == needle {
        return index
    }
    return nil
}

private func run(_ executable: String, _ arguments: [String], in directory: String? = nil) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let directory { process.currentDirectoryURL = URL(fileURLWithPath: directory) }
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}

@Suite struct ZipArchiveTests {
    private let modified = Date(timeIntervalSince1970: 1_760_000_000)

    private func largeContent() -> [UInt8] {
        (0..<(BackupFiles.chunkSize * 2 + 4321)).map { UInt8(truncatingIfNeeded: ($0 / 7) &* 13) }
    }

    private func writeSample(_ path: String, source: String, forceZip64: Bool = false) throws {
        try writeBytes(source, largeContent())
        try writeBytes(source + ".empty", [])
        let writer = try ZipWriter(path: path, forceZip64: forceZip64)
        try writer.addData(name: "metadata.json", data: Data("{\"a\":1}".utf8), modified: modified)
        try writer.addFile(name: "db.sql", path: source)
        try writer.addDirectory(name: "attachments/tx-1/", modified: modified)
        try writer.addFile(name: "attachments/tx-1/empty.bin", path: source + ".empty")
        try writer.addData(name: "attachments/tx-1/caf\u{e9}.txt", data: Data("caf\u{e9}".utf8), modified: modified)
        try writer.finish()
    }

    private func checkSample(_ path: String, directory: String) throws {
        let reader = try ZipReader(path: path)
        defer { reader.close() }
        #expect(
            reader.entries.map(\.name) == [
                "metadata.json", "db.sql", "attachments/tx-1/", "attachments/tx-1/empty.bin",
                "attachments/tx-1/caf\u{e9}.txt",
            ])
        let total = TotalCounter()
        for (index, entry) in reader.entries.enumerated() where !entry.isDirectory {
            try reader.extract(entry, to: directory + "/out-\(index)") { total.add($0) }
        }
        let metadata = try readBytes(directory + "/out-0")
        let dump = try readBytes(directory + "/out-1")
        let empty = try readBytes(directory + "/out-3")
        let accented = try readBytes(directory + "/out-4")
        #expect(metadata == Array("{\"a\":1}".utf8))
        #expect(dump == largeContent())
        #expect(empty.isEmpty)
        #expect(accented == Array("caf\u{e9}".utf8))
        #expect(total.value == UInt64(7 + largeContent().count + 5))
        #expect(reader.entries[1].method == 8)
        #expect(reader.entries[1].compressedSize < reader.entries[1].uncompressedSize)
        #expect(reader.entries[3].method == 0)
    }

    @Test func roundTripsFilesDirectoriesAndNames() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeSample(directory + "/a.zip", source: directory + "/source")
        try checkSample(directory + "/a.zip", directory: directory)
    }

    @Test func roundTripsWithZip64Records() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeSample(directory + "/a.zip", source: directory + "/source", forceZip64: true)
        let raw = try readBytes(directory + "/a.zip")
        #expect(firstIndex(of: [0x50, 0x4b, 0x06, 0x06], in: raw) != nil)
        #expect(firstIndex(of: [0x50, 0x4b, 0x06, 0x07], in: raw) != nil)
        try checkSample(directory + "/a.zip", directory: directory)
    }

    @Test func refusesTraversalAndAbsoluteNames() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let writer = try ZipWriter(path: directory + "/a.zip")
        try writer.addData(name: "aa/evil.txt", data: Data("x".utf8), modified: modified)
        try writer.addData(name: "aaaa/abs.txt", data: Data("y".utf8), modified: modified)
        try writer.finish()
        let original = try readBytes(directory + "/a.zip")

        let traversal = replaceAll(original, Array("aa/evil.txt".utf8), with: Array("../evil.txt".utf8))
        try writeBytes(directory + "/traversal.zip", traversal)
        #expect(throws: ZipError("invalid relative path: ../evil.txt")) {
            _ = try ZipReader(path: directory + "/traversal.zip")
        }
        try BackupFiles.createDirectory(directory + "/contents")
        #expect(throws: (any Error).self) {
            try BackupBundle.extract(directory + "/traversal.zip", into: directory + "/contents")
        }
        #expect(!BackupFiles.exists(directory + "/evil.txt"))

        let absolute = replaceAll(original, Array("aaaa/abs.txt".utf8), with: Array("/tmp/abs.txt".utf8))
        try writeBytes(directory + "/absolute.zip", absolute)
        #expect(throws: ZipError("absolute path: /tmp/abs.txt")) {
            _ = try ZipReader(path: directory + "/absolute.zip")
        }

        #expect(throws: ZipError("Invalid zip entry name")) {
            let refused = try ZipWriter(path: directory + "/b.zip")
            try refused.addData(name: "../escape", data: Data(), modified: modified)
        }
    }

    @Test func aCorruptChecksumFailsExtraction() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let writer = try ZipWriter(path: directory + "/a.zip")
        try writer.addData(name: "data.txt", data: Data(repeating: 0x41, count: 4096), modified: modified)
        try writer.finish()
        var raw = try readBytes(directory + "/a.zip")
        let central = try #require(firstIndex(of: [0x50, 0x4b, 0x01, 0x02], in: raw))
        raw[central + 16] ^= 0xff
        try writeBytes(directory + "/bad.zip", raw)
        let reader = try ZipReader(path: directory + "/bad.zip")
        defer { reader.close() }
        let entry = try #require(reader.entries.first)
        #expect(throws: ZipError("CRC-32 mismatch: data.txt")) {
            try reader.extract(entry, to: directory + "/out") { _ in }
        }
    }

    @Test func theByteLimitStopsExtraction() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let writer = try ZipWriter(path: directory + "/a.zip")
        try writer.addData(name: "data.txt", data: Data(repeating: 0x41, count: 200_000), modified: modified)
        try writer.finish()
        let reader = try ZipReader(path: directory + "/a.zip")
        defer { reader.close() }
        let entry = try #require(reader.entries.first)
        let total = TotalCounter()
        #expect(throws: BackupFailure("limit")) {
            try reader.extract(entry, to: directory + "/out") { count in
                total.add(count)
                if total.value > 1000 { throw BackupFailure("limit") }
            }
        }
    }

    @Test func garbageIsNotAZipFile() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(directory + "/garbage", (0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 97 &+ 3) })
        do {
            _ = try ZipReader(path: directory + "/garbage")
            Issue.record("garbage opened as a zip archive")
        } catch {
            #expect(backupErrorMessage(error).contains("end of central directory"))
        }
    }

    @Test func systemUnzipAcceptsTheArchive() throws {
        let unzip = "/usr/bin/unzip"
        guard FileManager.default.isExecutableFile(atPath: unzip) else { return }
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeSample(directory + "/a.zip", source: directory + "/source")
        let status = try run(unzip, ["-tqq", directory + "/a.zip"])
        #expect(status == 0)
        try writeSample(directory + "/b.zip", source: directory + "/source", forceZip64: true)
        let zip64Status = try run(unzip, ["-tqq", directory + "/b.zip"])
        #expect(zip64Status == 0)
    }

    @Test func readsAnArchiveFromTheSystemZipTool() throws {
        let zip = "/usr/bin/zip"
        guard FileManager.default.isExecutableFile(atPath: zip) else { return }
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try BackupFiles.createDirectory(directory + "/tree/attachments/tx-9")
        try writeBytes(directory + "/tree/db.sql", largeContent())
        try writeBytes(directory + "/tree/attachments/tx-9/receipt.txt", Array("receipt".utf8))
        let status = try run(zip, ["-qr", directory + "/system.zip", "db.sql", "attachments"], in: directory + "/tree")
        #expect(status == 0)

        try BackupFiles.createDirectory(directory + "/contents")
        try BackupBundle.extract(directory + "/system.zip", into: directory + "/contents")
        let dump = try readBytes(directory + "/contents/db.sql")
        let receipt = try readBytes(directory + "/contents/attachments/tx-9/receipt.txt")
        #expect(dump == largeContent())
        #expect(receipt == Array("receipt".utf8))
    }
}

final class TotalCounter: @unchecked Sendable {
    private(set) var value: UInt64 = 0

    func add(_ count: Int) {
        value += UInt64(count)
    }
}

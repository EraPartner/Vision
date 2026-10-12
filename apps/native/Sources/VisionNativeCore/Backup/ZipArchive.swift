import Compression
import Foundation

/// CRC-32 (IEEE 802.3, reflected 0xEDB88320) as zip stores it.
public struct CRC32: Sendable {
    private static let table: [UInt32] = (0..<256).map { index -> UInt32 in
        var value = UInt32(index)
        for _ in 0..<8 { value = (value & 1) == 1 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1 }
        return value
    }

    public private(set) var value: UInt32 = 0

    public init() {}

    public mutating func update<Bytes: Sequence>(_ bytes: Bytes) where Bytes.Element == UInt8 {
        var crc = ~value
        for byte in bytes { crc = CRC32.table[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8) }
        value = ~crc
    }

    public static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var crc = CRC32()
        crc.update(bytes)
        return crc.value
    }
}

/// A zip format violation. Messages for a missing or damaged end of central directory
/// contain "end of central directory", like yauzl's, which a restore of an encrypted
/// bundle reports as a wrong passphrase.
public struct ZipError: Error, Equatable, Sendable, LocalizedError {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// One central directory record.
public struct ZipEntry: Equatable, Sendable {
    public let name: String
    public let method: UInt16
    public let flags: UInt16
    public let crc32: UInt32
    public let compressedSize: UInt64
    public let uncompressedSize: UInt64
    public let localHeaderOffset: UInt64

    public var isDirectory: Bool { name.hasSuffix("/") }
}

private enum ZipSignature {
    static let localHeader: UInt32 = 0x0403_4b50
    static let centralHeader: UInt32 = 0x0201_4b50
    static let endOfCentralDirectory: UInt32 = 0x0605_4b50
    static let zip64EndOfCentralDirectory: UInt32 = 0x0606_4b50
    static let zip64Locator: UInt32 = 0x0706_4b50
}

private struct ByteWriter {
    var bytes: [UInt8] = []

    mutating func u16(_ value: UInt16) {
        bytes.append(UInt8(truncatingIfNeeded: value))
        bytes.append(UInt8(truncatingIfNeeded: value >> 8))
    }

    mutating func u32(_ value: UInt32) {
        for shift in stride(from: 0, to: 32, by: 8) { bytes.append(UInt8(truncatingIfNeeded: value >> UInt32(shift))) }
    }

    mutating func u64(_ value: UInt64) {
        for shift in stride(from: 0, to: 64, by: 8) { bytes.append(UInt8(truncatingIfNeeded: value >> UInt64(shift))) }
    }

    mutating func append(_ data: [UInt8]) { bytes.append(contentsOf: data) }
}

private struct ByteReader {
    let bytes: [UInt8]
    var offset: Int

    init(_ bytes: [UInt8], offset: Int = 0) {
        self.bytes = bytes
        self.offset = offset
    }

    var remaining: Int { bytes.count - offset }

    mutating func u16() throws -> UInt16 {
        guard remaining >= 2 else { throw ZipError("Unexpected end of zip structure") }
        defer { offset += 2 }
        return UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
    }

    mutating func u32() throws -> UInt32 {
        guard remaining >= 4 else { throw ZipError("Unexpected end of zip structure") }
        var value: UInt32 = 0
        for index in 0..<4 { value |= UInt32(bytes[offset + index]) << UInt32(8 * index) }
        offset += 4
        return value
    }

    mutating func u64() throws -> UInt64 {
        guard remaining >= 8 else { throw ZipError("Unexpected end of zip structure") }
        var value: UInt64 = 0
        for index in 0..<8 { value |= UInt64(bytes[offset + index]) << UInt64(8 * index) }
        offset += 8
        return value
    }

    mutating func take(_ count: Int) throws -> [UInt8] {
        guard count >= 0, remaining >= count else { throw ZipError("Unexpected end of zip structure") }
        defer { offset += count }
        return Array(bytes[offset..<(offset + count)])
    }
}

/// DOS date and time of a local date (zip's modification time fields).
func dosDateTime(_ date: Date) -> (time: UInt16, date: UInt16) {
    let components = Calendar(identifier: .gregorian).dateComponents(
        in: TimeZone.current, from: date)
    let year = max(1980, min(2107, components.year ?? 1980))
    let time = (components.hour ?? 0) << 11 | (components.minute ?? 0) << 5 | (components.second ?? 0) / 2
    let day = (year - 1980) << 9 | (components.month ?? 1) << 5 | (components.day ?? 1)
    return (UInt16(truncatingIfNeeded: time), UInt16(truncatingIfNeeded: day))
}

/// Writes a zip archive to a file. Entries are streamed (deflated with the Compression
/// framework's raw DEFLATE, or stored when empty); each local header is patched with the
/// CRC and sizes once its data is written, so no data descriptors are needed. Zip64 fields
/// are written when an entry, an offset or the central directory exceeds 32 bits
/// (`forceZip64` writes them for every entry, for tests).
public final class ZipWriter {
    private struct Record {
        let name: [UInt8]
        let flags: UInt16
        let method: UInt16
        let time: UInt16
        let date: UInt16
        let crc32: UInt32
        let compressedSize: UInt64
        let uncompressedSize: UInt64
        let offset: UInt64
        let externalAttributes: UInt32
        let isDirectory: Bool
        let localZip64: Bool
    }

    private static let madeBy: UInt16 = 0x032D  // Unix, zip 4.5
    private static let max32: UInt64 = 0xFFFF_FFFF

    private let handle: FileHandle
    private let forceZip64: Bool
    private var records: [Record] = []
    private var position: UInt64 = 0
    private var finished = false

    public init(path: String, forceZip64: Bool = false) throws {
        handle = try BackupFiles.createFile(path)
        self.forceZip64 = forceZip64
    }

    deinit {
        if !finished { try? handle.close() }
    }

    private func write(_ bytes: [UInt8]) throws {
        try handle.write(contentsOf: bytes)
        position += UInt64(bytes.count)
    }

    private static func encodedName(_ name: String) -> (bytes: [UInt8], flags: UInt16) {
        let bytes = Array(name.utf8)
        // Bit 11: the name is UTF-8 (only needed beyond ASCII).
        return (bytes, bytes.contains { $0 >= 0x80 } ? 0x0800 : 0)
    }

    private static func validateName(_ name: String) throws {
        guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"),
            !name.split(separator: "/", omittingEmptySubsequences: false).contains("..")
        else {
            throw ZipError("Invalid zip entry name")
        }
    }

    /// Writes a local header; when `zip64` it carries a zip64 extra for both sizes.
    private func writeLocalHeader(
        name: [UInt8], flags: UInt16, method: UInt16, time: UInt16, date: UInt16, zip64: Bool, isDirectory: Bool
    ) throws {
        var header = ByteWriter()
        header.u32(ZipSignature.localHeader)
        header.u16(zip64 ? 45 : (isDirectory ? 10 : 20))
        header.u16(flags)
        header.u16(method)
        header.u16(time)
        header.u16(date)
        header.u32(0)  // CRC-32, patched
        header.u32(zip64 ? 0xFFFF_FFFF : 0)
        header.u32(zip64 ? 0xFFFF_FFFF : 0)
        header.u16(UInt16(name.count))
        header.u16(zip64 ? 20 : 0)
        header.append(name)
        if zip64 {
            header.u16(0x0001)
            header.u16(16)
            header.u64(0)
            header.u64(0)
        }
        try write(header.bytes)
    }

    private func patchLocalHeader(
        offset: UInt64, nameLength: Int, crc: UInt32, compressed: UInt64, uncompressed: UInt64, zip64: Bool
    ) throws {
        var fields = ByteWriter()
        fields.u32(crc)
        if zip64 {
            fields.u32(0xFFFF_FFFF)
            fields.u32(0xFFFF_FFFF)
        } else {
            guard compressed < ZipWriter.max32, uncompressed < ZipWriter.max32 else {
                throw ZipError("Zip entry grew beyond its reserved header size")
            }
            fields.u32(UInt32(compressed))
            fields.u32(UInt32(uncompressed))
        }
        try handle.seek(toOffset: offset + 14)
        try handle.write(contentsOf: fields.bytes)
        if zip64 {
            var sizes = ByteWriter()
            sizes.u64(uncompressed)
            sizes.u64(compressed)
            try handle.seek(toOffset: offset + 30 + UInt64(nameLength) + 4)
            try handle.write(contentsOf: sizes.bytes)
        }
        try handle.seek(toOffset: position)
    }

    /// A directory entry (`name` ends with `/`).
    public func addDirectory(name: String, modified: Date) throws {
        let directoryName = name.hasSuffix("/") ? name : name + "/"
        try ZipWriter.validateName(directoryName)
        let (nameBytes, flags) = ZipWriter.encodedName(directoryName)
        let (time, date) = dosDateTime(modified)
        let offset = position
        try writeLocalHeader(
            name: nameBytes, flags: flags, method: 0, time: time, date: date, zip64: forceZip64, isDirectory: true)
        if forceZip64 {
            try patchLocalHeader(
                offset: offset, nameLength: nameBytes.count, crc: 0, compressed: 0, uncompressed: 0, zip64: true)
        }
        records.append(
            Record(
                name: nameBytes, flags: flags, method: 0, time: time, date: date, crc32: 0, compressedSize: 0,
                uncompressedSize: 0, offset: offset, externalAttributes: (0o40755 << 16) | 0x10, isDirectory: true,
                localZip64: forceZip64))
    }

    public func addData(name: String, data: Data, modified: Date) throws {
        var remaining = data[...]
        try addEntry(name: name, expectedSize: UInt64(data.count), modified: modified) {
            let chunk = remaining.prefix(BackupFiles.chunkSize)
            remaining = remaining.dropFirst(chunk.count)
            return Data(chunk)
        }
    }

    /// Streams a regular file into the archive.
    public func addFile(name: String, path: String, modified: Date? = nil) throws {
        guard BackupFiles.isRegularFile(path), let size = BackupFiles.size(path) else {
            throw ZipError("Not a regular file: \(PathUtilities.basename(path))")
        }
        let input = try BackupFiles.openForReading(path)
        defer { try? input.close() }
        try addEntry(
            name: name, expectedSize: size, modified: modified ?? BackupFiles.modificationDate(path) ?? Date()
        ) {
            try BackupFiles.read(input, upTo: BackupFiles.chunkSize)
        }
    }

    private func addEntry(
        name: String, expectedSize: UInt64, modified: Date, nextChunk: () throws -> Data
    ) throws {
        try ZipWriter.validateName(name)
        guard !name.hasSuffix("/") else { throw ZipError("Invalid zip entry name") }
        let (nameBytes, flags) = ZipWriter.encodedName(name)
        let (time, date) = dosDateTime(modified)
        let method: UInt16 = expectedSize == 0 ? 0 : 8
        // Deflate can expand incompressible data slightly; reserve zip64 sizes with margin.
        let zip64 = forceZip64 || expectedSize + expectedSize / 512 + 65_536 >= ZipWriter.max32
        let offset = position
        try writeLocalHeader(
            name: nameBytes, flags: flags, method: method, time: time, date: date, zip64: zip64, isDirectory: false)
        var crc = CRC32()
        var uncompressed: UInt64 = 0
        var compressed: UInt64 = 0
        if method == 0 {
            while true {
                let chunk = try nextChunk()
                if chunk.isEmpty { break }
                crc.update(chunk)
                uncompressed += UInt64(chunk.count)
                try write([UInt8](chunk))
                compressed += UInt64(chunk.count)
            }
        } else {
            var pendingError: Error?
            let filter = try OutputFilter(.compress, using: .zlib, bufferCapacity: 65_536) { [self] output in
                guard let output, !output.isEmpty else { return }
                do {
                    try self.write([UInt8](output))
                    compressed += UInt64(output.count)
                } catch {
                    pendingError = error
                    throw error
                }
            }
            while true {
                let chunk = try nextChunk()
                if chunk.isEmpty { break }
                crc.update(chunk)
                uncompressed += UInt64(chunk.count)
                try filter.write(chunk)
            }
            try filter.finalize()
            if let pendingError { throw pendingError }
        }
        try patchLocalHeader(
            offset: offset, nameLength: nameBytes.count, crc: crc.value, compressed: compressed,
            uncompressed: uncompressed, zip64: zip64)
        records.append(
            Record(
                name: nameBytes, flags: flags, method: method, time: time, date: date, crc32: crc.value,
                compressedSize: compressed, uncompressedSize: uncompressed, offset: offset,
                externalAttributes: (0o100644 << 16), isDirectory: false, localZip64: zip64))
    }

    /// Writes the central directory and the end records, then closes the file.
    public func finish() throws {
        guard !finished else { return }
        let centralOffset = position
        for record in records {
            let sizesOverflow =
                forceZip64 || record.compressedSize >= ZipWriter.max32 || record.uncompressedSize >= ZipWriter.max32
            let offsetOverflows = forceZip64 || record.offset >= ZipWriter.max32
            var extra = ByteWriter()
            if sizesOverflow || offsetOverflows {
                var fields = ByteWriter()
                if sizesOverflow {
                    fields.u64(record.uncompressedSize)
                    fields.u64(record.compressedSize)
                }
                if offsetOverflows { fields.u64(record.offset) }
                extra.u16(0x0001)
                extra.u16(UInt16(fields.bytes.count))
                extra.append(fields.bytes)
            }
            let usesZip64 = !extra.bytes.isEmpty || record.localZip64
            var header = ByteWriter()
            header.u32(ZipSignature.centralHeader)
            header.u16(ZipWriter.madeBy)
            header.u16(usesZip64 ? 45 : (record.isDirectory ? 10 : 20))
            header.u16(record.flags)
            header.u16(record.method)
            header.u16(record.time)
            header.u16(record.date)
            header.u32(record.crc32)
            header.u32(sizesOverflow ? 0xFFFF_FFFF : UInt32(record.compressedSize))
            header.u32(sizesOverflow ? 0xFFFF_FFFF : UInt32(record.uncompressedSize))
            header.u16(UInt16(record.name.count))
            header.u16(UInt16(extra.bytes.count))
            header.u16(0)  // comment
            header.u16(0)  // disk number
            header.u16(0)  // internal attributes
            header.u32(record.externalAttributes)
            header.u32(offsetOverflows ? 0xFFFF_FFFF : UInt32(record.offset))
            header.append(record.name)
            header.append(extra.bytes)
            try write(header.bytes)
        }
        let centralSize = position - centralOffset
        let count = UInt64(records.count)
        let needsZip64 =
            forceZip64 || count >= 0xFFFF || centralSize >= ZipWriter.max32 || centralOffset >= ZipWriter.max32
        var end = ByteWriter()
        if needsZip64 {
            let zip64Offset = position
            end.u32(ZipSignature.zip64EndOfCentralDirectory)
            end.u64(44)
            end.u16(ZipWriter.madeBy)
            end.u16(45)
            end.u32(0)
            end.u32(0)
            end.u64(count)
            end.u64(count)
            end.u64(centralSize)
            end.u64(centralOffset)
            end.u32(ZipSignature.zip64Locator)
            end.u32(0)
            end.u64(zip64Offset)
            end.u32(1)
        }
        end.u32(ZipSignature.endOfCentralDirectory)
        end.u16(0)
        end.u16(0)
        end.u16(needsZip64 ? 0xFFFF : UInt16(count))
        end.u16(needsZip64 ? 0xFFFF : UInt16(count))
        end.u32(needsZip64 ? 0xFFFF_FFFF : UInt32(centralSize))
        end.u32(needsZip64 ? 0xFFFF_FFFF : UInt32(centralOffset))
        end.u16(0)
        try write(end.bytes)
        try handle.synchronize()
        try handle.close()
        finished = true
    }
}

/// Reads a zip archive through its central directory, like yauzl: zip64, data
/// descriptors (sizes come from the central directory) and stored or deflated entries.
/// Every entry's CRC-32 and size are verified on extraction.
public final class ZipReader {
    public let entries: [ZipEntry]
    private let handle: FileHandle
    private let fileSize: UInt64

    public init(path: String) throws {
        handle = try BackupFiles.openForReading(path)
        do {
            fileSize = try handle.seekToEnd()
            entries = try ZipReader.readCentralDirectory(handle, fileSize: fileSize)
        } catch {
            try? handle.close()
            throw error
        }
    }

    deinit {
        try? handle.close()
    }

    public func close() {
        try? handle.close()
    }

    private static func readCentralDirectory(_ handle: FileHandle, fileSize: UInt64) throws -> [ZipEntry] {
        guard fileSize >= 22 else { throw ZipError("end of central directory record signature not found") }
        let tailLength = Int(min(fileSize, 22 + 0xFFFF))
        let tailStart = fileSize - UInt64(tailLength)
        let tail = try BackupFiles.read(
            handle, at: tailStart, count: tailLength, message: "end of central directory record signature not found")
        var eocd = -1
        var index = tailLength - 22
        while index >= 0 {
            if tail[index] == 0x50, tail[index + 1] == 0x4b, tail[index + 2] == 0x05, tail[index + 3] == 0x06 {
                eocd = index
                break
            }
            index -= 1
        }
        guard eocd >= 0 else { throw ZipError("end of central directory record signature not found") }
        var reader = ByteReader(tail, offset: eocd + 4)
        let diskNumber = try reader.u16()
        _ = try reader.u16()
        _ = try reader.u16()
        var entryCount = UInt64(try reader.u16())
        var centralSize = UInt64(try reader.u32())
        var centralOffset = UInt64(try reader.u32())
        guard diskNumber == 0 || diskNumber == 0xFFFF else { throw ZipError("multi-disk zip files are not supported") }
        if entryCount == 0xFFFF || centralSize == 0xFFFF_FFFF || centralOffset == 0xFFFF_FFFF {
            let eocdPosition = tailStart + UInt64(eocd)
            guard eocdPosition >= 20 else { throw ZipError("invalid zip64 end of central directory locator") }
            var locator = ByteReader(
                try BackupFiles.read(
                    handle, at: eocdPosition - 20, count: 20,
                    message: "invalid zip64 end of central directory locator"))
            guard try locator.u32() == ZipSignature.zip64Locator else {
                throw ZipError("invalid zip64 end of central directory locator signature")
            }
            _ = try locator.u32()
            let zip64Offset = try locator.u64()
            guard zip64Offset + 56 <= fileSize else { throw ZipError("invalid zip64 end of central directory record") }
            var record = ByteReader(
                try BackupFiles.read(
                    handle, at: zip64Offset, count: 56, message: "invalid zip64 end of central directory record"))
            guard try record.u32() == ZipSignature.zip64EndOfCentralDirectory else {
                throw ZipError("invalid zip64 end of central directory record signature")
            }
            _ = try record.u64()
            _ = try record.u16()
            _ = try record.u16()
            _ = try record.u32()
            _ = try record.u32()
            _ = try record.u64()
            entryCount = try record.u64()
            centralSize = try record.u64()
            centralOffset = try record.u64()
        }
        guard centralOffset <= fileSize, centralSize <= fileSize - centralOffset else {
            throw ZipError("central directory offset is beyond the end of the file")
        }
        guard entryCount <= UInt64(BackupBundle.maximumRestoreEntries) else {
            throw ZipError(
                "Restore bundle has too many entries (> \(BackupBundle.maximumRestoreEntries)) — refusing to extract.")
        }
        guard centralSize <= 512 * 1024 * 1024 else { throw ZipError("central directory is too large") }
        var central = ByteReader(
            try BackupFiles.read(
                handle, at: centralOffset, count: Int(centralSize), message: "central directory is truncated"))
        var entries: [ZipEntry] = []
        entries.reserveCapacity(Int(entryCount))
        for _ in 0..<entryCount {
            guard try central.u32() == ZipSignature.centralHeader else {
                throw ZipError("invalid central directory file header signature")
            }
            _ = try central.u16()  // made by
            _ = try central.u16()  // needed
            let flags = try central.u16()
            let method = try central.u16()
            _ = try central.u16()
            _ = try central.u16()
            let crc = try central.u32()
            var compressed = UInt64(try central.u32())
            var uncompressed = UInt64(try central.u32())
            let nameLength = Int(try central.u16())
            let extraLength = Int(try central.u16())
            let commentLength = Int(try central.u16())
            _ = try central.u16()  // disk
            _ = try central.u16()  // internal attributes
            _ = try central.u32()  // external attributes
            var offset = UInt64(try central.u32())
            let nameBytes = try central.take(nameLength)
            var extra = ByteReader(try central.take(extraLength))
            _ = try central.take(commentLength)
            while extra.remaining >= 4 {
                let id = try extra.u16()
                let size = Int(try extra.u16())
                var field = ByteReader(try extra.take(size))
                guard id == 0x0001 else { continue }
                if uncompressed == 0xFFFF_FFFF { uncompressed = try field.u64() }
                if compressed == 0xFFFF_FFFF { compressed = try field.u64() }
                if offset == 0xFFFF_FFFF { offset = try field.u64() }
            }
            guard flags & 0x0001 == 0 else { throw ZipError("encrypted entries not supported") }
            guard method == 0 || method == 8 else { throw ZipError("unsupported compression method: \(method)") }
            if method == 0, compressed != uncompressed {
                throw ZipError("compressed/uncompressed size mismatch for stored file")
            }
            let name = try decodeName(nameBytes, utf8: flags & 0x0800 != 0)
            try validateEntryName(name)
            entries.append(
                ZipEntry(
                    name: name, method: method, flags: flags, crc32: crc, compressedSize: compressed,
                    uncompressedSize: uncompressed, localHeaderOffset: offset))
        }
        return entries
    }

    /// The CP437 upper half, for names without the UTF-8 flag (yauzl's default decoding).
    static let cp437High = Array(
        "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{00A0}")

    static func decodeName(_ bytes: [UInt8], utf8: Bool) throws -> String {
        if utf8 {
            guard let name = String(bytes: bytes, encoding: .utf8) else { throw ZipError("invalid UTF-8 file name") }
            return name
        }
        var name = ""
        for byte in bytes {
            if byte < 0x80 {
                name.unicodeScalars.append(Unicode.Scalar(byte))
            } else {
                name.append(cp437High[Int(byte) - 0x80])
            }
        }
        return name
    }

    /// yauzl's `validateFileName`, plus empty names and NUL bytes.
    static func validateEntryName(_ name: String) throws {
        if name.isEmpty || name.contains("\0") { throw ZipError("invalid characters in fileName: \(name)") }
        if name.contains("\\") { throw ZipError("invalid characters in fileName: \(name)") }
        let characters = Array(name.unicodeScalars.prefix(2))
        let drive = characters.count == 2 && characters[1] == ":"
            && ((characters[0] >= "a" && characters[0] <= "z") || (characters[0] >= "A" && characters[0] <= "Z"))
        if name.hasPrefix("/") || drive {
            throw ZipError("absolute path: \(name)")
        }
        if name.split(separator: "/", omittingEmptySubsequences: false).contains("..") {
            throw ZipError("invalid relative path: \(name)")
        }
    }

    /// Streams one file entry to `destination` (created 0600). `onBytes` sees every chunk
    /// of output and may throw to stop (the zip-bomb guard).
    public func extract(_ entry: ZipEntry, to destination: String, onBytes: @escaping (Int) throws -> Void) throws {
        guard !entry.isDirectory else { throw ZipError("Cannot extract a directory entry as a file") }
        guard entry.localHeaderOffset + 30 <= fileSize else {
            throw ZipError("local file header is beyond the end of the file")
        }
        var local = ByteReader(
            try BackupFiles.read(
                handle, at: entry.localHeaderOffset, count: 30, message: "local file header is truncated"))
        guard try local.u32() == ZipSignature.localHeader else {
            throw ZipError("invalid local file header signature: \(entry.name)")
        }
        local.offset = 26
        let nameLength = UInt64(try local.u16())
        let extraLength = UInt64(try local.u16())
        let dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
        guard dataStart <= fileSize, entry.compressedSize <= fileSize - dataStart else {
            throw ZipError("file data overflows file bounds: \(entry.name)")
        }
        try handle.seek(toOffset: dataStart)
        let sink = ExtractionSink(
            output: try BackupFiles.createFile(destination), entry: entry, onBytes: onBytes)
        defer { sink.close() }
        var remaining = entry.compressedSize
        if entry.method == 0 {
            while remaining > 0 {
                let chunk = try BackupFiles.read(handle, upTo: Int(min(UInt64(BackupFiles.chunkSize), remaining)))
                guard !chunk.isEmpty else { throw ZipError("unexpected end of file: \(entry.name)") }
                remaining -= UInt64(chunk.count)
                try sink.consume(chunk)
            }
        } else {
            let filter = try OutputFilter(.decompress, using: .zlib, bufferCapacity: 65_536) { data in
                guard let data, !data.isEmpty else { return }
                try sink.consume(data)
            }
            do {
                while remaining > 0 {
                    let chunk = try BackupFiles.read(handle, upTo: Int(min(UInt64(BackupFiles.chunkSize), remaining)))
                    guard !chunk.isEmpty else { throw ZipError("unexpected end of file: \(entry.name)") }
                    remaining -= UInt64(chunk.count)
                    try filter.write(chunk)
                }
                try filter.finalize()
            } catch {
                throw sink.failure ?? ZipError("invalid deflate data: \(entry.name)")
            }
        }
        guard sink.written == entry.uncompressedSize else {
            throw ZipError("not enough bytes in the stream: \(entry.name)")
        }
        guard sink.crc.value == entry.crc32 else { throw ZipError("CRC-32 mismatch: \(entry.name)") }
    }
}

/// Receives one entry's output: checks the size and the caller's limit, updates the
/// CRC-32 and writes to the destination file.
private final class ExtractionSink {
    let output: FileHandle
    let entry: ZipEntry
    let onBytes: (Int) throws -> Void
    var crc = CRC32()
    var written: UInt64 = 0
    var failure: Error?

    init(output: FileHandle, entry: ZipEntry, onBytes: @escaping (Int) throws -> Void) {
        self.output = output
        self.entry = entry
        self.onBytes = onBytes
    }

    func consume(_ data: Data) throws {
        do {
            try onBytes(data.count)
            written += UInt64(data.count)
            guard written <= entry.uncompressedSize else {
                throw ZipError("too many bytes in the stream: \(entry.name)")
            }
            crc.update(data)
            try output.write(contentsOf: data)
        } catch {
            failure = error
            throw error
        }
    }

    func close() {
        try? output.close()
    }
}

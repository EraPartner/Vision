import Foundation

/// The multipart body of the hand-written upload routes, as busboy parses it for multer: the
/// parts of a `multipart/form-data` body, each with the `name` of its form field, its
/// `filename` (only a file part has one), the part's own `Content-Type`, and its bytes.
///
/// The corpus's `multipart` steps and the client's `MultipartFormData` write the same layout
/// (one `--boundary` block per part, the headers to the blank line, the bytes to the next
/// boundary), so a tolerant scan of the boundary markers is the whole parse.
enum MultipartParts {
    struct Part: Equatable, Sendable {
        let name: String
        /// Present for a file part, as the part's `filename=` wrote it; a text field has none.
        let filename: String?
        let contentType: String
        let data: Data
    }

    /// Node's `'latin1'` decode, which busboy reads the header block with: every byte
    /// is one character, so a multi-byte UTF-8 filename stays as its raw bytes (the
    /// recorded TS answers store them that way), never re-joined as UTF-8.
    static func latin1(_ bytes: ArraySlice<UInt8>) -> String {
        String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) }))
    }

    /// The parts of `body`, or nil when the request is not multipart form data (multer then
    /// finds no buffer, and the route answers its "No file uploaded" validation error).
    static func parse(headers: [String: String], body: Data?) -> [Part]? {
        guard
            let header = headers.first(where: { $0.key.lowercased() == "content-type" })?.value,  // lint:allow string-literal-compare the header name, read case-insensitively as in HTTP
            let boundary = boundary(of: header), !boundary.isEmpty,
            let body
        else { return nil }
        let bytes = [UInt8](body)
        let delimiterBytes: [UInt8] = Array("--\(boundary)".utf8)

        // RFC 2046: a delimiter starts the body or a line (it follows a CRLF), and the line it
        // starts holds only the boundary, optionally `--`, then optional padding before the CRLF
        // or the end. Boundary text inside a line is content, as busboy reads it.
        func isDelimiter(at index: Int) -> Bool {
            guard index + delimiterBytes.count <= bytes.count else { return false }
            if index > 0 {
                guard index >= 2, bytes[index - 2] == 0x0D, bytes[index - 1] == 0x0A else { return false }
            }
            for (offset, byte) in delimiterBytes.enumerated() where bytes[index + offset] != byte { return false }
            var next = index + delimiterBytes.count
            if next + 1 < bytes.count, bytes[next] == 0x2D, bytes[next + 1] == 0x2D { next += 2 }
            while next < bytes.count, bytes[next] == 0x20 || bytes[next] == 0x09 { next += 1 }
            return next == bytes.count || (next + 1 < bytes.count && bytes[next] == 0x0D && bytes[next + 1] == 0x0A)
        }
        var marks: [Int] = []
        var cursor = 0
        while cursor < bytes.count {
            if isDelimiter(at: cursor) {
                marks.append(cursor)
                cursor += delimiterBytes.count
            } else {
                cursor += 1
            }
        }
        var parts: [Part] = []
        for (index, mark) in marks.enumerated() {
            let start = mark + delimiterBytes.count
            // The closing `--boundary--`: nothing follows it.
            guard index + 1 < marks.count else { break }
            var blockStart = start
            var blockEnd = marks[index + 1]
            // A part's content ends with the CRLF that starts the next boundary, and the
            // first part needs no preamble at all.
            if blockStart + 2 <= bytes.count, bytes[blockStart] == 0x0D, bytes[blockStart + 1] == 0x0A {
                blockStart += 2
            }
            if blockEnd - 2 >= blockStart, bytes[blockEnd - 2] == 0x0D, bytes[blockEnd - 1] == 0x0A {
                blockEnd -= 2
            }
            if let part = part(of: bytes[blockStart..<blockEnd]) { parts.append(part) }
        }
        return parts
    }

    /// One block between boundary markers: its headers to the blank line, its bytes after.
    static func part(of block: ArraySlice<UInt8>) -> Part? {
        let bytes = Array(block)
        // The headers end at the first blank line.
        var headersEnd: Int? = nil
        var scan = 0
        while scan + 4 <= bytes.count {
            if bytes[scan] == 0x0D, bytes[scan + 1] == 0x0A, bytes[scan + 2] == 0x0D, bytes[scan + 3] == 0x0A {
                headersEnd = scan
                break
            }
            scan += 1
        }
        guard let headersEnd else { return nil }
        var name: String? = nil
        var filename: String? = nil
        var contentType = ""
        var lineStart = 0
        while lineStart < headersEnd {
            var lineEnd = lineStart
            while lineEnd + 2 <= bytes.count, !(bytes[lineEnd] == 0x0D && bytes[lineEnd + 1] == 0x0A) {
                lineEnd += 1
            }
            let line = Self.latin1(bytes[lineStart..<lineEnd])
            let lower = line.lowercased()
            if lower.hasPrefix("content-disposition:") {
                name = Self.parameter(named: "name", of: line)
                filename = Self.parameter(named: "filename", of: line)
            } else if lower.hasPrefix("content-type:") {
                contentType = String(line.dropFirst("content-type:".count)).trimmingCharacters(in: .whitespaces)
            }
            lineStart = lineEnd + 2
        }
        guard let name else { return nil }
        // A file part carries a `filename=`; a text field does not. An absent Content-Type
        // header stays empty, as busboy leaves `mimetype` for a part without one.
        return Part(
            name: name, filename: filename, contentType: contentType,
            data: Data(bytes[(headersEnd + 4)...]))
    }

    /// The request's boundary, from the `Content-Type` header's `boundary=` parameter.
    static func boundary(of header: String) -> String? {
        for parameter in header.split(separator: ";").dropFirst() {
            let pieces = parameter.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pieces.count == 2, pieces[0].trimmingCharacters(in: .whitespaces).lowercased() == "boundary" else {  // lint:allow string-literal-compare the boundary parameter of the form content type
                continue
            }
            let value = pieces[1].trimmingCharacters(in: .whitespaces)
            return value.hasPrefix("\"") && value.hasSuffix("\"")
                ? String(value.dropFirst().dropLast()) : value
        }
        return nil
    }

    /// `name="value"` of a `Content-Disposition` header, verbatim (the client percent-escapes
    /// a line break and a double quote, and busboy keeps them as written).
    static func parameter(named wanted: String, of header: String) -> String? {
        let marker = "\(wanted)=\""
        guard let start = header.range(of: marker)?.upperBound, let end = header[start...].firstIndex(of: "\"") else {
            return nil
        }
        return String(header[start..<end])
    }
}

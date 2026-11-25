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

    /// The parts of `body`, or nil when the request is not multipart form data (multer then
    /// finds no buffer, and the route answers its "No file uploaded" validation error).
    static func parse(headers: [String: String], body: Data?) -> [Part]? {
        guard
            let header = headers.first(where: { $0.key.lowercased() == "content-type" })?.value,  // lint:allow string-literal-compare the header name, read case-insensitively as in HTTP
            let boundary = boundary(of: header),
            let body
        else { return nil }
        let delimiter = Data("--\(boundary)".utf8)
        var marks: [Data.Index] = []
        var cursor = body.startIndex
        while cursor < body.endIndex,
            let range = body.range(of: delimiter, in: cursor..<body.endIndex)
        {
            marks.append(range.lowerBound)
            cursor = range.upperBound
        }
        var parts: [Part] = []
        for (index, mark) in marks.enumerated() {
            let start = mark + delimiter.count
            // The closing `--boundary--`: nothing follows it.
            guard index + 1 < marks.count else { break }
            let end = marks[index + 1]
            var block = body[start..<end]
            // A part's content ends with the CRLF that starts the next boundary, and the
            // first part needs no preamble at all.
            let breakBytes = Data("\r\n".utf8)
            if block.prefix(2) == breakBytes { block = block.dropFirst(2) }
            if block.suffix(2) == breakBytes { block = block.dropLast(2) }
            if let part = part(of: block) { parts.append(part) }
        }
        return parts
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

    /// One block between boundary markers: its headers to the blank line, its bytes after.
    static func part(of block: Data) -> Part? {
        guard let headersEnd = block.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        var name: String?
        var filename: String?
        var contentType = ""
        var headerStart = block.startIndex
        while let lineBreak = block.range(of: Data("\r\n".utf8), in: headerStart..<headersEnd.lowerBound) {
            let line = String(decoding: block[headerStart..<lineBreak.lowerBound], as: UTF8.self)
            let lower = line.lowercased()
            if lower.hasPrefix("content-disposition:") {
                name = Self.parameter(named: "name", of: line)
                filename = Self.parameter(named: "filename", of: line)
            } else if lower.hasPrefix("content-type:") {
                contentType = String(line.dropFirst("content-type:".count)).trimmingCharacters(in: .whitespaces)
            }
            headerStart = lineBreak.upperBound
        }
        guard let name else { return nil }
        // A file part carries a `filename=`; a text field does not. An absent Content-Type
        // header stays empty, as busboy leaves `mimetype` for a part without one.
        return Part(
            name: name, filename: filename, contentType: contentType,
            data: Data(block[headersEnd.upperBound...]))
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

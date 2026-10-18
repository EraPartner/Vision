import Foundation

/// `useCsvPreview`: the header row and up to five data rows of a CSV, parsed on the Mac from
/// the first `peekBytes` of the file (the file never goes to the backend for this preview).
/// The parser follows the csv-parse options the web passes: the given delimiter, `\r\n`,
/// `\n` or `\r` record ends, quotes with `""` escapes, quotes inside unquoted fields kept,
/// empty lines skipped, every field trimmed, and `skipRows` leading lines dropped.
public struct CSVPreview: Equatable, Sendable {
    public let headers: [String]
    public let rows: [[String]]

    public init(headers: [String], rows: [[String]]) {
        self.headers = headers
        self.rows = rows
    }

    /// `PEEK_BYTES`.
    public static let peekBytes = 16_384
    /// `MAX_PREVIEW_ROWS`.
    public static let maximumRows = 5

    /// The preview of a file, or `nil` when it cannot be read as CSV (an unsupported encoding
    /// or no header row): the panel then shows `csvHeaders.unreadable`.
    public static func make(_ data: Data, separator: String, encoding: String, skipRows: Int) -> CSVPreview? {
        let peek = data.prefix(peekBytes)
        guard let text = decode(Array(peek), encoding: encoding, partial: peek.count < data.count) else { return nil }
        let preview = parse(text, separator: separator, skipRows: skipRows)
        return preview.headers.isEmpty ? nil : preview
    }

    /// `useAutoSeparator`: the separator of the first non-empty line, read as UTF-8.
    public static func detectSeparator(_ data: Data) -> String {
        let text = String(decoding: data.prefix(peekBytes), as: UTF8.self)
        let line = lines(text).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        return CSVSeparator.detect(line)
    }

    /// `decodePreviewBytes`: UTF-8 (falling back to Latin-1 when it does not decode cleanly),
    /// Latin-1 or Windows-1252; `nil` for any other encoding. A preview slice may end inside
    /// a UTF-8 character; that tail is left out instead of forcing the fallback.
    static func decode(_ bytes: [UInt8], encoding: String, partial: Bool) -> String? {
        let normalized = encoding.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let latin1 = { String(decoding: bytes.map { UInt16($0) }, as: UTF16.self) }
        switch normalized {
        case "latin1", "latin-1", "iso-8859-1":
            return latin1()
        case "windows-1252":
            return String(data: Data(bytes), encoding: .windowsCP1252) ?? latin1()
        case "", "utf-8", "utf8":
            let complete = partial ? trimmingIncompleteCharacter(bytes) : bytes
            guard let text = String(data: Data(complete), encoding: .utf8), !text.contains("\u{FFFD}") else {
                return latin1()
            }
            return text
        default:
            return nil
        }
    }

    /// Drops a multi-byte UTF-8 sequence cut off at the end.
    static func trimmingIncompleteCharacter(_ bytes: [UInt8]) -> [UInt8] {
        var index = bytes.count - 1
        var continuation = 0
        while index >= 0, continuation < 3, bytes[index] & 0xC0 == 0x80 {
            index -= 1
            continuation += 1
        }
        guard index >= 0 else { return bytes }
        let lead = bytes[index]
        let length = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
        return length > 1 && bytes.count - index < length ? Array(bytes[..<index]) : bytes
    }

    /// `parseCsvText`: a leading BOM goes, the first record is the header, and a data row
    /// counts only with as many fields as the header.
    static func parse(_ text: String, separator: String, skipRows: Int) -> CSVPreview {
        var body = text
        if body.unicodeScalars.first == "\u{FEFF}" { body.unicodeScalars.removeFirst() }
        let records = self.records(skippingLines(body, count: max(0, skipRows)), separator: separator)
        guard let header = records.first else { return CSVPreview(headers: [], rows: []) }
        var rows: [[String]] = []
        for record in records.dropFirst() {
            if rows.count >= maximumRows { break }
            guard record.count == header.count else { continue }
            rows.append(record)
        }
        return CSVPreview(headers: header, rows: rows)
    }

    /// The text after `count` physical lines (`from_line: skipRows + 1`).
    static func skippingLines(_ text: String, count: Int) -> String {
        guard count > 0 else { return text }
        let scalars = Array(text.unicodeScalars)
        var index = 0
        var skipped = 0
        while index < scalars.count, skipped < count {
            if scalars[index] == "\r" {
                skipped += 1
                index += index + 1 < scalars.count && scalars[index + 1] == "\n" ? 2 : 1
            } else if scalars[index] == "\n" {
                skipped += 1
                index += 1
            } else {
                index += 1
            }
        }
        var rest = String.UnicodeScalarView()
        rest.append(contentsOf: scalars[index...])
        return String(rest)
    }

    static func lines(_ text: String) -> [String] {
        var result: [String] = []
        var current = String.UnicodeScalarView()
        var previousWasReturn = false
        for scalar in text.unicodeScalars {
            if scalar == "\n" && previousWasReturn {
                previousWasReturn = false
                continue
            }
            previousWasReturn = scalar == "\r"
            if scalar == "\r" || scalar == "\n" {
                result.append(String(current))
                current = String.UnicodeScalarView()
            } else {
                current.append(scalar)
            }
        }
        result.append(String(current))
        return result
    }

    /// The records of the text: fields split on the delimiter outside quotes, every field
    /// trimmed, and blank lines skipped. A quote left open at the end closes there (the
    /// preview may cut a record in half).
    static func records(_ text: String, separator: String) -> [[String]] {
        let delimiter = separator.unicodeScalars.first ?? ","
        let scalars = Array(text.unicodeScalars)
        var records: [[String]] = []
        var record: [String] = []
        var field = String.UnicodeScalarView()
        var fieldStarted = false
        var inQuotes = false
        var wasQuoted = false

        func isBlank(_ scalar: Unicode.Scalar) -> Bool {
            scalar != delimiter && (scalar == " " || scalar == "\t")
        }
        func endField() {
            record.append(String(field).trimmingCharacters(in: .whitespacesAndNewlines))
            field = String.UnicodeScalarView()
            fieldStarted = false
        }
        func endRecord() {
            endField()
            // `skip_empty_lines`: a line with nothing on it makes no record.
            if record.count == 1, record[0].isEmpty, !wasQuoted {
                record = []
                return
            }
            records.append(record)
            record = []
            wasQuoted = false
        }

        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if inQuotes {
                if scalar == "\"" {
                    if index + 1 < scalars.count, scalars[index + 1] == "\"" {
                        field.append("\"")
                        index += 2
                        continue
                    }
                    inQuotes = false
                } else {
                    field.append(scalar)
                }
                index += 1
                continue
            }
            if scalar == delimiter {
                endField()
            } else if scalar == "\r" || scalar == "\n" {
                endRecord()
                if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" { index += 1 }
            } else if scalar == "\"" && !fieldStarted {
                inQuotes = true
                wasQuoted = true
                fieldStarted = true
            } else if isBlank(scalar) && !fieldStarted {
                // `trim`: whitespace before the value (or its opening quote) is not part of it.
            } else {
                field.append(scalar)
                fieldStarted = true
            }
            index += 1
        }
        if fieldStarted || !field.isEmpty || !record.isEmpty || inQuotes {
            endRecord()
        }
        return records
    }
}

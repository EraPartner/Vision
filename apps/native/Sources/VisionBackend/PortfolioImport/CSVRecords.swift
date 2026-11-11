import Foundation

/// `csv-parse/sync` for the options the import services re-read a stored record with
/// (ADR-270): comma delimiter, `"` as quote and escape, the record delimiter discovered from
/// the first line ending (`\r\n`, `\n` or `\r`), no trimming and no skipped lines. A port of
/// the parser loop of csv-parse 7.0.3 (`lib/api/index.js`), byte for byte over UTF-8.
enum CSVRecords {
    /// A `CsvError`: the services catch it and treat the text as not a record.
    struct Malformed: Error, Equatable, Sendable {
        enum Reason: Sendable { case invalidOpeningQuote, invalidClosingQuote, quoteNotClosed, inconsistentRecordLength }
        let reason: Reason
    }

    private static let quote = UInt8(ascii: "\"")
    private static let comma = UInt8(ascii: ",")
    private static let carriageReturn = UInt8(ascii: "\r")
    private static let lineFeed = UInt8(ascii: "\n")

    /// - Parameters:
    ///   - relaxQuotes: `relax_quotes`: a quote inside an unquoted field, or text after a
    ///     closing quote, is kept literally instead of failing.
    ///   - relaxColumnCount: `relax_column_count`: records may differ in length.
    static func parse(_ text: String, relaxQuotes: Bool, relaxColumnCount: Bool) throws -> [[String]] {
        let buffer = Array(text.utf8)
        let count = buffer.count
        var recordDelimiter: [UInt8] = []
        var quoting = false
        var wasQuoting = false
        var escaping = false
        var field: [UInt8] = []
        var record: [String] = []
        var records: [[String]] = []
        var expectedLength = 0

        func byte(_ position: Int) -> UInt8? { position < count ? buffer[position] : nil }

        /// `__autoDiscoverRecordDelimiter`: windows before mac os 9.
        func discover(at position: Int) -> Int {
            if byte(position) == carriageReturn, byte(position + 1) == lineFeed {
                recordDelimiter = [carriageReturn, lineFeed]
            } else if byte(position) == lineFeed {
                recordDelimiter = [lineFeed]
            } else if byte(position) == carriageReturn {
                recordDelimiter = [carriageReturn]
            } else {
                return 0
            }
            return recordDelimiter.count
        }

        /// `__isRecordDelimiter`.
        func recordDelimiterLength(at position: Int) -> Int {
            guard !recordDelimiter.isEmpty else { return 0 }
            for (offset, expected) in recordDelimiter.enumerated() where byte(position + offset) != expected { return 0 }
            return recordDelimiter.count
        }

        func endField() {
            record.append(String(decoding: field, as: UTF8.self))
            field.removeAll(keepingCapacity: true)
            wasQuoting = false
        }

        func endRecord() throws {
            if records.isEmpty { expectedLength = record.count }
            if record.count != expectedLength, !relaxColumnCount { throw Malformed(reason: .inconsistentRecordLength) }
            records.append(record)
            record = []
        }

        var position = 0
        while position < count {
            defer { position += 1 }
            if !quoting, recordDelimiter.isEmpty { _ = discover(at: position) }
            let character = buffer[position]
            if escaping {
                escaping = false
            } else {
                // The escape is the quote: only a doubled quote inside a quoted field.
                if quoting, character == quote, position + 1 < count, buffer[position + 1] == quote {
                    escaping = true
                    continue
                }
                if character == quote {
                    if quoting {
                        let next = byte(position + 1)
                        let nextIsRecordDelimiter =
                            recordDelimiter.isEmpty
                            ? discover(at: position + 1) != 0 : recordDelimiterLength(at: position + 1) != 0
                        // `!nextChr`: the end of the text, or a NUL byte.
                        if next == nil || next == 0 || next == comma || nextIsRecordDelimiter {
                            quoting = false
                            wasQuoting = true
                            continue
                        } else if !relaxQuotes {
                            throw Malformed(reason: .invalidClosingQuote)
                        } else {
                            quoting = false
                            wasQuoting = true
                            field.insert(quote, at: 0)
                        }
                    } else if !field.isEmpty {
                        if !relaxQuotes { throw Malformed(reason: .invalidOpeningQuote) }
                    } else {
                        quoting = true
                        continue
                    }
                }
                if !quoting {
                    let delimiterLength = recordDelimiterLength(at: position)
                    if delimiterLength != 0 {
                        endField()
                        try endRecord()
                        position += delimiterLength - 1
                        continue
                    }
                    if character == comma {
                        endField()
                        continue
                    }
                }
            }
            field.append(character)
        }
        if quoting { throw Malformed(reason: .quoteNotClosed) }
        // The last line is skipped if it has no characters.
        if wasQuoting || !record.isEmpty || !field.isEmpty {
            endField()
            try endRecord()
        }
        return records
    }
}

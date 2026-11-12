import Foundation

/// `csv-parse/sync` 7.0.3 for the options the import adapters read a file with: a port of the
/// parser loop of `lib/api/index.js`, byte for byte over UTF-8, with `"` as quote and escape
/// and the record delimiter discovered from the first line ending.
///
/// Each record carries its literal source text (`raw: true`), which the adapters keep as the
/// row's provenance. As in csv-parse, that text starts where the previous record ended, so it
/// includes blank lines skipped before the record.
enum CSVParse {
    enum Columns: Sendable {
        /// `columns: false`: records are tuples.
        case none
        /// `columns: true`: the first record names the columns.
        case firstRecord
        /// `columns: (headers) => names`: the first record, renamed. A nil name disables the
        /// column.
        case renamed(@Sendable ([String]) -> [String?])
    }

    struct Options: Sendable {
        var delimiter = ","
        /// `from_line`: records start on this line (1 is the first).
        var fromLine = 1
        var skipEmptyLines = false
        var relaxColumnCount = false
        var relaxQuotes = false
        /// `skip_records_with_error`: a record with an error is dropped and counted.
        var skipRecordsWithError = false
        var columns = Columns.none
        /// `trim`: whitespace around unquoted fields and outside quotes is dropped.
        var trim = false
    }

    struct Record: Equatable, Sendable {
        /// The cells in source order.
        let cells: [String]
        /// With columns: the cells by column name. A repeated name keeps its last cell; a
        /// cell beyond the named columns is dropped.
        let fields: [String: String]
        /// The decoded source text of the record, with its record delimiter.
        let raw: String

        subscript(name: String) -> String? { fields[name] }
    }

    struct Output: Equatable, Sendable {
        var records: [Record] = []
        /// How often `on_skip` was called.
        var skipped = 0
    }

    /// A `CsvError`, by its code.
    struct Failure: Error, Equatable, Sendable {
        enum Code: String, Sendable {
            case invalidOpeningQuote = "INVALID_OPENING_QUOTE"
            case invalidClosingQuote = "CSV_INVALID_CLOSING_QUOTE"
            case quoteNotClosed = "CSV_QUOTE_NOT_CLOSED"
            case inconsistentFieldsLength = "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH"
            case inconsistentColumns = "CSV_RECORD_INCONSISTENT_COLUMNS"
            case nonTrimableCharAfterClosingQuote = "CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE"
            case invalidDelimiter = "CSV_INVALID_OPTION_DELIMITER"
        }
        let code: Code
    }

    /// The characters `trim` removes, as csv-parse lists them.
    private static let trimCharacters: [[UInt8]] = [
        0x0020, 0x0009, 0x000A, 0x000D, 0x000C, 0x000B, 0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
        0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ].compactMap { Unicode.Scalar($0 as UInt32).map { Array(String($0).utf8) } }

    private static let quote = UInt8(ascii: "\"")
    private static let carriageReturn = UInt8(ascii: "\r")
    private static let lineFeed = UInt8(ascii: "\n")

    /// `parse(text, options)` with `info` and `raw` on, as `parseCsvText` calls it.
    static func parse(_ text: String, _ options: Options = Options()) throws -> Output {
        let delimiter = Array(options.delimiter.utf8)
        guard !delimiter.isEmpty else { throw Failure(code: .invalidDelimiter) }
        let buffer = Array(text.utf8)
        let count = buffer.count
        var output = Output()

        var recordDelimiter: [UInt8] = []
        var quoting = false
        var wasQuoting = false
        var escaping = false
        var wasRowDelimiter = false
        var enabled = options.fromLine == 1
        var recordHasError = false
        var lines = 1
        var recordCount = 0
        var field: [UInt8] = []
        var record: [String] = []
        var raw: [UInt8] = []
        var columns: [String?]?
        var awaitingColumns: Bool
        if case .none = options.columns { awaitingColumns = false } else { awaitingColumns = true }
        var expectedLength: Int?

        func byte(_ position: Int) -> UInt8? { position < count ? buffer[position] : nil }

        func matches(_ bytes: [UInt8], at position: Int) -> Bool {
            for (offset, expected) in bytes.enumerated() where byte(position + offset) != expected { return false }
            return true
        }

        func discover(at position: Int) -> Int {
            for candidate in [[carriageReturn, lineFeed], [lineFeed], [carriageReturn]] where matches(candidate, at: position) {
                recordDelimiter = candidate
                return candidate.count
            }
            return 0
        }

        func recordDelimiterLength(at position: Int) -> Int {
            !recordDelimiter.isEmpty && matches(recordDelimiter, at: position) ? recordDelimiter.count : 0
        }

        func trimableLength(at position: Int) -> Int {
            guard position < count else { return 0 }
            return trimCharacters.first { matches($0, at: position) }?.count ?? 0
        }

        /// `__error`: nil when the record is skipped instead.
        func failure(_ code: Failure.Code) -> Failure? {
            guard options.skipRecordsWithError else { return Failure(code: code) }
            recordHasError = true
            output.skipped += 1
            return nil
        }

        func resetRecord() {
            raw.removeAll(keepingCapacity: true)
            record = []
        }

        func resetField() {
            field.removeAll(keepingCapacity: true)
            wasQuoting = false
        }

        func endField() {
            guard enabled else { return resetField() }
            var text = String(decoding: field, as: UTF8.self)
            if options.trim, !wasQuoting {
                // `trimRight`.
                let scalars = text.unicodeScalars
                if let last = scalars.lastIndex(where: { !JavaScriptWhitespace.contains($0) }) {
                    text = String(scalars[...last])
                } else {
                    text = ""
                }
            }
            record.append(text)
            resetField()
        }

        func endRecord() throws {
            guard enabled else { return resetRecord() }
            if awaitingColumns {
                let names: [String?]
                if case .renamed(let rename) = options.columns { names = rename(record) } else { names = record }
                columns = names
                expectedLength = names.count
                awaitingColumns = false
                return resetRecord()
            }
            if columns == nil, recordCount == 0 { expectedLength = record.count }
            if record.count != expectedLength, !options.relaxColumnCount {
                if let error = failure(columns == nil ? .inconsistentFieldsLength : .inconsistentColumns) { throw error }
            }
            if recordHasError {
                resetRecord()
                recordHasError = false
                return
            }
            recordCount += 1
            var fields: [String: String] = [:]
            if let columns {
                for (index, cell) in record.enumerated() where index < columns.count {
                    if let name = columns[index] { fields[name] = cell }
                }
            }
            output.records.append(Record(cells: record, fields: fields, raw: String(decoding: raw, as: UTF8.self)))
            resetRecord()
        }

        var position = 0
        scan: while position < count {
            defer { position += 1 }
            if wasRowDelimiter {
                lines += 1
                wasRowDelimiter = false
            }
            if !quoting, recordDelimiter.isEmpty { _ = discover(at: position) }
            let character = buffer[position]
            raw.append(character)
            if character == carriageReturn || character == lineFeed { wasRowDelimiter = true }
            if escaping {
                escaping = false
            } else {
                if quoting, character == quote, position + 1 < count, buffer[position + 1] == quote {
                    escaping = true
                    continue
                }
                if character == quote {
                    if quoting {
                        let next = byte(position + 1)
                        let nextIsTrimable = options.trim && trimableLength(at: position + 1) != 0
                        let nextIsDelimiter = matches(delimiter, at: position + 1)
                        let nextIsRecordDelimiter =
                            recordDelimiter.isEmpty
                            ? discover(at: position + 1) != 0 : recordDelimiterLength(at: position + 1) != 0
                        // `!nextChr`: the end of the text, or a NUL byte.
                        if next == nil || next == 0 || nextIsDelimiter || nextIsRecordDelimiter || nextIsTrimable {
                            quoting = false
                            wasQuoting = true
                            continue
                        } else if !options.relaxQuotes {
                            if let error = failure(.invalidClosingQuote) { throw error }
                        } else {
                            quoting = false
                            wasQuoting = true
                            field.insert(quote, at: 0)
                        }
                    } else if !field.isEmpty {
                        if !options.relaxQuotes, let error = failure(.invalidOpeningQuote) { throw error }
                    } else {
                        quoting = true
                        continue
                    }
                }
                if !quoting {
                    let delimiterLength = recordDelimiterLength(at: position)
                    if delimiterLength != 0 {
                        if !enabled, lines + (wasRowDelimiter ? 1 : 0) >= options.fromLine {
                            enabled = true
                            resetField()
                            resetRecord()
                            position += delimiterLength - 1
                            continue
                        }
                        if options.skipEmptyLines, !wasQuoting, record.isEmpty, field.isEmpty {
                            position += delimiterLength - 1
                            continue
                        }
                        endField()
                        try endRecord()
                        position += delimiterLength - 1
                        continue
                    }
                    if matches(delimiter, at: position) {
                        endField()
                        position += delimiter.count - 1
                        continue
                    }
                }
            }
            let leftAppend = !options.trim || quoting || !field.isEmpty || trimableLength(at: position) == 0
            let rightAppend = !options.trim || !wasQuoting
            if leftAppend, rightAppend {
                field.append(character)
            } else if options.trim, trimableLength(at: position) == 0 {
                // csv-parse returns from the parser here: with skipped errors the rest of the
                // text is dropped without a word.
                if let error = failure(.nonTrimableCharAfterClosingQuote) { throw error }
                return output
            } else if !leftAppend {
                position += trimableLength(at: position) - 1
            }
        }
        if quoting {
            if let error = failure(.quoteNotClosed) { throw error }
        } else if wasQuoting || !record.isEmpty || !field.isEmpty {
            endField()
            try endRecord()
        }
        return output
    }
}

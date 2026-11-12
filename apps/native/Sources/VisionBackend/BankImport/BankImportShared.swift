import Foundation

/// One bank transaction as an adapter reads it from a statement (`ParsedBankTransaction` of
/// `importPipeline/adapters/_shared.ts`).
struct ParsedBankTransaction: Equatable, Sendable {
    /// The booking day, as days since 1970-01-01 (the TypeScript holds a UTC-midnight `Date`).
    var day: Int
    var bankAccount: String
    var recipient: String
    var memo: String
    /// Signed; negative is an outflow.
    var amount: Double
    var currency: String?
    var balance: Double?
    var recipientAccount: String?
    var recipientAddress: String?
    var recipientBankName: String?
    var comment: String?
    var rawData: String
    /// The bank's own identifier of the transaction. The outer `nil` is a row without the
    /// property; the inner one is the property holding `null`.
    var sourceReference: Optional<String?> = nil
    var bankSequence: Optional<String?> = nil

    var jsonValue: JSValue {
        func text(_ value: String?) -> JSValue { value.map(JSValue.string) ?? .null }
        var out = JSObject([
            ("day", .number(Double(day))),
            ("bankAccount", .string(bankAccount)), ("recipient", .string(recipient)), ("memo", .string(memo)),
            ("amount", .number(amount)), ("currency", text(currency)),
            ("balance", balance.map(JSValue.number) ?? .null), ("recipientAccount", text(recipientAccount)),
            ("recipientAddress", text(recipientAddress)), ("recipientBankName", text(recipientBankName)),
            ("comment", text(comment)), ("rawData", .string(rawData)),
        ])
        if let sourceReference { out["sourceId"] = text(sourceReference) }
        if let bankSequence { out["bankSequence"] = text(bankSequence) }
        return .object(out)
    }
}

/// An adapter's result: the rows and its counts of rows it could not use.
struct ParsedBankTransactions: Equatable, Sendable {
    var rows: [ParsedBankTransaction] = []
    var skipped: Int?
    /// Records left out on purpose (not settled); they count in `skipped` too.
    var excluded: Int?
    var issues: [String]?

    var jsonValue: JSValue {
        var out = JSObject([("rows", .array(rows.map(\.jsonValue)))])
        if let skipped { out["skipped"] = .number(Double(skipped)) }
        if let excluded { out["excluded"] = .number(Double(excluded)) }
        if let issues { out["issues"] = .array(issues.map(JSValue.string)) }
        return .object(out)
    }
}

enum StatementImportError: Error, Equatable, Sendable {
    /// A `ValidationError`: the message is shown to the user.
    case validation(String)
    /// A plain `Error` of the adapter (a missing or unsupported setting).
    case failed(String)
    /// The adapter's output broke the row contract (`parsedBankTransactionSchema`).
    case contract(adapter: String)
}

/// The helpers every bank adapter shares (`importPipeline/adapters/_shared.ts`,
/// `lib/csvFormatOptions.ts`, `lib/textNormalization.ts`).
enum BankImportText {
    typealias Units = [UInt16]

    static func units(_ text: String) -> Units { Array(text.utf16) }
    static func text(_ units: some Sequence<UInt16>) -> String { String(decoding: Array(units), as: UTF16.self) }
    static func trim(_ text: String) -> String { JavaScriptWhitespace.trim(text) }
    static func isSpace(_ unit: UInt16) -> Bool { AnalysisSQLRules.isSpace(unit) }
    static func isDigit(_ unit: UInt16) -> Bool { unit >= 0x30 && unit <= 0x39 }

    /// `text.replace(/\s/g, "")`.
    static func withoutSpaces(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter { !JavaScriptWhitespace.contains($0) }))
    }

    /// `text.split(/\s+/)`.
    static func splitOnSpaces(_ text: String) -> [String] {
        var parts: [String] = []
        var current = String.UnicodeScalarView()
        var inRun = false
        for scalar in text.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !inRun {
                    parts.append(String(current))
                    current = String.UnicodeScalarView()
                }
                inRun = true
            } else {
                inRun = false
                current.append(scalar)
            }
        }
        parts.append(String(current))
        return parts
    }

    // The comparisons below are by UTF-16 unit, as JavaScript's are. Swift's own treat
    // canonically equivalent text as equal, so a Greek question mark would pass for `;`.

    /// `a === b`.
    static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

    /// `text.startsWith(prefix)`.
    static func hasPrefix(_ text: String, _ prefix: String) -> Bool { text.utf16.starts(with: prefix.utf16) }

    private static func firstIndex(of needle: Units, in all: Units, from start: Int = 0) -> Int? {
        guard !needle.isEmpty, all.count >= needle.count, start <= all.count - needle.count else { return nil }
        for index in start...(all.count - needle.count) where all[index] == needle[0] {
            if all[index..<(index + needle.count)].elementsEqual(needle) { return index }
        }
        return nil
    }

    /// `text.includes(needle)`, for a needle that is not empty.
    static func contains(_ text: String, _ needle: String) -> Bool {
        firstIndex(of: units(needle), in: units(text)) != nil
    }

    /// `text.split(separator)`, for a separator that is not empty.
    static func split(_ text: String, _ separator: String) -> [String] {
        let all = units(text)
        let needle = units(separator)
        var parts: [String] = []
        var start = 0
        while let index = firstIndex(of: needle, in: all, from: start) {
            parts.append(Self.text(all[start..<index]))
            start = index + needle.count
        }
        parts.append(Self.text(all[start...]))
        return parts
    }

    /// `text.replace(needle, replacement)`: the first occurrence only.
    static func replacingFirst(_ text: String, _ needle: String, _ replacement: String) -> String {
        let all = units(text)
        guard let index = firstIndex(of: units(needle), in: all) else { return text }
        return Self.text(all[..<index]) + replacement + Self.text(all[(index + needle.utf16.count)...])
    }

    // MARK: Encodings

    enum Encoding: Sendable { case utf8, latin1, windows1252 }

    /// `normalizeCsvEncoding(value)`; nil is an absent setting.
    static func encoding(_ value: String?) throws -> Encoding {
        guard let value, !value.isEmpty else { return .utf8 }
        let name = JavaScriptCase.lowercased(trim(value))
        if name.isEmpty || name == "utf-8" || name == "utf8" { return .utf8 }
        if ["latin1", "latin-1", "iso-8859-1"].contains(name) { return .latin1 }
        if name == "windows-1252" { return .windows1252 }
        throw StatementImportError.validation("Unsupported CSV encoding \"\(value)\"")
    }

    /// The code points of bytes 0x80...0x9F in windows-1252 (WHATWG).
    private static let windows1252High: [UInt32] = [
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D,
        0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
        0x0153, 0x9D, 0x017E, 0x0178,
    ]

    private static func singleByte(_ bytes: [UInt8], high: [UInt32]?) -> String {
        var scalars = String.UnicodeScalarView()
        for byte in bytes {
            let value: UInt32
            if let high, byte >= 0x80, byte <= 0x9F { value = high[Int(byte) - 0x80] } else { value = UInt32(byte) }
            if let scalar = Unicode.Scalar(value) { scalars.append(scalar) }
        }
        return String(scalars)
    }

    /// `decodeCsvBuffer(buffer, encoding)`: UTF-8 falls back to Latin-1 when the bytes are not
    /// valid UTF-8.
    static func decode(_ bytes: [UInt8], _ encoding: Encoding = .utf8) -> String {
        switch encoding {
        case .windows1252:
            // `TextDecoder` drops a byte order mark; none exists in this encoding.
            return singleByte(bytes, high: windows1252High)
        case .latin1: return singleByte(bytes, high: nil)
        case .utf8:
            let text = String(decoding: bytes, as: UTF8.self)
            return text.unicodeScalars.contains("\u{FFFD}") ? singleByte(bytes, high: nil) : text
        }
    }

    /// The text without a leading byte order mark.
    static func withoutByteOrderMark(_ text: String) -> String {
        text.unicodeScalars.first == "\u{FEFF}" ? String(text.unicodeScalars.dropFirst()) : text
    }

    /// `splitCsvLines(content)`.
    static func lines(_ content: String) -> [String] { lines(keepingByteOrderMark: withoutByteOrderMark(content)) }

    /// `content.split(/\r\n|\r|\n/)`.
    static func lines(keepingByteOrderMark content: String) -> [String] {
        var lines: [String] = []
        var current: Units = []
        let all = units(content)
        var index = 0
        while index < all.count {
            let unit = all[index]
            if unit == 0x0D || unit == 0x0A {
                lines.append(text(current))
                current = []
                if unit == 0x0D, index + 1 < all.count, all[index + 1] == 0x0A { index += 1 }
            } else {
                current.append(unit)
            }
            index += 1
        }
        lines.append(text(current))
        return lines
    }

    /// `parseCsvText(content, options)`: the records, each with its source text less the
    /// final record delimiter.
    static func records(_ content: String, _ options: CSVParse.Options) throws -> CSVParse.Output {
        try CSVParse.parse(withoutByteOrderMark(content), options)
    }

    /// `rawDataForCsvRecord(record)`.
    static func rawData(_ record: CSVParse.Record) -> String {
        let raw = units(record.raw)
        if raw.count >= 2, raw[raw.count - 2] == 0x0D, raw[raw.count - 1] == 0x0A { return text(raw.dropLast(2)) }
        if let last = raw.last, last == 0x0D || last == 0x0A { return text(raw.dropLast()) }
        return record.raw
    }

    // MARK: Numbers

    /// `parseInt(text, 10)`.
    static func parseInt(_ text: String) -> Double {
        var all = units(text)[...]
        while let first = all.first, isSpace(first) { all = all.dropFirst() }
        var negative = false
        if let first = all.first, first == 0x2D || first == 0x2B {
            negative = first == 0x2D
            all = all.dropFirst()
        }
        let digits = all.prefix(while: isDigit)
        guard !digits.isEmpty, let value = Double(Self.text(digits)) else { return .nan }
        return negative ? -value : value
    }

    /// `parseFloat(text)`.
    static func parseFloat(_ text: String) -> Double {
        var all = units(text)[...]
        while let first = all.first, isSpace(first) { all = all.dropFirst() }
        var literal: Units = []
        if let first = all.first, first == 0x2D || first == 0x2B {
            literal.append(first)
            all = all.dropFirst()
        }
        if Self.text(all.prefix(8)) == "Infinity" { return literal.first == 0x2D ? -.infinity : .infinity }
        let whole = all.prefix(while: isDigit)
        all = all.dropFirst(whole.count)
        literal += whole
        var fraction: Units.SubSequence = []
        if all.first == 0x2E {
            fraction = all.dropFirst().prefix(while: isDigit)
            if !whole.isEmpty || !fraction.isEmpty {
                literal.append(0x2E)
                literal += fraction
                all = all.dropFirst(1 + fraction.count)
            }
        }
        guard !whole.isEmpty || !fraction.isEmpty else { return .nan }
        if let mark = all.first, mark == 0x65 || mark == 0x45 {
            var rest = all.dropFirst()
            var sign: Units = []
            if let first = rest.first, first == 0x2D || first == 0x2B {
                sign = [first]
                rest = rest.dropFirst()
            }
            let exponent = rest.prefix(while: isDigit)
            if !exponent.isEmpty { literal += [0x65] + sign + exponent }
        }
        var value = Self.text(literal)
        if value.hasSuffix(".") { value += "0" }
        if value.hasPrefix(".") || value.hasPrefix("-.") || value.hasPrefix("+.") {
            value = value.replacingOccurrences(of: ".", with: "0.", options: [], range: value.range(of: "."))
        }
        return Double(value) ?? .nan
    }

    /// `parseDecimalSafe(value)`: the text through decimal.js, NaN when it refuses it.
    static func decimal(_ value: String) -> Double {
        let text = trim(value)
        if text.isEmpty { return .nan }
        // decimal.js reads a signed `Infinity`; `DecimalJS` holds finite values only.
        var unsigned = Substring(text)
        if unsigned.hasPrefix("-") || unsigned.hasPrefix("+") { unsigned = unsigned.dropFirst() }
        if unsigned.utf8.elementsEqual("Infinity".utf8) { return text.hasPrefix("-") ? -.infinity : .infinity }
        return (try? DecimalJS(text).toNumber) ?? .nan
    }

    /// `parseCommaDecimal(value)`: a comma as the decimal mark, dots as grouping.
    static func commaDecimal(_ value: String) -> Double {
        var text = withoutSpaces(value)
        if text.contains(",") {
            text = text.replacingOccurrences(of: ".", with: "")
            if let comma = text.range(of: ",") { text.replaceSubrange(comma, with: ".") }
        }
        return decimal(text)
    }

    /// `parseAmountField(raw)`: either convention, currency symbols, a sign or parentheses.
    static func amount(_ raw: String) -> Double {
        var text = trim(raw)
        if text.isEmpty { return .nan }
        text = withoutSpaces(text)
        text = String(String.UnicodeScalarView(text.unicodeScalars.filter { !"$€£¥".unicodeScalars.contains($0) }))
        var all = units(text)
        var negative = false
        if all.first == 0x28, all.last == 0x29 {
            negative = true
            all = all.count >= 2 ? Array(all[1..<(all.count - 1)]) : []
        }
        if all.first == 0x2D {
            negative.toggle()
            all.removeFirst()
        } else if all.first == 0x2B {
            all.removeFirst()
        }
        let comma: UInt16 = 0x2C
        let dot: UInt16 = 0x2E
        let lastComma = all.lastIndex(of: comma)
        let lastDot = all.lastIndex(of: dot)
        func replacingFirstComma(_ source: Units) -> Units {
            var out = source
            if let index = out.firstIndex(of: comma) { out[index] = dot }
            return out
        }
        if let lastComma, let lastDot {
            all = lastComma > lastDot ? replacingFirstComma(all.filter { $0 != dot }) : all.filter { $0 != comma }
        } else if let lastComma {
            let tail = all.count - lastComma - 1
            all = tail == 3 && all.firstIndex(of: comma) != lastComma ? all.filter { $0 != comma } : replacingFirstComma(all)
        }
        let value = decimal(BankImportText.text(all))
        if value.isNaN { return .nan }
        return negative ? -value : value
    }

    enum NumberFormat: String, Sendable { case auto, decimalDot = "decimal_dot", decimalComma = "decimal_comma" }

    /// `normalizeCsvNumberFormat(value)`; nil is an absent setting.
    static func numberFormat(_ value: JSValue?) throws -> NumberFormat {
        guard let value else { return .auto }
        guard case .string(let name) = value, let format = NumberFormat(rawValue: name) else {
            throw StatementImportError.validation("number_format must be auto, decimal_dot or decimal_comma")
        }
        return format
    }

    /// `parseCustomAmount(raw, format, context)`: no guessing between grouping and decimals;
    /// a cell that reads differently both ways is refused under `auto`.
    static func customAmount(_ raw: String, _ format: NumberFormat, rowNumber: Int? = nil, column: String? = nil) throws
        -> Double
    {
        switch format {
        case .decimalDot: return IbkrStatementNumber.customAmount(raw, .decimalDot)
        case .decimalComma: return IbkrStatementNumber.customAmount(raw, .decimalComma)
        case .auto: break
        }
        var scalars = String.UnicodeScalarView()
        for scalar in trim(raw).unicodeScalars
        where !JavaScriptWhitespace.contains(scalar) && !"$€£¥".unicodeScalars.contains(scalar) {
            scalars.append(scalar)
        }
        var mantissa = Substring(String(scalars))
        if mantissa.isEmpty { return .nan }
        if mantissa.hasPrefix("("), mantissa.hasSuffix(")") { mantissa = mantissa.dropFirst().dropLast() }
        if mantissa.hasPrefix("-") || mantissa.hasPrefix("+") { mantissa = mantissa.dropFirst() }
        if let mark = mantissa.lastIndex(where: { $0 == "e" || $0 == "E" }) {
            var digits = mantissa[mantissa.index(after: mark)...]
            if digits.hasPrefix("+") || digits.hasPrefix("-") { digits = digits.dropFirst() }
            if ImportInterop.isASCIIDigits(digits) { mantissa = mantissa[..<mark] }
        }
        let validDot = IbkrStatementNumber.isGroupedNumber(mantissa, grouping: ",", point: ".")
        let validComma = IbkrStatementNumber.isGroupedNumber(mantissa, grouping: ".", point: ",")
        if validDot, validComma {
            let dotText = String(mantissa.filter { $0 != "," })
            var commaText = String(mantissa.filter { $0 != "." })
            if let comma = commaText.firstIndex(of: ",") { commaText.replaceSubrange(comma...comma, with: ".") }
            if let dot = try? DecimalJS(dotText), let comma = try? DecimalJS(commaText), !dot.eq(comma) {
                let row = rowNumber.map { " at CSV data row \($0)" } ?? ""
                let name = column.map { ", column \"\($0)\"" } ?? ""
                throw StatementImportError.validation(
                    "Ambiguous number\(row)\(name). Select decimal_dot or decimal_comma number_format.")
            }
        }
        let dot = IbkrStatementNumber.customAmount(raw, .decimalDot)
        return dot.isFinite ? dot : IbkrStatementNumber.customAmount(raw, .decimalComma)
    }

    /// `normalizeIsoCurrency(value)`.
    static func isoCurrency(_ value: String?) -> String? {
        let code = JavaScriptCase.uppercased(trim(value ?? ""))
        let all = units(code)
        return all.count == 3 && all.allSatisfy { $0 >= 0x41 && $0 <= 0x5A } ? code : nil
    }

    // MARK: Dates

    /// `Date.UTC(year, month - 1, day)` as a day number when the three parts name that very
    /// day (the round-trip check of `parseDayMonthYear`); years 0...99 never do.
    static func exactDay(year: Double, month: Double, day: Double) -> Int? {
        guard year.isFinite, month.isFinite, day.isFinite, abs(year) <= 275_760, !(0...99).contains(year),
            (1...12).contains(month), day >= 1, day <= 31
        else { return nil }
        let y = Int(year)
        let m = Int(month)
        let d = Int(day)
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        guard d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] else { return nil }
        let number = ImportInterop.daysFromCivil(year: y, month: m, day: d)
        return number.magnitude <= 100_000_000 ? number : nil
    }

    /// `parseDayMonthYear(text)`: `DD/MM/YYYY`.
    static func dayMonthYear(_ text: String) -> Int? {
        let parts = text.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3 else { return nil }
        return exactDay(year: parseInt(parts[2]), month: parseInt(parts[1]), day: parseInt(parts[0]))
    }

    /// `parseDateFlexibleUtc(text)` for text that starts with `YYYY-MM-DD`. Any other shape
    /// goes to the JavaScript engine's own date parser in the TypeScript, whose answer
    /// depends on the engine and on the machine's time zone; here it is no date.
    static func flexibleDay(_ value: String?) -> Int? {
        let all = units(trim(value ?? ""))
        guard all.count >= 10, all[4] == 0x2D, all[7] == 0x2D,
            (all[0..<4] + all[5..<7] + all[8..<10]).allSatisfy(isDigit),
            all.count == 10 || all[10] == 0x54 || isSpace(all[10])
        else { return nil }
        func number(_ range: Range<Int>) -> Int { Int(text(all[range])) ?? 0 }
        // Date.UTC: a year below 100 is in the 1900s, and month and day roll over.
        var year = number(0..<4)
        if year < 100 { year += 1900 }
        let monthIndex = number(5..<7) - 1
        year += CalendarDays.floorDivide(monthIndex, 12)
        let month = monthIndex - CalendarDays.floorDivide(monthIndex, 12) * 12 + 1
        return ImportInterop.daysFromCivil(year: year, month: month, day: 1) + number(8..<10) - 1
    }

    static let supportedDateFormats = ["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y-%m-%d %H:%M:%S"]

    /// `parseDateWithFormat(text, format)`.
    static func day(_ value: String, format: String) -> Int? {
        func build(_ parts: [String], year: Int, month: Int, day: Int) -> Int? {
            guard parts.count > max(year, month, day) else { return nil }
            let y = parseInt(parts[year])
            guard y.isFinite, y >= 100 else { return nil }
            return exactDay(year: y, month: parseInt(parts[month]), day: parseInt(parts[day]))
        }
        func split(_ text: String, _ separator: Character) -> [String] {
            text.split(separator: separator, omittingEmptySubsequences: false).map(String.init)
        }
        if format.contains("%d/%m/%Y") { return build(split(value, "/"), year: 2, month: 1, day: 0) }
        if format.contains("%m/%d/%Y") { return build(split(value, "/"), year: 2, month: 0, day: 1) }
        if format.contains("%d-%m-%Y") { return build(split(value, "-"), year: 2, month: 1, day: 0) }
        if format.contains("%Y-%m-%d") {
            return build(split(text(units(value).prefix(10)), "-"), year: 0, month: 1, day: 2)
        }
        return flexibleDay(value)
    }

    // MARK: Names

    /// `normalizeToUppercase(name)`.
    static func uppercase(_ name: String) -> String { name.isEmpty ? name : JavaScriptCase.uppercased(trim(name)) }

    private static let recipientPrefixes = [
        "payment from ", "payment to ", "from ", "to ", "transfer from ", "transfer to ", "sent to ", "received from ",
    ]

    /// `cleanRecipientName(recipient)`: without a leading "Payment to" and the like.
    static func cleanRecipient(_ recipient: String) -> String {
        if recipient.isEmpty { return recipient }
        let cleaned = trim(recipient)
        let lowered = units(JavaScriptCase.lowercased(cleaned))
        for prefix in recipientPrefixes where lowered.starts(with: prefix.utf16) {
            return trim(text(units(cleaned).dropFirst(prefix.utf16.count)))
        }
        return cleaned
    }

    private static let kbcTypes = [
        "GELDOPNEMING", "OVERSCHRIJVING", "DOMICILIËRING", "DOMICILIERING", "AANKOOP", "TERUGBETALING", "STORTING",
        "AFHALING", "BETALING", "RETRO-SEPA", "SEPA", "EUROPESE", "INTERNATIONALE", "CREDITRENTE",
    ]
    private static let kbcSeparators = [" VIA ", " NAAR ", " VAN ", " MET ", " DOOR ", " OP ", " OM "]

    /// `text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()`.
    static func capitalised(_ value: String) -> String {
        guard let first = value.unicodeScalars.first else { return value }
        let rest = JavaScriptCase.lowercased(String(value.unicodeScalars.dropFirst()))
        // `charAt(0)` of a character outside the basic plane is half of it, which has no case.
        return (first.value > 0xFFFF ? String(first) : first.properties.uppercaseMapping) + rest
    }

    /// `cleanKbcRecipientName(recipient)`: the transaction type or the first words of a KBC
    /// description.
    static func cleanKbcRecipient(_ value: String) -> String {
        if value.isEmpty { return value }
        let recipient = trim(value)
        let upper = JavaScriptCase.uppercased(recipient)
        for type in kbcTypes where units(upper).starts(with: type.utf16) { return capitalised(type) }
        for separator in kbcSeparators where upper.contains(separator) {
            // `recipient.split(new RegExp(separator, "i"))[0]`: ASCII letters, either case.
            let all = units(recipient)
            let wanted = Array(separator.utf16)
            var head = all[...]
            if all.count >= wanted.count {
                func upperUnit(_ unit: UInt16) -> UInt16 { unit >= 0x61 && unit <= 0x7A ? unit - 0x20 : unit }
                for start in 0...(all.count - wanted.count) {
                    let matched = zip(all[start...], wanted).allSatisfy { (unit: UInt16, want: UInt16) -> Bool in
                        upperUnit(unit) == want
                    }
                    if matched {
                        head = all[..<start]
                        break
                    }
                }
            }
            return capitalised(trim(text(head)))
        }
        let words = splitOnSpaces(recipient)
        let firstWord = words.first.flatMap { $0.isEmpty ? nil : $0 } ?? recipient
        if firstWord.utf16.count > 3 { return capitalised(firstWord) }
        return capitalised(words.prefix(3).joined(separator: " "))
    }

    /// `canonicalIban(value)`.
    static func canonicalIBAN(_ value: String) -> String { JavaScriptCase.uppercased(withoutSpaces(value)) }

    /// `buildOptionalComment(parts)`.
    static func comment(_ parts: [String]) -> String? { parts.isEmpty ? nil : parts.joined(separator: " | ") }
}

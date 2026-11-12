import Foundation

/// One cell of a workbook sheet, as `readXlsxWorkbook` of `packages/shared-utils` types it.
enum XLSXCell: Equatable, Sendable {
    case text(String)
    /// A number as the file writes it, never passed through a floating-point value.
    case number(raw: String)
    case boolean(Bool)
    /// Milliseconds since 1970-01-01T00:00Z; NaN is JavaScript's invalid date.
    case date(Double)
}

struct XLSXSheet: Equatable, Sendable {
    var name: String
    /// A rectangular grid; `nil` is an empty cell.
    var rows: [[XLSXCell?]]
}

/// The XLSX reader of `packages/shared-utils/src/xlsx` (ADR-245): the XML parts of the ZIP
/// archive, then every sheet in workbook order with strings, raw number text, dates by number
/// format, and booleans. Any failure is `Unreadable`; callers word their own message.
enum XLSXWorkbook {
    typealias Units = XLSXMarkup.Units

    struct Unreadable: Error, Equatable, Sendable {
        let reason: String
    }

    private static func units(_ text: String) -> Units { Array(text.utf16) }
    private static func text(_ units: Units) -> String { String(decoding: units, as: UTF16.self) }
    private static func number(_ units: Units) -> Double { JavaScriptNumber.fromString(text(units)) }
    private static func nonZero(_ value: Double?) -> Bool { value.map { $0 != 0 && !$0.isNaN } ?? false }

    /// A whole non-negative index into an array of `count`, or nil (`array[number]` is undefined).
    private static func index(_ value: Double, in count: Int) -> Int? {
        value >= 0 && value < Double(count) && value == value.rounded(.towardZero) ? Int(value) : nil
    }

    // MARK: ZIP

    private static func u16(_ bytes: [UInt8], _ at: Int) throws -> Int {
        guard at >= 0, at + 2 <= bytes.count else { throw Unreadable(reason: "offset outside the archive") }
        return Int(bytes[at]) | Int(bytes[at + 1]) << 8
    }

    private static func u32(_ bytes: [UInt8], _ at: Int) throws -> Int {
        try u16(bytes, at) | (try u16(bytes, at + 2)) << 16
    }

    /// `TextDecoder("utf-8").decode`: ill-formed bytes become U+FFFD and a leading byte order
    /// mark is dropped.
    static func decodeUTF8(_ bytes: some Collection<UInt8>, keepingByteOrderMark: Bool = false) -> Units {
        let decoded = Array(String(decoding: bytes, as: UTF8.self).utf16)
        return !keepingByteOrderMark && decoded.first == 0xFEFF ? Array(decoded.dropFirst()) : decoded
    }

    /// `readZipXmlParts(bytes)`: the `*.xml` and `*.xml.rels` entries by name; a later entry of
    /// the same name replaces an earlier one.
    static func xmlParts(_ bytes: [UInt8]) throws -> [Units: [UInt8]] {
        var end = -1
        var offset = bytes.count - 22
        while offset >= max(0, bytes.count - 65557) {
            if try u32(bytes, offset) == 0x0605_4b50 {
                end = offset
                break
            }
            offset -= 1
        }
        guard end >= 0 else { throw Unreadable(reason: "no end of central directory") }
        let count = try u16(bytes, end + 10)
        offset = try u32(bytes, end + 16)
        var parts: [Units: [UInt8]] = [:]
        for _ in 0..<count {
            guard offset + 46 <= bytes.count, try u32(bytes, offset) == 0x0201_4b50 else {
                throw Unreadable(reason: "bad central directory")
            }
            let flags = try u16(bytes, offset + 8)
            let method = try u16(bytes, offset + 10)
            let compressedSize = try u32(bytes, offset + 20)
            let nameLength = try u16(bytes, offset + 28)
            let localOffset = try u32(bytes, offset + 42)
            let name = decodeUTF8(bytes[min(offset + 46, bytes.count)..<min(offset + 46 + nameLength, bytes.count)])
            offset += 46 + nameLength + (try u16(bytes, offset + 30)) + (try u16(bytes, offset + 32))
            func ends(_ suffix: String) -> Bool { name.reversed().starts(with: suffix.utf16.reversed()) }
            if !ends(".xml") && !ends(".xml.rels") { continue }
            guard flags & 1 == 0 else { throw Unreadable(reason: "encrypted entry") }
            guard localOffset + 30 <= bytes.count, try u32(bytes, localOffset) == 0x0403_4b50 else {
                throw Unreadable(reason: "bad local header")
            }
            let dataStart = localOffset + 30 + (try u16(bytes, localOffset + 26)) + (try u16(bytes, localOffset + 28))
            guard dataStart + compressedSize <= bytes.count else { throw Unreadable(reason: "entry out of bounds") }
            let data = Array(bytes[dataStart..<(dataStart + compressedSize)])
            switch method {
            case 0: parts[name] = data
            case 8:
                // A `DecompressionStream` refuses bytes after the end of the stream.
                guard let inflated = try? RawInflate.inflate(data), inflated.consumed == data.count else {
                    throw Unreadable(reason: "damaged entry")
                }
                parts[name] = inflated.bytes
            default: throw Unreadable(reason: "unsupported method \(method)")
            }
        }
        return parts
    }

    // MARK: Number formats

    private static let builtInDateFormats: Set<Double> = [
        14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55,
        56, 57, 58, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
    ]
    private static let dateTokens: Set<String> = [
        "s", "ss", "m", "mm", "h", "hh", "am", "pm", "a", "p", "d", "dd", "ddd", "dddd", "aaa", "aaaa", "aaaaa", "mmm",
        "mmmm", "mmmmm", "y", "yy", "yyyy", "e", "ee", "eeee",
    ]

    private static func isClockLetter(_ unit: UInt16) -> Bool { unit == 115 || unit == 109 || unit == 104 || unit == 100 }

    /// Replaces every leftmost match, like a global `String.replace`; `match` answers the end
    /// of a match at a position and its replacement.
    private static func replacing(_ text: Units, _ match: (Units, Int) -> (end: Int, with: Units)?) -> Units {
        var out: Units = []
        var position = 0
        while position < text.count {
            if let found = match(text, position), found.end > position {
                out += found.with
                position = found.end
            } else {
                out.append(text[position])
                position += 1
            }
        }
        return out
    }

    /// `/(\[?[smhd]{1,2}\]?)[.,]00?0?/` at one position: the group and the end of the match.
    private static func fractionalClock(_ s: Units, _ p: Int) -> (end: Int, with: Units)? {
        func at(_ index: Int) -> UInt16 { index < s.count ? s[index] : 0 }
        for open in at(p) == 91 ? [1, 0] : [0] {
            for letters in [2, 1] {
                let start = p + open
                guard (start..<(start + letters)).allSatisfy({ isClockLetter(at($0)) }) else { continue }
                let afterLetters = start + letters
                for close in at(afterLetters) == 93 ? [1, 0] : [0] {
                    let separator = afterLetters + close
                    guard at(separator) == 46 || at(separator) == 44, at(separator + 1) == 48 else { continue }
                    var end = separator + 2
                    if at(end) == 48 { end += 1 }
                    if at(end) == 48 { end += 1 }
                    return (end, Array(s[p..<separator]))
                }
            }
        }
        return nil
    }

    /// `isDateFormatTemplate(format)`: read-excel-file's guess whether a custom number format
    /// shows a date.
    static func isDateFormat(_ format: Units) -> Bool {
        var template = units(JavaScriptCase.lowercased(text(format)))
        if template.suffix(2).elementsEqual([59, 64]) { template.removeLast(2) }
        template = replacing(template) { s, p in
            guard s[p] == 92, p + 1 < s.count, ![0x0A, 0x0D, 0x2028, 0x2029].contains(s[p + 1]) else { return nil }
            return (p + 2, [32])
        }
        var sections: [Units] = [[]]
        for unit in template {
            if unit == 59 { sections.append([]) } else { sections[sections.count - 1].append(unit) }
        }
        return sections.contains { section in
            var s = replacing(section) { s, p in
                guard s[p] == 34, let close = s[(p + 1)...].firstIndex(of: 34) else { return nil }
                return (close + 1, [32])
            }
            s = replacing(s, fractionalClock)
            s = replacing(s) { s, p in
                guard s[p] == 91 else { return nil }
                for letters in [2, 1] {
                    let end = p + 1 + letters
                    if end < s.count, s[(p + 1)..<end].allSatisfy(isClockLetter), s[end] == 93 {
                        return (end + 1, Array(s[(p + 1)..<end]))
                    }
                }
                return nil
            }
            s = replacing(s) { s, p in
                guard s[p] == 91, let close = s[(p + 1)...].firstIndex(of: 93) else { return nil }
                return (close + 1, [])
            }
            var tokens: [String] = []
            var token: Units = []
            for unit in s + [32] {
                if (unit >= 97 && unit <= 122) || unit == 48 || unit == 35 || unit == 63 || unit == 37 {
                    token.append(unit)
                } else if !token.isEmpty {
                    tokens.append(text(token))
                    token = []
                }
            }
            return !tokens.isEmpty && tokens.allSatisfy(dateTokens.contains)
        }
    }

    /// `new Date(excelSerialToTime(serial, epoch1904))`: a serial day number as milliseconds.
    static func serialTime(_ serial: Double, epoch1904: Bool) -> Double {
        let adjusted = epoch1904 ? serial + Double((1904 - 1900) * 365 + 1 + 1) : serial
        return timeClip(((adjusted - Double(1 + 1 + (1970 - 1900) * 365 + 17)) * 86_400_000).rounded(.down))
    }

    /// The time value of `new Date(number)`.
    static func timeClip(_ time: Double) -> Double {
        guard time.isFinite, abs(time) <= 8.64e15 else { return .nan }
        return time.rounded(.towardZero) + 0
    }

    /// The calendar date of a day number (days since 1970-01-01).
    static func civil(fromDays days: Int) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let shifted = (5 * dayOfYear + 2) / 153
        let month = shifted < 10 ? shifted + 3 : shifted - 9
        return (yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, dayOfYear - (153 * shifted + 2) / 5 + 1)
    }

    static func days(fromCivil year: Int, _ month: Int, _ day: Int) -> Int { daysFromCivil(year, month, day) }

    private static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        return era * 146_097 + yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear - 719_468
    }

    /// `new Date(text)` for the ISO 8601 forms of the language standard (`YYYY`, `YYYY-MM`,
    /// `YYYY-MM-DD`, each optionally with `THH:mm[:ss[.fff]]` and `Z` or `±HH:mm`). A date and
    /// time without an offset is local time. `nil` is any other text: the TypeScript hands that
    /// to the engine's own parser, whose answer this backend does not reproduce.
    static func isoTime(_ value: String) -> Double? {
        let s = Array(value.utf8)
        var p = 0
        func digits(_ count: Int) -> Int? {
            guard p + count <= s.count, s[p..<(p + count)].allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
            defer { p += count }
            return s[p..<(p + count)].reduce(0) { $0 * 10 + Int($1) - 48 }
        }
        func take(_ byte: UInt8) -> Bool {
            guard p < s.count, s[p] == byte else { return false }
            p += 1
            return true
        }
        var year: Int
        if p < s.count, s[p] == 43 || s[p] == 45 {
            let negative = s[p] == 45
            p += 1
            guard let extended = digits(6), !(negative && extended == 0) else { return nil }
            year = negative ? -extended : extended
        } else {
            guard let plain = digits(4) else { return nil }
            year = plain
        }
        var month = 1
        var day = 1
        if take(45) {
            guard let m = digits(2) else { return nil }
            month = m
            if take(45) {
                guard let d = digits(2) else { return nil }
                day = d
            }
        }
        var hour = 0
        var minute = 0
        var second = 0
        var millisecond = 0
        var offsetMinutes: Int?
        var hasTime = false
        if take(84) {
            hasTime = true
            guard let h = digits(2), take(58), let m = digits(2) else { return nil }
            hour = h
            minute = m
            if take(58) {
                guard let sec = digits(2) else { return nil }
                second = sec
                if take(46) {
                    let start = p
                    while p < s.count, s[p] >= 48, s[p] <= 57 { p += 1 }
                    guard p > start else { return nil }
                    let fraction = Array(s[start..<p].prefix(3))
                    millisecond = fraction.reduce(0) { $0 * 10 + Int($1) - 48 }
                    for _ in fraction.count..<3 { millisecond *= 10 }
                }
            }
            if take(90) {
                offsetMinutes = 0
            } else if p < s.count, s[p] == 43 || s[p] == 45 {
                let negative = s[p] == 45
                p += 1
                guard let h = digits(2), take(58), let m = digits(2), h < 24, m < 60 else { return nil }
                offsetMinutes = (negative ? -1 : 1) * (h * 60 + m)
            }
        }
        // The engine takes any day up to 31 and counts on from the first of the month.
        guard p == s.count, (1...12).contains(month), (1...31).contains(day), minute < 60, second < 60,
            hour < 24 || (hour == 24 && minute == 0 && second == 0 && millisecond == 0)
        else { return nil }
        let wall =
            Double(daysFromCivil(year, month, 1) + day - 1) * 86_400_000
            + Double(hour * 3_600_000 + minute * 60_000 + second * 1000 + millisecond)
        if let offsetMinutes { return timeClip(wall - Double(offsetMinutes) * 60_000) }
        guard hasTime else { return timeClip(wall) }
        // Local time: the offset in force at that wall-clock moment.
        let zone = TimeZone.current
        let guess = Date(timeIntervalSince1970: wall / 1000)
        let first = Double(zone.secondsFromGMT(for: guess))
        let offset = Double(zone.secondsFromGMT(for: Date(timeIntervalSince1970: wall / 1000 - first)))
        return timeClip(wall - offset * 1000)
    }

    // MARK: Parts

    private struct NumberFormat {
        var id: Double
        var template: Units?
    }

    private struct CellStyle {
        var numberFormat: NumberFormat?
        var baseIndex: Double?
    }

    private struct Context {
        var sharedStrings: [Units] = []
        var styles: [CellStyle] = []
        var epoch1904 = false
        var trim = true
        var dateFormats: [String: Bool] = [:]
    }

    private static func key(_ id: Double) -> String { JavaScriptNumber.text(id) }

    private static let relationshipBases = [
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/",
    ].map(units)

    private static func relationTarget(_ target: Units) -> Units {
        target.first == 47 ? Array(target.dropFirst()) : units("xl/") + target
    }

    private struct Relationships {
        var sheets: [Units: Units] = [:]
        var sharedStrings: Units?
        var styles: Units?
    }

    private static func relationships(_ xml: Units) throws -> Relationships {
        var found = Relationships()
        var handlers = XLSXMarkup.Handlers()
        handlers.open = { name, attributes in
            guard name == units("Relationship"), let type = attributes["Type"],
                let base = relationshipBases.first(where: { type.starts(with: $0) })
            else { return }
            let kind = Array(type.dropFirst(base.count))
            guard [units("styles"), units("sharedStrings"), units("worksheet")].contains(kind) else { return }
            guard let target = attributes["Target"] else { throw Unreadable(reason: "relationship without a target") }
            if kind == units("styles") {
                found.styles = relationTarget(target)
            } else if kind == units("sharedStrings") {
                found.sharedStrings = relationTarget(target)
            } else {
                // `String(attributes.Id)`: a missing id is the text "undefined".
                found.sheets[attributes["Id"] ?? units("undefined")] = relationTarget(target)
            }
        }
        try XLSXMarkup.parse(xml, handlers)
        return found
    }

    private static func workbookInfo(_ xml: Units) throws -> (epoch1904: Bool, sheets: [(name: Units, relation: Units?)]) {
        var epoch1904: Bool?
        var sheets: [(name: Units, relation: Units?)] = []
        var handlers = XLSXMarkup.Handlers()
        handlers.open = { name, attributes in
            if name == units("workbookPr") {
                if epoch1904 == nil { epoch1904 = attributes["date1904"] == units("1") }
            } else if name == units("sheet"), let sheet = attributes.filled("name") {
                sheets.append((sheet, attributes["id"]))
            }
        }
        try XLSXMarkup.parse(xml, handlers)
        return (epoch1904 ?? false, sheets)
    }

    /// Whether a `<t>`, `<r>` or `<rPh>` element is open, for shared and inline strings.
    private struct TextState {
        var t = false
        var r = false
        var rPh = false

        mutating func set(_ name: Units, _ value: Bool) -> Bool {
            if name == [116] { t = value } else if name == [114] { r = value } else if name == [114, 80, 104] { rPh = value } else {
                return false
            }
            return true
        }
    }

    private static func sharedStrings(_ xml: Units) throws -> [Units] {
        var strings: [Units] = []
        var item: (state: TextState, text: Units)?
        var handlers = XLSXMarkup.Handlers()
        handlers.open = { name, _ in
            if name == units("si") { item = (TextState(), []) } else if item != nil { _ = item?.state.set(name, true) }
        }
        handlers.close = { name in
            if name == units("si") {
                strings.append(item?.text ?? [])
                item = nil
            } else if item != nil {
                _ = item?.state.set(name, false)
            }
        }
        handlers.text = { text in
            guard let current = item, !current.state.rPh, current.state.t else { return }
            item?.text = current.state.r ? current.text + text : text
        }
        try XLSXMarkup.parse(xml, handlers)
        return strings
    }

    private static func styles(_ xml: Units) throws -> [CellStyle] {
        var formats: [String: NumberFormat] = [:]
        var base: [CellStyle] = []
        var cells: [CellStyle] = []
        var inBase = false
        var inCell = false
        func style(_ attributes: XLSXMarkup.Attributes, known: Bool) -> CellStyle {
            guard let text = attributes.filled("numFmtId") else { return CellStyle() }
            let id = number(text)
            return CellStyle(numberFormat: (known ? formats[key(id)] : nil) ?? NumberFormat(id: id))
        }
        var handlers = XLSXMarkup.Handlers()
        handlers.open = { name, attributes in
            if name == units("numFmt") {
                // `Number(undefined)` is NaN.
                let id = attributes["numFmtId"].map(number) ?? .nan
                formats[key(id)] = NumberFormat(id: id, template: id >= 100 ? attributes["formatCode"] : nil)
            } else if name == units("cellStyleXfs") {
                inBase = true
            } else if name == units("cellXfs") {
                inCell = true
            } else if name == units("xf") {
                if inBase {
                    base.append(style(attributes, known: false))
                } else if inCell {
                    var own = style(attributes, known: true)
                    if let reference = attributes.filled("xfId") { own.baseIndex = number(reference) }
                    cells.append(own)
                }
            }
        }
        handlers.close = { name in
            if name == units("cellStyleXfs") { inBase = false } else if name == units("cellXfs") { inCell = false }
        }
        try XLSXMarkup.parse(xml, handlers)
        return cells.map { own in
            guard let reference = own.baseIndex, nonZero(reference), own.numberFormat == nil,
                let position = index(reference, in: base.count)
            else { return own }
            return CellStyle(numberFormat: base[position].numberFormat, baseIndex: reference)
        }
    }

    private static func isDate(_ style: CellStyle, _ context: inout Context) -> Bool {
        guard let format = style.numberFormat else { return false }
        if builtInDateFormats.contains(format.id) { return true }
        guard let template = format.template, !template.isEmpty else { return false }
        if let cached = context.dateFormats[key(format.id)] { return cached }
        let answer = isDateFormat(template)
        context.dateFormats[key(format.id)] = answer
        return answer
    }

    // MARK: Cells

    private enum Parsed {
        case missing
        case failed(String)
        case string(Units)
        case number(Units)
        case date(Double)
        case boolean(Bool)
        case empty
    }

    private static func parseCell(type: Units, style: Units?, v: Units?, inline: Units?, _ context: inout Context) -> Parsed {
        let filled = v.flatMap { $0.isEmpty ? nil : $0 }
        switch text(type) {
        case "str":
            guard let v else { return .missing }
            return v.isEmpty ? .empty : .string(v)
        case "inlineStr": return inline.map(Parsed.string) ?? .missing
        case "s":
            guard let filled else { return .missing }
            return index(number(filled), in: context.sharedStrings.count).map { .string(context.sharedStrings[$0]) }
                ?? .failed("VALUE_INVALID")
        case "b":
            guard let filled else { return .missing }
            return filled == [49] ? .boolean(true) : filled == [48] ? .boolean(false) : .failed("VALUE_INVALID")
        case "e": return .empty
        case "d":
            guard let filled else { return .empty }
            // Text outside the standard forms goes to the engine's own parser in the TypeScript.
            guard let time = isoTime(text(filled)), !time.isNaN else { return .failed("VALUE_INVALID") }
            return .date(time)
        case "n":
            guard let filled else { return .empty }
            if let style, !style.isEmpty {
                guard let found = index(number(style), in: context.styles.count) else { return .failed("FORMAT_INVALID") }
                if isDate(context.styles[found], &context) {
                    let serial = number(filled)
                    return serial.isNaN ? .failed("VALUE_INVALID") : .date(serialTime(serial, epoch1904: context.epoch1904))
                }
            }
            return .number(filled)
        default: return .failed("TYPE_INVALID")
        }
    }

    /// `cellValue(...)`: the value after the repair and trim rules; `.some(nil)` is an empty cell.
    private static func cellValue(
        _ attributes: XLSXMarkup.Attributes, v: Units?, inline: Units?, _ context: inout Context
    ) throws -> XLSXCell? {
        let declared = attributes["t"] ?? []
        let type = declared.isEmpty ? [110] : declared
        var parsed = parseCell(type: type, style: attributes["s"], v: v, inline: inline, &context)
        if declared == [101] { parsed = .empty }
        switch parsed {
        // A missing value is an empty cell for the four types that can miss one.
        case .missing, .empty: return nil
        case .failed(let reason): throw Unreadable(reason: reason)
        case .string(let value):
            let string = context.trim ? JavaScriptWhitespace.trim(text(value)) : text(value)
            return value.isEmpty || string.isEmpty ? nil : .text(string)
        case .number(let raw): return .number(raw: text(raw))
        case .date(let time): return .date(time)
        case .boolean(let value): return .boolean(value)
        }
    }

    /// "B12" → (12, 2); letters are not validated, as in read-excel-file.
    private static func address(_ value: Units?) throws -> (row: Double, column: Double) {
        guard let value else { throw Unreadable(reason: "cell without an address") }
        var column = 0.0
        for (position, unit) in value.enumerated() {
            if unit >= 48 && unit <= 57 {
                let row = number(Array(value[position...]))
                if row.isNaN { break }
                return (row, column)
            }
            column = column * 26 + Double(unit) - 64
        }
        throw Unreadable(reason: "cell address")
    }

    /// Rows and columns past this are refused: the TypeScript would build them all in memory.
    private static let gridLimit = 4_000_000.0

    private struct CellState {
        var attributes: XLSXMarkup.Attributes
        var v = false
        var inlineOpen = false
        var text = TextState()
        var vText: Units?
        var inline: Units?
    }

    private struct SheetData {
        var rows: [[XLSXCell?]] = []
        var row: [XLSXCell?]?
        var rowNumber: Double?
        var cell: CellState?
        var cursor = (row: 0.0, column: 0.0)
        var rowCount = 0.0
        var dataRowCount: Double? = 0
        var dataColumnCount = 0.0
    }

    private static func sheet(_ xml: Units, _ context: inout Context) throws -> [[XLSXCell?]] {
        var data: SheetData?
        var local = context
        var handlers = XLSXMarkup.Handlers()
        handlers.open = { name, attributes in
            if name == units("dimension") {
                guard let reference = attributes["ref"] else { throw Unreadable(reason: "dimension") }
                var part: Units = []
                for unit in reference + [58] {
                    if unit == 58 {
                        _ = try address(part)
                        part = []
                    } else {
                        part.append(unit)
                    }
                }
            } else if name == units("sheetData") {
                data = SheetData()
            } else if data != nil {
                if name == units("row") {
                    if let r = attributes.filled("r") { data?.rowNumber = number(r) }
                    data?.row = []
                } else if name == [99] {
                    data?.cell = CellState(attributes: attributes)
                } else if data?.cell != nil {
                    if name == [118] {
                        data?.cell?.v = true
                    } else if name == units("is") {
                        data?.cell?.inlineOpen = true
                        data?.cell?.inline = []
                    } else {
                        _ = data?.cell?.text.set(name, true)
                    }
                }
            }
        }
        handlers.close = { name in
            guard var current = data else { return }
            defer { data = current }
            if name == units("row") {
                if let rowNumber = current.rowNumber, nonZero(rowNumber) {
                    guard rowNumber > Double(current.rows.count) else { throw Unreadable(reason: "out-of-place row") }
                    guard rowNumber <= gridLimit else { throw Unreadable(reason: "row number") }
                    while rowNumber > Double(current.rows.count + 1) { current.rows.append([]) }
                }
                guard let row = current.row else { throw Unreadable(reason: "row") }
                current.rows.append(row)
                if !row.isEmpty { current.dataRowCount = current.rowNumber }
                if let rowNumber = current.rowNumber, rowNumber > current.rowCount { current.rowCount = rowNumber }
                current.row = nil
                current.rowNumber = nil
            } else if name == [99] {
                guard let cell = current.cell else { throw Unreadable(reason: "cell") }
                let (row, column) = try address(cell.attributes["r"])
                let value: Result<XLSXCell?, any Error> = Result {
                    try cellValue(cell.attributes, v: cell.vText, inline: cell.inline, &local)
                }
                if row < current.cursor.row || (row == current.cursor.row && column <= current.cursor.column) {
                    throw Unreadable(reason: "out-of-place cell")
                }
                current.cursor = (row, column)
                if !nonZero(current.rowNumber) { current.rowNumber = row }
                if let filled = try value.get() {
                    guard column <= gridLimit, var target = current.row else { throw Unreadable(reason: "cell position") }
                    while column > Double(target.count + 1) { target.append(nil) }
                    target.append(filled)
                    current.row = target
                    if column > current.dataColumnCount { current.dataColumnCount = column }
                }
                current.cell = nil
            } else if current.cell != nil {
                if name == [118] {
                    current.cell?.v = false
                    if (current.cell?.vText ?? []).isEmpty { current.cell?.vText = [] }
                } else if name == units("is") {
                    current.cell?.inlineOpen = false
                } else {
                    _ = current.cell?.text.set(name, false)
                }
            }
        }
        handlers.text = { text in
            guard let cell = data?.cell else { return }
            if cell.v {
                data?.cell?.vText = text
            } else if cell.inlineOpen, !cell.text.rPh, cell.text.t {
                data?.cell?.inline = cell.text.r ? (cell.inline ?? []) + text : text
            }
        }
        try XLSXMarkup.parse(xml, handlers)
        context = local
        guard let data else { throw Unreadable(reason: "Worksheet has no <sheetData>") }
        var rows = data.rows
        // `undefined < n` is false: a data row without a number keeps every row.
        if let dataRows = data.dataRowCount, dataRows < data.rowCount {
            rows = Array(rows.prefix(Int(max(0, dataRows.rounded(.towardZero)))))
        }
        let width = data.dataColumnCount
        return rows.map { row in
            var trimmed = Double(row.count) > width ? Array(row.prefix(Int(width.rounded(.towardZero)))) : row
            while Double(trimmed.count) < width { trimmed.append(nil) }
            return trimmed
        }
    }

    /// `readXlsxWorkbook(bytes, { trim, parseNumber })` with the raw number text kept.
    static func read(_ bytes: [UInt8], trim: Bool = true) throws -> [XLSXSheet] {
        do {
            let parts = try xmlParts(bytes)
            func part(_ name: Units) -> Units? { parts[name].map { decodeUTF8($0) } }
            func required(_ name: Units) throws -> Units {
                guard let content = part(name) else { throw Unreadable(reason: "\(text(name)) not found") }
                return content
            }
            let related = try relationships(try required(units("xl/_rels/workbook.xml.rels")))
            let info = try workbookInfo(try required(units("xl/workbook.xml")))
            var context = Context()
            context.trim = trim
            context.epoch1904 = info.epoch1904
            if let xml = part(related.sharedStrings ?? units("xl/sharedStrings.xml")) {
                context.sharedStrings = try sharedStrings(xml)
            }
            if let xml = part(related.styles ?? units("xl/styles.xml")) { context.styles = try styles(xml) }
            guard !info.sheets.isEmpty else { throw Unreadable(reason: "Workbook has no sheets") }
            var sheets: [XLSXSheet] = []
            for entry in info.sheets {
                guard let relation = entry.relation, let path = related.sheets[relation] else {
                    throw Unreadable(reason: "sheet without a worksheet part")
                }
                // Sheets sharing a relationship id all take the first one's name.
                let name = info.sheets.first { $0.relation == relation }?.name ?? entry.name
                sheets.append(XLSXSheet(name: text(name), rows: try sheet(try required(path), &context)))
            }
            return sheets
        } catch let error as XLSXMarkup.Failure {
            throw Unreadable(reason: error.message)
        }
    }
}

/// `readPortfolioWorkbook` and `assertBoundedWorkbook` of `lib/portfolioUpload.ts`.
extension PortfolioUpload {
    static let maxUploadBytes = 50 * 1024 * 1024
    private static let maxWorkbookBytes = 100 * 1024 * 1024
    private static let maxWorkbookEntries = 1000
    private static let maxWorkbookCells = 500_000

    /// `assertBoundedWorkbook(bytes)`: bounds the ZIP inflation before the reader decompresses
    /// XML. Every entry must be stored or deflated, unencrypted, named once, inside the archive
    /// and exactly as long as it declares.
    static func assertBounded(_ bytes: [UInt8]) throws {
        func fail(_ message: String) -> StatementImportError { .validation(message) }
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        guard bytes.count <= maxUploadBytes else { throw fail("File size exceeds maximum of 50MB") }
        var end = -1
        var offset = bytes.count - 22
        while offset >= max(0, bytes.count - 65557) {
            if u32(offset) == 0x0605_4b50, offset + 22 + u16(offset + 20) == bytes.count {
                end = offset
                break
            }
            offset -= 1
        }
        guard end >= 0 else { throw fail("Invalid XLSX workbook archive") }
        let entryCount = u16(end + 10)
        let directorySize = u32(end + 12)
        let directoryOffset = u32(end + 16)
        guard u16(end + 4) == 0, u16(end + 6) == 0, entryCount == u16(end + 8), entryCount <= maxWorkbookEntries,
            directoryOffset + directorySize == end
        else { throw fail("Unsupported XLSX archive layout or size") }
        offset = directoryOffset
        var expanded = 0
        var names: Set<[UInt16]> = []
        for _ in 0..<entryCount {
            guard offset + 46 <= end, u32(offset) == 0x0201_4b50 else { throw fail("Invalid XLSX archive directory") }
            let nameLength = u16(offset + 28)
            let length = 46 + nameLength + u16(offset + 30) + u16(offset + 32)
            let uncompressed = u32(offset + 24)
            let compressed = u32(offset + 20)
            let localOffset = u32(offset + 42)
            let method = u16(offset + 10)
            // `Buffer.toString("utf8")` keeps a byte order mark.
            let name = XLSXWorkbook.decodeUTF8(
                bytes[min(offset + 46, bytes.count)..<min(offset + 46 + nameLength, bytes.count)], keepingByteOrderMark: true)
            expanded += uncompressed
            guard offset + length <= end, expanded <= maxWorkbookBytes, uncompressed != 0xFFFF_FFFF,
                u16(offset + 8) & 1 == 0, !names.contains(name)
            else { throw fail("XLSX workbook exceeds safe limits or contains unsupported entries") }
            names.insert(name)
            guard localOffset + 30 <= directoryOffset, u32(localOffset) == 0x0403_4b50, u16(localOffset + 6) & 1 == 0,
                method == 0 || method == 8, u16(localOffset + 8) == method
            else { throw fail("Unsupported XLSX archive entry") }
            let dataOffset = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28)
            guard dataOffset + compressed <= directoryOffset else { throw fail("Invalid XLSX archive entry bounds") }
            let payload = Array(bytes[dataOffset..<(dataOffset + compressed)])
            let size =
                method == 0 ? payload.count : (try? RawInflate.inflate(payload, limit: max(1, uncompressed)))?.bytes.count
            guard size == uncompressed else { throw fail("XLSX archive entry does not match its declared size") }
            offset += length
        }
        guard offset == end, names.contains(Array("xl/workbook.xml".utf16)),
            names.contains(Array("[Content_Types].xml".utf16))
        else { throw fail("Uploaded archive is not an XLSX workbook") }
    }

    /// `readPortfolioWorkbook(file)`: the bounded workbook with untrimmed strings and raw
    /// number text, and the SHA-256 of the file for each row's provenance.
    static func workbook(_ bytes: [UInt8]) throws -> (sheets: [XLSXSheet], sourceFileHash: String) {
        try assertBounded(bytes)
        guard let sheets = try? XLSXWorkbook.read(bytes, trim: false) else {
            throw StatementImportError.validation("XLSX workbook could not be read safely")
        }
        let cells = sheets.reduce(0) { $0 + $1.rows.reduce(0) { $0 + $1.count } }
        guard cells <= maxWorkbookCells else {
            throw StatementImportError.validation("XLSX workbook contains too many cells")
        }
        return (sheets, SHA256Digest.hex(bytes))
    }
}

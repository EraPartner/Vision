import Foundation

/// A cell of an imported workbook sheet: the value kinds `importAnalysisWorkbook` can return.
enum WorkbookCell: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
}

struct ImportedAnalysisWorkbook: Equatable, Sendable {
    var columns: [String]
    var rows: [[String: WorkbookCell]]
    var formulaCells: Int
}

/// Swift port of packages/shared-utils/src/analysis/workbook.ts: a stored-ZIP, value-only XLSX
/// writer for a captured Analysis result and a bounded reader for the files Vision itself wrote.
/// Formulas are definitions only and never execute.
enum AnalysisWorkbook {
    private static let sheetNames = ["Results", "Assumptions", "Provenance", "Formula definitions", "Summary results"]

    // MARK: Export

    static func exportWorkbook(result: InterchangeJSON, context: InterchangeJSON) throws -> [UInt8] {
        let resultRows = result["rows"]?.arrayValue ?? []
        if resultRows.count > 100_000 { throw AnalysisInterchangeError("Workbook exceeds 100,000 rows") }
        let declared = result["declaredColumns"]?.arrayValue ?? []
        let columns = declared.isEmpty ? (result["columns"]?.arrayValue ?? []) : declared
        let columnIDs = columns.map { $0["id"]?.stringValue }

        let header: [InterchangeJSON?] = columns.map { (column: InterchangeJSON) -> InterchangeJSON? in
            if let label = column.members?.first(where: { $0.key == "label" }) { return label.value }
            return column["id"]
        }
        var results: [[InterchangeJSON?]] = [header]
        for row in resultRows { results.append(columnIDs.map { id in id.flatMap { row[$0] } }) }

        let provenance = provenanceRows(result: result, context: context, columns: columns)
        let assumptions = try assumptionRows(context["assumptions"])
        let formulas = try formulaRows(context["formulas"])
        var summaries: [[InterchangeJSON?]] = [[.string("Identifier"), .string("Value")]]
        for member in result["formulaSummaries"]?.members ?? [] { summaries.append([.string(member.key), member.value]) }

        let sheets = [
            sheet(results, types: columns.map { $0["type"]?.stringValue }),
            sheet(assumptions, types: ["string", "string", "decimal"]),
            sheet([[.string("Property"), .string("Value")]] + provenance, types: []),
            sheet(formulas, types: []),
            sheet(summaries, types: ["string", "decimal"]),
        ]
        let contentTypes = sheetNames.indices.map {
            "<Override PartName=\"/xl/worksheets/sheet\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        }.joined()
        let sheetEntries = sheetNames.enumerated().map {
            "<sheet name=\"\($0.element)\" sheetId=\"\($0.offset + 1)\" r:id=\"rId\($0.offset + 1)\"/>"
        }.joined()
        let relationships = sheetNames.indices.map {
            "<Relationship Id=\"rId\($0 + 1)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet\($0 + 1).xml\"/>"
        }.joined()
        var files: [(String, String)] = [
            (
                "[Content_Types].xml",
                "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\(contentTypes)</Types>"
            ),
            (
                "_rels/.rels",
                "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
            ),
            (
                "xl/workbook.xml",
                "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>\(sheetEntries)</sheets></workbook>"
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\(relationships)<Relationship Id=\"rId\(sheetNames.count + 1)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>"
            ),
            (
                "xl/styles.xml",
                "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/><xf numFmtId=\"14\" fontId=\"0\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"1\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
            ),
        ]
        for (index, xml) in sheets.enumerated() { files.append(("xl/worksheets/sheet\(index + 1).xml", xml)) }
        return zip(files)
    }

    /// `Object.entries({...context, assumptions: undefined, formulas: undefined, requestId, ...})`
    /// without the undefined values, objects (and null) as `JSON.stringify` text.
    private static func provenanceRows(result: InterchangeJSON, context: InterchangeJSON, columns: [InterchangeJSON])
        -> [[InterchangeJSON?]]
    {
        var entries: [(key: String, value: InterchangeJSON?)] = (context.members ?? []).map { ($0.key, $0.value) }
        func set(_ key: String, _ value: InterchangeJSON?) {
            if let index = entries.firstIndex(where: { $0.key == key }) {
                entries[index].value = value
            } else {
                entries.append((key, value))
            }
        }
        set("assumptions", nil)
        set("formulas", nil)
        set("requestId", result["requestId"])
        set("completedAt", result["completedAt"])
        set("window", result["window"])
        set("complete", result["complete"])
        set("financialCoverage", result["coverage"])
        set("transformationCoverage", result["transformationCoverage"])
        set("preparationLineage", result["preparationLineage"])
        set("transformationErrors", result["transformationErrors"])
        set("formulaErrors", result["formulaErrors"])
        set("columns", .array(columns))
        set(
            "precision",
            .string(
                "Numeric values exceeding 15 significant digits are text. Dates use Excel 1900 calendar. Formulas are definitions only and never execute."
            ))
        set("refresh", .string("Static snapshot. Refresh in Vision and export again."))
        return entries.compactMap { entry in
            guard let value = entry.value else { return nil }
            return [.string(entry.key), value.isJSObject ? .string(value.stringified()) : value]
        }
    }

    private static func isTruthy(_ value: InterchangeJSON?) -> Bool {
        switch value {
        case nil, .null?: return false
        case .bool(let flag)?: return flag
        case .number(let number)?: return number != 0 && !number.isNaN
        case .string(let text)?: return !text.isEmpty
        default: return true
        }
    }

    private static func assumptionRows(_ assumptions: InterchangeJSON?) throws -> [[InterchangeJSON?]] {
        var rows: [[InterchangeJSON?]] = [[.string("Identifier"), .string("Label"), .string("Value")]]
        func nullish(_ value: InterchangeJSON?) -> InterchangeJSON? {
            if case .null? = value { return nil }
            return value
        }
        if let definitions = assumptions?["definitions"]?.arrayValue {
            let values = assumptions?["values"]
            for definition in definitions {
                if definition.isNull { throw AnalysisInterchangeError("Invalid assumption definition") }
                let id = definition["id"]
                let valueByID = id?.stringValue.flatMap { values?[$0] }
                rows.append([
                    id, nullish(definition["label"]) ?? id,
                    nullish(valueByID) ?? nullish(definition["defaultValue"]) ?? InterchangeJSON.null,
                ])
            }
        } else if let assumptions, assumptions.members != nil || assumptions.arrayValue != nil {
            if let members = assumptions.members {
                for member in members { rows.append([.string(member.key), .string(member.key), member.value]) }
            } else {
                for (index, item) in (assumptions.arrayValue ?? []).enumerated() {
                    rows.append([.string(String(index)), .string(String(index)), item])
                }
            }
        }
        return rows
    }

    private static func formulaRows(_ formulas: InterchangeJSON?) throws -> [[InterchangeJSON?]] {
        var rows: [[InterchangeJSON?]] = [
            [.string("Identifier"), .string("Label"), .string("Scope"), .string("Expression (text only)"), .string("Unit")]
        ]
        for definition in formulas?.arrayValue ?? [] {
            if definition.isNull { throw AnalysisInterchangeError("Invalid formula definition") }
            let unit = definition["unit"]
            rows.append([
                definition["id"], definition["label"], definition["scope"], definition["expression"],
                isTruthy(unit) ? .string(unit!.stringified()) : .string(""),
            ])
        }
        return rows
    }

    // MARK: Sheet XML

    private static func xmlEscape(_ text: String) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            if scalar.value < 32 && ![9, 10, 13].contains(scalar.value) { continue }
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&apos;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    private static func columnName(_ index: Int) -> String {
        var name = ""
        var n = index + 1
        while n > 0 {
            name = String(UnicodeScalar(UInt8(65 + (n - 1) % 26))) + name
            n = (n - 1) / 26
        }
        return name
    }

    /// `^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$` (case-insensitive).
    private static func looksNumeric(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        var index = 0
        func digits() -> Int {
            var count = 0
            while index < scalars.count, scalars[index].value >= 0x30, scalars[index].value <= 0x39 {
                index += 1
                count += 1
            }
            return count
        }
        if index < scalars.count, scalars[index] == "-" { index += 1 }
        let whole = digits()
        if whole > 0 {
            if index < scalars.count, scalars[index] == "." {
                index += 1
                _ = digits()
            }
        } else {
            guard index < scalars.count, scalars[index] == "." else { return false }
            index += 1
            guard digits() > 0 else { return false }
        }
        if index < scalars.count, scalars[index] == "e" || scalars[index] == "E" {
            index += 1
            if index < scalars.count, scalars[index] == "+" || scalars[index] == "-" { index += 1 }
            guard digits() > 0 else { return false }
        }
        return index == scalars.count
    }

    private static func cell(_ value: InterchangeJSON?, _ reference: String, _ type: String?) -> String {
        guard let value, !value.isNull else { return "<c r=\"\(reference)\"/>" }
        if type == "date", case .string(let text) = value, let day = InterchangeCalendar.realDate(text) {
            let days =
                InterchangeCalendar.daysFromCivil(year: day.year, month: day.month, day: day.day)
                - InterchangeCalendar.daysFromCivil(year: 1899, month: 12, day: 30)
            let serial = days < 61 ? days - 1 : days
            return "<c r=\"\(reference)\" s=\"1\"><v>\(serial)</v></c>"
        }
        if case .bool(let flag) = value { return "<c r=\"\(reference)\" t=\"b\"><v>\(flag ? 1 : 0)</v></c>" }
        let text = value.jsString()
        var digits = text.filter { !"-+.eE".contains($0) }
        while digits.hasPrefix("0") { digits.removeFirst() }
        var isNumber = false
        if case .number = value { isNumber = true }
        let typeIsNumeric = ["decimal", "number", "integer", "numeric", "float", "double"].contains {
            (type ?? "").contains($0)
        }
        if isNumber || typeIsNumeric, looksNumeric(text), digits.count <= 15,
            JSNumber.decimalLiteral(text)?.isFinite == true
        {
            return "<c r=\"\(reference)\"><v>\(text)</v></c>"
        }
        let content = value.isJSObject ? value.stringified() : text
        return "<c r=\"\(reference)\" t=\"inlineStr\"><is><t xml:space=\"preserve\">\(xmlEscape(content))</t></is></c>"
    }

    private static func sheet(_ rows: [[InterchangeJSON?]], types: [String?]) -> String {
        var out =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"
        for (i, row) in rows.enumerated() {
            out += "<row r=\"\(i + 1)\">"
            for (j, value) in row.enumerated() {
                out += cell(value, "\(columnName(j))\(i + 1)", i > 0 && j < types.count ? types[j] : nil)
            }
            out += "</row>"
        }
        return out + "</sheetData></worksheet>"
    }

    // MARK: Stored ZIP

    private static func zip(_ files: [(String, String)]) -> [UInt8] {
        func put16(_ bytes: inout [UInt8], _ offset: Int, _ value: Int) {
            bytes[offset] = UInt8(value & 0xFF)
            bytes[offset + 1] = UInt8((value >> 8) & 0xFF)
        }
        func put32(_ bytes: inout [UInt8], _ offset: Int, _ value: UInt32) {
            for shift in 0..<4 { bytes[offset + shift] = UInt8((value >> UInt32(8 * shift)) & 0xFF) }
        }
        var local: [UInt8] = []
        var central: [UInt8] = []
        var offset = 0
        for (path, text) in files {
            let name = Array(path.utf8)
            let data = Array(text.utf8)
            let crc = InterchangeCRC32.checksum(data)
            var header = [UInt8](repeating: 0, count: 30 + name.count)
            put32(&header, 0, 0x0403_4B50)
            put16(&header, 4, 20)
            put16(&header, 6, 0x800)
            put32(&header, 14, crc)
            put32(&header, 18, UInt32(data.count))
            put32(&header, 22, UInt32(data.count))
            put16(&header, 26, name.count)
            header.replaceSubrange(30..<30 + name.count, with: name)
            local += header
            local += data
            var entry = [UInt8](repeating: 0, count: 46 + name.count)
            put32(&entry, 0, 0x0201_4B50)
            put16(&entry, 4, 20)
            put16(&entry, 6, 20)
            put16(&entry, 8, 0x800)
            put32(&entry, 16, crc)
            put32(&entry, 20, UInt32(data.count))
            put32(&entry, 24, UInt32(data.count))
            put16(&entry, 28, name.count)
            put32(&entry, 42, UInt32(offset))
            entry.replaceSubrange(46..<46 + name.count, with: name)
            central += entry
            offset += header.count + data.count
        }
        var end = [UInt8](repeating: 0, count: 22)
        put32(&end, 0, 0x0605_4B50)
        put16(&end, 8, files.count)
        put16(&end, 10, files.count)
        put32(&end, 12, UInt32(central.count))
        put32(&end, 16, UInt32(offset))
        return local + central + end
    }

    // MARK: Import

    /// Bounded value-only import of the Results sheet of a Vision-generated stored-ZIP workbook.
    static func importWorkbook(_ bytes: [UInt8]) throws -> ImportedAnalysisWorkbook {
        if bytes.count > 10_000_000 { throw AnalysisInterchangeError("Workbook exceeds 10 MB") }
        func u16(_ at: Int) -> Int {
            let low = Int(bytes[at])
            let high = Int(bytes[at + 1])
            return low | (high << 8)
        }
        func u32(_ at: Int) -> UInt32 {
            var value: UInt32 = 0
            for shift in 0..<4 { value |= UInt32(bytes[at + shift]) << UInt32(8 * shift) }
            return value
        }
        var offset = 0
        var source = ""
        var provenance = ""
        while offset + 30 <= bytes.count, u32(offset) == 0x0403_4B50 {
            let method = u16(offset + 8)
            let size = Int(u32(offset + 18))
            let nameLength = u16(offset + 26)
            let extra = u16(offset + 28)
            let start = offset + 30 + nameLength + extra
            if start + size > bytes.count { throw AnalysisInterchangeError("Invalid ZIP entry") }
            let path = String(decoding: bytes[offset + 30..<offset + 30 + nameLength], as: UTF8.self)
            if path == "xl/worksheets/sheet1.xml" || path == "xl/worksheets/sheet3.xml" {
                if method != 0 {
                    throw AnalysisInterchangeError("Import supports Vision-generated uncompressed XLSX only")
                }
                let data = Array(bytes[start..<start + size])
                if InterchangeCRC32.checksum(data) != u32(offset + 14) {
                    throw AnalysisInterchangeError("Workbook checksum mismatch")
                }
                if path == "xl/worksheets/sheet1.xml" {
                    source = interchangeDecodeUTF8(data)
                } else {
                    provenance = interchangeDecodeUTF8(data)
                }
            }
            offset = start + size
        }
        if source.isEmpty { throw AnalysisInterchangeError("Results sheet missing or workbook format unsupported") }
        guard let document = WorkbookXML.parse(source) else { throw AnalysisInterchangeError("Invalid worksheet XML") }
        var formulaCells = 0
        var rows: [[WorkbookCell]] = try document.descendants(named: "row").map { (row: WorkbookXMLNode) -> [WorkbookCell] in
            try row.descendants(named: "c").map { (cell: WorkbookXMLNode) -> WorkbookCell in
                if !cell.descendants(named: "f").isEmpty {
                    formulaCells += 1
                    return .null
                }
                let type = cell.attributes["t"]
                let value = cell.descendants(named: "v").first?.textContent ?? ""
                if type == "inlineStr" { return .string(cell.descendants(named: "t").first?.textContent ?? "") }
                if type == "b" { return .bool(value == "1") }
                if value.isEmpty { return .null }
                let number = JSNumber.parse(value)
                if cell.attributes["s"] == "1" {
                    let serial = number < 60 ? number + 1 : number
                    guard let date = InterchangeCalendar.isoDatePrefix(milliseconds: -2_209_161_600_000 + serial * 86_400_000)
                    else { throw AnalysisInterchangeError("Invalid time value") }
                    return .string(date)
                }
                return .number(number)
            }
        }
        if rows.count > 10_001 { throw AnalysisInterchangeError("Import exceeds 10,000 rows") }
        var columns: [String] = (rows.isEmpty ? [] : rows.removeFirst()).map(headerText)
        if !provenance.isEmpty, let metadata = WorkbookXML.parse(provenance) {
            let declaration = metadata.descendants(named: "row")
                .first { $0.descendants(named: "t").first?.textContent == "columns" }
                .flatMap { row -> String? in
                    let cells = row.descendants(named: "t")
                    return cells.count > 1 ? cells[1].textContent : nil
                }
            if let declaration, !declaration.isEmpty {
                guard let declared = try? InterchangeJSON.parse(declaration), let list = declared.arrayValue,
                    list.count == columns.count, list.allSatisfy({ $0["id"]?.stringValue != nil })
                else { throw AnalysisInterchangeError("Invalid workbook column provenance") }
                columns = list.compactMap { $0["id"]?.stringValue }
            }
        }
        if columns.isEmpty || columns.count > 128 || Set(columns).count != columns.count {
            throw AnalysisInterchangeError("Invalid or duplicate workbook columns")
        }
        return ImportedAnalysisWorkbook(
            columns: columns,
            rows: rows.map { row in
                var record: [String: WorkbookCell] = [:]
                for (index, column) in columns.enumerated() { record[column] = index < row.count ? row[index] : .null }
                return record
            }, formulaCells: formulaCells)
    }

    /// `String(cell)` of a header cell.
    private static func headerText(_ cell: WorkbookCell) -> String {
        switch cell {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return JSNumber.string(number)
        case .string(let text): return text
        }
    }
}

/// The tag, attribute and text access `importAnalysisWorkbook` needs from an XML document.
final class WorkbookXMLNode {
    enum Part {
        case text(String)
        case node(WorkbookXMLNode)
    }
    let name: String
    let attributes: [String: String]
    var parts: [Part] = []
    init(name: String, attributes: [String: String]) {
        self.name = name
        self.attributes = attributes
    }
    var textContent: String {
        parts.map { part -> String in
            switch part {
            case .text(let text): return text
            case .node(let node): return node.textContent
            }
        }.joined()
    }
    /// Descendants named `name` in document order (`getElementsByTagName`).
    func descendants(named name: String) -> [WorkbookXMLNode] {
        var found: [WorkbookXMLNode] = []
        for case .node(let child) in parts {
            if child.name == name { found.append(child) }
            found += child.descendants(named: name)
        }
        return found
    }
}

enum WorkbookXML {
    private final class Builder: NSObject, XMLParserDelegate {
        let root = WorkbookXMLNode(name: "#document", attributes: [:])
        var stack: [WorkbookXMLNode] = []
        var failed = false
        override init() {
            super.init()
            stack = [root]
        }
        func parser(
            _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?,
            attributes attributeDict: [String: String] = [:]
        ) {
            let node = WorkbookXMLNode(name: elementName, attributes: attributeDict)
            stack.last?.parts.append(.node(node))
            stack.append(node)
        }
        func parser(
            _ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?
        ) {
            if stack.count > 1 { stack.removeLast() }
        }
        func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.parts.append(.text(string)) }
        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            stack.last?.parts.append(.text(String(decoding: CDATABlock, as: UTF8.self)))
        }
        func parser(_ parser: XMLParser, parseErrorOccurred parseError: any Error) { failed = true }
    }

    /// The document, or nil when the source is not well-formed XML.
    static func parse(_ source: String) -> WorkbookXMLNode? {
        let builder = Builder()
        let parser = XMLParser(data: Data(source.utf8))
        parser.shouldProcessNamespaces = false
        parser.shouldResolveExternalEntities = false
        parser.delegate = builder
        let completed = parser.parse()
        guard completed, !builder.failed, builder.stack.count == 1 else { return nil }
        return builder.root
    }
}

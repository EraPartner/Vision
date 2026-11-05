import CryptoKit
import Foundation

/// Failure of a value-only Analysis import or export; the message is shown to the person as is.
public struct AnalysisInterchangeError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Swift port of packages/shared-utils/src/analysis/interchange.ts (scenario CSV import, result CSV
/// export) and the Express layer that the removed `/api/analysis/interchange/*` routes added on top
/// (size limits, workbook attachment inference, export snapshot validation). Pure and deterministic:
/// no network, no database, no formula evaluation.
public enum AnalysisInterchange {
    public static let scenarioCSVMaxBytes = 1_000_000
    public static let workbookMaxBytes = 10_000_000
    static let csvContentType = "text/csv"
    static let xlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    // MARK: Entry points used by the app

    /// Import a scenario CSV or a Vision-generated workbook as an opaque scalar attachment.
    public static func importAttachment(
        file: AnalysisInterchangeFile, format: String, now: Date = Date(),
        makeWorkbookID: () -> String = { "workbook_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    ) throws -> AnalysisAttachment {
        let importedAt = isoTimestamp(now)
        switch format {
        case "csv":
            guard file.data.count <= scenarioCSVMaxBytes else {
                throw AnalysisInterchangeError("Scenario CSV exceeds the 1 MB limit")
            }
            let attachment = try parseScenarioCSV(
                text: interchangeDecodeUTF8(file.data), fileName: file.name, size: file.data.count,
                importedAt: importedAt)
            return try AnalysisAttachment(raw: attachment)
        case "xlsx":
            guard file.data.count <= workbookMaxBytes else { throw AnalysisInterchangeError("Workbook exceeds 10 MB") }
            let workbook = try AnalysisWorkbook.importWorkbook(Array(file.data))
            guard workbook.rows.count <= 1000, workbook.columns.count <= 32 else {
                throw AnalysisInterchangeError("Workbook attachment exceeds 1,000 rows or 32 columns")
            }
            let digest = SHA256.hash(data: file.data).map { String(format: "%02x", $0) }.joined()
            return try AnalysisAttachment(
                raw: workbookScenarioAttachment(
                    workbook, id: makeWorkbookID(), fileName: file.name, importedAt: importedAt, sha256: digest))
        default:
            throw AnalysisInterchangeError("Invalid analysis import format")
        }
    }

    /// Export the captured result snapshot. Nothing reruns a query or repairs missing values.
    public static func exportFile(result: AnalysisResult, context: TaxValue, format: String) throws
        -> AnalysisExportFile
    {
        guard format == "csv" || format == "xlsx" else { throw AnalysisInterchangeError("Invalid analysis export format") }
        let snapshot = InterchangeJSON(tax: result.raw)
        let contextJSON = InterchangeJSON(tax: context)
        try validateExport(result: snapshot, context: contextJSON)
        let name = context["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "analysis"
        if format == "csv" {
            let metadata = CSVMetadata(
                name: contextJSON["name"]?.stringValue ?? "", timezone: contextJSON["timezone"]?.stringValue ?? "",
                workspace: contextJSON["workspace"]?.stringValue ?? "",
                definitionId: contextJSON["definitionId"]?.stringValue,
                definitionVersion: contextJSON["definitionVersion"]?.doubleValue,
                datasetIds: (contextJSON["datasetIds"]?.arrayValue ?? []).compactMap(\.stringValue),
                sourceReferences: (contextJSON["sourceReferences"]?.arrayValue ?? []).compactMap(\.stringValue))
            let text = analysisResultCSV(snapshot, metadata: metadata)
            let filename =
                name.replacingOccurrences(of: #"[^a-zA-Z0-9_-]+"#, with: "-", options: .regularExpression)
                .lowercased() + ".csv"
            return AnalysisExportFile(filename: filename, data: Data(text.utf8), contentType: csvContentType)
        }
        let bytes = try AnalysisWorkbook.exportWorkbook(result: snapshot, context: contextJSON)
        return AnalysisExportFile(filename: name + ".xlsx", data: Data(bytes), contentType: xlsxContentType)
    }

    static func isoTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    // MARK: Scenario CSV

    /// Inference and bounds of `parseScenarioCsvText`. `text` is the decoded file (byte order mark
    /// removed); the digest covers its UTF-8 encoding, so a replaced file keeps its identity.
    static func parseScenarioCSV(text: String, fileName: String, size: Int, importedAt: String) throws -> TaxValue {
        if size > scenarioCSVMaxBytes { throw AnalysisInterchangeError("Scenario CSV exceeds the 1 MB limit") }
        let records = try ScenarioCSVReader.parse(text)
        if records.count < 2 { throw AnalysisInterchangeError("Scenario CSV needs a header and at least one row") }
        let headers = records[0]
        if headers.isEmpty || headers.count > 32 {
            throw AnalysisInterchangeError("Scenario CSV must contain 1 to 32 columns")
        }
        if records.count - 1 > 1_000 { throw AnalysisInterchangeError("Scenario CSV exceeds the 1,000 row limit") }
        let ids = headers.enumerated().map { columnID($1, index: $0) }
        if Set(ids).count != headers.count { throw AnalysisInterchangeError("Scenario CSV column names must be unique") }
        let body = Array(records.dropFirst())
        var columns: [(id: String, label: String, type: String)] = []
        for (index, label) in headers.enumerated() {
            let trimmed = jsTrim(label)
            columns.append(
                (
                    ids[index], trimmed.isEmpty ? ids[index] : trimmed,
                    inferType(body.map { $0.indices.contains(index) ? $0[index] : "" })
                ))
        }
        let sha256 = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        let rows: [TaxValue] = body.map { record in
            var row: [String: TaxValue] = [:]
            for (index, column) in columns.enumerated() {
                row[column.id] = normalize(record.indices.contains(index) ? record[index] : "", type: column.type)
            }
            return .object(row)
        }
        return .object([
            "id": .string("scenario_" + String(sha256.prefix(12))), "fileName": .string(fileName),
            "importedAt": .string(importedAt), "sha256": .string(sha256),
            "columns": .array(
                columns.map {
                    .object(["id": .string($0.id), "label": .string($0.label), "type": .string($0.type)])
                }),
            "rows": .array(rows),
        ])
    }

    /// JavaScript `String.prototype.trim` (white space, line terminators and the byte order mark).
    static func jsTrim(_ text: String) -> String {
        var scalars = Substring(text).unicodeScalars
        let space: (Unicode.Scalar) -> Bool = { $0 == "\u{FEFF}" || CharacterSet.whitespacesAndNewlines.contains($0) }
        while let first = scalars.first, space(first) { scalars.removeFirst() }
        while let last = scalars.last, space(last) { scalars.removeLast() }
        return String(scalars)
    }

    static func columnID(_ label: String, index: Int) -> String {
        var normalized = ""
        var pendingSeparator = false
        for scalar in jsTrim(label).lowercased().unicodeScalars {
            let alphanumeric = (scalar.value >= 0x61 && scalar.value <= 0x7A) || (scalar.value >= 0x30 && scalar.value <= 0x39)
            if alphanumeric {
                if pendingSeparator, !normalized.isEmpty { normalized += "_" }
                pendingSeparator = false
                normalized.unicodeScalars.append(scalar)
            } else {
                pendingSeparator = true
            }
        }
        if let first = normalized.unicodeScalars.first, first.value >= 0x61, first.value <= 0x7A {
            return String(normalized.prefix(64))
        }
        return "column_\(index + 1)"
    }

    private static func inferType(_ values: [String]) -> String {
        let present = values.filter { !$0.isEmpty }
        guard !present.isEmpty else { return "string" }
        if present.allSatisfy({ ["true", "false"].contains($0.lowercased()) }) { return "boolean" }
        if present.allSatisfy(isSafeIntegerText) { return "integer" }
        if present.allSatisfy({ isSafeIntegerText($0) || isDecimalText($0) }) { return "decimal" }
        if present.allSatisfy({ InterchangeCalendar.realDate($0) != nil }) { return "date" }
        return "string"
    }
    /// `^-?(?:0|[1-9]\d*)$` and a safe integer value.
    private static func isSafeIntegerText(_ text: String) -> Bool {
        let digits = text.hasPrefix("-") ? String(text.dropFirst()) : text
        guard !digits.isEmpty, digits.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else {
            return false
        }
        if digits.count > 1, digits.hasPrefix("0") { return false }
        return JSNumber.isSafeIntegerText(text)
    }
    /// `^-?(?:0|[1-9]\d*)\.\d+$`
    private static func isDecimalText(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[1].isEmpty, parts[1].unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 })
        else { return false }
        let integer = parts[0].hasPrefix("-") ? parts[0].dropFirst() : parts[0]
        guard !integer.isEmpty, integer.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else {
            return false
        }
        return integer.count == 1 || !integer.hasPrefix("0")
    }
    private static func normalize(_ value: String, type: String) -> TaxValue {
        if value.isEmpty { return .null }
        if type == "boolean" { return .bool(value.lowercased() == "true") }
        if type == "integer" {
            // Number("-0") is -0, which JSON prints as 0.
            return JSNumber.decimal(Double(value) ?? 0).map(TaxValue.number) ?? .null
        }
        return .string(value)
    }

    // MARK: Workbook attachment

    /// The workbook attachment preview inference: units are unavailable and a large numeric text
    /// cell stays a string even when its logical column type is decimal.
    static func workbookScenarioAttachment(
        _ imported: ImportedAnalysisWorkbook, id: String, fileName: String, importedAt: String, sha256: String
    ) -> TaxValue {
        func text(_ cell: WorkbookCell) -> String {
            switch cell {
            case .null: return "null"
            case .bool(let flag): return flag ? "true" : "false"
            case .number(let number): return JSNumber.string(number)
            case .string(let value): return value
            }
        }
        func decimalPattern(_ value: String) -> Bool {
            // /^-?\d+(\.\d+)?$/
            let parts = value.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count <= 2 else { return false }
            return parts.enumerated().allSatisfy { offset, part in
                let digits = offset == 0 && part.hasPrefix("-") ? part.dropFirst() : part
                return !digits.isEmpty && digits.unicodeScalars.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
            }
        }
        let columns: [TaxValue] = imported.columns.map { column in
            let values = imported.rows.compactMap { row -> WorkbookCell? in
                guard let cell = row[column], cell != .null else { return nil }
                return cell
            }
            let type: String
            if !values.isEmpty, values.allSatisfy({ if case .bool = $0 { true } else { false } }) {
                type = "boolean"
            } else if !values.isEmpty,
                values.allSatisfy({
                    if case .number(let number) = $0 { return number.isFinite && number == number.rounded() && abs(number) <= 9_007_199_254_740_991 }
                    return false
                })
            {
                type = "integer"
            } else if !values.isEmpty, values.allSatisfy({ decimalPattern(text($0)) }) {
                type = "decimal"
            } else if !values.isEmpty, values.allSatisfy({ InterchangeCalendar.looksLikeDate(text($0)) }) {
                type = "date"
            } else {
                type = "string"
            }
            return .object(["id": .string(column), "label": .string(column), "type": .string(type)])
        }
        let rows: [TaxValue] = imported.rows.map { row in
            .object(
                row.mapValues { (cell: WorkbookCell) -> TaxValue in
                    switch cell {
                    case .null: return .null
                    case .bool(let flag): return .bool(flag)
                    case .number(let number): return JSNumber.decimal(number).map(TaxValue.number) ?? .null
                    case .string(let value): return .string(value)
                    }
                })
        }
        return .object([
            "id": .string(id), "fileName": .string(fileName), "importedAt": .string(importedAt),
            "sha256": .string(sha256), "rows": .array(rows), "columns": .array(columns),
        ])
    }

    // MARK: Result CSV

    struct CSVMetadata: Equatable {
        var name: String
        var timezone: String
        var workspace: String
        var definitionId: String?
        var definitionVersion: Double?
        var datasetIds: [String]
        var sourceReferences: [String]
    }

    /// `escapeCsvValue(value, { treatNumericStringsAsSafe: true })` of packages/shared-utils/src/csv.ts.
    static func escapeCSVValue(_ value: InterchangeJSON?) -> String {
        guard let value, !value.isNull else { return "" }
        let raw = value.jsString()
        var safeNumeric = false
        switch value {
        case .number, .bool: safeNumeric = true
        default: safeNumeric = isStrictNumeric(raw)
        }
        let guarded = safeNumeric ? raw : neutralizeFormula(raw)
        if guarded.unicodeScalars.contains(where: { $0 == "\"" || $0 == "," || $0 == "\n" || $0 == "\r" }) {
            return "\"" + guarded.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return guarded
    }
    /// `^-?\d+(\.\d+)?$`
    private static func isStrictNumeric(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return false }
        return parts.enumerated().allSatisfy { offset, part in
            let digits = offset == 0 && part.hasPrefix("-") ? part.dropFirst() : part
            return !digits.isEmpty && digits.unicodeScalars.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
        }
    }
    private static func neutralizeFormula(_ value: String) -> String {
        if value.isEmpty { return value }
        var scalars = Substring(value).unicodeScalars
        while let first = scalars.first, first == " " || first == "\u{00A0}" { scalars.removeFirst() }
        guard let head = scalars.first else { return value }
        return ["=", "+", "-", "@", "\t", "\r"].contains(Character(head)) ? "'" + value : value
    }

    /// `analysisResultCsv`: reproducibility header lines, the column header and one line per row.
    static func analysisResultCSV(_ result: InterchangeJSON, metadata: CSVMetadata) -> String {
        struct Column {
            var id: String
            var type: String?
        }
        func columnList(_ value: InterchangeJSON?) -> [Column] {
            (value?.arrayValue ?? []).compactMap { entry in
                guard let id = entry["id"]?.stringValue else { return nil }
                return Column(id: id, type: entry["type"]?.stringValue)
            }
        }
        let declaredList = columnList(result["declaredColumns"])
        let declared = declaredList.isEmpty ? columnList(result["columns"]) : declaredList
        let rows = result["rows"]?.arrayValue ?? []
        var columns: [String] = []
        for id in declared.map(\.id) + rows.flatMap({ ($0.members ?? []).map(\.key) }) where !columns.contains(id) {
            columns.append(id)
        }
        let schema = columns.map { id -> String in
            if let column = declared.first(where: { $0.id == id }) {
                return "\(id):\(column.type ?? "undefined"):unit-unavailable"
            }
            let sample = rows.compactMap { $0[id] }.first { !$0.isNull }
            let inferred: String
            switch sample {
            case .bool?: inferred = "boolean"
            case .number(let number)?:
                inferred = number.isFinite && number == number.rounded() && abs(number) <= 9_007_199_254_740_991
                    ? "integer" : "decimal"
            default: inferred = "string"
            }
            return "\(id):\(inferred):unit-unavailable:runtime-inferred"
        }
        let window = result["window"]
        let windowLabel: String
        if window?["kind"]?.stringValue == "truncated" {
            windowLabel = "truncated:\(window?["reason"]?.jsString() ?? "undefined")"
        } else if window?["hasMore"]?.boolValue == true {
            windowLabel =
                "page:\(window?["offset"]?.jsString() ?? "undefined"):\(window?["returnedRows"]?.jsString() ?? "undefined")"
        } else {
            windowLabel = "complete"
        }
        func text(_ value: String) -> InterchangeJSON { .string(value) }
        func list(_ values: [String]) -> InterchangeJSON { text(values.isEmpty ? "unavailable" : values.joined(separator: "; ")) }
        let dateColumns = declared.filter { $0.type == "date" || $0.type == "datetime" }.map(\.id)
        var lines: [[InterchangeJSON?]] = [
            [text("# Vision analysis export"), text(metadata.name)],
            [text("# analysis_workspace"), text(metadata.workspace)],
            [text("# definition_id"), text(metadata.definitionId ?? "unavailable")],
            [text("# definition_version"), metadata.definitionVersion.map { InterchangeJSON.number($0) } ?? text("unavailable")],
            [text("# datasets"), list(metadata.datasetIds)],
            [text("# request_id"), result["requestId"]],
            [text("# executor"), result["executor"]],
            [text("# source_versions"), text("unavailable")],
            [text("# snapshot_id"), text("unavailable")],
            [text("# started_at"), result["startedAt"]],
            [text("# completed_at"), result["completedAt"]],
            [text("# reporting_timezone"), text(metadata.timezone)],
            [text("# value_semantics"), text("as-returned; no currency conversion")],
            [text("# source_date_columns"), list(dateColumns)],
            [text("# source_references"), list(metadata.sourceReferences)],
            [text("# column_schema"), text(schema.joined(separator: "; "))],
            [text("# result_window"), text(windowLabel)],
            columns.map { text($0) },
        ]
        for row in rows { lines.append(columns.map { row[$0] ?? .null }) }
        return lines.map { $0.map(escapeCSVValue).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
    }

    // MARK: Export snapshot validation

    /// The Zod `exportPayload` schema: shape checks only; the captured objects stay as they are.
    static func validateExport(result: InterchangeJSON, context: InterchangeJSON) throws {
        func fail(_ message: String) -> AnalysisInterchangeError { AnalysisInterchangeError(message) }
        func isColumn(_ value: InterchangeJSON) -> Bool {
            guard value.members != nil, value["id"]?.stringValue != nil, value["type"]?.stringValue != nil else {
                return false
            }
            if let label = value["label"], label.stringValue == nil { return false }
            if let nullable = value["nullable"], nullable.boolValue == nil { return false }
            return true
        }
        func isCount(_ value: InterchangeJSON?) -> Bool {
            guard let number = value?.doubleValue else { return false }
            return number >= 0 && number == number.rounded() && number <= 9_007_199_254_740_991
        }
        guard result.members != nil else { throw fail("Analysis export snapshot must be an object") }
        guard result["requestId"]?.stringValue != nil else { throw fail("Analysis export requestId must be a string") }
        guard result["completedAt"]?.stringValue != nil else { throw fail("Analysis export completedAt must be a string") }
        for key in ["startedAt", "executor"] {
            if let value = result[key], value.stringValue == nil { throw fail("Analysis export \(key) must be a string") }
        }
        guard let rows = result["rows"]?.arrayValue, rows.allSatisfy({ $0.members != nil }) else { throw fail("Analysis export rows must be objects") }
        guard let columns = result["columns"]?.arrayValue, columns.allSatisfy(isColumn) else {
            throw fail("Analysis export columns are invalid")
        }
        if let declared = result["declaredColumns"], declared.arrayValue?.allSatisfy(isColumn) != true {
            throw fail("Analysis export declaredColumns are invalid")
        }
        if let complete = result["complete"], complete.boolValue == nil { throw fail("Analysis export complete must be a boolean") }
        if let summaries = result["formulaSummaries"] {
            guard let members = summaries.members else { throw fail("Analysis export formulaSummaries are invalid") }
            for member in members {
                switch member.value {
                case .string, .bool, .null: continue
                case .number(let number) where number.isFinite: continue
                default: throw fail("Analysis export formulaSummaries are invalid")
                }
            }
        }
        guard let window = result["window"], window.members != nil else { throw fail("Analysis export window is required") }
        switch window["kind"]?.stringValue {
        case "page":
            guard isCount(window["offset"]), isCount(window["limit"]), window["hasMore"]?.boolValue != nil,
                isCount(window["returnedRows"])
            else { throw fail("Analysis export window is invalid") }
        case "truncated":
            guard window["reason"]?.stringValue != nil, isCount(window["returnedRows"]), isCount(window["enforcedLimit"])
            else { throw fail("Analysis export window is invalid") }
        default: throw fail("Analysis export window is invalid")
        }
        guard context.members != nil, context["name"]?.stringValue != nil, context["timezone"]?.stringValue != nil,
            context["workspace"]?.stringValue != nil
        else { throw fail("Analysis export context is invalid") }
        if let id = context["definitionId"], id.stringValue == nil { throw fail("Analysis export context is invalid") }
        if let version = context["definitionVersion"] {
            guard let number = version.doubleValue, number == number.rounded() else {
                throw fail("Analysis export context is invalid")
            }
        }
        for key in ["datasetIds", "sourceReferences"] {
            if let list = context[key], list.arrayValue?.allSatisfy({ $0.stringValue != nil }) != true {
                throw fail("Analysis export context is invalid")
            }
        }
    }
}

/// `csv-parse/sync` with `bom`, `columns: false`, `relax_column_count: false`, `skip_empty_lines: true`
/// and `trim: false`: comma delimiter, double-quote quoting and escaping, the record delimiter taken
/// from the first line break outside quotes, strict quotes and a constant column count.
enum ScenarioCSVReader {
    static func parse(_ text: String) throws -> [[String]] {
        let scalars = Array(text.unicodeScalars)
        var records: [[String]] = []
        var record: [String] = []
        var field = String.UnicodeScalarView()
        var quoting = false
        var wasQuoting = false
        var delimiter: [Unicode.Scalar]?
        var expectedColumns: Int?
        func fail(_ message: String) -> AnalysisInterchangeError { AnalysisInterchangeError("Invalid CSV: " + message) }
        func finishRecord() throws {
            record.append(String(field))
            field = String.UnicodeScalarView()
            if let expected = expectedColumns, expected != record.count {
                throw fail("Number of columns is inconsistent on line \(records.count + 1)")
            }
            expectedColumns = record.count
            records.append(record)
            record = []
            wasQuoting = false
        }
        func matches(_ pattern: [Unicode.Scalar], at index: Int) -> Bool {
            index + pattern.count <= scalars.count && Array(scalars[index..<index + pattern.count]) == pattern
        }
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if !quoting {
                if delimiter == nil {
                    if scalar == "\n" {
                        delimiter = ["\n"]
                    } else if scalar == "\r" {
                        delimiter = index + 1 < scalars.count && scalars[index + 1] == "\n" ? ["\r", "\n"] : ["\r"]
                    }
                }
                if let delimiter, matches(delimiter, at: index) {
                    if field.isEmpty && record.isEmpty && !wasQuoting {
                        index += delimiter.count
                        continue
                    }
                    try finishRecord()
                    index += delimiter.count
                    continue
                }
                if scalar == "," {
                    record.append(String(field))
                    field = String.UnicodeScalarView()
                    wasQuoting = false
                    index += 1
                    continue
                }
            }
            if scalar == "\"" {
                if quoting {
                    if index + 1 < scalars.count, scalars[index + 1] == "\"" {
                        field.append(scalar)
                        index += 2
                        continue
                    }
                    let next = index + 1
                    let atEnd = next >= scalars.count
                    if !atEnd, scalars[next] != ",", !(delimiter.map { matches($0, at: next) } ?? false),
                        !(delimiter == nil && (scalars[next] == "\n" || scalars[next] == "\r"))
                    {
                        throw fail("Invalid Closing Quote on line \(records.count + 1)")
                    }
                    quoting = false
                    wasQuoting = true
                    index += 1
                    continue
                }
                if !field.isEmpty || wasQuoting {
                    throw fail("Invalid Opening Quote on line \(records.count + 1)")
                }
                quoting = true
                index += 1
                continue
            }
            field.append(scalar)
            index += 1
        }
        if quoting { throw fail("Quote Not Closed on line \(records.count + 1)") }
        if !field.isEmpty || !record.isEmpty || wasQuoting { try finishRecord() }
        return records
    }
}

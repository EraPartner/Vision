import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/workbook.jsonl`: the XLSX reader (`packages/shared-utils/src/xlsx`),
/// the workbook checks of `portfolioUpload.ts`, and the adapters that read a workbook, with
/// what the TypeScript answered (`bun run native:parity-plans`). A workbook travels as base64.
@Suite struct WorkbookParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("workbook.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func text(_ units: [UInt16]) -> JSValue { .string(String(decoding: units, as: UTF16.self)) }

    private static func bytes(_ value: JSValue?) -> [UInt8] {
        Array(Data(base64Encoded: value?.stringValue ?? "") ?? Data())
    }

    private static func number(_ value: Double) -> JSValue {
        value.isFinite ? .number(value) : .string(JavaScriptNumber.text(value))
    }

    private static func cell(_ cell: XLSXCell?) -> JSValue {
        switch cell {
        case nil: return .null
        case .text(let text): return .string(text)
        case .number(let raw): return .object(JSObject([("type", .string("number")), ("raw", .string(raw))]))
        case .boolean(let value): return .bool(value)
        case .date(let time): return .object(JSObject([("date", number(time))]))
        }
    }

    private static func items(_ value: JSValue?) -> [JSValue] {
        if case .array(let items)? = value { return items }
        return []
    }

    private static func grid(_ rows: [[XLSXCell?]]) -> JSValue { .array(rows.map { .array($0.map(cell)) }) }

    private static func failure(_ kind: String, _ message: String? = nil) -> JSValue {
        .object(JSObject([("error", .string(kind))] + (message.map { [("message", .string($0))] } ?? [])))
    }

    static func evaluate(_ op: [JSValue], recorded: JSValue?) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        do {
            switch name {
            case "xml":
                var events: [JSValue] = []
                var handlers = XLSXMarkup.Handlers()
                handlers.open = { tag, attributes in
                    let entries = attributes.names.map { JSValue.array([text($0), text(attributes[units: $0] ?? [])]) }
                    events.append(.array([.string("open"), text(tag), .array(entries)]))
                }
                handlers.close = { tag in events.append(.array([.string("close"), text(tag)])) }
                handlers.text = { value in events.append(.array([.string("text"), text(value)])) }
                do {
                    try XLSXMarkup.parse(Array((at(1)?.stringValue ?? "").utf16), handlers)
                } catch is XLSXMarkup.Failure {
                    return .object(JSObject([("error", .string("invalid")), ("events", .array(events))]))
                }
                return .object(JSObject([("events", .array(events))]))
            case "dateFormat": return .bool(XLSXWorkbook.isDateFormat(Array((at(1)?.stringValue ?? "").utf16)))
            case "serial":
                let serial = at(1).map { $0.stringValue.map(JavaScriptNumber.fromString) ?? $0.javaScriptNumber } ?? .nan
                return number(XLSXWorkbook.serialTime(serial, epoch1904: at(2) == .bool(true)))
            case "sheets":
                guard let sheets = try? XLSXWorkbook.read(bytes(at(1)), trim: at(2) != .bool(false)) else {
                    return failure("unreadable")
                }
                return .array(sheets.map { .object(JSObject([("sheet", .string($0.name)), ("data", grid($0.rows))])) })
            case "bounded":
                try PortfolioUpload.assertBounded(bytes(at(1)))
                return .bool(true)
            case "portfolioWorkbook":
                let read = try PortfolioUpload.workbook(bytes(at(1)))
                return .array(
                    read.sheets.map {
                        .object(
                            JSObject([
                                ("sheet", .string($0.name)), ("sourceFileHash", .string(read.sourceFileHash)),
                                ("data", grid($0.rows)),
                            ]))
                    })
            case "saxo":
                return try PortfolioAdapters.parse(
                    bytes(at(1)), PortfolioParserConfig(format: .saxoTransactionHistory)
                ).jsonValue
            case "ibkrFunding":
                // SheetJS reads the file in the TypeScript; the Swift adapter starts from its sheets.
                guard let answer = recorded?.objectValue, case .array(let wire)? = answer["sheets"] else {
                    return recorded ?? .null
                }
                let sheets = wire.map { value -> IbkrFundingHistory.Sheet in
                    let sheet = value.objectValue
                    let rows = Self.items(sheet?["data"]).map { row in
                        Self.items(row).map { cell -> IbkrFundingHistory.Cell? in
                            guard let cell = cell.objectValue else { return nil }
                            switch cell["type"]?.stringValue {
                            case "number": return .number(cell["value"]?.stringValue ?? "")
                            case "boolean": return .boolean(cell["value"] == .bool(true))
                            default: return .text(cell["value"]?.stringValue ?? "")
                            }
                        }
                    }
                    return IbkrFundingHistory.Sheet(
                        name: sheet?["sheet"]?.stringValue ?? "", rows: rows,
                        sourceFileHash: sheet?["sourceFileHash"]?.stringValue ?? "",
                        sourceFormat: sheet?["sourceFormat"]?.stringValue ?? "")
                }
                var result: JSValue
                do {
                    result = try IbkrFundingHistory.parse(sheets).jsonValue
                } catch let error as StatementImportError {
                    guard case .validation(let message) = error else { throw error }
                    result = failure("validation", message)
                }
                return .object(JSObject([("sheets", .array(wire)), ("result", result)]))
            default: throw UnknownOperation(name: name)
            }
        } catch let error as StatementImportError {
            switch error {
            case .validation(let message): return failure("validation", message)
            case .failed(let message): return failure("failed", message)
            case .contract: return failure("contract")
            }
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op, recorded: recorded["r"]))
            let want = PlanFixture.canonical(recorded["r"] ?? .null)
            // By code unit: Swift's `==` takes canonically equivalent text for equal.
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 12 {
                    failures.append(
                        "line \(index + 1) \(String(line.prefix(160)))\n  want \(want.prefix(700))\n  got  \(got.prefix(700))")
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 300)
    }
}

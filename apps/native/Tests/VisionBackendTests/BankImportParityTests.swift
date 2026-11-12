import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/bank-import.jsonl`: generated statements through each bank adapter
/// (`importPipeline/adapters`), the format detection and the helpers the adapters share, with
/// what the TypeScript answered (`bun run native:parity-plans`). A statement travels as the
/// base64 of its bytes; dates are compared as day numbers.
@Suite struct BankImportParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("bank-import.jsonl")

    private struct UnknownOperation: Error { let name: String }

    /// A number as the recorder keeps it: NaN and the infinities by name.
    private static func number(_ value: Double) -> JSValue {
        value.isFinite ? .number(value) : .string(JavaScriptNumber.text(value))
    }

    private static func day(_ value: Int?) -> JSValue { value.map { .number(Double($0)) } ?? .null }

    private static func bytes(_ value: JSValue?) -> [UInt8] {
        Array(Data(base64Encoded: value?.stringValue ?? "") ?? Data())
    }

    private static func config(_ wire: JSObject) -> CustomBankParserConfig {
        let mapping = wire["column_mapping"]?.objectValue
        func column(_ key: String) -> String? { mapping?[key]?.stringValue }
        return CustomBankParserConfig(
            bankName: wire["bank_name"]?.stringValue, accountType: wire["account_type"]?.stringValue,
            dateFormat: wire["date_format"]?.stringValue, separator: wire["separator"]?.stringValue,
            skipRows: wire["skip_rows"].map { Int($0.javaScriptNumber) } ?? 0, encoding: wire["encoding"]?.stringValue,
            numberFormat: wire["number_format"],
            columns: .init(
                date: column("date") ?? "", recipient: column("recipient") ?? "", amount: column("amount") ?? "",
                memo: column("memo"), currency: column("currency"), balance: column("balance"),
                sourceReference: column("source_id")))
    }

    private static func options(_ wire: JSObject?) -> CSVParse.Options {
        var options = CSVParse.Options()
        if let delimiter = wire?["delimiter"]?.stringValue { options.delimiter = delimiter }
        if let line = wire?["from_line"] { options.fromLine = Int(line.javaScriptNumber) }
        options.skipEmptyLines = wire?["skip_empty_lines"] == .bool(true)
        options.relaxColumnCount = wire?["relax_column_count"] == .bool(true)
        options.relaxQuotes = wire?["relax_quotes"] == .bool(true)
        options.skipRecordsWithError = wire?["skip_records_with_error"] == .bool(true)
        options.trim = wire?["trim"] == .bool(true)
        if wire?["columns"] == .bool(true) { options.columns = .firstRecord }
        return options
    }

    private static func failure(_ kind: String, _ pairs: (String, JSValue)...) -> JSValue {
        .object(JSObject([("error", .string(kind))] + pairs))
    }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        let text = at(1)?.stringValue ?? ""
        do {
            switch name {
            case "bank":
                if let wire = at(3)?.objectValue {
                    return try BankAdapters.parse(custom: config(wire), bytes(at(2))).jsonValue
                }
                if JavaScriptCase.lowercased(text) == "generic" {
                    return failure("failed", ("message", .string("Generic adapter requires a customConfig")))
                }
                guard let bank = BankAdapters.bank(named: text) else { throw UnknownOperation(name: text) }
                return try BankAdapters.parse(bank, bytes(at(2))).jsonValue
            case "detect":
                return .object(
                    JSObject([
                        ("first", BankAdapters.detect(text).map { .string($0.rawValue) } ?? .null),
                        ("all", .array(BankAdapters.detectAll(text).map { .string($0.rawValue) })),
                    ]))
            case "adapter":
                if BankImportText.same(text, "generic") { return .string("generic") }
                return BankAdapters.bank(named: text).map { .string($0.rawValue) } ?? .null
            case "records":
                let wire = at(2)?.objectValue
                let output = try BankImportText.records(text, options(wire))
                let named = wire?["columns"] == .bool(true)
                return .object(
                    JSObject([
                        (
                            "records",
                            .array(
                                output.records.map { record in
                                    let value: JSValue =
                                        named
                                        ? .object(JSObject(record.fields.map { ($0.key, .string($0.value)) }))
                                        : .array(record.cells.map(JSValue.string))
                                    return .object(
                                        JSObject([("record", value), ("raw", .string(BankImportText.rawData(record)))]))
                                })
                        ), ("skipped", .number(Double(output.skipped))),
                    ]))
            case "decode":
                return .string(BankImportText.decode(bytes(at(1)), try BankImportText.encoding(at(2)?.stringValue)))
            case "lines": return .array(BankImportText.lines(text).map(JSValue.string))
            case "decimal": return number(BankImportText.decimal(text))
            case "commaDecimal": return number(BankImportText.commaDecimal(text))
            case "amount": return number(BankImportText.amount(text))
            case "customAmount":
                return number(
                    try BankImportText.customAmount(
                        text, try BankImportText.numberFormat(at(2)), rowNumber: at(3).map { Int($0.javaScriptNumber) },
                        column: at(4)?.stringValue))
            case "currency": return BankImportText.isoCurrency(text).map(JSValue.string) ?? .null
            case "dayMonthYear": return day(BankImportText.dayMonthYear(text))
            case "flexibleDay": return day(BankImportText.flexibleDay(text))
            case "formatDay": return day(BankImportText.day(text, format: at(2)?.stringValue ?? ""))
            case "uppercase": return .string(BankImportText.uppercase(text))
            case "cleanRecipient": return .string(BankImportText.cleanRecipient(text))
            case "cleanKbcRecipient": return .string(BankImportText.cleanKbcRecipient(text))
            case "iban": return .string(BankImportText.canonicalIBAN(text))
            case "parseInt": return number(BankImportText.parseInt(text))
            case "parseFloat": return number(BankImportText.parseFloat(text))
            default: throw UnknownOperation(name: name)
            }
        } catch let error as StatementImportError {
            switch error {
            case .validation(let message): return failure("validation", ("message", .string(message)))
            case .failed(let message): return failure("failed", ("message", .string(message)))
            case .contract: return failure("contract")
            }
        } catch let error as CSVParse.Failure {
            return failure("csv", ("code", .string(error.code.rawValue)))
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op))
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

import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Replays the plan corpus `bun run native:parity-plans` records (ADR-270 decision 5): each
/// line holds one input the TypeScript `buildPortfolioImportReconciliationPlan` was given,
/// by its unit tests, by the import pipeline in the database tests or as a mutation of one of
/// those, and what it answered.
@Suite struct PortfolioImportPlanParityTests {
    static let corpus = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("parity/plans/portfolio-import-reconciliation.jsonl")

    @Test func everyRecordedPlanIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        #expect(lines.count > 100)
        var failures: [String] = []
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            let input = try PlanFixture.input(recorded["input"]?.objectValue ?? JSObject())
            let expected = recorded["result"].map(PlanFixture.canonical) ?? "error: \(recorded["error"]?.stringValue ?? "")"
            let actual: String
            do {
                actual = PlanFixture.canonical(PlanFixture.recorded(try PortfolioImportReconciliation.buildPlan(input)))
            } catch let error as BackendHTTPError {
                actual = "error: \(error.message)"
            } catch let error as DecimalJSError {
                actual = "error: [DecimalError] Invalid argument: \(error.input)"
            }
            if actual != expected { failures.append("case \(index + 1)\n  expected \(expected)\n  actual   \(actual)") }
        }
        #expect(failures.isEmpty, "\(failures.count) of \(lines.count) differ:\n\(failures.prefix(3).joined(separator: "\n"))")
    }

    static let interop = corpus.deletingLastPathComponent().appendingPathComponent("import-interop.jsonl")

    private struct UnknownOperation: Error { let name: String }

    /// One recorded operation, answered by the Swift counterpart of the JavaScript behaviour.
    private static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func text(_ index: Int) -> String { op.count > index ? op[index].stringValue ?? "" : "" }
        func decimal(_ index: Int) throws -> DecimalJS { try DecimalJS(text(index)) }
        func number(_ value: Double) -> JSValue { .string(value.isNaN ? "NaN" : SQLArguments.javaScriptText(value)) }
        let name = text(0)
        switch name {
        case "new": return .string(try decimal(1).toFixed)
        case "fromNumber": return .string(try DecimalJS(op[1].javaScriptNumber).toFixed)
        case "plus": return .string(try decimal(1).plus(try decimal(2)).toFixed)
        case "minus": return .string(try decimal(1).minus(try decimal(2)).toFixed)
        case "times": return .string(try decimal(1).times(try decimal(2)).toFixed)
        case "div": return .string(try decimal(1).dividedBy(try decimal(2)).toFixed)
        case "dp":
            let places = Int(op[2].javaScriptNumber)
            return .string(try decimal(1).toDecimalPlaces(places, op[3] == .string("up") ? .halfUp : .halfEven).toFixed)
        case "cmp": return .int(try decimal(1).compared(to: try decimal(2)))
        case "num": return number(try decimal(1).toNumber)
        case "day": return number(ImportInterop.dayNumber(text(1)))
        case "csv":
            let records = try CSVRecords.parse(
                text(1), relaxQuotes: op[2] == .bool(true), relaxColumnCount: op[3] == .bool(true))
            return .array(records.map { .array($0.map(JSValue.string)) })
        case "identity": return .string(ImportInterop.normalizeIdentityText(text(1)))
        default: throw UnknownOperation(name: name)
        }
    }

    /// decimal.js, csv-parse, `Date.parse` and the identity text rule, against what Bun gave.
    @Test func javaScriptBehavioursAreReproduced() throws {
        let lines = try String(contentsOf: Self.interop, encoding: .utf8).split(separator: "\n")
        #expect(lines.count > 2000)
        var failures: [String] = []
        for line in lines {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"], let expected = recorded["r"] else { continue }
            let actual: JSValue
            do { actual = try Self.evaluate(op) } catch is UnknownOperation { throw PlanFixture.Malformed(what: String(line)) }
            catch { actual = .string("error") }
            if actual != expected { failures.append("\(line) gave \(actual.jsonText)") }
        }
        #expect(failures.isEmpty, "\(failures.count) of \(lines.count) differ:\n\(failures.prefix(40).joined(separator: "\n"))")
    }
}

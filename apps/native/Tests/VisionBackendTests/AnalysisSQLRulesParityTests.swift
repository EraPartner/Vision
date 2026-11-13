import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/analysis-sql-rules.jsonl`: SQL texts, dataset declarations, column
/// types and parameters given to the TypeScript analysis SQL rules
/// (`services/analysisExecutor.ts`, `database/sqlite/sqlText.ts`), with what they answered
/// (`bun run native:parity-plans`).
@Suite struct AnalysisSQLRulesParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("analysis-sql-rules.jsonl")

    private struct UnknownOperation: Error { let name: String }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func strings(_ value: JSValue) -> [String] {
            guard case .array(let items) = value else { return [] }
            return items.compactMap(\.stringValue)
        }
        func refusal(_ body: () throws -> JSValue) rethrows -> JSValue {
            do { return try body() } catch let violation as AnalysisSQLRules.Violation {
                return .object(JSObject([("error", .string(violation.message))]))
            }
        }
        switch op.first?.stringValue ?? "" {
        case "check":
            return try refusal {
                let checked = try AnalysisSQLRules.check(op[1].stringValue, datasetIds: strings(op[2]))
                return .object(JSObject([("sql", .string(checked.sql)), ("masked", .string(checked.masked))]))
            }
        case "views":
            return .array(
                AnalysisSQLRules.referencedViews(masked: op[1].stringValue ?? "", datasetIds: strings(op[2]))
                    .map(JSValue.string))
        case "kind":
            return AnalysisSQLRules.columnKind(column: op[1].stringValue ?? "", declaredType: op[2].stringValue ?? "")
                .map(JSValue.string) ?? .null
        case "hint": return .string(AnalysisSQLRules.storedValueHint(declaredType: op[1].stringValue ?? ""))
        case "params": return try refusal { .array(try AnalysisSQLRules.checkParameters(op[1])) }
        case "scan":
            let scan = SQLStatementScan(op[1].stringValue ?? "")
            return .object(
                JSObject([
                    ("text", .string(scan.text)), ("readOnly", .bool(scan.readOnly)),
                    ("multipleStatements", .bool(scan.multipleStatements)), ("firstKeyword", .string(scan.firstKeyword)),
                ]))
        case let name: throw UnknownOperation(name: name)
        }
    }

    @Test func recordedAnswersMatch() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        for (index, line) in lines.enumerated() {
            let entry = try PlanFixture.object(String(line))
            guard case .array(let op)? = entry["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op))
            let want = PlanFixture.canonical(entry["r"] ?? .null)
            if got != want, failures.count < 12 {
                failures.append("line \(index + 1) \(String(line.prefix(300)))\n  got \(got.prefix(300))")
            }
        }
        #expect(failures.isEmpty, "\(failures.joined(separator: "\n"))")
        #expect(lines.count > 500)
    }
}

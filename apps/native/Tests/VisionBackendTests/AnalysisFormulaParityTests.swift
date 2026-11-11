import Foundation
import Testing

@testable import VisionBackend

/// Replays the formula corpus `bun run native:parity-plans` records: each line holds one
/// request the TypeScript `evaluateAnalysisFormulas` was given, by its tests or as a generated
/// request, and what it answered or the error it threw.
@Suite struct AnalysisFormulaParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("analysis-formulas.jsonl")

    private static func objects(_ value: JSValue?) -> [JSObject] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(\.objectValue)
    }

    /// A recorded request body as the engine's request.
    static func request(_ wire: JSObject) -> AnalysisFormulaRequest {
        var request = AnalysisFormulaRequest(rows: objects(wire["rows"]))
        request.formulas = objects(wire["formulas"])
        request.columns = objects(wire["columns"])
        if let assumptions = wire["assumptions"]?.objectValue { request.assumptions = assumptions }
        if let units = wire["assumptionUnits"]?.objectValue { request.assumptionUnits = units }
        if case .bool(let complete)? = wire["inputComplete"] { request.inputComplete = complete }
        return request
    }

    /// What the recorder writes for one request: the result, or the error by code and message.
    static func answer(_ wire: JSObject) -> String {
        do {
            return PlanFixture.canonical(try AnalysisFormulaEngine.evaluate(request(wire)).jsonValue)
        } catch let error as AnalysisFormulaError {
            var object = JSObject([("code", .string(error.code.rawValue)), ("message", .string(error.message))])
            if let formula = error.formula { object["formulaId"] = formula }
            return "error: " + PlanFixture.canonical(.object(object))
        } catch is FormulaStringLiteralError {
            return "error: " + PlanFixture.canonical(.object(JSObject([("name", .string("SyntaxError"))])))
        } catch {
            return "error: \(error)"
        }
    }

    static func differences(in file: URL) throws -> (count: Int, failures: [String]) {
        let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            let expected =
                recorded["result"].map(PlanFixture.canonical)
                ?? "error: " + PlanFixture.canonical(recorded["error"] ?? .null)
            let actual = answer(recorded["input"]?.objectValue ?? JSObject())
            if actual != expected {
                failures.append("case \(index + 1)\n  input    \(recorded["input"]?.jsonText ?? "")\n  expected \(expected)\n  actual   \(actual)")
            }
        }
        return (lines.count, failures)
    }

    @Test func everyRecordedEvaluationIsReproduced() throws {
        let (count, failures) = try Self.differences(in: Self.corpus)
        #expect(count > 100)
        #expect(failures.count == 0, "\(failures.count) of \(count) differ:\n\(failures.prefix(2).map { String($0.prefix(1500)) }.joined(separator: "\n"))")
    }
}

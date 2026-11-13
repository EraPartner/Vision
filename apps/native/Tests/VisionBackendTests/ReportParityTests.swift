import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/reports.jsonl`: report bodies and whole print documents that the
/// TypeScript renderers of `services/reports` produced from given data
/// (`bun run native:parity-plans`). The Swift text has to equal the recorded text character
/// for character. A recorded document names the shared CSS `<base-css>`; one case holds it.
@Suite struct ReportParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("reports.jsonl")

    private struct UnknownOperation: Error { let name: String }

    /// The cases were recorded in the default application zone on a machine in UTC.
    private static func context(_ wire: JSValue?, nowMs: JSValue?) throws -> ReportContext {
        ReportContext(
            currency: wire["currency"].s, period: ReportPeriod(wire["period"]), nowMs: Int(nowMs.n), zone: try AppTimeZone(),
            localZone: TimeZone(identifier: "UTC") ?? .current)
    }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func at(_ index: Int) -> JSValue? { op.count > index ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        switch name {
        case "body":
            guard let kind = ReportKind(rawValue: at(1).s) else { throw UnknownOperation(name: at(1).s) }
            return .string(
                ReportDocument.body(
                    kind, sections: at(2).items.map(\.s), data: at(3), context: try context(at(4), nowMs: at(5))))
        case "document":
            let options = at(1)
            guard let kind = ReportKind(rawValue: options["type"].s) else { throw UnknownOperation(name: options["type"].s) }
            let request = ReportDocument.Request(
                kind: kind, context: try context(options, nowMs: at(3)), theme: options["theme"],
                generatedAtMs: Int(XLSXWorkbook.isoTime(options["generatedAt"].s) ?? 0), pricesAsOf: options["pricesAsOf"]?.stringValue,
                excludedCategoryCount: options["excludedCategoryIds"].items.count,
                excludedRecipientCount: options["excludedRecipientIds"].items.count)
            let document = ReportDocument.assemble(request, body: at(2).s)
            var html = document.html
            if let css = html.range(of: ReportStyles.base) { html.replaceSubrange(css, with: "<base-css>") }
            return .object(
                JSObject([
                    ("filename", .string(document.filename)), ("html", .string(html)),
                    ("footerTemplate", .string(document.footerTemplate)),
                ]))
        case "baseCss":
            return .string(ReportStyles.base)
        default: throw UnknownOperation(name: name)
        }
    }

    /// The text around the first unit two texts differ at.
    private static func difference(_ want: String, _ got: String) -> String {
        let a = Array(want.utf8)
        let b = Array(got.utf8)
        var index = 0
        while index < a.count, index < b.count, a[index] == b[index] { index += 1 }
        func around(_ units: [UInt8]) -> String {
            String(decoding: units[Swift.max(0, index - 160)..<Swift.min(units.count, index + 160)], as: UTF8.self)
        }
        return "at \(index) of \(a.count)/\(b.count)\n  want …\(around(a))\n  got  …\(around(b))"
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        var operations: Set<String> = []
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            operations.insert(op.first?.stringValue ?? "")
            let got = PlanFixture.canonical(try Self.evaluate(op))
            let want = PlanFixture.canonical(recorded["r"] ?? .null)
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 8 {
                    failures.append("line \(index + 1) \(String(line.prefix(160)))\n  \(Self.difference(want, got))")
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 300)
        #expect(operations == ["body", "document", "baseCss"])
    }
}

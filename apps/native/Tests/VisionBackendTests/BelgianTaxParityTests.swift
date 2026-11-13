import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/belgian-tax.jsonl`: households and the other tax inputs the TypeScript
/// engine (`packages/shared-utils/src/belgianTax`) was given, by its tests or as generated cases,
/// with what it answered (`bun run native:parity-plans`).
@Suite struct BelgianTaxParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("belgian-tax.jsonl")

    private struct UnknownOperation: Error { let name: String }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        let name = op.first?.stringValue ?? ""
        func object(_ index: Int) -> JSObject { op.count > index ? op[index].objectValue ?? JSObject() : JSObject() }
        switch name {
        case "household":
            let household = TaxHousehold(object(1))
            do {
                let result = try HouseholdTax.compute(household)
                return .object(
                    JSObject([
                        ("result", result.jsonValue), ("calculation", BelgianTaxCalculation.json(result, household)),
                    ]))
            } catch is BelgianTaxError {
                return .string("error: TypeError")
            }
        default: break
        }
        func value(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        func joint(_ index: Int) -> ((JSObject) -> Bool)? {
            if value(index) == .bool(true) { return { HouseholdTaxSettings.filesJointly($0) } }
            return nil
        }
        do {
            switch name {
            case "upgrade": return .object(try HouseholdMigration.upgrade(object(1)))
            case "upgradeSnapshots": return .object(try HouseholdMigration.upgradeSnapshots(object(1)))
            case "project": return .object(try HouseholdMigration.project(object(1), jointFiling: joint(2)))
            case "patch":
                return .object(try HouseholdMigration.apply(patch: object(2), to: object(1), jointFiling: joint(3)))
            case "load":
                let stored = object(1)
                return try HouseholdTaxSettings.load(
                    HouseholdTaxSettings.Stored(
                        defaults: stored.object("defaultsV1") ?? JSObject(),
                        profile: stored.object("profileV1") ?? JSObject(), hasProfile: stored.flag("hasProfileV1"),
                        snapshotsV1: stored["snapshotsV1"], householdV2: stored["householdV2"],
                        snapshotsV2: stored["snapshotsV2"])
                ).jsonValue
            case "overview":
                return try HouseholdTaxSettings.overview(
                    settings: object(1), expected: object(2), requestedYear: value(3)?.javaScriptNumber)
            case "attribute":
                let parts = RecordedIncomeAttribution.attribute(
                    op[1].javaScriptNumber, value(2)?.objectValue, hasPartnerB: op[3] == .bool(true))
                return .object(JSObject([("A", TaxJSON.number(parts.a)), ("B", TaxJSON.number(parts.b))]))
            case "recorded":
                return try RecordedIncomeAttribution.household(
                    value(1)?.objectValue, total: op[2].javaScriptNumber, byOwner: value(3)?.objectValue
                ).map(JSValue.object) ?? .null
            case "selfEmployed":
                return TaxJSON.number(
                    TaxContributions.selfEmployedContributions(
                        op[1].javaScriptNumber, BelgianTaxTable.table(for: op[2].javaScriptNumber)))
            case "dashboard":
                let input = object(1)
                let rates = object(2)
                return try PortfolioTaxDashboard.build(
                    summaries: input.objects("summaries"), year: input.number("year") ?? .nan,
                    currency: input.text("currency") ?? "", totalPIT: input.number("totalPIT") ?? .nan,
                    filingStatus: input.text("filingStatus") ?? "", hasProfile: input.flag("hasProfile"),
                    adjustments: input["adjustments"], classifications: input["classifications"]
                ) { amount, currency in rates.number(currency ?? "").map { amount * $0 } }
            default: throw UnknownOperation(name: name)
            }
        } catch is BelgianTaxError {
            return .string("error: TypeError")
        }
    }

    static func differences(in file: URL) throws -> (count: Int, failures: [String]) {
        let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"], let expected = recorded["r"] else { continue }
            let actual = PlanFixture.canonical(try evaluate(op))
            let wanted = PlanFixture.canonical(expected)
            if actual != wanted {
                let at = zip(actual, wanted).enumerated().first { $0.element.0 != $0.element.1 }?.offset ?? 0
                let from = max(0, at - 160)
                failures.append(
                    "case \(index + 1) at \(at)\n  expected …\(wanted.dropFirst(from).prefix(320))\n  actual   …\(actual.dropFirst(from).prefix(320))")
            }
        }
        return (lines.count, failures)
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let (count, failures) = try Self.differences(in: Self.corpus)
        #expect(count > 100)
        #expect(failures.count == 0, "\(failures.count) of \(count) differ:\n\(failures.prefix(6).joined(separator: "\n"))")
    }
}

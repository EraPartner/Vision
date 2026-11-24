import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/planned.jsonl`: the planned-payment helpers
/// (`lib/calculations/recurrence.ts` and `lib/plannedMatching.ts`) — the pattern grammar,
/// its steppers, the horizon expansion, the monthly occurrence factor and the match
/// tolerance — with what the TypeScript answered (`bun run native:parity-plans`).
@Suite struct PlannedPlanParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("planned.jsonl")

    private struct UnknownOperation: Error { let name: String }

    /// The thrown message the recorder stores as the answer.
    private static func failure(_ error: Error) -> JSValue {
        if let thrown = error as? CalendarDaysError { return .string(thrown.message) }
        if let thrown = error as? BackendHTTPError { return .string(thrown.message) }
        return .string("\(error)")
    }

    private static func like(_ object: JSObject?, _ cluster: String, _ currency: String, _ amount: String, _ date: String) -> (
        cluster: JSValue?, currency: JSValue?, amount: JSValue?, date: JSValue?
    ) {
        func field(_ key: String) -> JSValue? {
            guard let value = object?[key], value != .null else { return nil }
            return value
        }
        return (field(cluster), field(currency), field(amount), field(date))
    }

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func text(_ index: Int) -> String? {
            guard op.count > index, case .string(let value)? = op[index] else { return nil }
            return value
        }
        func integer(_ index: Int) -> Int { Int(op[index].javaScriptNumber) }
        let name = op.first?.stringValue ?? ""
        do {
            switch name {
            case "step":
                guard let step = Recurrence.parseStep(op[safe: 1]) else { return .null }
                return .object([
                    ("unit", .string(step.unit == .day ? "day" : "month")),
                    ("amount", JSValue.number(step.amount).envelopeValue),
                ])
            case "valid":
                return .bool(Recurrence.isValidPattern(op[safe: 1]))
            case "next":
                return try Recurrence.nextOccurrenceYmd(text(1) ?? "", text(2)).map(JSONValue.string) ?? .null
            case "fastForward":
                return .string(
                    try Recurrence.fastForward(text(1) ?? "", text(2), text(3) ?? ""))
            case "factor":
                guard let factor = try Recurrence.monthlyOccurrenceFactor(text(1)) else { return .null }
                return .string(factor.toFixed)
            case "expand":
                return .array(
                    try Recurrence.expandOccurrences(
                        row: (
                            text(1) ?? "", op.count > 2 && op[2] == .bool(true), text(3)
                        ),
                        horizonYmd: text(4) ?? "", maxOccurrences: op.count > 5 ? integer(5) : 500
                    ).map { .string($0) })
            case "match":
                let planned = like(op[safe: 1]?.objectValue, "recipient_cluster_id", "currency", "amount", "planned_date")
                let tx = like(op[safe: 2]?.objectValue, "recipient_cluster_id", "currency", "amount", "transaction_date")
                return .bool(
                    PlannedMatching.matchesTolerance(
                        PlannedMatchLike(
                            recipientClusterId: planned.cluster, currency: planned.currency,
                            amount: planned.amount, plannedDate: planned.date),
                        TxMatchLike(
                            recipientClusterId: tx.cluster, currency: tx.currency, amount: tx.amount,
                            transactionDate: tx.date)))
            case "loan":
                let config = op[safe: 1]?.objectValue
                let answer = try LoanSchedule.generate(
                    LoanSchedule.Config(
                        loanType: config?["loan_type"], loanPrincipal: config?["loan_principal"],
                        loanAnnualInterestRate: config?["loan_annual_interest_rate"],
                        loanTermMonths: config?["loan_term_months"],
                        loanStartDate: config?["loan_start_date"],
                        loanPaymentDay: config?["loan_payment_day"]))
                return answer.json
            default:
                throw UnknownOperation(name: name)
            }
        } catch {
            return failure(error)
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
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 12 {
                    failures.append(
                        "line \(index + 1) \(String(line.prefix(160)))\n  want \(want.prefix(700))\n  got  \(got.prefix(700))"
                    )
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 200)
    }
}

extension Array {
    /// The element at `index`, or nil beyond the end.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

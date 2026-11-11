import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Replays `parity/plans/foundations.jsonl`: the shared helpers the TypeScript backend builds
/// on (the money helpers, JavaScript number rendering, `lib/math.ts`, `lib/timezone.ts`), each
/// evaluated by Bun for one input (`bun run native:parity-plans`).
@Suite struct FoundationParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("foundations.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func evaluate(_ op: [JSValue]) throws -> JSValue {
        func text(_ index: Int) -> String { op.count > index ? op[index].stringValue ?? "" : "" }
        func number(_ index: Int) -> Double { op.count > index ? op[index].javaScriptNumber : .nan }
        func integer(_ index: Int) -> Int { Int(number(index)) }
        func numbers(from index: Int) -> [Double] { op.dropFirst(index).map(\.javaScriptNumber) }
        func rendered(_ value: Double) -> JSValue { .string(JavaScriptNumber.text(value)) }
        func zone(_ index: Int) throws -> AppTimeZone { try AppTimeZone(identifier: text(index)) }
        let name = text(0)
        switch name {
        case "toFixed": return .string(JavaScriptNumber.toFixed(number(1), integer(2)))
        case "toPrecision": return .string(JavaScriptNumber.toPrecision(number(1), integer(2)))
        case "round": return rendered(JavaScriptNumber.round(number(1)))
        case "roundMoney": return rendered(DecimalMoney.roundMoney(try DecimalJS.from(text(1)), places: integer(2)))
        case "roundToCents": return .string(DecimalMoney.roundToCents(try DecimalJS.from(text(1))).toFixed)
        case "addAll":
            return .string(DecimalMoney.addAll(try op.indices.dropFirst().map { try DecimalJS.from(text($0)) }).toFixed)
        case "decimalToFixed":
            return .string(try DecimalJS(text(1)).toFixed(integer(2), op[3] == .string("up") ? .halfUp : .halfEven))
        case "isInteger": return .bool(try DecimalJS(text(1)).isInteger)
        case "numericColumn":
            return try DecimalMoney.numericColumn(op[1] == .null ? nil : text(1)).map(rendered) ?? .null
        case "median": return RobustStatistics.median(numbers(from: 1)).map(rendered) ?? .null
        case "returnStatistics":
            let statistics = RobustStatistics.returnStatistics(numbers(from: 1))
            return .array(
                [
                    statistics.medianReturn, statistics.robustSigma, statistics.spikeThreshold,
                    statistics.bridgeThreshold, statistics.minimumSpikeMove,
                ].map(rendered))
        case "needle":
            return .bool(
                RobustStatistics.isNeedle(
                    previous: number(1), current: number(2), next: number(3),
                    RobustStatistics.returnStatistics(numbers(from: 4))))
        case "zoneParts":
            let parts = try zone(2).parts(atEpochMilliseconds: integer(1))
            return .array([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(JSValue.int))
        case "zoneInstant":
            let parts = AppTimeZone.Parts(
                year: integer(2), month: integer(3), day: integer(4), hour: integer(5), minute: integer(6),
                second: integer(7))
            return .int(try zone(1).epochMilliseconds(parts))
        case "zoneDay": return .string(try zone(2).day(atEpochMilliseconds: integer(1)))
        case "startOfDay": return .int(try zone(2).startOfDay(text(1)))
        case "epochDay": return .int(try CalendarDays.epochDay(text(1)))
        case "differenceInDays": return .int(try CalendarDays.difference(from: text(1), to: text(2)))
        case "addDays": return .string(try CalendarDays.adding(integer(2), to: text(1)))
        case "firstOfMonth": return .string(try CalendarDays.firstOfMonth(text(1), monthOffset: integer(2)))
        case "utcDay": return .string(try CalendarDays.utcDay(epochMilliseconds: integer(1)))
        default: throw UnknownOperation(name: name)
        }
    }

    /// Whether two rendered doubles are the same or adjacent: the logarithm of the system
    /// library may differ from the JavaScript engine's in the last place.
    private static func adjacent(_ a: JSValue, _ b: JSValue) -> Bool {
        guard case .array(let left) = a, case .array(let right) = b, left.count == right.count else { return false }
        return zip(left, right).allSatisfy { pair in
            let (x, y) = (pair.0.javaScriptNumber, pair.1.javaScriptNumber)
            return x == y || x.nextUp == y || x.nextDown == y
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        #expect(lines.count > 2000)
        var failures: [String] = []
        for line in lines {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"], let expected = recorded["r"] else { continue }
            let actual: JSValue
            do {
                actual = try Self.evaluate(op)
            } catch is UnknownOperation {
                throw PlanFixture.Malformed(what: String(line))
            } catch let error as CalendarDaysError {
                // The engine words its own `RangeError`; the corpus records only that it threw.
                actual = .string(error == CalendarDays.outOfRange ? "error: range" : "error: \(error.message)")
            }
            if actual == expected { continue }
            if op.first == .string("returnStatistics"), Self.adjacent(actual, expected) { continue }
            failures.append("\(line.prefix(300)) gave \(actual.jsonText.prefix(200))")
        }
        #expect(failures.count == 0, "\(failures.count) of \(lines.count) differ:\n\(failures.prefix(40).joined(separator: "\n"))")
    }

    @Test func zoneNamesAreChecked() throws {
        #expect(try AppTimeZone().zone.identifier == "Europe/Brussels")
        #expect(try AppTimeZone(identifier: "").zone.identifier == "Europe/Brussels")
        #expect(throws: AppTimeZone.Invalid(identifier: "Mars/Olympus")) { try AppTimeZone(identifier: "Mars/Olympus") }
    }

    @Test func mixedCurrenciesAreRefused() throws {
        let euros = MoneyAmount(amount: try DecimalJS("1.10"), currency: .eur)
        let dollars = MoneyAmount(amount: try DecimalJS("2"), currency: try CurrencyCode(validating: "USD"))
        #expect(try euros.adding(euros).amount.toFixed == "2.2")
        #expect(throws: CurrencyMismatchError(expected: .eur, actual: dollars.currency)) { try euros.adding(dollars) }
        #expect(try MoneyAmount.sum([], in: .eur).amount.isZero)
    }
}

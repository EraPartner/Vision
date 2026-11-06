import Foundation

/// A SQL function argument of the wrong kind (`intArg`/`textArg` in functions.ts), which
/// carries no SQLSTATE.
public struct SQLFunctionArgumentError: Error, CustomStringConvertible, Sendable {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// The SQLite-value conversions of functions.ts and `toDec` of numeric.ts.
enum SQLArguments {
    /// `toDec`: text and integers are exact; a REAL that is not a whole number is refused,
    /// because it means a NUMERIC value already went through floating point.
    static func decimal(_ value: SQLValue, _ function: String = "decimal") throws -> ExactDecimal? {
        switch value {
        case .null:
            return nil
        case .text(let text):
            return try ExactDecimal.parse(text)
        case .integer(let number):
            return ExactDecimal(coefficient: ExactInteger(number), scale: 0)
        case .real(let number):
            guard number.isFinite else { throw ExactDecimal.invalidSyntax(javaScriptText(number)) }
            if number.rounded(.towardZero) == number {
                // Number.isSafeInteger
                if abs(number) <= 9_007_199_254_740_991 {
                    return ExactDecimal(coefficient: ExactInteger(Int64(number)), scale: 0)
                }
                throw SQLStateError(
                    "\(function): integer \(javaScriptText(number)) is outside the exact range; pass it as text",
                    code: "22003")
            }
            let text = javaScriptText(number)
            throw SQLStateError(
                "\(function): floating-point input \(text) refused; NUMERIC values must stay decimal text "
                    + "(write literals as '\(text)')",
                code: "42804")
        case .blob:
            throw ExactDecimal.invalidSyntax(String(describing: value))
        }
    }

    /// `intArg`: a whole number as an INTEGER, a whole REAL, or digits in text.
    static func integer(_ value: SQLValue, _ function: String) throws -> Int {
        switch value {
        case .integer(let number):
            return Int(number)
        case .real(let number) where number.isFinite && number.rounded(.towardZero) == number:
            return Int(number)
        case .text(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.range(of: #"^-?\d+$"#, options: .regularExpression) != nil, let number = Int(trimmed) {
                return number
            }
        default:
            break
        }
        throw SQLFunctionArgumentError("\(function): expected a whole number, got \(value)")
    }

    /// `textArg`.
    static func text(_ value: SQLValue, _ function: String) throws -> String {
        if case .text(let text) = value { return text }
        throw SQLFunctionArgumentError("\(function): expected text, got \(value)")
    }

    /// JavaScript's `String(number)` for the messages that quote one.
    static func javaScriptText(_ number: Double) -> String {
        if number.isNaN { return "NaN" }
        if number.isInfinite { return number < 0 ? "-Infinity" : "Infinity" }
        if number.rounded(.towardZero) == number, abs(number) < 1e21 { return String(Int64(number)) }
        return String(number)
    }

    static func output(_ value: ExactDecimal?) -> SQLValue {
        value.map { .text($0.description) } ?? .null
    }

    static func bool(_ value: Bool) -> SQLValue { .integer(value ? 1 : 0) }
}

/// Running NUMERIC sum. PostgreSQL's result scale is the largest input scale in the frame, so
/// the state counts values per scale and a window frame that drops the last value of the
/// largest scale shrinks the scale (`SumState` of functions.ts).
final class DecimalSumAccumulator: SQLAggregateAccumulator {
    private let function: String
    private let average: Bool
    private var coefficient = ExactInteger.zero
    private var scale = 0
    private var count = 0
    private var scales: [Int: Int] = [:]

    init(function: String, average: Bool) {
        self.function = function
        self.average = average
    }

    func step(_ arguments: [SQLValue]) throws { try add(arguments.first ?? .null, sign: 1) }
    func inverse(_ arguments: [SQLValue]) throws { try add(arguments.first ?? .null, sign: -1) }

    private func add(_ value: SQLValue, sign: Int) throws {
        guard let decimal = try SQLArguments.decimal(value, function) else { return }
        let target = max(scale, decimal.scale)
        let term = decimal.coefficient.timesPow10(target - decimal.scale)
        coefficient = coefficient.timesPow10(target - scale) + (sign > 0 ? term : -term)
        scale = target
        let seen = (scales[decimal.scale] ?? 0) + sign
        scales[decimal.scale] = seen == 0 ? nil : seen
        count += sign
        if sign < 0 {
            let top = max(0, scales.keys.max() ?? 0)
            if top < scale {
                // Exact: every remaining value has at most `top` decimals.
                coefficient = coefficient / .pow10(scale - top)
                scale = top
            }
        }
    }

    func result() throws -> SQLValue {
        if count == 0 { return .null }
        let sum = ExactDecimal(coefficient: coefficient, scale: scale)
        if !average { return .text(sum.description) }
        let divisor = ExactDecimal(coefficient: ExactInteger(count), scale: 0)
        return .text(try ExactDecimal.divide(sum, divisor).description)
    }
}

/// `dec_max` / `dec_min`.
final class DecimalExtremeAccumulator: SQLAggregateAccumulator {
    private let function: String
    private let larger: Bool
    private var best: ExactDecimal?

    init(function: String, larger: Bool) {
        self.function = function
        self.larger = larger
    }

    func step(_ arguments: [SQLValue]) throws {
        guard let decimal = try SQLArguments.decimal(arguments.first ?? .null, function) else { return }
        guard let current = best else {
            best = decimal
            return
        }
        let order = ExactDecimal.compare(decimal, current)
        if larger ? order > 0 : order < 0 { best = decimal }
    }

    /// Registered without an inverse: SQLite recomputes window frames through `step`.
    func inverse(_ arguments: [SQLValue]) throws {
        throw SQLFunctionArgumentError("\(function) has no inverse transition")
    }

    func result() throws -> SQLValue { SQLArguments.output(best) }
}

extension SQLiteConnection {
    /// The NUMERIC functions of functions.ts (`dec`, `dec_*`, `vision_numeric`,
    /// `vision_numeric_ok`, and the `dec_sum`, `dec_avg`, `dec_max`, `dec_min` aggregates).
    public func registerNumericFunctions() throws {
        typealias A = SQLArguments
        try defineFunction("dec", argumentCount: 1) { args in
            A.output(try A.decimal(args[0]))
        }
        for (name, combine) in [
            ("dec_add", ExactDecimal.add), ("dec_mul", ExactDecimal.multiply),
        ] as [(String, (ExactDecimal, ExactDecimal) throws -> ExactDecimal)] {
            try defineFunction(name, argumentCount: -1) { args in
                var accumulated: ExactDecimal?
                for arg in args {
                    guard let decimal = try A.decimal(arg, name) else { return .null }
                    accumulated = try accumulated.map { try combine($0, decimal) } ?? decimal
                }
                return A.output(accumulated)
            }
        }
        for (name, operation) in [
            ("dec_sub", ExactDecimal.subtract), ("dec_div", ExactDecimal.divide), ("dec_mod", ExactDecimal.modulo),
        ] as [(String, (ExactDecimal, ExactDecimal) throws -> ExactDecimal)] {
            try defineFunction(name, argumentCount: 2) { args in
                guard let x = try A.decimal(args[0], name), let y = try A.decimal(args[1], name) else { return .null }
                return .text(try operation(x, y).description)
            }
        }
        for (name, operation) in [
            ("dec_neg", { $0.negated }), ("dec_abs", { $0.absolute }), ("dec_floor", { $0.floor }),
            ("dec_ceil", { $0.ceiling }),
        ] as [(String, (ExactDecimal) -> ExactDecimal)] {
            try defineFunction(name, argumentCount: 1) { args in
                A.output(try A.decimal(args[0], name).map(operation))
            }
        }
        try defineFunction("dec_round", argumentCount: -1) { args in
            guard let decimal = try A.decimal(args.first ?? .null, "dec_round") else { return .null }
            let scale = args.count > 1 ? args[1] : .integer(0)
            if scale.isNull { return .null }
            return .text(try decimal.rounded(toScale: A.integer(scale, "dec_round")).description)
        }
        try defineFunction("dec_trunc", argumentCount: -1) { args in
            guard let decimal = try A.decimal(args.first ?? .null, "dec_trunc") else { return .null }
            let scale = args.count > 1 ? args[1] : .integer(0)
            if scale.isNull { return .null }
            return .text(decimal.truncated(toScale: try A.integer(scale, "dec_trunc")).description)
        }
        try defineFunction("dec_cmp", argumentCount: 2) { args in
            guard let x = try A.decimal(args[0], "dec_cmp"), let y = try A.decimal(args[1], "dec_cmp") else {
                return .null
            }
            return .integer(Int64(ExactDecimal.compare(x, y)))
        }
        for (name, test) in [
            ("dec_eq", { $0 == 0 }), ("dec_ne", { $0 != 0 }), ("dec_lt", { $0 < 0 }), ("dec_le", { $0 <= 0 }),
            ("dec_gt", { $0 > 0 }), ("dec_ge", { $0 >= 0 }),
        ] as [(String, (Int) -> Bool)] {
            try defineFunction(name, argumentCount: 2) { args in
                guard let x = try A.decimal(args[0], name), let y = try A.decimal(args[1], name) else { return .null }
                return A.bool(test(ExactDecimal.compare(x, y)))
            }
        }
        try defineFunction("dec_sign", argumentCount: 1) { args in
            try A.decimal(args[0], "dec_sign").map { SQLValue.integer(Int64($0.signum)) } ?? .null
        }
        try defineFunction("dec_key", argumentCount: 1) { args in
            try A.decimal(args[0], "dec_key").map { SQLValue.text($0.sortKey) } ?? .null
        }
        try defineFunction("dec_int", argumentCount: 1) { args in
            try A.decimal(args[0], "dec_int").map { SQLValue.integer(try $0.integerValue()) } ?? .null
        }
        try defineFunction("dec_real", argumentCount: 1) { args in
            try A.decimal(args[0], "dec_real").map { SQLValue.real(Double($0.description) ?? .nan) } ?? .null
        }
        for (name, larger) in [("dec_greatest", true), ("dec_least", false)] {
            try defineFunction(name, argumentCount: -1) { args in
                var best: ExactDecimal?
                for arg in args {
                    guard let decimal = try A.decimal(arg, name) else { continue }
                    if let current = best {
                        let order = ExactDecimal.compare(decimal, current)
                        if larger ? order > 0 : order < 0 { best = decimal }
                    } else {
                        best = decimal
                    }
                }
                return A.output(best)
            }
        }
        // NUMERIC(p, s) assignment cast: round half away from zero, refuse overflow.
        try defineFunction("vision_numeric", argumentCount: -1) { args in
            guard let decimal = try A.decimal(args.first ?? .null, "vision_numeric") else { return .null }
            let precision = args.count > 1 ? args[1] : .null
            if precision.isNull { return .text(decimal.description) }
            let scale = args.count > 2 && !args[2].isNull ? args[2] : .integer(0)
            return .text(
                try decimal.coerced(
                    precision: A.integer(precision, "vision_numeric"), scale: A.integer(scale, "vision_numeric")
                ).description)
        }
        // CHECK helper: 1 when the stored text is exactly NUMERIC(p, s) output form.
        try defineFunction("vision_numeric_ok", argumentCount: -1) { args in
            let value = args.first ?? .null
            if value.isNull { return .null }
            guard case .text(let text) = value else { return .integer(0) }
            do {
                let decimal = try ExactDecimal.parse(text)
                let precision = args.count > 1 ? args[1] : .null
                if precision.isNull { return A.bool(decimal.description == text) }
                let scale = args.count > 2 && !args[2].isNull ? args[2] : .integer(0)
                let expected = try decimal.coerced(
                    precision: A.integer(precision, "vision_numeric_ok"), scale: A.integer(scale, "vision_numeric_ok"))
                return A.bool(expected.description == text)
            } catch {
                return .integer(0)
            }
        }
        try defineAggregate("dec_sum", argumentCount: 1) { DecimalSumAccumulator(function: "dec_sum", average: false) }
        try defineAggregate("dec_avg", argumentCount: 1) { DecimalSumAccumulator(function: "dec_avg", average: true) }
        try defineAggregate("dec_max", argumentCount: 1, inverse: false) {
            DecimalExtremeAccumulator(function: "dec_max", larger: true)
        }
        try defineAggregate("dec_min", argumentCount: 1, inverse: false) {
            DecimalExtremeAccumulator(function: "dec_min", larger: false)
        }
    }
}

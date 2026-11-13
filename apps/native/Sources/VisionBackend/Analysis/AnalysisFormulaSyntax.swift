import Foundation

/// A failure the formula engine reports by code (`AnalysisFormulaError`).
struct AnalysisFormulaError: Error, Equatable, Sendable {
    enum Code: String, Sendable {
        case emptyExpression = "EMPTY_EXPRESSION"
        case expressionTooLong = "EXPRESSION_TOO_LONG"
        case invalidToken = "INVALID_TOKEN"
        case invalidSyntax = "INVALID_SYNTAX"
        case unknownFunction = "UNKNOWN_FUNCTION"
        case typeError = "TYPE_ERROR"
        case mixedCurrencies = "MIXED_CURRENCIES"
        case brokenReference = "BROKEN_REFERENCE"
        case dependencyError = "DEPENDENCY_ERROR"
        case currencyProvenanceRequired = "CURRENCY_PROVENANCE_REQUIRED"
        case instrumentProvenanceRequired = "INSTRUMENT_PROVENANCE_REQUIRED"
        case arity = "ARITY"
        case divideByZero = "DIVIDE_BY_ZERO"
        case incompleteInput = "INCOMPLETE_INPUT"
        case insufficientData = "INSUFFICIENT_DATA"
        case numericRange = "NUMERIC_RANGE"
        case expressionTooDeep = "EXPRESSION_TOO_DEEP"
        case nestedAggregate = "NESTED_AGGREGATE"
        case cycle = "CYCLE"
        case rowLimit = "ROW_LIMIT"
        case formulaLimit = "FORMULA_LIMIT"
        case invalidFormula = "INVALID_FORMULA"
        case duplicateFormula = "DUPLICATE_FORMULA"
        case invalidScope = "INVALID_SCOPE"
        case unitMismatch = "UNIT_MISMATCH"
        case missingContributor = "MISSING_CONTRIBUTOR"
        case mixedInstruments = "MIXED_INSTRUMENTS"
        case resultByteLimit = "RESULT_BYTE_LIMIT"
    }

    let code: Code
    let message: String
    /// `formulaId`: the formula's `id` as the request stated it, when the error names one.
    var formula: JSValue?

    init(_ code: Code, _ message: String, formula: JSValue? = nil) {
        self.code = code
        self.message = message
        self.formula = formula
    }
}

/// A string literal `JSON.parse` refuses (an unknown escape, a raw control character). The
/// TypeScript engine lets the engine's `SyntaxError` escape; its message is the engine's own.
struct FormulaStringLiteralError: Error, Equatable, Sendable {
    let literal: String
}

/// An arithmetic or comparison operator of the formula language.
enum FormulaOperator: String, Sendable {
    case add = "+"
    case subtract = "-"
    case multiply = "*"
    case divide = "/"
    case less = "<"
    case lessOrEqual = "<="
    case greater = ">"
    case greaterOrEqual = ">="
    case equal = "=="
    case notEqual = "!="

    var isComparison: Bool {
        switch self {
        case .add, .subtract, .multiply, .divide: return false
        case .less, .lessOrEqual, .greater, .greaterOrEqual, .equal, .notEqual: return true
        }
    }
}

/// `FUNCTIONS`: every function a formula may call, by its upper-case name.
enum FormulaFunction: String, Sendable {
    case conditional = "IF"
    case coalesce = "COALESCE"
    case absolute = "ABS"
    case round = "ROUND"
    case year = "YEAR"
    case month = "MONTH"
    case dateAdd = "DATEADD"
    case dateDifference = "DATEDIFF"
    case sum = "SUM"
    case average = "AVERAGE"
    case minimum = "MIN"
    case maximum = "MAX"
    case count = "COUNT"
    case countIf = "COUNTIF"
    case sumIf = "SUMIF"
    case median = "MEDIAN"
    case standardDeviation = "STDEV"
    case variance = "VARIANCE"
    case netPresentValue = "NPV"
    case presentValue = "PV"
    case futureValue = "FV"
    case payment = "PMT"

    /// `AGGREGATES`: functions that read every row.
    var isAggregate: Bool {
        switch self {
        case .sum, .average, .minimum, .maximum, .count, .countIf, .sumIf, .median, .standardDeviation, .variance:
            return true
        case .conditional, .coalesce, .absolute, .round, .year, .month, .dateAdd, .dateDifference,
            .netPresentValue, .presentValue, .futureValue, .payment:
            return false
        }
    }

    var isFinancial: Bool {
        switch self {
        case .netPresentValue, .presentValue, .futureValue, .payment: return true
        default: return false
        }
    }
}

/// A parsed formula (`FormulaAst`).
indirect enum FormulaExpression: Equatable, Sendable {
    case decimal(DecimalJS)
    case string(String)
    case boolean(Bool)
    case null
    case reference(String)
    case call(FormulaFunction, [FormulaExpression])
    case unary(negate: Bool, FormulaExpression)
    case binary(FormulaOperator, FormulaExpression, FormulaExpression)
}

/// The tokenizer and recursive-descent parser of `analysisFormulaEngine.ts`.
enum FormulaParser {
    static let maximumExpressionLength = 2048

    private enum Symbol: String {
        case open = "("
        case close = ")"
        case comma = ","
        case plus = "+"
        case minus = "-"
        case star = "*"
        case slash = "/"
        case less = "<"
        case greater = ">"
        case lessOrEqual = "<="
        case greaterOrEqual = ">="
        case notEqual = "!="
        case equal = "=="
    }

    private enum Token: Equatable {
        case number(String)
        case string(String)
        case identifier(String)
        case symbol(Symbol)
        case end

        /// `token.value || "end of formula"`.
        var shown: String {
            let value: String
            switch self {
            case .number(let text), .string(let text), .identifier(let text): value = text
            case .symbol(let symbol): value = symbol.rawValue
            case .end: value = ""
            }
            return value.isEmpty ? "end of formula" : value
        }
    }

    private static func isDigit(_ unit: UInt16) -> Bool { unit >= 0x30 && unit <= 0x39 }

    private static func isLetter(_ unit: UInt16) -> Bool {
        (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A) || unit == 0x5F
    }

    /// A line terminator, which `.` in the string pattern does not match.
    private static func isLineTerminator(_ unit: UInt16) -> Bool {
        unit == 0x0A || unit == 0x0D || unit == 0x2028 || unit == 0x2029
    }

    private static func isSpace(_ unit: UInt16) -> Bool {
        Unicode.Scalar(unit).map(JavaScriptWhitespace.contains) ?? false
    }

    private static func text(_ units: ArraySlice<UInt16>) -> String { String(decoding: units, as: UTF16.self) }

    /// `tokenize`: the sticky pattern
    /// `\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|!=|==|[()+\-*/<>,]))`
    /// over UTF-16 code units, so positions in messages are JavaScript string positions.
    private static func tokenize(_ source: JSValue?) throws -> [Token] {
        guard case .string(let expression)? = source, !JavaScriptWhitespace.trim(expression).isEmpty else {
            throw AnalysisFormulaError(.emptyExpression, "Formula expression is required")
        }
        let units = Array(expression.utf16)
        if units.count > maximumExpressionLength {
            throw AnalysisFormulaError(
                .expressionTooLong, "Formula expressions are limited to \(maximumExpressionLength) characters")
        }
        var tokens: [Token] = []
        var offset = 0
        while offset < units.count {
            let invalid = AnalysisFormulaError(.invalidToken, "Unsupported formula syntax at character \(offset + 1)")
            var position = offset
            while position < units.count, isSpace(units[position]) { position += 1 }
            guard position < units.count else { throw invalid }
            let first = units[position]
            if isDigit(first) {
                var end = position
                while end < units.count, isDigit(units[end]) { end += 1 }
                if end + 1 < units.count, units[end] == 0x2E, isDigit(units[end + 1]) {
                    end += 1
                    while end < units.count, isDigit(units[end]) { end += 1 }
                }
                tokens.append(.number(text(units[position..<end])))
                offset = end
            } else if first == 0x22 {
                var end = position + 1
                var closed = false
                while end < units.count {
                    if units[end] == 0x22 {
                        closed = true
                        break
                    }
                    if units[end] == 0x5C {
                        guard end + 1 < units.count, !isLineTerminator(units[end + 1]) else { break }
                        end += 2
                    } else {
                        end += 1
                    }
                }
                guard closed else { throw invalid }
                let literal = text(units[position...end])
                // `JSON.parse(match[2])`
                guard case .string(let value)? = JSValue.parse(literal) else {
                    throw FormulaStringLiteralError(literal: literal)
                }
                tokens.append(.string(value))
                offset = end + 1
            } else if isLetter(first) {
                var end = position + 1
                while end < units.count, isLetter(units[end]) || isDigit(units[end]) || units[end] == 0x2E { end += 1 }
                tokens.append(.identifier(text(units[position..<end])))
                offset = end
            } else {
                let pair = position + 1 < units.count ? Symbol(rawValue: text(units[position...position + 1])) : nil
                if let pair, pair.rawValue.utf16.count == 2 {
                    tokens.append(.symbol(pair))
                    offset = position + 2
                } else if let single = Symbol(rawValue: text(units[position...position])) {
                    tokens.append(.symbol(single))
                    offset = position + 1
                } else {
                    throw invalid
                }
            }
        }
        tokens.append(.end)
        return tokens
    }

    private struct Cursor {
        let tokens: [Token]
        var index = 0

        var peek: Token { index < tokens.count ? tokens[index] : .end }

        func isAt(_ symbol: Symbol) -> Bool { peek == .symbol(symbol) }

        mutating func take(_ symbol: Symbol) throws {
            guard isAt(symbol) else {
                throw AnalysisFormulaError(.invalidSyntax, "Expected \(symbol.rawValue), received \(peek.shown)")
            }
            index += 1
        }

        mutating func primary() throws -> FormulaExpression {
            let token = peek
            switch token {
            case .number(let digits):
                index += 1
                return .decimal(try DecimalJS(digits))
            case .string(let value):
                index += 1
                return .string(value)
            case .identifier(let name):
                index += 1
                let upper = name.uppercased()
                if isAt(.open) {
                    guard let function = FormulaFunction(rawValue: upper) else {
                        throw AnalysisFormulaError(.unknownFunction, "Unsupported function: \(name)")
                    }
                    try take(.open)
                    var arguments: [FormulaExpression] = []
                    if !isAt(.close) {
                        while true {
                            arguments.append(try comparison())
                            guard isAt(.comma) else { break }
                            try take(.comma)
                        }
                    }
                    try take(.close)
                    return .call(function, arguments)
                }
                switch Keyword(rawValue: upper) {
                case .yes: return .boolean(true)
                case .no: return .boolean(false)
                case .null: return .null
                case nil: return .reference(name)
                }
            case .symbol(.open):
                try take(.open)
                let value = try comparison()
                try take(.close)
                return value
            case .symbol(.minus), .symbol(.plus):
                index += 1
                return .unary(negate: token == .symbol(.minus), try primary())
            case .symbol, .end:
                throw AnalysisFormulaError(.invalidSyntax, "Unexpected token: \(token.shown)")
            }
        }

        private enum Keyword: String {
            case yes = "TRUE"
            case no = "FALSE"
            case null = "NULL"
        }

        /// The operator at the cursor when it is one of `operators`.
        private func binaryOperator(_ operators: [Symbol]) -> FormulaOperator? {
            guard case .symbol(let symbol) = peek, operators.contains(symbol) else { return nil }
            return FormulaOperator(rawValue: symbol.rawValue)
        }

        mutating func product() throws -> FormulaExpression {
            var left = try primary()
            while let op = binaryOperator([.star, .slash]) {
                index += 1
                left = .binary(op, left, try primary())
            }
            return left
        }

        mutating func sum() throws -> FormulaExpression {
            var left = try product()
            while let op = binaryOperator([.plus, .minus]) {
                index += 1
                left = .binary(op, left, try product())
            }
            return left
        }

        mutating func comparison() throws -> FormulaExpression {
            var left = try sum()
            while let op = binaryOperator([.less, .lessOrEqual, .greater, .greaterOrEqual, .equal, .notEqual]) {
                index += 1
                left = .binary(op, left, try sum())
            }
            return left
        }
    }

    /// `parseExpression(source)`.
    static func parse(_ source: JSValue?) throws -> FormulaExpression {
        var cursor = Cursor(tokens: try tokenize(source))
        let expression = try cursor.comparison()
        guard cursor.peek == .end else {
            throw AnalysisFormulaError(.invalidSyntax, "Expected eof, received \(cursor.peek.shown)")
        }
        return expression
    }
}

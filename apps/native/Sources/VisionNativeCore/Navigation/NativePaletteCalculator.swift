import Foundation

/// The command palette's inline answers (`lib/commandPalette.ts` and
/// `lib/nativePaletteAnswer.ts`) without a web document: locale-aware arithmetic and
/// currency conversion. The arithmetic accepts exactly what the source's guarded
/// `new Function("return (…)")` evaluation accepts for the characters its pattern admits,
/// including JavaScript's `**`, comma operator and block comments.
public enum NativePaletteCalculator {
    public struct FXQuery: Equatable, Sendable {
        public let amount: Double
        public let from: String
        public let to: String?
    }

    // `FX_QUERY`; JavaScript's `\d` is ASCII only.
    private static let fxPattern = try! NSRegularExpression(
        pattern: #"^([0-9.,'’]+)\s*([a-zA-Z]{3})(?:\s+(?:in|to|naar)\s+([a-zA-Z]{3}))?$"#)
    // `CALC_QUERY`.
    private static let calcCharacters = Set("0123456789+-*/()., \t\n\r'’")

    /// `parseFxQuery`.
    public static func parseFX(_ query: String, format: NumberFormat) -> FXQuery? {
        let range = NSRange(query.startIndex..., in: query)
        guard let match = fxPattern.firstMatch(in: query, range: range),
            let amountRange = Range(match.range(at: 1), in: query),
            let fromRange = Range(match.range(at: 2), in: query),
            let amount = number(String(query[amountRange]), format: format)
        else { return nil }
        let to = Range(match.range(at: 3), in: query).map { query[$0].uppercased() }
        return FXQuery(amount: amount, from: query[fromRange].uppercased(), to: to)
    }

    /// `evaluateArithmetic`: a finite result or `nil`.
    public static func evaluate(_ query: String, format: NumberFormat) -> Double? {
        guard !query.isEmpty, query.allSatisfy({ calcCharacters.contains($0) || $0.isWhitespace })
        else { return nil }
        guard query.contains(where: { "+-*/".contains($0) }), query.contains(where: { $0.isASCII && $0.isNumber })
        else { return nil }
        if query.allSatisfy({ $0.isWhitespace || $0.isNumber || $0 == "." || $0 == "," }) { return nil }
        guard let tokens = tokenize(query, format: format) else { return nil }
        var parser = Parser(tokens: tokens)
        guard let value = parser.parseProgram(), value.isFinite else { return nil }
        return value
    }

    /// `nativePaletteAnswer`: arithmetic first unless the query is a conversion; a missing
    /// rate keeps the source amount, as `useCurrencyConverter` does. Only stored rates convert.
    public static func answer(
        query: String, format: NumberFormat, currency: String, decimals: Int,
        readRates: @Sendable () async -> OpenAPI.ExchangeRates?
    ) async -> NativeCommandPaletteAnswer? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let fx = parseFX(trimmed, format: format) else {
            guard let value = evaluate(trimmed, format: format) else { return nil }
            return NativeCommandPaletteAnswer(kind: .arithmetic, text: formatArithmetic(value, locale: format.locale))
        }
        let target = fx.to ?? currency
        if fx.from == target { return nil }
        let data = await readRates()
        var rates: [String: Double] = [:]
        rates["EUR"] = 1
        for row in data?.rates ?? [] { rates[row.currency] = double(row.rateToEur) }
        let fromRate = rates[fx.from.uppercased()] ?? 0
        let toRate = rates[target.uppercased()] ?? 0
        let usable = { (rate: Double) in rate != 0 && !rate.isNaN }
        let value = usable(fromRate) && usable(toRate) ? fx.amount * fromRate / toRate : fx.amount
        guard value.isFinite else { return nil }
        return NativeCommandPaletteAnswer(
            kind: .fx, text: formatCurrency(value, code: target, locale: format.locale, decimals: decimals))
    }

    // MARK: Formatting

    /// `new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value)`.
    static func formatArithmetic(_ value: Double, locale: Locale) -> String {
        let decimal = Decimal(string: jsString(abs(value))) ?? Decimal(abs(value))
        let text = decimal.formatted(
            Decimal.FormatStyle(locale: locale).precision(.fractionLength(0...6))
                .rounded(rule: .toNearestOrAwayFromZero))
        return value.sign == .minus ? "-" + text : text
    }

    /// `formatCurrency`, whose `Intl` constructor throws for a malformed code or digit
    /// count; the source then shows the amount with two decimals and the code.
    static func formatCurrency(_ value: Double, code: String, locale: Locale, decimals: Int) -> String {
        let wellFormed = code.count == 3 && code.allSatisfy { $0.isASCII && $0.isLetter }
        guard wellFormed, (0...20).contains(decimals), let amount = Decimal(string: jsString(value)) else {
            return String(format: "%.2f", value) + " " + code
        }
        return VisionFormat.currency(amount, code: code.uppercased(), locale: locale, fractionDigits: decimals)
    }

    /// `String(number)` for the finite values the evaluator produces.
    static func jsString(_ value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e21 { return String(format: "%.0f", value) }
        return "\(value)"
    }

    private static func double(_ value: Decimal) -> Double {
        Double(NSDecimalNumber(decimal: value).stringValue) ?? .nan
    }

    /// `parseLocaleNumber` as a JavaScript number.
    private static func number(_ text: String, format: NumberFormat) -> Double? {
        guard let value = LocaleNumber.parse(text, format: format) else { return nil }
        let double = double(value)
        return double.isFinite ? double : nil
    }

    // MARK: Lexing

    enum Token: Equatable {
        case number(Double)
        case plus, minus, star, slash, power, comma, open, close
    }

    /// The source replaces each digit-led run of `[0-9.,'’]` with `String(value)` and lets
    /// JavaScript lex the rest; this lexes the same text directly.
    static func tokenize(_ query: String, format: NumberFormat) -> [Token]? {
        let characters = Array(query)
        var tokens: [Token] = []
        var index = 0
        func isNumberCharacter(_ character: Character) -> Bool {
            character.isASCII && character.isNumber || ".,'’".contains(character)
        }
        while index < characters.count {
            let character = characters[index]
            if character.isWhitespace {
                index += 1
            } else if character.isASCII, character.isNumber {
                var end = index
                while end < characters.count, isNumberCharacter(characters[end]) { end += 1 }
                guard let value = number(String(characters[index..<end]), format: format) else { return nil }
                tokens.append(.number(value))
                index = end
            } else if character == "." {
                // `.5`: JavaScript reads the dot and the replaced digits as one literal.
                var end = index + 1
                guard end < characters.count, characters[end].isASCII, characters[end].isNumber else { return nil }
                while end < characters.count, isNumberCharacter(characters[end]) { end += 1 }
                guard let value = number(String(characters[(index + 1)..<end]), format: format) else { return nil }
                let digits = jsString(value)
                guard digits.allSatisfy(\.isNumber), let literal = Double("0." + digits) else { return nil }
                tokens.append(.number(literal))
                index = end
            } else if character == "/", index + 1 < characters.count, characters[index + 1] == "*" {
                // A block comment is whitespace; an unterminated one is a syntax error.
                var end = index + 2
                while end + 1 < characters.count, !(characters[end] == "*" && characters[end + 1] == "/") { end += 1 }
                guard end + 1 < characters.count else { return nil }
                index = end + 2
            } else if character == "/", index + 1 < characters.count, characters[index + 1] == "/" {
                // A line comment swallows the closing parenthesis of the wrapper.
                return nil
            } else if character == "*", index + 1 < characters.count, characters[index + 1] == "*" {
                tokens.append(.power)
                index += 2
            } else if (character == "+" || character == "-"), index + 1 < characters.count,
                characters[index + 1] == character
            {
                // `++` and `--` on a literal are syntax errors.
                return nil
            } else {
                switch character {
                case "+": tokens.append(.plus)
                case "-": tokens.append(.minus)
                case "*": tokens.append(.star)
                case "/": tokens.append(.slash)
                case ",": tokens.append(.comma)
                case "(": tokens.append(.open)
                case ")": tokens.append(.close)
                default: return nil
                }
                index += 1
            }
        }
        return tokens
    }

    // MARK: Parsing

    /// JavaScript precedence: comma < additive < multiplicative < unary < exponent, `**`
    /// right-associative with no unary operand on its left. A literal or parenthesis
    /// followed by `(` is a call, which throws at run time.
    struct Parser {
        let tokens: [Token]
        var position = 0

        init(tokens: [Token]) { self.tokens = tokens }

        private var current: Token? { position < tokens.count ? tokens[position] : nil }

        mutating func parseProgram() -> Double? {
            guard let value = parseComma(), position == tokens.count else { return nil }
            return value
        }

        private mutating func parseComma() -> Double? {
            guard var value = parseAdditive() else { return nil }
            while current == .comma {
                position += 1
                guard let next = parseAdditive() else { return nil }
                value = next
            }
            return value
        }

        private mutating func parseAdditive() -> Double? {
            guard var value = parseMultiplicative() else { return nil }
            while let token = current, token == .plus || token == .minus {
                position += 1
                guard let right = parseMultiplicative() else { return nil }
                value = token == .plus ? value + right : value - right
            }
            return value
        }

        private mutating func parseMultiplicative() -> Double? {
            guard var value = parseExponent() else { return nil }
            while let token = current, token == .star || token == .slash {
                position += 1
                guard let right = parseExponent() else { return nil }
                value = token == .star ? value * right : value / right
            }
            return value
        }

        /// ExponentiationExpression: a unary expression, which must not be followed by
        /// `**` (`-2 ** 2` is a SyntaxError), or a primary with a right-associative `**`.
        private mutating func parseExponent() -> Double? {
            if current == .plus || current == .minus {
                guard let value = parseUnary(), current != .power else { return nil }
                return value
            }
            guard let base = parsePrimary() else { return nil }
            guard current == .power else { return base }
            position += 1
            guard let exponent = parseExponent() else { return nil }
            return Self.power(base, exponent)
        }

        private mutating func parseUnary() -> Double? {
            let negate = current == .minus
            position += 1
            let operand = current == .plus || current == .minus ? parseUnary() : parsePrimary()
            guard let operand else { return nil }
            return negate ? -operand : operand
        }

        private mutating func parsePrimary() -> Double? {
            let value: Double
            switch current {
            case .number(let number)?:
                position += 1
                value = number
            case .open?:
                position += 1
                guard let inner = parseComma(), current == .close else { return nil }
                position += 1
                value = inner
            default:
                return nil
            }
            // `2(3)` or `(2)(3)`: a call on a number throws.
            if current == .open { return nil }
            return value
        }

        /// `Math.pow` semantics for the cases `pow` differs on: `1 ** ±∞` and `x ** NaN`.
        static func power(_ base: Double, _ exponent: Double) -> Double {
            if exponent.isNaN { return .nan }
            if abs(base) == 1, exponent.isInfinite { return .nan }
            return Foundation.pow(base, exponent)
        }
    }
}

/// The palette's rate reads: `fetchQuery` on the shared exchange-rate key with a 10-minute
/// stale time, the last answer kept after a failed refetch, overlapping reads joined.
public actor NativePaletteRates {
    private let load: @Sendable () async throws -> OpenAPI.ExchangeRates
    private let now: @Sendable () -> Date
    private var cached: (value: OpenAPI.ExchangeRates, at: Date)?
    private var inFlight: Task<OpenAPI.ExchangeRates?, Never>?

    public static let staleAfter: TimeInterval = 600

    public init(
        load: @escaping @Sendable () async throws -> OpenAPI.ExchangeRates,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.load = load
        self.now = now
    }

    public func read() async -> OpenAPI.ExchangeRates? {
        if let cached, now().timeIntervalSince(cached.at) <= Self.staleAfter { return cached.value }
        if let inFlight { return await inFlight.value }
        let load = self.load
        let task = Task { () -> OpenAPI.ExchangeRates? in try? await load() }
        inFlight = task
        let fresh = await task.value
        inFlight = nil
        if let fresh {
            cached = (fresh, now())
            return fresh
        }
        return cached?.value
    }
}

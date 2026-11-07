import Foundation

extension SQLiteConnection {
    /// The text, jsonb, UUID, GREATEST/LEAST, trim and math functions of functions.ts.
    public func registerTextFunctions() throws {
        typealias A = SQLArguments
        /// `typeof value === "string" ? value : String(value)`.
        func textOf(_ value: SQLValue) -> String {
            switch value {
            case .text(let text): return text
            case .integer(let number): return String(number)
            case .real(let number): return A.javaScriptText(number)
            default: return value.description
            }
        }
        // `X LIKE Y [ESCAPE Z]` calls like(Y, X[, Z]). Fixed arities so they replace SQLite's
        // own case-insensitive like().
        try defineFunction("like", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return A.bool(try SQLText.like(textOf(args[1]), textOf(args[0])))
        }
        try defineFunction("like", argumentCount: 3) { args in
            if args.contains(where: \.isNull) { return .null }
            return A.bool(try SQLText.like(textOf(args[1]), textOf(args[0]), escape: textOf(args[2])))
        }
        try defineFunction("ilike", argumentCount: -1) { args in
            guard args.count >= 2 else { throw SQLFunctionArgumentError("ilike: expected a value and a pattern") }
            let escape = args.count > 2 ? args[2] : .text("\\")
            if args[0].isNull || args[1].isNull || escape.isNull { return .null }
            return A.bool(try SQLText.ilike(textOf(args[0]), textOf(args[1]), escape: textOf(escape)))
        }
        // `X REGEXP Y` calls regexp(Y, X).
        try defineFunction("regexp", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return A.bool(try SQLText.regexpMatch(textOf(args[0]), textOf(args[1])))
        }
        try defineFunction("regexp_i", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return A.bool(try SQLText.regexpMatch(textOf(args[1]), textOf(args[0]), insensitive: true))
        }
        try defineFunction("similarity", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return .real(SQLText.similarity(textOf(args[0]), textOf(args[1])))
        }
        try defineFunction("json_contains", argumentCount: 2) { args in
            if args[0].isNull || args[1].isNull { return .null }
            return A.bool(try SQLJsonb.contains(A.text(args[0], "json_contains"), A.text(args[1], "json_contains")))
        }
        // `x::jsonb` for text and `to_jsonb(x)` for numbers.
        try defineFunction("vision_jsonb", argumentCount: 1) { args in
            switch args[0] {
            case .null: return .null
            case .text(let text): return .text(try SQLJsonb.canonicalText(text))
            case .integer(let number): return .text(String(number))
            case .real(let number):
                // to_jsonb(double precision) reads float8out text back as a numeric.
                let text = A.javaScriptText(number)
                return .text(number.isFinite ? try SQLJsonb.canonicalText(text) : SQLJsonb.quote(text))
            case .blob: throw SQLStateError("vision_jsonb: a blob is not jsonb", code: "42804")
            }
        }
        // CHECK helper: 1 when the stored text is exactly PostgreSQL's jsonb output.
        try defineFunction("vision_jsonb_ok", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            guard case .text(let text) = args[0] else { return .integer(0) }
            return A.bool(SQLJsonb.isCanonicalText(text))
        }
        try defineFunction("vision_uuid_ok", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            guard case .text(let text) = args[0] else { return .integer(0) }
            return A.bool(Self.isUUIDText(text))
        }
        try defineFunction("vision_array_ok", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            guard case .text(let text) = args[0] else { return .integer(0) }
            return A.bool(Self.isCanonicalArrayText(text))
        }
        try defineFunction("gen_random_uuid", argumentCount: 0, deterministic: false) { _ in
            .text(UUID().uuidString.lowercased())
        }
        for (name, larger) in [("greatest", true), ("least", false)] {
            try defineFunction(name, argumentCount: -1) { args in
                var best: SQLValue = .null
                for value in args where !value.isNull {
                    if best.isNull {
                        best = value
                        continue
                    }
                    let order = Self.compareSQLValues(value, best)
                    if larger ? order > 0 : order < 0 { best = value }
                }
                return best
            }
        }
        try defineFunction("btrim", argumentCount: -1) { args in
            guard let value = args.first else { return .null }
            let chars = args.count > 1 ? args[1] : .text(" ")
            if value.isNull || chars.isNull { return .null }
            let set = Set(textOf(chars).unicodeScalars)
            var scalars = Array(textOf(value).unicodeScalars)[...]
            while let first = scalars.first, set.contains(first) { scalars = scalars.dropFirst() }
            while let last = scalars.last, set.contains(last) { scalars = scalars.dropLast() }
            return .text(String(String.UnicodeScalarView(scalars)))
        }
        // Math: SQLite's math functions are a compile option. An INTEGER keeps its type
        // through floor/ceil/sign.
        func number(_ value: SQLValue) -> Double {
            switch value {
            case .integer(let number): return Double(number)
            case .real(let number): return number
            case .text(let text): return Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? .nan
            default: return .nan
            }
        }
        func finite(_ value: Double) -> SQLValue { value.isFinite ? .real(value) : .null }
        for (name, operation, keepsInteger) in [
            ("floor", { Foundation.floor($0) }, true), ("ceil", { Foundation.ceil($0) }, true),
            ("ceiling", { Foundation.ceil($0) }, true), ("sqrt", { $0.squareRoot() }, false),
            ("ln", { Foundation.log($0) }, false), ("exp", { Foundation.exp($0) }, false),
            ("log10", { Foundation.log10($0) }, false),
        ] as [(String, (Double) -> Double, Bool)] {
            try defineFunction(name, argumentCount: 1) { args in
                if args[0].isNull { return .null }
                if keepsInteger, case .integer = args[0] { return args[0] }
                return finite(operation(number(args[0])))
            }
        }
        try defineFunction("sign", argumentCount: 1) { args in
            switch args[0] {
            case .null: return .null
            case .integer(let value): return .integer(value.signum())
            default:
                let value = number(args[0])
                if value.isNaN { return .null }
                return .real(value > 0 ? 1 : (value < 0 ? -1 : value))
            }
        }
        for name in ["power", "pow"] {
            try defineFunction(name, argumentCount: 2) { args in
                if args[0].isNull || args[1].isNull { return .null }
                return finite(Foundation.pow(number(args[0]), number(args[1])))
            }
        }
    }

    static func isUUIDText(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 36 else { return false }
        for (index, byte) in bytes.enumerated() {
            if [8, 13, 18, 23].contains(index) {
                if byte != 0x2D { return false }
            } else if !((byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)) {
                return false
            }
        }
        return true
    }

    /// A JSON array of strings, or of safe integers, with NULLs allowed, written exactly as
    /// `JSON.stringify` writes it.
    static func isCanonicalArrayText(_ text: String) -> Bool {
        // lint:allow explicit-any JSONSerialization returns untyped arrays
        guard let items = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) as? [Any]
        else { return false }
        let present = items.filter { !($0 is NSNull) }
        let allStrings = present.allSatisfy { $0 is String }
        let allIntegers = present.allSatisfy { item in
            guard let number = item as? NSNumber, !(item is String), CFGetTypeID(number) != CFBooleanGetTypeID() else {
                return false
            }
            let value = number.doubleValue
            return value.rounded(.towardZero) == value && abs(value) <= 9_007_199_254_740_991
        }
        guard allStrings || allIntegers else { return false }
        let rendered = items.map { item -> String in
            if item is NSNull { return "null" }
            if let string = item as? String { return Self.jsonStringify(string) }
            return String(Int64((item as? NSNumber)?.doubleValue ?? 0))
        }
        return "[" + rendered.joined(separator: ",") + "]" == text
    }

    /// `JSON.stringify(string)`: `"`, `\`, \b \f \n \r \t, other control characters as `\u00xx`
    /// and lone surrogates escaped; everything else as is.
    static func jsonStringify(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    /// SQLite's ordering of values: numbers, then text (bytewise), then blobs.
    static func compareSQLValues(_ a: SQLValue, _ b: SQLValue) -> Int {
        func rank(_ value: SQLValue) -> Int {
            switch value {
            case .text: return 1
            case .blob: return 2
            default: return 0
            }
        }
        let ra = rank(a)
        let rb = rank(b)
        if ra != rb { return ra < rb ? -1 : 1 }
        func sign<T: Comparable>(_ x: T, _ y: T) -> Int { x < y ? -1 : (x > y ? 1 : 0) }
        switch (a, b) {
        case (.text(let x), .text(let y)): return SQLText.compareCodePoints(x, y)
        case (.blob(let x), .blob(let y)):
            for index in 0..<min(x.count, y.count) where x[index] != y[index] { return x[index] < y[index] ? -1 : 1 }
            return sign(x.count, y.count)
        case (.integer(let x), .integer(let y)): return sign(x, y)
        case (.real(let x), .real(let y)): return sign(x, y)
        case (.integer(let x), .real(let y)): return compareIntegerReal(x, y)
        case (.real(let x), .integer(let y)): return -compareIntegerReal(y, x)
        default: return 0
        }
    }

    /// An exact comparison of an INTEGER with a REAL.
    private static func compareIntegerReal(_ a: Int64, _ b: Double) -> Int {
        if b == .infinity { return -1 }
        if b == -.infinity { return 1 }
        if b.isNaN { return 0 }
        let floor = b.rounded(.down)
        guard floor > -9.3e18, floor < 9.3e18 else { return floor > 0 ? -1 : 1 }
        let difference = ExactInteger(a) - ExactInteger(Int64(floor))
        if difference.signum != 0 { return difference.signum }
        return floor == b ? 0 : -1
    }
}

import Foundation

/// One zod issue: its path, its English message, and zod's `continue` flag. `continues` is
/// `continue === true` (the parse may still run later checks); `stops` is `continue === false`
/// (even checks with their own `when` are skipped). Neither is zod's implicit abort.
struct ZodIssue: Equatable, Sendable {
    enum PathElement: Equatable, Sendable {
        case key(String)
        case index(Int)

        var text: String {
            switch self {
            case .key(let key): return key
            case .index(let index): return String(index)
            }
        }
    }

    var path: [PathElement] = []
    var message: String
    var continues = false
    var stops = false
    /// zod's `unrecognized_keys`: the one issue a pipe lets through to its transform.
    var isUnrecognizedKeys = false

    /// `formatZodIssues`: `path: message`, or the message at the root.
    var formatted: String {
        path.isEmpty ? message : path.map(\.text).joined(separator: ".") + ": " + message
    }

    func prefixed(_ element: PathElement) -> ZodIssue {
        var copy = self
        copy.path.insert(element, at: 0)
        return copy
    }
}

/// A zod parse in progress: the value (nil is `undefined`) and the issues so far.
struct ZodPayload {
    var value: JSValue?
    var issues: [ZodIssue] = []

    /// `util.aborted`: some issue does not say `continue: true`.
    func aborted(from start: Int = 0) -> Bool { issues[start...].contains { !$0.continues } }
    /// `util.explicitlyAborted`: some issue says `continue: false`.
    var explicitlyAborted: Bool { issues.contains { $0.stops } }
}

/// A check run after a schema's own parse (`_zod.check`), in declaration order.
struct ZodCheck: Sendable {
    /// zod's `when`: nil runs the check unless the parse already aborted.
    let when: (@Sendable (JSValue?) -> Bool)?
    /// Issues for the current value; the output value cannot change.
    let run: @Sendable (JSValue?) -> [ZodIssue]
    /// A length check (`_length` / `_size`): a leading run of them may cap an array's size.
    var isLengthCheck = false
    /// A max-length check: an oversized array fails it before its elements parse.
    var sizeCap: Int?
}

/// A zod 4.6 schema, as far as the routes use them, with zod's messages, issue order,
/// abort rules and output values (`z.looseObject` keeps unknown keys, `z.object` strips them).
indirect enum Zod: Sendable {
    case unknown
    case string
    case number
    case boolean
    /// `z.never()`: every value fails.
    case never
    case literal(JSValue)
    case enumeration([String])
    case arrayOf(Zod)
    case object([(String, Zod)], UnknownKeys)
    /// `z.record(key, value)`; `partial` is `z.partialRecord` over an enum.
    case record(key: Zod, value: Zod, partial: Bool)
    case optionalOf(Zod)
    case nullableOf(Zod)
    case checked(Zod, [ZodCheck])
    /// `schema.transform(fn)`: fn may add issues and returns the new value.
    case transform(Zod, @Sendable (JSValue?, inout [ZodIssue]) -> JSValue?)
    /// A schema built with `{ error: message }`: the issues its own parse raises carry the
    /// message instead of zod's. Wrap only a schema without children or checks, whose issues
    /// are all its own (`z.string({ error })`, `z.enum(values, { error })`).
    case errored(Zod, String)

    enum UnknownKeys: Sendable {
        case strip
        case loose
        case strict
    }

    // MARK: - Builders

    static func looseObject(_ shape: [(String, Zod)]) -> Zod { .object(shape, .loose) }
    static func strictObject(_ shape: [(String, Zod)]) -> Zod { .object(shape, .strict) }

    func check(_ checks: ZodCheck...) -> Zod {
        if case .checked(let inner, let existing) = self { return .checked(inner, existing + checks) }
        return .checked(self, checks)
    }

    var optional: Zod { .optionalOf(self) }
    var nullable: Zod { .nullableOf(self) }
    var nullish: Zod { .optionalOf(.nullableOf(self)) }

    // MARK: - Optionality (`optin` / `optout`)

    /// zod's `optin` is set: an absent key is acceptable input. A bare `z.unknown()` has none,
    /// so an absent key fails it as `nonoptional`; a pipe takes its input side's.
    var acceptsAbsent: Bool {
        switch self {
        case .optionalOf: return true
        case .nullableOf(let inner), .checked(let inner, _), .errored(let inner, _): return inner.acceptsAbsent
        case .transform(let inner, _): return inner.acceptsAbsent
        default: return false
        }
    }

    /// zod's `optout == "optional"`: an absent key may stay absent in the output. A pipe takes
    /// its output side's, and a transform has none.
    var mayOmit: Bool {
        switch self {
        case .optionalOf: return true
        case .nullableOf(let inner), .checked(let inner, _), .errored(let inner, _): return inner.mayOmit
        default: return false
        }
    }

    // MARK: - Parsing

    /// `schema.safeParse(value)`: the output value, or the issues.
    func parse(_ value: JSValue?) -> Result<JSValue?, ZodFailure> {
        let payload = run(ZodPayload(value: value))
        return payload.issues.isEmpty ? .success(payload.value) : .failure(ZodFailure(issues: payload.issues))
    }

    func run(_ input: ZodPayload) -> ZodPayload {
        var payload = input
        switch self {
        case .unknown:
            return payload
        case .string:
            if case .string? = payload.value { return payload }
            payload.issues.append(Self.invalidType("string", payload.value))
        case .number:
            if case .number(let number)? = payload.value, number.isFinite { return payload }
            payload.issues.append(Self.invalidType("number", payload.value))
        case .boolean:
            if case .bool? = payload.value { return payload }
            payload.issues.append(Self.invalidType("boolean", payload.value))
        case .never:
            payload.issues.append(Self.invalidType("never", payload.value))
        case .errored(let inner, let message):
            let start = payload.issues.count
            payload = inner.run(payload)
            for index in payload.issues.indices[start...] { payload.issues[index].message = message }
        case .literal(let literal):
            if payload.value == literal { return payload }
            payload.issues.append(ZodIssue(message: "Invalid input: expected \(Self.primitive(literal))"))
        case .enumeration(let values):
            if let text = payload.value?.stringValue, values.contains(text) { return payload }
            let message =
                values.count == 1
                ? "Invalid input: expected \"\(values[0])\""
                : "Invalid option: expected one of " + values.map { "\"\($0)\"" }.joined(separator: "|")
            payload.issues.append(ZodIssue(message: message))
        case .arrayOf(let element):
            guard case .array(let items)? = payload.value else {
                payload.issues.append(Self.invalidType("array", payload.value))
                return payload
            }
            var output: [JSValue] = []
            for (index, item) in items.enumerated() {
                let result = element.run(ZodPayload(value: item))
                payload.issues += result.issues.map { $0.prefixed(.index(index)) }
                output.append(result.value ?? .null)
            }
            payload.value = .array(output)
        case .object(let shape, let unknownKeys):
            return Self.parseObject(payload, shape: shape, unknownKeys: unknownKeys)
        case .record(let key, let value, let partial):
            return Self.parseRecord(payload, key: key, value: value, partial: partial)
        case .optionalOf(let inner):
            if payload.value == nil { return payload }
            return inner.run(payload)
        case .nullableOf(let inner):
            if payload.value == .null { return payload }
            return inner.run(payload)
        case .checked(let inner, let checks):
            if case .array(let items)? = payload.value {
                // `capSize`: an array over a max of the leading length checks fails it unparsed.
                for check in checks {
                    guard check.isLengthCheck else { break }
                    if let cap = check.sizeCap, items.count > cap {
                        var issues = check.run(payload.value)
                        if !issues.isEmpty {
                            issues[0].continues = false
                            issues[0].stops = true
                        }
                        payload.issues += issues
                        return payload
                    }
                }
            }
            payload = inner.run(payload)
            return Self.runChecks(payload, checks)
        case .transform(let inner, let transform):
            // `handlePipeResult`: any issue but an unrecognized key stops the pipe.
            payload = inner.run(payload)
            if payload.issues.contains(where: { !$0.isUnrecognizedKeys }) { return payload }
            var issues: [ZodIssue] = []
            let output = transform(payload.value, &issues)
            payload.issues += issues
            payload.value = output
        }
        return payload
    }

    /// `runChecks` of `$ZodType`.
    static func runChecks(_ input: ZodPayload, _ checks: [ZodCheck]) -> ZodPayload {
        var payload = input
        var isAborted = payload.aborted()
        for check in checks {
            if let when = check.when {
                if payload.explicitlyAborted { continue }
                if !when(payload.value) { continue }
            } else if isAborted {
                continue
            }
            let start = payload.issues.count
            payload.issues += check.run(payload.value)
            if payload.issues.count != start, !isAborted { isAborted = payload.aborted(from: start) }
        }
        return payload
    }

    static func parseObject(_ input: ZodPayload, shape: [(String, Zod)], unknownKeys: UnknownKeys) -> ZodPayload {
        var payload = input
        guard case .object(let object)? = payload.value else {
            payload.issues.append(invalidType("object", payload.value))
            return payload
        }
        var output = JSObject()
        for (key, schema) in shape where key != "__proto__" {
            // `handlePropertyResult`, with no defaulted schemas: an absent optional key adds nothing.
            let isPresent = object.has(key)
            if !isPresent, schema.mayOmit, schema.acceptsAbsent { continue }
            let result = schema.run(ZodPayload(value: object[key]))
            if !result.issues.isEmpty {
                payload.issues += result.issues.map { $0.prefixed(.key(key)) }
            }
            if !isPresent, !schema.acceptsAbsent {
                if result.issues.isEmpty {
                    payload.issues.append(
                        ZodIssue(path: [.key(key)], message: "Invalid input: expected nonoptional, received undefined"))
                }
                continue
            }
            if let value = result.value {
                output[key] = value
            }
        }
        let declared = Set(shape.map(\.0))
        var unrecognized: [String] = []
        for (key, value) in object.entries where !declared.contains(key) {
            switch unknownKeys {
            case .strip: continue
            case .loose: if key != "__proto__" { output[key] = value }
            case .strict: unrecognized.append(key)
            }
        }
        if !unrecognized.isEmpty {
            payload.issues.append(unrecognizedKeysIssue(unrecognized))
        }
        payload.value = .object(output)
        return payload
    }

    static func parseRecord(_ input: ZodPayload, key keySchema: Zod, value valueSchema: Zod, partial: Bool)
        -> ZodPayload
    {
        var payload = input
        guard case .object(let object)? = payload.value else {
            payload.issues.append(invalidType("record", payload.value))
            return payload
        }
        var output = JSObject()
        var unrecognized: [String] = []
        let enumerable: Bool
        if case .enumeration = keySchema { enumerable = true } else { enumerable = false }
        if enumerable, !partial, case .enumeration(let values) = keySchema {
            for key in values where key != "__proto__" {
                let result = valueSchema.run(ZodPayload(value: object[key]))
                payload.issues += result.issues.map { $0.prefixed(.key(key)) }
                if let value = result.value { output[key] = value }
            }
            for key in object.keys where !values.contains(key) { unrecognized.append(key) }
        } else {
            for (key, value) in object.entries where key != "__proto__" {
                let keyResult = keySchema.run(ZodPayload(value: .string(key)))
                if !keyResult.issues.isEmpty {
                    if enumerable {
                        unrecognized.append(key)
                    } else {
                        payload.issues.append(ZodIssue(path: [.key(key)], message: "Invalid key in record"))
                    }
                    continue
                }
                let result = valueSchema.run(ZodPayload(value: value))
                payload.issues += result.issues.map { $0.prefixed(.key(key)) }
                if let parsed = result.value { output[key] = parsed }
            }
        }
        if !unrecognized.isEmpty {
            payload.issues.append(unrecognizedKeysIssue(unrecognized))
        }
        payload.value = .object(output)
        return payload
    }

    // MARK: - Messages

    static func unrecognizedKeysIssue(_ keys: [String]) -> ZodIssue {
        var issue = ZodIssue(message: unrecognizedKeys(keys), continues: true)
        issue.isUnrecognizedKeys = true
        return issue
    }

    static func invalidType(_ expected: String, _ value: JSValue?) -> ZodIssue {
        ZodIssue(message: "Invalid input: expected \(expected), received \(value?.zodTypeName ?? "undefined")")
    }

    static func unrecognizedKeys(_ keys: [String]) -> String {
        "Unrecognized key\(keys.count > 1 ? "s" : ""): " + keys.map { "\"\($0)\"" }.joined(separator: ", ")
    }

    /// `stringifyPrimitive`.
    static func primitive(_ value: JSValue) -> String {
        if case .string(let text) = value { return "\"\(text)\"" }
        return value.javaScriptString
    }
}

/// The issues of a failed parse.
struct ZodFailure: Error, Equatable, Sendable {
    let issues: [ZodIssue]

    /// `formatZodIssues(error, "; ")`.
    var message: String { issues.map(\.formatted).joined(separator: "; ") }
}

// MARK: - Checks

extension ZodCheck {
    private static func numeric(_ value: JSValue?) -> Double? {
        if case .number(let number)? = value { return number }
        return nil
    }

    /// `.min(n)` on a number (`>=`).
    static func min(_ bound: Double) -> ZodCheck {
        ZodCheck(when: nil) { value in
            guard let number = numeric(value), !(number >= bound) else { return [] }
            return [
                ZodIssue(
                    message: "Too small: expected number to be >=\(SQLArguments.javaScriptText(bound))", continues: true)
            ]
        }
    }

    /// `.max(n)` on a number (`<=`).
    static func max(_ bound: Double) -> ZodCheck {
        ZodCheck(when: nil) { value in
            guard let number = numeric(value), !(number <= bound) else { return [] }
            return [
                ZodIssue(message: "Too big: expected number to be <=\(SQLArguments.javaScriptText(bound))", continues: true)
            ]
        }
    }

    /// `.int()`: a non-integer stops the parse; an unsafe integer is out of range.
    static let int = ZodCheck(when: nil) { value in
        guard let number = numeric(value) else { return [] }
        guard number.rounded(.towardZero) == number, number.isFinite else {
            return [ZodIssue(message: "Invalid input: expected int, received number", stops: true)]
        }
        let safe = 9_007_199_254_740_991.0
        if number > safe {
            return [ZodIssue(message: "Too big: expected int to be <=9007199254740991", continues: true)]
        }
        if number < -safe {
            return [ZodIssue(message: "Too small: expected int to be >=-9007199254740991", continues: true)]
        }
        return []
    }

    private static func lengthable(_ value: JSValue?) -> (origin: String, unit: String, length: Int)? {
        switch value {
        case .string(let text)?: return ("string", "characters", text.unicodeScalars.count)
        case .array(let items)?: return ("array", "items", items.count)
        default: return nil
        }
    }

    /// `.max(n)` on a string (code points) or an array (items); it runs whenever the value has
    /// a length, even after a type issue.
    static func maxLength(_ bound: Int) -> ZodCheck {
        var check = ZodCheck(when: { lengthable($0) != nil }) { value in
            guard let (origin, unit, length) = lengthable(value), length > bound else { return [] }
            return [ZodIssue(message: "Too big: expected \(origin) to have <=\(bound) \(unit)", continues: true)]
        }
        check.isLengthCheck = true
        check.sizeCap = bound
        return check
    }

    /// `.min(n)` on a string or an array.
    static func minLength(_ bound: Int) -> ZodCheck {
        var check = ZodCheck(when: { lengthable($0) != nil }) { value in
            guard let (origin, unit, length) = lengthable(value), length < bound else { return [] }
            return [ZodIssue(message: "Too small: expected \(origin) to have >=\(bound) \(unit)", continues: true)]
        }
        check.isLengthCheck = true
        return check
    }

    /// A string format (`.regex`, `z.iso.date()`): `test` stands in for the pattern.
    static func format(_ message: String, _ test: @escaping @Sendable (String) -> Bool) -> ZodCheck {
        ZodCheck(when: nil) { value in
            guard let text = value?.stringValue, !test(text) else { return [] }
            return [ZodIssue(message: message, continues: true)]
        }
    }

    /// `.refine(fn, message)`.
    static func refine(_ message: String, _ test: @escaping @Sendable (JSValue?) -> Bool) -> ZodCheck {
        ZodCheck(when: nil) { value in test(value) ? [] : [ZodIssue(message: message, continues: true)] }
    }

    /// `.superRefine(fn)`: the issues it adds continue.
    static func superRefine(_ body: @escaping @Sendable (JSValue?) -> [ZodIssue]) -> ZodCheck {
        ZodCheck(when: nil) { value in
            body(value).map { issue in
                var copy = issue
                copy.continues = true
                return copy
            }
        }
    }
}

extension Zod {
    // Number schemas.
    static func number(min: Double? = nil, max: Double? = nil, int: Bool = false) -> Zod {
        var checks: [ZodCheck] = []
        if int { checks.append(.int) }
        if let min { checks.append(.min(min)) }
        if let max { checks.append(.max(max)) }
        return checks.isEmpty ? .number : .checked(.number, checks)
    }

    // String schemas.
    static func string(min: Int? = nil, max: Int? = nil) -> Zod {
        var checks: [ZodCheck] = []
        if let min { checks.append(.minLength(min)) }
        if let max { checks.append(.maxLength(max)) }
        return checks.isEmpty ? .string : .checked(.string, checks)
    }

    /// `z.iso.date()`: `YYYY-MM-DD` of a real calendar day.
    static let isoDate = Zod.checked(.string, [.format("Invalid ISO date") { isISODate($0) }])

    static func isISODate(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45 else { return false }
        let digitAt = [0, 1, 2, 3, 5, 6, 8, 9]
        guard digitAt.allSatisfy({ bytes[$0] >= 48 && bytes[$0] <= 57 }) else { return false }
        func value(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(bytes[$1] - 48) } }
        let year = value(0..<4)
        let month = value(5..<7)
        let day = value(8..<10)
        guard (1...12).contains(month), day >= 1 else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        return day <= days
    }

    /// `z.array(element).min(min).max(max)`, the checks in that order.
    static func array(_ element: Zod, min: Int? = nil, max: Int? = nil) -> Zod {
        var checks: [ZodCheck] = []
        if let min { checks.append(.minLength(min)) }
        if let max { checks.append(.maxLength(max)) }
        return checks.isEmpty ? .arrayOf(element) : .checked(.arrayOf(element), checks)
    }
}

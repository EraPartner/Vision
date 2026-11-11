import Foundation

/// A formula unit (`FormulaUnit`): the fields a request or the catalog declared, kept as the
/// JSON they arrived as, because the TypeScript engine compares and copies them untyped.
struct FormulaUnit: Equatable, Sendable {
    enum Field: String, CaseIterable {
        case kind
        case currency
        case percentageBasis
        case currencyColumn
        case instrumentColumn
        case instrumentId
        case currencyParameterId

        /// The fields `sameDimension` compares.
        static let dimension: [Field] = [
            .kind, .currency, .percentageBasis, .currencyColumn, .instrumentColumn, .instrumentId,
        ]
    }

    enum Kind {
        static let money = JSValue.string("money")
        static let percentage = JSValue.string("percentage")
        static let count = JSValue.string("count")
        static let duration = JSValue.string("duration")
        static let quantity = JSValue.string("quantity")
    }

    var fields: JSObject
    /// The unit is a function: an `Object.prototype` member the TypeScript engine reads off
    /// its unit table for a formula named like one (`formula.constructor`). It has no fields,
    /// counts as dimensional, and `JSON.stringify` leaves it out of the result.
    var isFunction = false

    init(fields: JSObject = JSObject(), isFunction: Bool = false) {
        self.fields = fields
        self.isFunction = isFunction
    }

    init(_ pairs: [(Field, JSValue)]) {
        self.init(fields: JSObject(pairs.map { ($0.0.rawValue, $0.1) }))
    }

    subscript(field: Field) -> JSValue? {
        get { fields[field.rawValue] }
        set { fields[field.rawValue] = newValue }
    }

    func has(_ field: Field, _ value: JSValue) -> Bool { FormulaSemantics.strictlyEqual(self[field], value) }

    /// `!unit || ["percentage", "count"].includes(unit.kind)`.
    static func isDimensionless(_ unit: FormulaUnit?) -> Bool {
        guard let unit else { return true }
        return unit.has(.kind, Kind.percentage) || unit.has(.kind, Kind.count)
    }

    /// `sameDimension(a, b)`. An object-valued field compares by content here; JavaScript
    /// compares it by identity, which holds when both units came from one declaration.
    static func sameDimension(_ a: FormulaUnit?, _ b: FormulaUnit?) -> Bool {
        Field.dimension.allSatisfy { FormulaSemantics.strictlyEqual(a?[$0], b?[$0], objectsEqual: true) }
    }

    /// `Object.prototype`'s function members.
    private static let prototypeFunctions: Set<String> = [
        "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf",
        "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
    ]
    private static let prototypeAccessor = "__proto__"

    /// What `table[name]` reads when the plain object `table` has no such own key: a function,
    /// `Object.prototype` itself, or `undefined`.
    static func inherited(_ name: String) -> FormulaUnit? {
        if prototypeFunctions.contains(name) { return FormulaUnit(isFunction: true) }
        return name == prototypeAccessor ? FormulaUnit() : nil
    }

    /// `normalizeUnit(unit, assumptions)`: a shorthand string (an ISO currency, `percent`,
    /// `ratio`, `currency`, or a kind) or a unit object, whose `currencyParameterId` resolves
    /// to that assumption's value when it has one.
    static func normalized(_ unit: JSValue?, assumptions: JSObject) -> FormulaUnit? {
        switch unit {
        case nil, .null?: return nil
        case .string(let text)?:
            if text.isEmpty { return nil }
            if FormulaSemantics.isCurrencyCode(unit) { return FormulaUnit([(.kind, Kind.money), (.currency, .string(text))]) }
            switch Shorthand(rawValue: text) {
            case .percent: return FormulaUnit([(.kind, Kind.percentage), (.percentageBasis, .string(text))])
            case .ratio: return FormulaUnit([(.kind, Kind.percentage), (.percentageBasis, .string(text))])
            case .currency: return FormulaUnit([(.kind, Kind.money)])
            case nil: return FormulaUnit([(.kind, .string(text))])
            }
        case .object(let object)?:
            var resolved = FormulaUnit(fields: object)
            if let parameter = object[Field.currencyParameterId.rawValue], FormulaSemantics.truthy(parameter),
                let value = assumptions[parameter.javaScriptString], FormulaSemantics.truthy(value)
            {
                resolved[.currencyParameterId] = nil
                resolved[.currency] = value
            }
            return resolved
        case .array(let items)?:
            // `{ ...array }`: its indices as keys.
            return FormulaUnit(fields: JSObject(items.enumerated().map { (String($0.offset), $0.element) }))
        case .bool?, .number?:
            return FormulaUnit()
        }
    }

    private enum Shorthand: String {
        case percent
        case ratio
        case currency
    }
}

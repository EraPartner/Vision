import Foundation

/// The body of a formula evaluation (`EvaluateAnalysisFormulasInput`). Formulas, columns and
/// units stay the JSON the request held: the TypeScript engine validates them itself, and
/// reads their fields untyped.
struct AnalysisFormulaRequest: Equatable, Sendable {
    var rows: [JSObject]
    var formulas: [JSObject] = []
    var assumptions = JSObject()
    var inputComplete = true
    var columns: [JSObject] = []
    var assumptionUnits = JSObject()
}

/// One formula failure (`FormulaEvaluationError`).
struct FormulaEvaluationIssue: Equatable, Sendable {
    /// `formulaId`: the formula's `id` as the request stated it.
    var formula: JSValue?
    var rowIndex: Int?
    var code: String
    var message: String

    var jsonValue: JSValue {
        var object = JSObject()
        if let formula { object["formulaId"] = formula }
        if let rowIndex { object["rowIndex"] = .int(rowIndex) }
        object["code"] = .string(code)
        object["message"] = .string(message)
        return .object(object)
    }
}

/// `AnalysisFormulaEvaluation`.
struct AnalysisFormulaEvaluation: Equatable, Sendable {
    static let languageVersion = "vision-formula-v1"

    var rows: [JSObject]
    var summaries: JSObject
    var errors: [FormulaEvaluationIssue]
    /// The unit of each formula that has one, in evaluation order.
    var formulaUnits: [FormulaUnitEntry]

    var complete: Bool { errors.isEmpty }

    /// The JSON the TypeScript result serializes to.
    var jsonValue: JSValue {
        var units = JSObject()
        for entry in formulaUnits where !entry.unit.isFunction { units[entry.name] = .object(entry.unit.fields) }
        return .object(
            JSObject([
                ("rows", .array(rows.map(JSValue.object))), ("summaries", .object(summaries)),
                ("errors", .array(errors.map(\.jsonValue))), ("complete", .bool(complete)),
                ("formulaUnits", .object(units)), ("languageVersion", .string(Self.languageVersion)),
            ]))
    }
}

struct FormulaUnitEntry: Equatable, Sendable {
    var name: String
    var unit: FormulaUnit
}

/// Safe spreadsheet-style formulas over an already bounded analysis result: a port of
/// `services/analysisFormulaEngine.ts` (ADR-270), language `vision-formula-v1`.
///
/// Row formulas add a column to every row; summary formulas give one value. A formula may
/// read columns, assumptions and other formulas, in dependency order. Numbers are
/// `decimal.js` values and results are text rounded to 12 decimal places. A failure is
/// recorded per formula and row with a code, and the failed cell is `null`. Units are
/// inferred conservatively: incompatible dimensions or currencies are never combined.
enum AnalysisFormulaEngine {
    static let maximumFormulas = 64
    static let maximumRows = 1000
    private static let maximumDepth = 64
    private static let maximumResultBytes = 2 * 1024 * 1024
    private static let resultPlaces = 12
    private static let maximumResultExponent = 1000

    private enum Scope: String {
        case row
        case summary
    }

    private enum Prefix {
        static let assumption = "assumption."
        static let formula = "formula."
        static let row = "row."
    }

    private enum Key {
        static let identifier = "id"
        static let scope = "scope"
        static let expression = "expression"
        static let unit = "unit"
        static let currency = "currency"
        static let investment = "investment_id"
    }

    private struct Formula {
        /// `formula.id` as stated; a string unless the request sent `true` or an array whose
        /// text passes the identifier pattern.
        let identity: JSValue
        /// `String(formula.id)`: the row or summary key.
        let name: String
        let scope: Scope
        let declaredUnit: JSValue?
        let expression: FormulaExpression

        /// The name the engine's error sets and its formula table know it by: only a string
        /// `id` equals the name a reference spells.
        var referenceName: String? {
            if case .string = identity { return name }
            return nil
        }
    }

    // MARK: Request validation

    /// `/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/`
    private static func isIdentifier(_ text: String) -> Bool {
        text.wholeMatch(of: /[A-Za-z][A-Za-z0-9._:\-]{0,127}/) != nil
    }

    private static func parsed(_ formulas: [JSObject]) throws -> [Formula] {
        var scopes: [Scope] = []
        var seen: [JSValue] = []
        for formula in formulas {
            let identity = formula[Key.identifier]
            guard let identity, FormulaSemantics.truthy(identity), isIdentifier(identity.javaScriptString) else {
                throw AnalysisFormulaError(.invalidFormula, "Every formula needs a stable identifier")
            }
            let name = identity.javaScriptString
            if seen.contains(where: { FormulaSemantics.strictlyEqual($0, identity) }) {
                throw AnalysisFormulaError(.duplicateFormula, "Duplicate formula: \(name)", formula: identity)
            }
            seen.append(identity)
            guard let scope = formula[Key.scope]?.stringValue.flatMap(Scope.init(rawValue:)) else {
                throw AnalysisFormulaError(.invalidScope, "Formula \(name) needs row or summary scope", formula: identity)
            }
            scopes.append(scope)
        }
        var result: [Formula] = []
        for (formula, scope) in zip(formulas, scopes) {
            let expression = try FormulaParser.parse(formula[Key.expression])
            try assertBounded(expression, insideAggregate: false, depth: 0)
            let identity = formula[Key.identifier] ?? .null
            result.append(
                Formula(
                    identity: identity, name: identity.javaScriptString, scope: scope, declaredUnit: formula[Key.unit],
                    expression: expression))
        }
        return result
    }

    /// `assertBoundedAggregateTree`: at most 64 nested operations, and no aggregate inside
    /// another.
    private static func assertBounded(_ expression: FormulaExpression, insideAggregate: Bool, depth: Int) throws {
        if depth > maximumDepth {
            throw AnalysisFormulaError(.expressionTooDeep, "Formula expressions are limited to 64 nested operations")
        }
        switch expression {
        case .call(let function, let arguments):
            if insideAggregate, function.isAggregate {
                throw AnalysisFormulaError(.nestedAggregate, "Aggregate functions cannot be nested")
            }
            for argument in arguments {
                try assertBounded(argument, insideAggregate: insideAggregate || function.isAggregate, depth: depth + 1)
            }
        case .binary(_, let left, let right):
            try assertBounded(left, insideAggregate: insideAggregate, depth: depth + 1)
            try assertBounded(right, insideAggregate: insideAggregate, depth: depth + 1)
        case .unary(_, let value):
            try assertBounded(value, insideAggregate: insideAggregate, depth: depth + 1)
        case .decimal, .string, .boolean, .null, .reference: break
        }
    }

    /// `dependencies(ast)`: the formulas an expression names, in first-seen order.
    private static func dependencies(_ expression: FormulaExpression, into found: inout [String]) {
        switch expression {
        case .reference(let name):
            if name.hasPrefix(Prefix.formula) {
                let dependency = String(name.dropFirst(Prefix.formula.count))
                if !found.contains(dependency) { found.append(dependency) }
            }
        case .binary(_, let left, let right):
            dependencies(left, into: &found)
            dependencies(right, into: &found)
        case .unary(_, let value): dependencies(value, into: &found)
        case .call(_, let arguments): for argument in arguments { dependencies(argument, into: &found) }
        case .decimal, .string, .boolean, .null: break
        }
    }

    /// `ordered(formulas)`: dependencies before dependents, otherwise request order.
    private static func ordered(_ formulas: [Formula]) throws -> [Formula] {
        var byName: [String: Int] = [:]
        for (index, formula) in formulas.enumerated() {
            if let name = formula.referenceName { byName[name] = index }
        }
        var result: [Formula] = []
        var visiting = Set<Int>()
        var visited = Set<Int>()
        func visit(_ index: Int) throws {
            let formula = formulas[index]
            if visiting.contains(index) {
                throw AnalysisFormulaError(
                    .cycle, "Formula dependency cycle includes \(formula.name)", formula: formula.identity)
            }
            if visited.contains(index) { return }
            visiting.insert(index)
            var names: [String] = []
            dependencies(formula.expression, into: &names)
            for name in names {
                guard let dependency = byName[name] else {
                    throw AnalysisFormulaError(.brokenReference, "Unknown formula: \(name)", formula: .string(name))
                }
                try visit(dependency)
            }
            visiting.remove(index)
            visited.insert(index)
            result.append(formula)
        }
        for index in formulas.indices { try visit(index) }
        return result
    }

    // MARK: Evaluation state

    /// `output(value)`: a decimal as text rounded to 12 places, anything else as it is.
    private static func output(_ value: FormulaValue) throws -> JSValue {
        switch value {
        case .json(let json): return json
        case .decimal(let decimal) where abs(decimal.leadingExponent) <= maximumResultExponent:
            return .string(decimal.toDecimalPlaces(resultPlaces).toFixed)
        case .decimal, .nonFinite:
            throw AnalysisFormulaError(.numericRange, "Formula result exceeds the finite decimal range")
        }
    }

    /// Which row an expression reads (`context.row`) and where `formula.x` falls back to
    /// (`context.formulas`): the row a row formula is computing, or the summaries.
    private struct Frame {
        var row: Int?
        let formulasRow: Int?
    }

    private struct Entry {
        let row: JSObject
        let value: FormulaValue
    }

    private struct Run {
        let request: AnalysisFormulaRequest
        /// `calculatedRows`: the rows with the formulas computed so far.
        var rows: [JSObject]
        var summaries = JSObject()
        var errors: [FormulaEvaluationIssue] = []
        var rowErrors: [Set<String>]
        var summaryErrors = Set<String>()
        var unitNames: [String] = []
        var units: [String: FormulaUnit] = [:]

        init(_ request: AnalysisFormulaRequest) {
            self.request = request
            rows = request.rows
            rowErrors = Array(repeating: [], count: request.rows.count)
        }

        // MARK: Units

        /// `context.formulaUnits[name]`.
        func unit(named name: String) -> FormulaUnit? { units[name] ?? FormulaUnit.inherited(name) }

        mutating func setUnit(_ unit: FormulaUnit, for name: String) {
            if units.updateValue(unit, forKey: name) == nil { unitNames.append(name) }
        }

        func column(_ name: String) -> JSObject? {
            request.columns.first { column in
                if case .string(let identifier)? = column[Key.identifier] { return FormulaSemantics.sameText(identifier, name) }
                return false
            }
        }

        private func compatible(_ a: FormulaUnit?, _ b: FormulaUnit?) throws -> FormulaUnit? {
            if let a, let b, !FormulaUnit.sameDimension(a, b) {
                throw AnalysisFormulaError(.unitMismatch, "Formula combines incompatible units or currencies")
            }
            return a ?? b
        }

        /// `row[unit.currencyColumn || "currency"]`.
        private func currencyCell(_ unit: FormulaUnit, _ row: JSObject) -> JSValue? {
            let column = unit[.currencyColumn]
            return row[FormulaSemantics.truthy(column) ? column?.javaScriptString ?? Key.currency : Key.currency]
        }

        /// `inferFormulaUnit(ast, context)` over `rows`: the request's rows when a formula's
        /// own unit is inferred, the calculated ones when an aggregate checks its argument.
        func inferUnit(_ expression: FormulaExpression, rows: [JSObject]) throws -> FormulaUnit? {
            switch expression {
            case .decimal, .string, .boolean, .null: return nil
            case .reference(let name): return try referenceUnit(name, rows: rows)
            case .unary(_, let value): return try inferUnit(value, rows: rows)
            case .binary(let op, let left, let right):
                let a = try inferUnit(left, rows: rows)
                let b = try inferUnit(right, rows: rows)
                switch op {
                case .add, .subtract: return try compatible(a, b)
                case .less, .lessOrEqual, .greater, .greaterOrEqual, .equal, .notEqual:
                    _ = try compatible(a, b)
                    return nil
                case .divide:
                    if let a, let b, FormulaUnit.sameDimension(a, b) {
                        return FormulaUnit([(.kind, FormulaUnit.Kind.percentage), (.percentageBasis, .string("ratio"))])
                    }
                    if b != nil, !FormulaUnit.isDimensionless(b) {
                        throw AnalysisFormulaError(
                            .unitMismatch, "Division by a dimensional value requires matching units")
                    }
                    return a
                case .multiply:
                    if a != nil, b != nil, !FormulaUnit.isDimensionless(a), !FormulaUnit.isDimensionless(b) {
                        throw AnalysisFormulaError(
                            .unitMismatch, "Multiplication of two dimensional values is unsupported")
                    }
                    return FormulaUnit.isDimensionless(a) ? b ?? a : a
                }
            case .call(let function, let arguments):
                let units = try arguments.map { try inferUnit($0, rows: rows) }
                func unit(_ index: Int) -> FormulaUnit? { index < units.count ? units[index] : nil }
                switch function {
                case .count, .countIf, .year, .month: return FormulaUnit([(.kind, FormulaUnit.Kind.count)])
                case .dateDifference: return FormulaUnit([(.kind, FormulaUnit.Kind.duration)])
                case .conditional: return try compatible(unit(1), unit(2))
                case .coalesce: return try units.reduce(FormulaUnit?.none) { try compatible($0, $1) }
                case .netPresentValue, .presentValue, .futureValue, .payment:
                    let present = function == .netPresentValue
                    if !FormulaUnit.isDimensionless(unit(0)) || (!present && !FormulaUnit.isDimensionless(unit(1))) {
                        throw AnalysisFormulaError(
                            .unitMismatch, "Financial rate and period inputs must be dimensionless")
                    }
                    let amounts = present ? units.dropFirst(1) : units.dropFirst(2).prefix(2)
                    return try amounts.reduce(FormulaUnit?.none) { try compatible($0, $1) }
                case .absolute, .round, .dateAdd, .sum, .average, .minimum, .maximum, .sumIf, .median,
                    .standardDeviation, .variance:
                    let result = function == .sumIf ? unit(3) : unit(0)
                    if function.isAggregate, let result, result.has(.kind, FormulaUnit.Kind.money),
                        !FormulaSemantics.truthy(result[.currency]), !FormulaSemantics.truthy(result[.currencyColumn])
                    {
                        throw AnalysisFormulaError(
                            .currencyProvenanceRequired,
                            "Money aggregates require a literal currency or resolved currency parameter, even when the result omits the currency column"
                        )
                    }
                    if function == .variance, result != nil, !FormulaUnit.isDimensionless(result) {
                        throw AnalysisFormulaError(
                            .unitMismatch,
                            "Variance of dimensional data has squared units; use STDEV or a dimensionless ratio")
                    }
                    return result
                }
            }
        }

        private func referenceUnit(_ name: String, rows: [JSObject]) throws -> FormulaUnit? {
            if name.hasPrefix(Prefix.formula) { return unit(named: String(name.dropFirst(Prefix.formula.count))) }
            if name.hasPrefix(Prefix.assumption) {
                let key = String(name.dropFirst(Prefix.assumption.count))
                if let declared = request.assumptionUnits[key] {
                    return FormulaUnit.normalized(declared, assumptions: request.assumptions)
                }
                // `{ ...inherited }`: an empty unit for an `Object.prototype` member.
                return FormulaUnit.inherited(key).map { _ in FormulaUnit() }
            }
            let identifier = name.hasPrefix(Prefix.row) ? String(name.dropFirst(Prefix.row.count)) : name
            if let known = unit(named: identifier) { return known }
            guard var unit = FormulaUnit.normalized(column(identifier)?[Key.unit], assumptions: request.assumptions)
            else { return nil }
            if unit.has(.kind, FormulaUnit.Kind.money), !FormulaSemantics.truthy(unit[.currency]) {
                let currencies = rows.map { currencyCell(unit, $0) }.filter(FormulaSemantics.truthy)
                if FormulaSemantics.distinctCount(currencies) == 1, let currency = currencies.first {
                    unit[.currencyColumn] = nil
                    unit[.currencyParameterId] = nil
                    unit[.currency] = currency
                    return unit
                }
            }
            if unit.has(.kind, FormulaUnit.Kind.quantity), !FormulaSemantics.truthy(unit[.instrumentColumn]),
                !FormulaSemantics.truthy(unit[.instrumentId]),
                rows.contains(where: { ($0[Key.investment] ?? .null) != .null })
            {
                unit[.instrumentColumn] = .string(Key.investment)
            }
            return unit
        }

        /// `assertSingleCurrency(entries)`.
        private func assertSingleCurrency(_ entries: [Entry]) throws {
            let currencies = entries.map { $0.row[Key.currency] }.filter { ($0 ?? .null) != .null }
            if FormulaSemantics.distinctCount(currencies) > 1 {
                throw AnalysisFormulaError(
                    .mixedCurrencies, "Numeric aggregates cannot combine rows with different currencies")
            }
        }

        /// `assertAggregateUnits(ast, entries, context)`.
        private func assertAggregateUnits(_ expression: FormulaExpression, _ entries: [Entry]) throws {
            guard let unit = try inferUnit(expression, rows: rows) else {
                try assertSingleCurrency(entries.filter { !$0.value.isNull })
                return
            }
            if unit.has(.kind, FormulaUnit.Kind.money) {
                if entries.contains(where: \.value.isNull) {
                    throw AnalysisFormulaError(
                        .missingContributor, "Money aggregate withheld because a contributing value is missing")
                }
                let declared = unit[.currency]
                let values = entries.map { FormulaSemantics.truthy(declared) ? declared : currencyCell(unit, $0.row) }
                if !values.allSatisfy(FormulaSemantics.isCurrencyCode) {
                    throw AnalysisFormulaError(.currencyProvenanceRequired, "Every money contributor needs a known currency")
                }
                if FormulaSemantics.distinctCount(values) > 1 {
                    throw AnalysisFormulaError(.mixedCurrencies, "Money aggregates cannot combine different currencies")
                }
                if let column = unit[.currencyColumn], column != .string(""),
                    entries.contains(where: { ($0.row[column.javaScriptString] ?? .null) == .null })
                {
                    throw AnalysisFormulaError(.currencyProvenanceRequired, "Money contributor provenance is missing")
                }
            }
            if unit.has(.kind, FormulaUnit.Kind.quantity) {
                let instrument = unit[.instrumentId]
                let column = unit[.instrumentColumn]
                if !FormulaSemantics.truthy(column), !FormulaSemantics.truthy(instrument) {
                    throw AnalysisFormulaError(
                        .instrumentProvenanceRequired, "Quantity aggregate needs a known instrument or instrument column")
                }
                if entries.contains(where: \.value.isNull) {
                    throw AnalysisFormulaError(
                        .missingContributor, "Quantity aggregate withheld because a contributing value is missing")
                }
                // `instrumentId ?? (instrumentColumn ? row[instrumentColumn] : undefined)`
                let values = entries.map { entry -> JSValue? in
                    if let instrument, instrument != .null { return instrument }
                    guard let column, FormulaSemantics.truthy(column) else { return nil }
                    return entry.row[column.javaScriptString]
                }
                if values.contains(where: { ($0 ?? .null) == .null }) || FormulaSemantics.distinctCount(values) > 1 {
                    throw AnalysisFormulaError(.mixedInstruments, "Quantity aggregates require one known instrument")
                }
            }
        }

        // MARK: References

        /// `resolveReference(name, context)`.
        private func resolve(_ name: String, _ frame: Frame) throws -> FormulaValue {
            let row = frame.row.map { rows[$0] }
            let failed = frame.row.map { rowErrors[$0] } ?? []
            if name.hasPrefix(Prefix.assumption) {
                let key = String(name.dropFirst(Prefix.assumption.count))
                guard let value = request.assumptions[key] else {
                    throw AnalysisFormulaError(.brokenReference, "Unknown assumption: \(key)")
                }
                return .json(value)
            }
            if name.hasPrefix(Prefix.formula) {
                let key = String(name.dropFirst(Prefix.formula.count))
                let own = row?[key]
                if failed.contains(key) || (own == nil && summaryErrors.contains(key)) {
                    throw AnalysisFormulaError(.dependencyError, "Referenced formula failed: \(key)")
                }
                if let own { return .json(own) }
                let formulas = frame.formulasRow.map { rows[$0] } ?? summaries
                guard let value = formulas[key] else {
                    throw AnalysisFormulaError(.brokenReference, "Unknown formula: \(key)")
                }
                return .json(value)
            }
            let key = name.hasPrefix(Prefix.row) ? String(name.dropFirst(Prefix.row.count)) : name
            if failed.contains(key) {
                throw AnalysisFormulaError(.dependencyError, "Referenced formula failed: \(key)")
            }
            guard let row, let value = row[key] else {
                throw AnalysisFormulaError(.brokenReference, "Unknown column: \(key)")
            }
            // The column's declared unit as the request stated it; only an object has fields.
            if let declared = column(key)?[Key.unit]?.objectValue {
                if let currencyColumn = declared[FormulaUnit.Field.currencyColumn.rawValue],
                    FormulaSemantics.truthy(currencyColumn),
                    !FormulaSemantics.isCurrencyCode(row[currencyColumn.javaScriptString])
                {
                    throw AnalysisFormulaError(
                        .currencyProvenanceRequired,
                        "Column \(key) needs its source currency column \(currencyColumn.javaScriptString)")
                }
                if let instrumentColumn = declared[FormulaUnit.Field.instrumentColumn.rawValue],
                    FormulaSemantics.truthy(instrumentColumn),
                    (row[instrumentColumn.javaScriptString] ?? .null) == .null
                {
                    throw AnalysisFormulaError(
                        .instrumentProvenanceRequired,
                        "Column \(key) needs its source instrument column \(instrumentColumn.javaScriptString)")
                }
            }
            return .json(value)
        }

        // MARK: Expressions

        private static func number(_ value: Int) -> FormulaValue { .json(.int(value)) }

        private static func optional(_ value: DecimalJS?) -> FormulaValue { value.map(FormulaValue.decimal) ?? .null }

        /// `argument(ast, index)`.
        private static func argument(_ function: FormulaFunction, _ arguments: [FormulaExpression], _ index: Int) throws
            -> FormulaExpression
        {
            guard index < arguments.count else {
                throw AnalysisFormulaError(.arity, "\(function.rawValue) is missing argument \(index + 1)")
            }
            return arguments[index]
        }

        /// `evaluate(ast, context)`.
        func evaluate(_ expression: FormulaExpression, _ frame: Frame) throws -> FormulaValue {
            switch expression {
            case .decimal(let value): return .decimal(value)
            case .string(let value): return .json(.string(value))
            case .boolean(let value): return .json(.bool(value))
            case .null: return .null
            case .reference(let name): return try resolve(name, frame)
            case .unary(let negate, let operand):
                guard let value = try FormulaSemantics.decimal(try evaluate(operand, frame)) else { return .null }
                return .decimal(negate ? value.negated : value)
            case .binary(let op, let leftOperand, let rightOperand):
                let left = try evaluate(leftOperand, frame)
                let right = try evaluate(rightOperand, frame)
                if op.isComparison {
                    return try FormulaSemantics.compare(left, op, right).map { .json(.bool($0)) } ?? .null
                }
                // Both operands are read as decimals before a missing one (`null` or "") propagates,
                // so a right operand that is no decimal fails even beside a missing left one.
                let first = try FormulaSemantics.decimal(left)
                let second = try FormulaSemantics.decimal(right)
                guard let a = first, let b = second else { return .null }
                switch op {
                case .add: return .decimal(a.plus(b))
                case .subtract: return .decimal(a.minus(b))
                case .multiply: return .decimal(a.times(b))
                default:
                    if b.isZero { throw AnalysisFormulaError(.divideByZero, "Division by zero") }
                    return .decimal(try a.dividedBy(b))
                }
            case .call(let function, let arguments):
                return try call(function, arguments, frame)
            }
        }

        /// `aggregateEntries(arg, rows)`: the argument evaluated on each of `indices`.
        private func entries(_ expression: FormulaExpression, _ frame: Frame, rows indices: [Int]? = nil) throws -> [Entry] {
            try (indices ?? Array(rows.indices)).map { index in
                Entry(row: rows[index], value: try evaluate(expression, Frame(row: index, formulasRow: frame.formulasRow)))
            }
        }

        /// The entries' numbers; a missing cell, `""` included, is skipped.
        private static func decimals(_ entries: [Entry]) throws -> [DecimalJS] {
            try entries.compactMap { try FormulaSemantics.decimal($0.value) }
        }

        private func call(_ function: FormulaFunction, _ arguments: [FormulaExpression], _ frame: Frame) throws
            -> FormulaValue
        {
            if function.isAggregate, !request.inputComplete {
                throw AnalysisFormulaError(.incompleteInput, "Aggregate formulas require the complete analysis result")
            }
            func values() throws -> [FormulaValue] { try arguments.map { try evaluate($0, frame) } }
            func value(_ list: [FormulaValue], _ index: Int) -> FormulaValue? { index < list.count ? list[index] : nil }
            switch function {
            case .conditional:
                if arguments.count != 3 { throw AnalysisFormulaError(.arity, "IF requires three arguments") }
                return FormulaSemantics.condition(try evaluate(arguments[0], frame))
                    ? try evaluate(arguments[1], frame) : try evaluate(arguments[2], frame)
            case .coalesce:
                return try values().first { !$0.isNull } ?? .null
            case .absolute:
                return Self.optional(try FormulaSemantics.decimal(value(try values(), 0))?.abs)
            case .round:
                let list = try values()
                guard let number = try FormulaSemantics.decimal(value(list, 0)) else { return .null }
                // `toDecimalPlaces(Number(scale), ROUND_HALF_EVEN)` with `checkInt32(dp, 0, 1e9)`.
                let places = list.count > 1 ? FormulaSemantics.number(list[1]) : 2
                guard let whole = Int(exactly: places), (0...1_000_000_000).contains(whole) else {
                    throw FormulaFault(message: "[DecimalError] Invalid argument: \(SQLArguments.javaScriptText(places))")
                }
                return .decimal(number.toDecimalPlaces(whole))
            case .year:
                return Self.number(try FormulaSemantics.date(value(try values(), 0)).year)
            case .month:
                return Self.number(try FormulaSemantics.date(value(try values(), 0)).month)
            case .dateAdd:
                let list = try values()
                let start = try FormulaSemantics.date(value(list, 0))
                return .json(.string(try FormulaSemantics.adding(FormulaSemantics.number(value(list, 1)), to: start)))
            case .dateDifference:
                let list = try values()
                let end = try FormulaSemantics.date(value(list, 1))
                let start = try FormulaSemantics.date(value(list, 0))
                return Self.number(end.dayNumber - start.dayNumber)
            case .count:
                return Self.number(try entries(try Self.argument(function, arguments, 0), frame).filter { !$0.value.isNull }.count)
            case .sum, .average, .minimum, .maximum:
                let argument = try Self.argument(function, arguments, 0)
                let entries = try entries(argument, frame)
                try assertAggregateUnits(argument, entries)
                let list = try Self.decimals(entries)
                guard let first = list.first else { return .null }
                switch function {
                case .sum: return .decimal(DecimalJS.sum(list))
                case .average: return .decimal(try DecimalJS.sum(list).dividedBy(DecimalJS(list.count)))
                case .minimum: return .decimal(list.dropFirst().reduce(first, DecimalJS.min))
                default: return .decimal(list.dropFirst().reduce(first, DecimalJS.max))
                }
            case .countIf, .sumIf:
                let expectedArity = function == .countIf ? 3 : 4
                if arguments.count != expectedArity {
                    throw AnalysisFormulaError(.arity, "\(function.rawValue) requires \(expectedArity) arguments")
                }
                let expected = try evaluate(arguments[2], frame)
                guard let op = FormulaOperator(rawValue: FormulaSemantics.string(try evaluate(arguments[1], frame))),
                    op.isComparison
                else { throw AnalysisFormulaError(.typeError, "Conditional aggregate operator is invalid") }
                let selected = try rows.indices.filter { index in
                    let tested = try evaluate(arguments[0], Frame(row: index, formulasRow: frame.formulasRow))
                    return try FormulaSemantics.compare(tested, op, expected) ?? false
                }
                if function == .countIf { return Self.number(selected.count) }
                let entries = try entries(arguments[3], frame, rows: selected)
                try assertAggregateUnits(arguments[3], entries)
                return .decimal(DecimalJS.sum(try entries.map { try FormulaSemantics.decimal($0.value) ?? .zero } + [.zero]))
            case .median, .standardDeviation, .variance:
                if arguments.count != 1 {
                    throw AnalysisFormulaError(.arity, "\(function.rawValue) requires one argument")
                }
                let entries = try entries(arguments[0], frame)
                try assertAggregateUnits(arguments[0], entries)
                var list = try Self.decimals(entries)
                if list.isEmpty { return .null }
                if function == .median {
                    list.sort { $0.lt($1) }
                    let middle = list.count / 2
                    if list.count % 2 != 0 { return .decimal(list[middle]) }
                    return .decimal(try list[middle - 1].plus(list[middle]).dividedBy(DecimalJS(2)))
                }
                if list.count < 2 {
                    throw AnalysisFormulaError(.insufficientData, "\(function.rawValue) requires at least two values")
                }
                let mean = try DecimalJS.sum(list).dividedBy(DecimalJS(list.count))
                let squares = try list.map { try $0.minus(mean).pow(DecimalJS(2)) }
                let variance = try DecimalJS.sum(squares).dividedBy(DecimalJS(list.count - 1))
                return .decimal(function == .standardDeviation ? variance.squareRoot : variance)
            case .netPresentValue, .presentValue, .futureValue, .payment:
                let parsed = try values().map { try FormulaSemantics.decimal($0) }
                let numbers = parsed.compactMap { $0 }
                if numbers.count != parsed.count { return .null }
                return try financial(function, numbers)
            }
        }

        private func financial(_ function: FormulaFunction, _ numbers: [DecimalJS]) throws -> FormulaValue {
            let name = function.rawValue
            if function == .netPresentValue {
                guard numbers.count >= 2 else {
                    throw AnalysisFormulaError(.arity, "NPV requires rate and one or more end-of-period cash flows")
                }
                let rate = numbers[0]
                if rate.lte(DecimalJS(-1)) { throw AnalysisFormulaError(.typeError, "NPV rate must exceed -1") }
                let growth = rate.plus(.one)
                return .decimal(
                    DecimalJS.sum(
                        try numbers.dropFirst().enumerated().map { index, flow in
                            try flow.dividedBy(try growth.pow(DecimalJS(index + 1)))
                        }))
            }
            guard (3...5).contains(numbers.count) else {
                throw AnalysisFormulaError(
                    .arity, "\(name) requires rate, periods, amount, optional future/present value, and timing")
            }
            let rate = numbers[0]
            let periods = numbers[1]
            let amount = numbers[2]
            let other = numbers.count > 3 ? numbers[3] : .zero
            let timing = numbers.count > 4 ? numbers[4] : .zero
            let timingNumber = timing.toNumber
            if rate.lte(DecimalJS(-1)) || !periods.gt(.zero) || !(timingNumber == 0 || timingNumber == 1) {
                throw AnalysisFormulaError(
                    .typeError, "Financial formulas require rate above -1, positive periods, and timing 0 or 1")
            }
            if periods.gt(DecimalJS(10000)) || rate.abs.gt(DecimalJS(100)) {
                throw AnalysisFormulaError(
                    .numericRange,
                    "Financial formulas allow at most 10000 periods and rates with absolute value at most 100")
            }
            let factor = try rate.plus(.one).pow(periods)
            let annuity =
                rate.isZero
                ? periods : try factor.minus(.one).dividedBy(rate).times(rate.times(timing).plus(.one))
            switch function {
            case .futureValue: return .decimal(other.times(factor).plus(amount.times(annuity)).negated)
            case .presentValue: return .decimal(try other.plus(amount.times(annuity)).negated.dividedBy(factor))
            default:
                let numerator = amount.times(factor).plus(other).negated
                if annuity.isZero {
                    // A zero annuity factor is 0 / rate, so it carries the rate's sign.
                    if numerator.isZero { return .nonFinite(.notANumber) }
                    let negative = (numerator.coefficient.signum < 0) != (rate.coefficient.signum < 0)
                    return .nonFinite(negative ? .negativeInfinity : .positiveInfinity)
                }
                return .decimal(try numerator.dividedBy(annuity))
            }
        }

        // MARK: Formulas

        private mutating func record(_ formula: Formula, _ error: any Error, row: Int? = nil) throws {
            let code: String
            let message: String
            switch error {
            case let error as AnalysisFormulaError:
                code = error.code.rawValue
                message = error.message
            case let error as FormulaFault:
                code = evaluationErrorCode
                message = error.message
            case let error as DecimalJSError:
                code = evaluationErrorCode
                message = error.description
            default: throw error
            }
            errors.append(FormulaEvaluationIssue(formula: formula.identity, rowIndex: row, code: code, message: message))
        }

        private var evaluationErrorCode: String { "EVALUATION_ERROR" }

        private mutating func fail(_ formula: Formula, row: Int) {
            rows[row][formula.name] = .null
            // `rowErrors.get(row)?.add(formula.id)`: a reference finds only a string id.
            if let name = formula.referenceName { rowErrors[row].insert(name) }
        }

        private mutating func failSummary(_ formula: Formula) {
            summaries[formula.name] = .null
            if let name = formula.referenceName { summaryErrors.insert(name) }
        }

        mutating func run(_ formula: Formula) throws {
            do {
                let inferred = try inferUnit(formula.expression, rows: request.rows)
                let declared = FormulaSemantics.truthy(formula.declaredUnit) ? formula.declaredUnit : nil
                if let declared, let inferred,
                    !FormulaUnit.sameDimension(
                        FormulaUnit.normalized(declared, assumptions: request.assumptions), inferred)
                {
                    throw AnalysisFormulaError(.unitMismatch, "Declared formula unit does not match its expression")
                }
                if let inferred {
                    setUnit(inferred, for: formula.name)
                } else if let declared, let unit = FormulaUnit.normalized(declared, assumptions: request.assumptions) {
                    setUnit(unit, for: formula.name)
                }
            } catch {
                try record(formula, error)
                switch formula.scope {
                case .row: for index in rows.indices { fail(formula, row: index) }
                case .summary: failSummary(formula)
                }
                return
            }
            switch formula.scope {
            case .row:
                for index in rows.indices {
                    do {
                        let value = try output(try evaluate(formula.expression, Frame(row: index, formulasRow: index)))
                        rows[index][formula.name] = value
                    } catch {
                        try record(formula, error, row: index)
                        fail(formula, row: index)
                    }
                }
            case .summary:
                do {
                    let value = try output(try evaluate(formula.expression, Frame(row: nil, formulasRow: nil)))
                    summaries[formula.name] = value
                } catch {
                    try record(formula, error)
                    failSummary(formula)
                }
            }
        }
    }

    // MARK: Entry point

    /// `evaluateAnalysisFormulas(input)`. Throws `AnalysisFormulaError` for a request the
    /// engine refuses as a whole, and `FormulaStringLiteralError` for a string literal
    /// `JSON.parse` refuses.
    static func evaluate(_ request: AnalysisFormulaRequest) throws -> AnalysisFormulaEvaluation {
        if request.rows.count > maximumRows {
            throw AnalysisFormulaError(.rowLimit, "Formula evaluation is limited to \(maximumRows) rows")
        }
        if request.formulas.count > maximumFormulas {
            throw AnalysisFormulaError(.formulaLimit, "At most \(maximumFormulas) formulas are allowed")
        }
        let sequence = try ordered(try parsed(request.formulas))
        var run = Run(request)
        for formula in sequence { try run.run(formula) }
        let evaluation = AnalysisFormulaEvaluation(
            rows: run.rows, summaries: run.summaries, errors: run.errors,
            formulaUnits: run.unitNames.compactMap { name in
                run.units[name].map { FormulaUnitEntry(name: name, unit: $0) }
            })
        // `Buffer.byteLength(JSON.stringify({ rows, summaries, errors }))`
        let measured = JSValue.object(
            JSObject([
                ("rows", .array(evaluation.rows.map(JSValue.object))), ("summaries", .object(evaluation.summaries)),
                ("errors", .array(evaluation.errors.map(\.jsonValue))),
            ]))
        if measured.jsonText.utf8.count > maximumResultBytes {
            throw AnalysisFormulaError(.resultByteLimit, "Formula result exceeds 2 MiB")
        }
        return evaluation
    }
}

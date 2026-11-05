import Foundation

/// Editable extension-pack structure. Expressions and all numeric input text are sent to
/// the TypeScript evaluator unchanged; this type only assembles and validates controls.
public struct AnalysisWorkbenchDraft: Equatable, Sendable {
    public var formulas: [TaxValue]
    public var assumptions: [TaxValue]
    public var assumptionValues: [String: TaxValue]
    public var config: TaxValue

    public init(
        formulas: [TaxValue] = [], assumptions: [TaxValue] = [],
        assumptionValues: [String: TaxValue] = [:], config: TaxValue = .object([:])
    ) {
        self.formulas = formulas
        self.assumptions = assumptions
        self.assumptionValues = assumptionValues
        self.config = config
    }

    public init(formulasJson: String, assumptionsJson: String, assumptionValuesJson: String, config: TaxValue) {
        func parse(_ text: String) -> TaxValue? { try? JSONDecoder().decode(TaxValue.self, from: Data(text.utf8)) }
        self.init(
            formulas: parse(formulasJson)?.arrayValue ?? [], assumptions: parse(assumptionsJson)?.arrayValue ?? [],
            assumptionValues: parse(assumptionValuesJson)?.objectValue ?? [:], config: config)
    }

    public var steps: [TaxValue] {
        get { config["steps"]?.arrayValue ?? [] }
        set { config["steps"] = .array(newValue) }
    }
    public var scenarios: [TaxValue] {
        get { config["scenarios"]?.arrayValue ?? [] }
        set { config["scenarios"] = .array(newValue) }
    }
    public var resolvedAssumptions: [String: TaxValue] {
        var result: [String: TaxValue] = [:]
        for item in assumptions {
            let id = item["id"]?.stringValue ?? ""
            let value = assumptionValues[id]
            result[id] = value == nil || value == .null ? item["defaultValue"] ?? .null : value
        }
        return result
    }
    public var assumptionUnits: TaxValue {
        var units: [String: TaxValue] = [:]
        for item in assumptions {
            if let unit = item["unit"], unit != .null { units[item["id"]?.stringValue ?? ""] = unit }
        }
        return .object(units)
    }
    public var summaryFormulas: [TaxValue] { formulas.filter { $0["scope"]?.stringValue == "summary" } }

    public mutating func addFormula() {
        formulas.append(
            .object([
                "id": .string("formula_\(formulas.count + 1)"), "label": .string(""),
                "expression": .string(""), "scope": .string("row"),
            ]))
    }
    public mutating func addAssumption() {
        assumptions.append(
            .object([
                "id": .string("input_\(assumptions.count + 1)"), "label": .string(""), "defaultValue": .string("0"),
            ]))
    }
    public mutating func setAssumptionValue(at index: Int, text: String) {
        guard assumptions.indices.contains(index) else { return }
        let id = assumptions[index]["id"]?.stringValue ?? ""
        assumptionValues[id] = .string(text)
        assumptions[index]["defaultValue"] = .string(text)
    }
    public mutating func setAssumptionUnit(at index: Int, kind: String) {
        guard assumptions.indices.contains(index) else { return }
        let old = assumptions[index]["unit"]
        guard !kind.isEmpty else {
            assumptions[index]["unit"] = nil
            return
        }
        var fields: [String: TaxValue] = ["kind": .string(kind)]
        if kind == "money" {
            let currency = old?["currency"]
            fields["currency"] = currency == nil || currency == .null ? .string("EUR") : currency
        }
        if kind == "percentage" {
            let basis = old?["percentageBasis"]
            fields["percentageBasis"] = basis == nil || basis == .null ? .string("ratio") : basis
        }
        assumptions[index]["unit"] = .object(fields)
    }
    public mutating func copyScenario(name: String, id: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !assumptions.isEmpty else { return }
        scenarios.append(
            .object([
                "id": .string(id), "name": .string(trimmed), "assumptions": .object(resolvedAssumptions),
            ]))
    }
    public func time(defaultDateColumn: String) -> TaxValue {
        if let time = config["time"], time != .null { return time }
        return .object([
            "bucket": .string("month"), "dateColumn": .string(defaultDateColumn),
            "valueColumns": .array([]), "groupColumns": .array([]), "missing": .string("null"),
            "rollingWindow": .number(3),
        ])
    }
    public static func valuesList(_ text: String) -> TaxValue {
        .array(
            text.split(separator: ",", omittingEmptySubsequences: false).map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
            }.filter { !$0.isEmpty }.map(TaxValue.string))
    }
    public static func json(_ value: TaxValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(decoding: encoder.encode(value), as: UTF8.self)) ?? "null"
    }
    public var formulasJson: String { Self.json(.array(formulas)) }
    public var assumptionsJson: String { Self.json(.array(assumptions)) }
    public var assumptionValuesJson: String { Self.json(.object(assumptionValues)) }
}

public struct AnalysisPreparationStepDraft: Equatable, Sendable {
    public static let types = ["convert", "lookup", "append", "calculate", "unpivot", "pivot"]
    public var type = "convert"
    public var column = ""
    public var inputId = ""
    public var inputKey = ""
    public var targetType = "decimal"
    public var outputId = "derived"
    public var expression = ""
    public var selected: [String] = []
    public var groups: [String] = []
    public var nameColumn = ""
    public var valueColumn = ""
    public var unpivotValueColumn = "value"
    public var aggregate = "sum"
    public init() {}
    private var outputName: String { outputId.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var unpivotName: String { unpivotValueColumn.trimmingCharacters(in: .whitespacesAndNewlines) }
    public func hasUnpivotConflict(columnIds: [String]) -> Bool {
        type == "unpivot" && !outputName.isEmpty && !unpivotName.isEmpty
            && (outputName == unpivotName || columnIds.contains(outputName) || columnIds.contains(unpivotName))
    }
    public func isValid(columnIds: [String]) -> Bool {
        switch type {
        case "convert": !column.isEmpty && !targetType.isEmpty
        case "lookup": !column.isEmpty && !inputId.isEmpty && !inputKey.isEmpty && !outputName.isEmpty
        case "append": !inputId.isEmpty
        case "calculate": !outputName.isEmpty && !expression.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case "unpivot":
            !selected.isEmpty && !outputName.isEmpty && !unpivotName.isEmpty
                && !hasUnpivotConflict(columnIds: columnIds)
        case "pivot": !nameColumn.isEmpty && !valueColumn.isEmpty && !aggregate.isEmpty
        default: false
        }
    }
    public func payload(input: TaxValue?, assumptions: [String: TaxValue]) -> TaxValue {
        var fields: [String: TaxValue] = ["type": .string(type)]
        switch type {
        case "convert":
            fields.merge(["columnId": .string(column), "targetType": .string(targetType), "onError": .string("null")]) {
                _, new in new
            }
        case "lookup":
            fields["input"] = input
            fields["keys"] = .array([.string(column)])
            fields["inputKeys"] = .array([.string(inputKey)])
            fields["prefix"] = .string(outputId)
        case "append": fields["input"] = input
        case "calculate":
            fields["formula"] = .object([
                "id": .string(outputId), "label": .string(outputId), "scope": .string("row"),
                "expression": .string(expression),
            ])
            fields["assumptions"] = .object(assumptions)
        case "unpivot":
            fields["columnIds"] = .array(selected.map(TaxValue.string))
            fields["nameColumn"] = .string(outputName)
            fields["valueColumn"] = .string(unpivotName)
        case "pivot":
            fields["groupColumns"] = .array(groups.map(TaxValue.string))
            fields["nameColumn"] = .string(nameColumn)
            fields["valueColumn"] = .string(valueColumn)
            fields["aggregate"] = .string(aggregate)
        default: break
        }
        return .object(fields)
    }
}

import Foundation

public struct ResearchLifeScenario: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let name: String
    public let monthlySurplus: Decimal
    public let monthlyIncomeLoss: Decimal
    public let monthlyContribution: Decimal
    public let goalValue: Decimal?
    public let goalDate: String?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        name = try ResearchDecode.string(raw["name"])
        monthlySurplus = try ResearchDecode.decimal(raw["monthlySurplus"])
        monthlyIncomeLoss = try ResearchDecode.decimal(raw["monthlyIncomeLoss"])
        monthlyContribution = try ResearchDecode.decimal(raw["monthlyContribution"])
        goalValue = try ResearchDecode.optionalDecimal(raw["goalValue"])
        goalDate = try ResearchDecode.optionalString(raw["goalDate"])
        guard !id.isEmpty, id.utf16.count <= 100, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            name.utf16.count <= 80, raw["kind"] == .string("income_interruption"),
            raw["interruptionMonths"] == .number(3),
            monthlySurplus >= 0, monthlyIncomeLoss >= 0, monthlyContribution >= 0,
            monthlyContribution <= monthlySurplus,
            (goalValue != nil) == (goalDate != nil), goalValue.map({ $0 > 0 }) ?? true
        else {
            throw ResearchDecode.failure("Invalid saved life scenario")
        }
        if let goalDate {
            guard Self.isISODate(goalDate) else {
                throw ResearchDecode.failure("Invalid saved life scenario goal date")
            }
        }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    private static func isISODate(_ text: String) -> Bool {
        guard text.range(of: #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z"#, options: .regularExpression) != nil else {
            return false
        }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return false }
        let leap = parts[0].isMultiple(of: 4) && (!parts[0].isMultiple(of: 100) || parts[0].isMultiple(of: 400))
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return (1...days[parts[1] - 1]).contains(parts[2])
    }
}

public struct ResearchLifeScenarioDraft: Equatable, Sendable {
    public var id: String?
    public var name = ""
    public var monthlySurplus = ""
    public var monthlyIncomeLoss = ""
    public var monthlyContribution = ""
    public var goalValue = ""
    public var goalMonth = ""
    public init() {}
    public init(scenario: ResearchLifeScenario, numberFormat: NumberFormat) {
        id = scenario.id
        name = scenario.name
        monthlySurplus = LocaleNumber.editable(scenario.monthlySurplus, format: numberFormat)
        monthlyIncomeLoss = LocaleNumber.editable(scenario.monthlyIncomeLoss, format: numberFormat)
        monthlyContribution = LocaleNumber.editable(scenario.monthlyContribution, format: numberFormat)
        goalValue = LocaleNumber.editable(scenario.goalValue, format: numberFormat)
        goalMonth = scenario.goalDate.map { String($0.prefix(7)) } ?? ""
    }
    public var signature: TaxValue {
        var fields: [String: TaxValue] = [
            "name": .string(name), "monthlySurplus": .string(monthlySurplus),
            "monthlyIncomeLoss": .string(monthlyIncomeLoss), "monthlyContribution": .string(monthlyContribution),
            "goalValue": .string(goalValue), "goalDate": .string(goalMonth),
        ]
        if let id { fields["id"] = .string(id) }
        return .object(fields)
    }
    public func read(
        numberFormat: NumberFormat, horizonMonths: Int, now: Date, timeZone: TimeZone = .current,
        newID: @Sendable () -> String = { UUID().uuidString }
    ) throws -> (scenario: ResearchLifeScenario, goalMonth: Int?) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, trimmedName.utf16.count <= 80,
            let surplus = LocaleNumber.parse(monthlySurplus, format: numberFormat), surplus >= 0,
            let loss = LocaleNumber.parse(monthlyIncomeLoss, format: numberFormat), loss >= 0,
            let contribution = LocaleNumber.parse(monthlyContribution, format: numberFormat), contribution >= 0,
            contribution <= surplus
        else { throw ResearchDecode.failure("research.lifeScenario.invalid") }
        let goalText = goalValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let goal = goalText.isEmpty ? nil : LocaleNumber.parse(goalValue, format: numberFormat)
        guard goalText.isEmpty || goal.map({ $0 > 0 && !$0.isNaN }) == true,
            (!goalText.isEmpty) == (!goalMonth.isEmpty)
        else { throw ResearchDecode.failure("research.lifeScenario.invalid") }
        let month: Int?
        if goal != nil {
            guard
                let valid = Self.resolveGoalMonth(goalMonth, horizonMonths: horizonMonths, now: now, timeZone: timeZone)
            else {
                throw ResearchDecode.failure("research.lifeScenario.invalid")
            }
            month = valid
        } else {
            month = nil
        }
        var fields: [String: TaxValue] = [
            "id": .string(id ?? newID()), "name": .string(trimmedName),
            "kind": .string("income_interruption"), "interruptionMonths": .number(3),
            "monthlySurplus": .number(surplus), "monthlyIncomeLoss": .number(loss),
            "monthlyContribution": .number(contribution),
        ]
        if let goal {
            fields["goalValue"] = .number(goal)
            fields["goalDate"] = .string(goalMonth + "-01")
        }
        return (try .init(raw: .object(fields)), month)
    }
    public static func resolveGoalMonth(_ text: String, horizonMonths: Int, now: Date, timeZone: TimeZone = .current)
        -> Int?
    {
        guard horizonMonths >= 1, text.range(of: #"\A[0-9]{4}-[0-9]{2}\z"#, options: .regularExpression) != nil,
            let year = Int(text.prefix(4)), let month = Int(text.suffix(2)), year >= 1, (1...12).contains(month)
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.dateComponents([.year, .month], from: now)
        guard let currentYear = today.year, let currentMonth = today.month else { return nil }
        let distance = (year - currentYear) * 12 + month - currentMonth
        return (1...horizonMonths).contains(distance) ? distance : nil
    }
}

public struct ResearchLifeScenarioComparison: Equatable, Sendable {
    public let baseline: ResearchForecastData
    public let interrupted: ResearchForecastData
    public let baselineMeta: ResearchMeta
    public let interruptedMeta: ResearchMeta
    public let goalMonth: Int?
    public let reducedContribution: Decimal
    public let monthlyDeficit: Decimal
    public let medianGap: Decimal?
    public let available: Bool
    public let rawPreparation: TaxValue
    public let rawComparison: TaxValue
    let signature: TaxValue
}

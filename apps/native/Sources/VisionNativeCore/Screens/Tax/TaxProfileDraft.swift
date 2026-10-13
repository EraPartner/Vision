import Foundation

public enum TaxProfileStep: String, CaseIterable, Sendable {
    case household, income, home, incomeSources, exemptions, region
    public var index: Int { Self.allCases.firstIndex(of: self)! }
    public var titleKey: String { "tax.profile.step.\(rawValue)" }
}

/// Structural form edits only. Assessment and every tax amount are returned by the backend.
public struct TaxProfileDraft: Equatable, Sendable {
    public private(set) var value: TaxValue
    public init(value: TaxValue) { self.value = value }
    public func get(_ path: [String]) -> TaxValue? { Self.read(value, path: path) }
    public mutating func set(_ path: [String], _ newValue: TaxValue?) {
        Self.write(&value, path: path, newValue: newValue)
    }
    public var partners: [TaxValue] { self.get(["partners"])?.arrayValue ?? [] }
    public func partnerIndex(_ id: String) -> Int { partners.firstIndex { $0["id"]?.stringValue == id } ?? 0 }
    public func partnerPath(_ id: String) -> [String] { ["partners", String(partnerIndex(id))] }
    public static let activityKinds = [
        "employee", "civil_servant", "director", "self_employed_profits", "self_employed_fees", "helping_spouse",
        "pension", "other_professional", "net_professional_amount",
    ]
    public static let eventKinds = [
        "marriage", "legal_cohabitation", "legal_cohabitation_ended", "factual_cohabitation_start",
        "factual_separation", "divorce", "death",
    ]
    public static let regions = ["flanders", "wallonia", "brussels"]

    public mutating func setHasPartner(_ enabled: Bool) {
        var rows = partners
        if enabled {
            guard !rows.contains(where: { $0["id"]?.stringValue == "B" }) else { return }
            rows.append(
                .object([
                    "id": .string("B"), "isDisabled": .bool(false),
                    "activities": .array([
                        .object([
                            "id": .string(nextActivityId("B")), "kind": .string("employee"), "grossIncome": .number(0),
                        ])
                    ]),
                    "professionalExpenses": .object([:]), "unionDues": .number(0), "otherTaxableIncome": .number(0),
                    "alimonyPaid": .number(0),
                    "reductions": .object(
                        Dictionary(
                            uniqueKeysWithValues: [
                                "personalPensionContributions", "lifeInsurancePremiums", "charitableDonations",
                                "childcareCosts", "medicalExpenses",
                            ].map { ($0, .number(0)) })),
                ]))
        } else {
            rows.removeAll { $0["id"]?.stringValue == "B" }
            set(["relationship", "deathYearElection"], nil)
            set(["relationship", "legacyAssumedJoint"], nil)
            let events = get(["relationship", "events"])?.arrayValue ?? []
            set(["relationship", "events"], .array(events.filter { $0["partnerId"]?.stringValue != "B" }))
            for path in [["dependents", "claimantPartnerId"], ["home", "mortgageCreditPartnerId"]] {
                if get(path)?.stringValue == "B" { set(path, .string("A")) }
            }
            set(["home", "mortgageSharePartnerB"], nil)
            if let fields = get(["migratedFrom", "unmappedFields"])?.arrayValue {
                set(
                    ["migratedFrom", "unmappedFields"],
                    .array(fields.filter { $0["field"]?.stringValue != "isSpouseDisabled" }))
            }
        }
        set(["partners"], .array(rows))
    }

    public mutating func addActivity(partner: String) {
        let path = partnerPath(partner) + ["activities"]
        var rows = get(path)?.arrayValue ?? []
        rows.append(
            .object(["id": .string(nextActivityId(partner)), "kind": .string("employee"), "grossIncome": .number(0)]))
        set(path, .array(rows))
    }
    public mutating func removeActivity(partner: String, index: Int) {
        let path = partnerPath(partner) + ["activities"]
        var rows = get(path)?.arrayValue ?? []
        guard rows.indices.contains(index), partner != "A" || rows.count > 1 else { return }
        rows.remove(at: index)
        set(path, .array(rows))
        pruneExpenses(partner)
    }
    public mutating func setActivityKind(partner: String, index: Int, kind: String) {
        let path = partnerPath(partner) + ["activities", String(index)]
        guard let old = get(path), Self.activityKinds.contains(kind) else { return }
        let wasNet = old["kind"]?.stringValue == "net_professional_amount"
        let isNet = kind == "net_professional_amount"
        set(path + ["kind"], .string(kind))
        if wasNet != isNet {
            set(
                path + [isNet ? "netProfessionalIncome" : "grossIncome"],
                old[wasNet ? "netProfessionalIncome" : "grossIncome"] ?? .number(0))
            set(path + [isNet ? "grossIncome" : "netProfessionalIncome"], isNet ? .number(0) : nil)
        }
        if kind != "pension" { set(path + ["pensionKind"], nil) }
        pruneExpenses(partner)
    }
    public func expenseCategories(_ partner: String) -> [String] {
        var result: [String] = []
        for row in get(partnerPath(partner) + ["activities"])?.arrayValue ?? [] {
            let kind = row["kind"]?.stringValue ?? ""
            guard kind != "net_professional_amount" else { continue }
            let category = Self.expenseCategory(kind)
            if !result.contains(category) { result.append(category) }
        }
        return result
    }
    public mutating func addEvent() {
        var rows = get(["relationship", "events"])?.arrayValue ?? []
        var n = 1
        while rows.contains(where: { $0["id"]?.stringValue == "evt_\(n)" }) { n += 1 }
        let year = get(["taxYear"])?.decimalValue ?? 2026
        rows.append(
            .object([
                "id": .string("evt_\(n)"), "kind": .string("marriage"),
                "date": .string("\(NSDecimalNumber(decimal: year - 1).intValue)-01-01"),
            ]))
        set(["relationship", "events"], .array(rows))
        set(["relationship", "legacyAssumedJoint"], nil)
    }
    public mutating func setEventKind(index: Int, kind: String) {
        let path = ["relationship", "events", String(index)]
        set(path + ["kind"], .string(kind))
        set(path + ["partnerId"], kind == "death" ? (get(path + ["partnerId"]) ?? .string("B")) : nil)
    }
    public mutating func removeEvent(index: Int) {
        var rows = get(["relationship", "events"])?.arrayValue ?? []
        guard rows.indices.contains(index) else { return }
        rows.remove(at: index)
        set(["relationship", "events"], .array(rows))
    }
    public mutating func addResidence() {
        var rows = get(["home", "additionalResidences"])?.arrayValue ?? []
        rows.append(
            .object([
                "label": .string(""), "cadastralIncome": .number(0), "region": get(["region"]) ?? .string("flanders"),
            ]))
        set(["home", "additionalResidences"], .array(rows))
    }
    public mutating func setDependent(_ key: String, count: Int) {
        set(["dependents", key], .number(Decimal(count)))
        let disabledKey = key == "children" ? "childrenDisabled" : "otherPersonsDisabled"
        if key == "children" || key == "otherPersons" {
            let disabled = get(["dependents", disabledKey])?.decimalValue ?? 0
            set(["dependents", disabledKey], .number(min(disabled, Decimal(count))))
        }
    }
    public var incomeErrorKey: String? {
        let a = partners.first { $0["id"]?.stringValue == "A" }
        let total = (a?["activities"]?.arrayValue ?? []).reduce(Decimal.zero) { sum, row in
            sum
                + (row[row["kind"]?.stringValue == "net_professional_amount" ? "netProfessionalIncome" : "grossIncome"]?
                    .decimalValue ?? 0)
        }
        guard total > 0 else { return "tax.profile.validation.grossIncomeRequired" }
        for partner in partners {
            let id = partner["id"]?.stringValue ?? "A"
            for category in expenseCategories(id) {
                let choice = partner["professionalExpenses"]?[category]
                if choice?["method"]?.stringValue == "actual", (choice?["actualAmount"]?.decimalValue ?? 0) <= 0 {
                    return "tax.profile.validation.actualExpensesRequired"
                }
            }
        }
        for partner in partners {
            for row in partner["activities"]?.arrayValue ?? [] {
                if let start = row["startDate"]?.stringValue, let end = row["endDate"]?.stringValue, !start.isEmpty,
                    !end.isEmpty, end < start
                {
                    return "tax.profile.validation.activityDatesOrder"
                }
            }
        }
        return nil
    }
    private func nextActivityId(_ partner: String) -> String {
        let ids = partners.flatMap { $0["activities"]?.arrayValue ?? [] }.compactMap { $0["id"]?.stringValue }
        var n = 1
        while ids.contains("act_\(partner)_\(n)") { n += 1 }
        return "act_\(partner)_\(n)"
    }
    private mutating func pruneExpenses(_ partner: String) {
        let path = partnerPath(partner) + ["professionalExpenses"]
        let used = Set(expenseCategories(partner))
        let choices = get(path)?.objectValue ?? [:]
        set(path, .object(choices.filter { used.contains($0.key) }))
    }
    private static func expenseCategory(_ kind: String) -> String {
        switch kind {
        case "employee", "civil_servant": "remuneration"
        case "director": "director"
        case "self_employed_profits": "profits"
        case "self_employed_fees": "fees"
        case "helping_spouse": "helping_spouse"
        default: "none"
        }
    }
    private static func read(_ value: TaxValue, path: [String]) -> TaxValue? {
        guard let first = path.first else { return value }
        let next: TaxValue?
        if let rows = value.arrayValue, let index = Int(first), rows.indices.contains(index) {
            next = rows[index]
        } else {
            next = value[first]
        }
        guard let next else { return nil }
        return read(next, path: Array(path.dropFirst()))
    }
    private static func write(_ value: inout TaxValue, path: [String], newValue: TaxValue?) {
        guard let first = path.first else {
            if let newValue { value = newValue }
            return
        }
        let rest = Array(path.dropFirst())
        if var rows = value.arrayValue, let index = Int(first), rows.indices.contains(index) {
            if rest.isEmpty, let newValue {
                rows[index] = newValue
            } else {
                write(&rows[index], path: rest, newValue: newValue)
            }
            value = .array(rows)
        } else {
            var fields = value.objectValue ?? [:]
            if rest.isEmpty {
                fields[first] = newValue
            } else {
                var child = fields[first] ?? .object([:])
                write(&child, path: rest, newValue: newValue)
                fields[first] = child
            }
            value = .object(fields)
        }
    }
}

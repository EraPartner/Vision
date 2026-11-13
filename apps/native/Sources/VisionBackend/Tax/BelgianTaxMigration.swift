import Foundation

/// `householdMigration.ts`: the version 1 profile and the version 2 household, converted both
/// ways on their stored JSON. A member that is absent here is `undefined` there.
enum HouseholdMigration {
    private static let reductionKeys = [
        "personalPensionContributions", "pensionScheme", "pensionEligible", "lifeInsurancePremiums",
        "lifeInsuranceEligible", "employeeGroupInsuranceContributions", "employeeGroupInsuranceEligible",
        "charitableDonations", "charitableDonationsEligible", "childcareCosts", "childcareEligibleDays",
        "childcareEligible", "domesticHelpCosts", "domesticHelpEligible", "serviceVoucherCount",
        "serviceVoucherSpend", "serviceVoucherEligible", "medicalExpenses",
    ]
    private static let requiredReductionKeys = [
        "personalPensionContributions", "lifeInsurancePremiums", "charitableDonations", "childcareCosts",
        "medicalExpenses",
    ]
    private static let homeKeys = [
        "cadastralIncome", "cadastralCentimesOverride", "additionalResidences", "mortgageInterestPaid",
        "mortgageCapitalRepaid", "mortgageStartYear", "mortgageRegion", "mortgageIsPrimaryResidence",
    ]
    /// Version 1 key and its version 2 key in `dependents`.
    private static let dependentKeys = [
        ("dependentChildren", "children"), ("dependentChildrenUnder3", "childrenUnder3"),
        ("dependentChildrenDisabled", "childrenDisabled"), ("dependentOtherPersons", "otherPersons"),
        ("dependentOtherPersonsDisabled", "otherPersonsDisabled"),
    ]
    private static let partnerAKeys = [
        "isDisabled", "isIsolatedParent", "unionDues", "otherTaxableIncome", "alimonyPaid", "annualDividendIncome",
        "annualSavingsInterest",
    ]
    private static let householdKeys = [
        "taxYear", "profileConfigured", "region", "communalSurchargePercent", "taxIncomeCategoryIds",
    ]
    private static let primaryActivityKeys = [
        "employmentType", "selfEmployedIncomeKind", "grossAnnualIncome", "professionalExpenseMethod",
        "actualProfessionalExpenses",
    ]
    private static let spouseKeys = ["filingStatus", "spouseProfessionalIncome", "isSpouseDisabled"]
    private static let knownKeys = Set(
        reductionKeys + homeKeys + dependentKeys.map(\.0) + partnerAKeys + householdKeys + primaryActivityKeys
            + spouseKeys)
    private static let primaryActivityID = "act_A_1"
    private static let spouseActivityID = "act_B_1"
    private static let netAmountKind = JSValue.string(HouseholdActivityKind.netProfessionalAmount.rawValue)
    private static let marriedJoint = JSValue.string("married_joint")
    private static let actualMethod = JSValue.string(ExpenseMethod.actual.rawValue)
    private static let zero = JSValue.number(0)

    private static func activityKind(employment: JSValue?, selfEmployedKind: JSValue?) -> HouseholdActivityKind {
        switch employment?.stringValue {
        case "employee": return .employee
        case "civil_servant": return .civilServant
        case "director": return .director
        case "self_employed":
            let profits = selfEmployedKind == nil || selfEmployedKind == .null || selfEmployedKind == .string("profits")
            return profits ? .selfEmployedProfits : .selfEmployedFees
        case "retired": return .pension
        default: return .otherProfessional
        }
    }

    private static func employment(for kind: HouseholdActivityKind) -> (type: String, selfEmployedKind: String?) {
        switch kind {
        case .employee: return ("employee", nil)
        case .civilServant: return ("civil_servant", nil)
        case .director: return ("director", nil)
        case .selfEmployedProfits: return ("self_employed", "profits")
        case .selfEmployedFees: return ("self_employed", "fees")
        case .pension: return ("retired", nil)
        default: return ("other", nil)
        }
    }

    /// `num(value)`: a finite number, otherwise 0.
    static func finite(_ value: JSValue?) -> Double {
        if case .number(let number)? = value, number.isFinite { return number }
        return 0
    }

    private static func number(_ value: JSValue?) -> JSValue { .number(finite(value)) }

    private static func copyDefined(_ target: inout JSObject, _ source: JSObject, _ keys: [String]) {
        for key in keys {
            if let value = source[key] { target[key] = value }
        }
    }

    private static func object(_ pairs: [(String, JSValue)]) -> JSValue { .object(JSObject(pairs)) }

    private static func expenseChoice(method: JSValue?, actualAmount: JSValue?) -> JSValue {
        object([
            ("method", .string(method == actualMethod ? ExpenseMethod.actual.rawValue : ExpenseMethod.lumpSum.rawValue)),
            ("actualAmount", number(actualAmount)),
        ])
    }

    private static func legacySpouse(_ profile: JSObject) -> JSValue {
        object([
            ("id", .string("B")), ("isDisabled", .bool(profile.flag("isSpouseDisabled"))),
            (
                "activities",
                .array([
                    object([
                        ("id", .string(spouseActivityID)), ("kind", netAmountKind), ("grossIncome", zero),
                        ("netProfessionalIncome", number(profile["spouseProfessionalIncome"])),
                    ])
                ])
            ),
            ("professionalExpenses", .object(JSObject())), ("unionDues", zero), ("otherTaxableIncome", zero),
            ("alimonyPaid", zero),
            (
                "reductions",
                object(requiredReductionKeys.map { ($0, zero) })
            ),
        ])
    }

    private static func isLegacySpouse(_ partner: JSObject) throws -> Bool {
        try activities(partner).allSatisfy { $0["kind"] == netAmountKind } && partner["otherTaxableIncome"] == zero
            && partner["alimonyPaid"] == zero && partner["unionDues"] == zero && partner["birthYear"] == nil
            && partner["displayName"] == nil
    }

    /// `withoutNullFields(profile)`.
    static func withoutNullFields(_ profile: JSObject) -> JSObject {
        JSObject(profile.entries.filter { $0.1 != .null })
    }

    /// `[...value]` of a stored list.
    private static func spread(_ value: JSValue) throws -> JSValue {
        switch value {
        case .array: return value
        case .string(let text): return .array(text.map { .string(String($0)) })
        default: throw BelgianTaxError.malformed("taxIncomeCategoryIds")
        }
    }

    private static func activities(_ partner: JSObject) throws -> [JSObject] {
        guard case .array(let items)? = partner["activities"] else { throw BelgianTaxError.malformed("activities") }
        return items.map { $0.objectValue ?? JSObject() }
    }

    private static func partners(_ household: JSObject) throws -> [JSObject] {
        guard case .array(let items)? = household["partners"] else { throw BelgianTaxError.malformed("partners") }
        return items.map { $0.objectValue ?? JSObject() }
    }

    private static func member(_ object: JSObject, _ key: String) throws -> JSObject {
        guard let value = object[key]?.objectValue else { throw BelgianTaxError.malformed(key) }
        return value
    }

    private static func forfaitKey(_ kind: HouseholdActivityKind) -> String { kind.forfaitCategory.rawValue }

    private static func kind(_ activity: JSObject) -> HouseholdActivityKind {
        HouseholdActivityKind(rawValue: activity.text("kind") ?? "")
    }

    /// `upgradeProfileV1ToHousehold(profile)`: a version 2 value is returned as it is.
    static func upgrade(_ value: JSObject) throws -> JSObject {
        if value["version"] == .number(2) { return value }
        let profile = withoutNullFields(value)
        var unmapped: [JSValue] = []
        let kind = activityKind(employment: profile["employmentType"], selfEmployedKind: profile["selfEmployedIncomeKind"])
        let primary = object([
            ("id", .string(primaryActivityID)), ("kind", .string(kind.rawValue)),
            ("grossIncome", number(profile["grossAnnualIncome"])),
        ])
        var reductions = JSObject()
        copyDefined(&reductions, profile, reductionKeys)
        for key in requiredReductionKeys { reductions[key] = number(reductions[key]) }
        var partnerA = JSObject([
            ("id", .string("A")), ("isDisabled", .bool(profile.flag("isDisabled"))), ("activities", .array([primary])),
            (
                "professionalExpenses",
                object([
                    (
                        forfaitKey(kind),
                        expenseChoice(
                            method: profile["professionalExpenseMethod"],
                            actualAmount: profile["actualProfessionalExpenses"])
                    )
                ])
            ),
            ("unionDues", number(profile["unionDues"])), ("otherTaxableIncome", number(profile["otherTaxableIncome"])),
            ("alimonyPaid", number(profile["alimonyPaid"])), ("reductions", .object(reductions)),
        ])
        copyDefined(&partnerA, profile, ["isIsolatedParent", "annualDividendIncome", "annualSavingsInterest"])
        var dependents = JSObject([
            ("children", number(profile["dependentChildren"])),
            ("otherPersons", number(profile["dependentOtherPersons"])), ("claimantPartnerId", .string("A")),
        ])
        for (old, new) in dependentKeys.dropFirst() where new != "otherPersons" {
            if let value = profile[old] { dependents[new] = value }
        }
        var home = JSObject()
        copyDefined(&home, profile, homeKeys)
        home["cadastralIncome"] = number(home["cadastralIncome"])
        home["mortgageInterestPaid"] = number(home["mortgageInterestPaid"])
        var partners: [JSValue] = [.object(partnerA)]
        let joint = profile["filingStatus"] == marriedJoint
        if joint {
            partners.append(legacySpouse(profile))
        } else {
            if finite(profile["spouseProfessionalIncome"]) > 0 {
                unmapped.append(
                    object([
                        ("field", .string("spouseProfessionalIncome")),
                        ("note", .string("spouse_income_without_joint_filing")),
                        ("value", profile["spouseProfessionalIncome"] ?? .null),
                    ]))
            }
            if profile.flag("isSpouseDisabled") {
                unmapped.append(
                    object([
                        ("field", .string("isSpouseDisabled")),
                        ("note", .string("spouse_disability_without_joint_filing")), ("value", .bool(true)),
                    ]))
            }
        }
        let sortedKeys = profile.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        for key in sortedKeys where !knownKeys.contains(key) {
            unmapped.append(
                object([("field", .string(key)), ("note", .string("unknown_profile_field")), ("value", profile[key] ?? .null)]))
        }
        var household = JSObject([("version", .number(2))])
        household["taxYear"] = profile["taxYear"]
        household["profileConfigured"] = .bool(profile.flag("profileConfigured"))
        household["region"] = profile["region"]
        household["communalSurchargePercent"] = number(profile["communalSurchargePercent"])
        household["partners"] = .array(partners)
        household["relationship"] =
            joint ? object([("events", .array([])), ("legacyAssumedJoint", .bool(true))]) : object([("events", .array([]))])
        household["dependents"] = .object(dependents)
        household["home"] = .object(home)
        household["migratedFrom"] = object([("fromVersion", .number(1)), ("unmappedFields", .array(unmapped))])
        if let ids = profile["taxIncomeCategoryIds"] { household["taxIncomeCategoryIds"] = try spread(ids) }
        return household
    }

    /// `upgradeSnapshotsV1ToV2(snapshots)`.
    static func upgradeSnapshots(_ snapshots: JSObject) throws -> JSObject {
        var result = JSObject()
        let years = snapshots.keys.map(JavaScriptNumber.fromString).sorted { $0 < $1 }
        for year in years {
            let key = JavaScriptNumber.text(year)
            guard let value = snapshots[key] else { continue }
            result[key] = .object(try upgrade(value.objectValue ?? JSObject()))
        }
        return result
    }

    private static func primaryActivityIndex(_ activities: [JSObject]) -> Int? {
        activities.firstIndex { $0["id"] == .string(primaryActivityID) }
            ?? activities.firstIndex { $0["kind"] != netAmountKind } ?? (activities.isEmpty ? nil : 0)
    }

    private static func activityAmount(_ activity: JSObject) -> Double {
        activity["kind"] == netAmountKind ? finite(activity["netProfessionalIncome"]) : finite(activity["grossIncome"])
    }

    /// `projectHouseholdToProfileV1(household, isJointFiling)`: `jointFiling` is the engine's
    /// `filesJointly` when the caller passes it, `nil` when it passes none.
    static func project(_ household: JSObject, jointFiling: ((JSObject) -> Bool)?) throws -> JSObject {
        var profile = JSObject()
        if case .array(let fields)? = household.object("migratedFrom")?["unmappedFields"] {
            for field in fields {
                guard let field = field.objectValue else { throw BelgianTaxError.malformed("unmappedFields") }
                if let value = field["value"] { profile[field["field"]?.javaScriptString ?? "undefined"] = value }
            }
        }
        let all = try partners(household)
        let partnerA = all.first { $0["id"] == .string("A") } ?? all.first
        let partnerB = all.first { $0["id"] == .string("B") }
        let activitiesA = try partnerA.map(activities)
        let primary = activitiesA.flatMap { list in primaryActivityIndex(list).map { list[$0] } }
        let kind = primary.map(kind) ?? .employee
        let employment = employment(for: kind)
        let choice = try partnerA.map { try member($0, "professionalExpenses") }?[forfaitKey(kind)]
        func valueOrNull(_ value: JSValue?, _ fallback: JSValue) -> JSValue {
            guard let value, value != .null else { return fallback }
            return value
        }
        profile["profileConfigured"] = household["profileConfigured"]
        profile["employmentType"] = .string(employment.type)
        profile["grossAnnualIncome"] = .number((activitiesA ?? []).reduce(0) { $0 + activityAmount($1) })
        profile["professionalExpenseMethod"] = valueOrNull(choice?.objectValue?["method"], .string("lump_sum"))
        profile["actualProfessionalExpenses"] = valueOrNull(choice?.objectValue?["actualAmount"], zero)
        profile["communalSurchargePercent"] = household["communalSurchargePercent"]
        profile["region"] = household["region"]
        profile["isDisabled"] = valueOrNull(partnerA?["isDisabled"], .bool(false))
        profile["isSpouseDisabled"] = partnerB.map { $0["isDisabled"] } ?? .bool(false)
        profile["unionDues"] = valueOrNull(partnerA?["unionDues"], zero)
        profile["otherTaxableIncome"] = valueOrNull(partnerA?["otherTaxableIncome"], zero)
        profile["alimonyPaid"] = valueOrNull(partnerA?["alimonyPaid"], zero)
        profile["taxYear"] = household["taxYear"]
        if let selfEmployedKind = employment.selfEmployedKind {
            profile["selfEmployedIncomeKind"] = .string(selfEmployedKind)
        }
        if let partnerA {
            copyDefined(&profile, partnerA, ["isIsolatedParent", "annualDividendIncome", "annualSavingsInterest"])
            copyDefined(&profile, try member(partnerA, "reductions"), reductionKeys)
        }
        let dependents = try member(household, "dependents")
        for (old, new) in dependentKeys {
            if let value = dependents[new] { profile[old] = value }
        }
        copyDefined(&profile, try member(household, "home"), homeKeys)
        if let ids = household["taxIncomeCategoryIds"] { profile["taxIncomeCategoryIds"] = try spread(ids) }
        if let partnerB {
            if let jointFiling { profile["filingStatus"] = jointFiling(household) ? marriedJoint : .string("single") }
            profile["spouseProfessionalIncome"] = .number(try activities(partnerB).reduce(0) { $0 + activityAmount($1) })
        } else {
            profile["filingStatus"] = .string("single")
        }
        return profile
    }

    /// `applyProfileV1PatchToHousehold(household, patch, isJointFiling)`.
    static func apply(
        patch: JSObject, to household: JSObject, jointFiling: ((JSObject) -> Bool)?
    ) throws -> JSObject {
        var next = household
        var all = try partners(next)
        if !all.contains(where: { $0["id"] == .string("A") }) {
            let upgraded = try partners(try upgrade(try project(next, jointFiling: jointFiling)))
            guard let first = upgraded.first else { throw BelgianTaxError.malformed("partner A") }
            all.insert(first, at: 0)
        }
        guard let indexA = all.firstIndex(where: { $0["id"] == .string("A") }) else {
            throw BelgianTaxError.malformed("partner A")
        }
        var partnerA = all[indexA]
        var reductions = try member(partnerA, "reductions")
        var home = try member(next, "home")
        var dependents = try member(next, "dependents")
        let keys = patch.keys
        for (key, value) in patch.entries {
            if key == "mortgageRegion" { continue }
            if householdKeys.contains(key) {
                next[key] = value
            } else if partnerAKeys.contains(key) {
                partnerA[key] = value
            } else if reductionKeys.contains(key) {
                reductions[key] = value
            } else if homeKeys.contains(key) {
                home[key] = value
            } else if let mapped = dependentKeys.first(where: { $0.0 == key }) {
                dependents[mapped.1] = value
            }
        }
        for key in requiredReductionKeys { reductions[key] = number(reductions[key]) }
        partnerA["reductions"] = .object(reductions)
        if keys.contains(where: homeKeys.contains) { home["mortgageRegion"] = nil }
        next["home"] = .object(home)
        next["dependents"] = .object(dependents)
        if keys.contains(where: primaryActivityKeys.contains) {
            var merged = try project(household, jointFiling: jointFiling)
            for (key, value) in patch.entries { merged[key] = value }
            let kind = activityKind(employment: merged["employmentType"], selfEmployedKind: merged["selfEmployedIncomeKind"])
            var list = try activities(partnerA)
            var index = primaryActivityIndex(list)
            if index == nil {
                list.insert(
                    JSObject([("id", .string(primaryActivityID)), ("kind", .string(kind.rawValue)), ("grossIncome", zero)]),
                    at: 0)
                index = 0
            }
            let at = index ?? 0
            var expenses = try member(partnerA, "professionalExpenses")
            if self.kind(list[at]) != kind {
                let oldCategory = forfaitKey(self.kind(list[at]))
                list[at]["netProfessionalIncome"] = nil
                if kind != .pension { list[at]["pensionKind"] = nil }
                list[at]["kind"] = .string(kind.rawValue)
                if !list.contains(where: { forfaitKey(self.kind($0)) == oldCategory }) { expenses[oldCategory] = nil }
            }
            if patch.has("grossAnnualIncome") { list[at]["grossIncome"] = number(merged["grossAnnualIncome"]) }
            expenses[forfaitKey(kind)] = expenseChoice(
                method: merged["professionalExpenseMethod"], actualAmount: merged["actualProfessionalExpenses"])
            partnerA["activities"] = .array(list.map(JSValue.object))
            partnerA["professionalExpenses"] = .object(expenses)
        }
        all[indexA] = partnerA
        if keys.contains(where: spouseKeys.contains) {
            var merged = try project(household, jointFiling: jointFiling)
            for (key, value) in patch.entries { merged[key] = value }
            var relationship = try member(next, "relationship")
            let indexB = all.firstIndex { $0["id"] == .string("B") }
            if merged["filingStatus"] == marriedJoint {
                if indexB == nil, let spouse = legacySpouse(merged).objectValue { all.append(spouse) }
                if let at = all.firstIndex(where: { $0["id"] == .string("B") }) {
                    if patch.has("isSpouseDisabled") { all[at]["isDisabled"] = .bool(merged.flag("isSpouseDisabled")) }
                    var list = try activities(all[at])
                    if patch.has("spouseProfessionalIncome"),
                        let net = list.firstIndex(where: { $0["kind"] == netAmountKind })
                    {
                        list[net]["netProfessionalIncome"] = number(merged["spouseProfessionalIncome"])
                        all[at]["activities"] = .array(list.map(JSValue.object))
                    }
                }
                guard case .array(let events)? = relationship["events"] else {
                    throw BelgianTaxError.malformed("events")
                }
                if events.isEmpty { relationship["legacyAssumedJoint"] = .bool(true) }
            } else if patch.has("filingStatus") {
                if let indexB, try isLegacySpouse(all[indexB]) { all.remove(at: indexB) }
                relationship["legacyAssumedJoint"] = nil
            }
            next["relationship"] = .object(relationship)
        }
        next["partners"] = .array(all.map(JSValue.object))
        return next
    }
}

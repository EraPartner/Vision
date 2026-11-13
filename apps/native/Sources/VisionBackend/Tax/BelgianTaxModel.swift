import Foundation

/// JavaScript's number helpers as the tax engine uses them (`packages/shared-utils/src/numeric.ts`
/// and `Math.max` / `Math.min`, which answer NaN when any argument is NaN).
enum TaxMath {
    /// `orZero(value)`: a missing value, NaN and -0 are 0.
    static func orZero(_ value: Double?) -> Double {
        guard let value, value != 0, !value.isNaN else { return 0 }
        return value
    }

    /// `isNonZeroNumber(value)`.
    static func isNonZero(_ value: Double?) -> Bool {
        guard let value else { return false }
        return value != 0 && !value.isNaN
    }

    static func max(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == b { return a.sign == .minus ? b : a }
        return a > b ? a : b
    }

    static func min(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == b { return a.sign == .minus ? a : b }
        return a < b ? a : b
    }

    /// `clampAtZero(n)`: `n > 0 ? n : 0`, so NaN is 0.
    static func clampAtZero(_ value: Double) -> Double { value > 0 ? value : 0 }

    /// `Math.max(orZero(value), 0)`, the engine's reading of an amount.
    static func amount(_ value: Double?) -> Double { max(orZero(value), 0) }

    /// `a.localeCompare(b)` as a sort predicate, by the root collation the engine's ids and
    /// ISO dates need.
    static func precedes(_ a: String, _ b: String) -> Bool {
        a.compare(b, locale: Locale(identifier: "en")) == .orderedAscending
    }

    static func sum<Item>(_ items: [Item], _ pick: (Item) -> Double) -> Double {
        var total = 0.0
        for item in items { total += pick(item) }
        return total
    }
}

extension JSObject {
    /// The key's value when it is a JSON number.
    func number(_ key: String) -> Double? {
        if case .number(let value)? = self[key] { return value }
        return nil
    }

    func text(_ key: String) -> String? { self[key]?.stringValue }

    func object(_ key: String) -> JSObject? { self[key]?.objectValue }

    /// The key's array elements that are objects.
    func objects(_ key: String) -> [JSObject] {
        guard case .array(let items)? = self[key] else { return [] }
        return items.compactMap(\.objectValue)
    }

    /// `Boolean(object[key])`.
    func flag(_ key: String) -> Bool { FormulaSemantics.truthy(self[key]) }

    /// The key's truthiness, `nil` when the key is absent (`undefined`).
    func optionalFlag(_ key: String) -> Bool? { self[key].map { FormulaSemantics.truthy($0) } }
}

/// A partner of the household (`PartnerId`): A is always present, B is the spouse or partner.
struct HouseholdPartnerID: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let a = HouseholdPartnerID(rawValue: "A")
    static let b = HouseholdPartnerID(rawValue: "B")
}

/// The kind of a professional activity (`ActivityKind`).
struct HouseholdActivityKind: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let employee = HouseholdActivityKind(rawValue: "employee")
    static let civilServant = HouseholdActivityKind(rawValue: "civil_servant")
    static let director = HouseholdActivityKind(rawValue: "director")
    static let selfEmployedProfits = HouseholdActivityKind(rawValue: "self_employed_profits")
    static let selfEmployedFees = HouseholdActivityKind(rawValue: "self_employed_fees")
    static let helpingSpouse = HouseholdActivityKind(rawValue: "helping_spouse")
    static let pension = HouseholdActivityKind(rawValue: "pension")
    static let otherProfessional = HouseholdActivityKind(rawValue: "other_professional")
    static let netProfessionalAmount = HouseholdActivityKind(rawValue: "net_professional_amount")

    /// Kinds whose personal social contributions come off the gross before the forfait.
    static let selfEmployedContribution: Set<HouseholdActivityKind> = [.selfEmployedProfits, .selfEmployedFees, .helpingSpouse]
    /// Kinds subject to the special social security contribution.
    static let contributionSubject: Set<HouseholdActivityKind> = [.employee, .civilServant]
    static let otherProfessionalKinds: Set<HouseholdActivityKind> = [
        .director, .selfEmployedProfits, .selfEmployedFees, .helpingSpouse, .otherProfessional,
    ]

    /// `forfaitCategoryOf(kind)`.
    var forfaitCategory: ForfaitCategory {
        switch self {
        case .employee, .civilServant: return .remuneration
        case .director: return .director
        case .selfEmployedProfits: return .profits
        case .selfEmployedFees: return .fees
        case .helpingSpouse: return .helpingSpouse
        default: return .none
        }
    }
}

/// The lump-sum expense category of an activity (`ForfaitCategory`).
struct ForfaitCategory: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let remuneration = ForfaitCategory(rawValue: "remuneration")
    static let profits = ForfaitCategory(rawValue: "profits")
    static let director = ForfaitCategory(rawValue: "director")
    static let fees = ForfaitCategory(rawValue: "fees")
    static let helpingSpouse = ForfaitCategory(rawValue: "helping_spouse")
    static let none = ForfaitCategory(rawValue: "none")

    /// `FORFAIT_CATEGORIES`, in the order the engine walks them.
    static let all: [ForfaitCategory] = [.remuneration, .profits, .director, .fees, .helpingSpouse, .none]
}

/// `ProfessionalExpenseMethod`.
struct ExpenseMethod: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let lumpSum = ExpenseMethod(rawValue: "lump_sum")
    static let actual = ExpenseMethod(rawValue: "actual")
}

/// The return line of a pension (`PensionKind`).
struct PensionKind: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let statutoryFromLegalAge = PensionKind(rawValue: "statutory_from_legal_age")
    static let survivorOrTransition = PensionKind(rawValue: "survivor_or_transition")
}

/// `MortgageCreditRegime`.
enum MortgageCreditRegime: String, Sendable {
    case flemishWoonbonus = "flemish_woonbonus"
    case walloonChequeHabitat = "walloon_cheque_habitat"
    case none
}

/// The household the engine computes (`BelgianTaxHouseholdV2`), read from its stored JSON.
/// A field of the wrong JSON type reads as absent; the stored value is validated by
/// `SettingsSchemas.belgianTaxHouseholdV2` before it gets here.
struct TaxHousehold: Sendable {
    /// `IncomeActivity`.
    struct Activity: Sendable {
        var id: String
        var kind: HouseholdActivityKind
        var grossIncome: Double?
        var netProfessionalIncome: Double?
        var pensionKind: PensionKind?
        var socialContributionsPaid: Double?

        init(_ json: JSObject) {
            id = json.text("id") ?? ""
            kind = HouseholdActivityKind(rawValue: json.text("kind") ?? "")
            grossIncome = json.number("grossIncome")
            netProfessionalIncome = json.number("netProfessionalIncome")
            pensionKind = json.text("pensionKind").map(PensionKind.init(rawValue:))
            socialContributionsPaid = json.number("socialContributionsPaid")
        }
    }

    /// `ProfessionalExpenseChoice`.
    struct ExpenseChoice: Sendable {
        var method: ExpenseMethod?
        var actualAmount: Double?
    }

    /// `ReductionInputs`.
    struct Reductions: Sendable {
        var personalPensionContributions: Double?
        var alternativePensionScheme = false
        var pensionEligible = false
        var lifeInsurancePremiums: Double?
        var lifeInsuranceEligible = false
        var employeeGroupInsuranceContributions: Double?
        var employeeGroupInsuranceEligible = false
        var charitableDonations: Double?
        var charitableDonationsEligible = false
        var childcareCosts: Double?
        var childcareEligibleDays: Double?
        var childcareEligible = false
        var domesticHelpCosts: Double?
        var domesticHelpEligible = false
        var serviceVoucherCount: Double?
        var serviceVoucherSpend: Double?
        var serviceVoucherEligible = false

        private static let alternativeScheme = JSValue.string("1350")

        init(_ json: JSObject) {
            personalPensionContributions = json.number("personalPensionContributions")
            alternativePensionScheme = json["pensionScheme"] == Self.alternativeScheme
            pensionEligible = json.flag("pensionEligible")
            lifeInsurancePremiums = json.number("lifeInsurancePremiums")
            lifeInsuranceEligible = json.flag("lifeInsuranceEligible")
            employeeGroupInsuranceContributions = json.number("employeeGroupInsuranceContributions")
            employeeGroupInsuranceEligible = json.flag("employeeGroupInsuranceEligible")
            charitableDonations = json.number("charitableDonations")
            charitableDonationsEligible = json.flag("charitableDonationsEligible")
            childcareCosts = json.number("childcareCosts")
            childcareEligibleDays = json.number("childcareEligibleDays")
            childcareEligible = json.flag("childcareEligible")
            domesticHelpCosts = json.number("domesticHelpCosts")
            domesticHelpEligible = json.flag("domesticHelpEligible")
            serviceVoucherCount = json.number("serviceVoucherCount")
            serviceVoucherSpend = json.number("serviceVoucherSpend")
            serviceVoucherEligible = json.flag("serviceVoucherEligible")
        }
    }

    /// `HouseholdPartner`.
    struct Partner: Sendable {
        var id: HouseholdPartnerID
        var birthYear: Double?
        var isDisabled: Bool
        var isIsolatedParent: Bool?
        var activities: [Activity]
        var professionalExpenses: [ForfaitCategory: ExpenseChoice]
        var unionDues: Double?
        var otherTaxableIncome: Double?
        var alimonyPaid: Double?
        var treatyExemptProfessionalIncome: Double?
        var reductions: Reductions
        var annualDividendIncome: Double?
        var annualSavingsInterest: Double?

        init(_ json: JSObject) {
            id = HouseholdPartnerID(rawValue: json.text("id") ?? "")
            birthYear = json.number("birthYear")
            isDisabled = json.flag("isDisabled")
            isIsolatedParent = json.optionalFlag("isIsolatedParent")
            activities = json.objects("activities").map(Activity.init)
            var choices: [ForfaitCategory: ExpenseChoice] = [:]
            for (category, choice) in json.object("professionalExpenses")?.entries ?? [] {
                guard let choice = choice.objectValue else { continue }
                choices[ForfaitCategory(rawValue: category)] = ExpenseChoice(
                    method: choice.text("method").map(ExpenseMethod.init(rawValue:)),
                    actualAmount: choice.number("actualAmount"))
            }
            professionalExpenses = choices
            unionDues = json.number("unionDues")
            otherTaxableIncome = json.number("otherTaxableIncome")
            alimonyPaid = json.number("alimonyPaid")
            treatyExemptProfessionalIncome = json.number("treatyExemptProfessionalIncome")
            reductions = Reductions(json.object("reductions") ?? JSObject())
            annualDividendIncome = json.number("annualDividendIncome")
            annualSavingsInterest = json.number("annualSavingsInterest")
        }
    }

    /// `RelationshipEvent`.
    struct Event: Sendable {
        struct Kind: RawRepresentable, Hashable, Sendable {
            let rawValue: String

            static let marriage = Kind(rawValue: "marriage")
            static let legalCohabitation = Kind(rawValue: "legal_cohabitation")
            static let legalCohabitationEnded = Kind(rawValue: "legal_cohabitation_ended")
            static let factualSeparation = Kind(rawValue: "factual_separation")
            static let divorce = Kind(rawValue: "divorce")
            static let death = Kind(rawValue: "death")
        }

        var id: String
        var kind: Kind
        var date: String
        var partnerID: HouseholdPartnerID?

        /// `Number(event.date.slice(0, 4))`.
        var year: Double { JavaScriptNumber.fromString(String(date.prefix(4))) }
    }

    /// `HouseholdDependents`.
    struct Dependents: Sendable {
        var children: Double?
        var childrenUnder3: Double?
        var childrenDisabled: Double?
        var otherPersons: Double?
        var otherPersonsDisabled: Double?
        var claimantPartnerID: HouseholdPartnerID?
    }

    /// One entry of `additionalResidences`.
    struct Residence: Sendable {
        var cadastralIncome: Double?
        var region: BelgianRegion?
        var centimesOverride: Double?
    }

    /// `HouseholdHomeInputs`.
    struct Home: Sendable {
        var cadastralIncome: Double?
        var cadastralCentimesOverride: Double?
        var additionalResidences: [Residence]
        var mortgageInterestPaid: Double?
        var mortgageCapitalRepaid: Double?
        var mortgageStartYear: Double?
        var mortgageRegion: BelgianRegion?
        var mortgageIsPrimaryResidence: Bool
        var mortgageCreditPartnerID: HouseholdPartnerID?
        var mortgageSharePartnerB: Double?
        var firstQualifyingYear: Double?
        var woonbonusChildrenAtLoanStart: Double?
    }

    enum DeathYearElection: Sendable {
        case joint
        case separate
    }

    var taxYear: Double
    var region: BelgianRegion
    /// Missing reads as NaN, as the engine's arithmetic on `undefined` does.
    var communalSurchargePercent: Double
    var partners: [Partner]
    var events: [Event]
    var deathYearElection: DeathYearElection?
    var legacyAssumedJoint: Bool
    var dependents: Dependents
    var home: Home

    private static let jointElection = JSValue.string("joint")
    private static let separateElection = JSValue.string("separate")

    init(_ json: JSObject) {
        taxYear = json.number("taxYear") ?? .nan
        region = BelgianRegion(rawValue: json.text("region") ?? "")
        communalSurchargePercent = json.number("communalSurchargePercent") ?? .nan
        partners = json.objects("partners").map(Partner.init)
        let relationship = json.object("relationship") ?? JSObject()
        events = relationship.objects("events").map { event in
            Event(
                id: event.text("id") ?? "", kind: Event.Kind(rawValue: event.text("kind") ?? ""),
                date: event.text("date") ?? "", partnerID: event.text("partnerId").map(HouseholdPartnerID.init(rawValue:)))
        }
        let election = relationship["deathYearElection"]
        deathYearElection = election == Self.jointElection ? .joint : election == Self.separateElection ? .separate : nil
        legacyAssumedJoint = relationship["legacyAssumedJoint"] == .bool(true)
        let dependentValues = json.object("dependents") ?? JSObject()
        dependents = Dependents(
            children: dependentValues.number("children"), childrenUnder3: dependentValues.number("childrenUnder3"),
            childrenDisabled: dependentValues.number("childrenDisabled"),
            otherPersons: dependentValues.number("otherPersons"),
            otherPersonsDisabled: dependentValues.number("otherPersonsDisabled"),
            claimantPartnerID: dependentValues.text("claimantPartnerId").map(HouseholdPartnerID.init(rawValue:)))
        let homeValues = json.object("home") ?? JSObject()
        home = Home(
            cadastralIncome: homeValues.number("cadastralIncome"),
            cadastralCentimesOverride: homeValues.number("cadastralCentimesOverride"),
            additionalResidences: homeValues.objects("additionalResidences").map { residence in
                Residence(
                    cadastralIncome: residence.number("cadastralIncome"),
                    // `r.region || profile.region`: an empty region falls back as well.
                    region: residence.text("region").flatMap { $0.isEmpty ? nil : BelgianRegion(rawValue: $0) },
                    centimesOverride: residence.number("centimesOverride"))
            },
            mortgageInterestPaid: homeValues.number("mortgageInterestPaid"),
            mortgageCapitalRepaid: homeValues.number("mortgageCapitalRepaid"),
            mortgageStartYear: homeValues.number("mortgageStartYear"),
            mortgageRegion: homeValues.text("mortgageRegion").map(BelgianRegion.init(rawValue:)),
            mortgageIsPrimaryResidence: homeValues.flag("mortgageIsPrimaryResidence"),
            mortgageCreditPartnerID: homeValues.text("mortgageCreditPartnerId").map(HouseholdPartnerID.init(rawValue:)),
            mortgageSharePartnerB: homeValues.number("mortgageSharePartnerB"),
            firstQualifyingYear: homeValues.number("firstQualifyingYear"),
            woonbonusChildrenAtLoanStart: homeValues.number("woonbonusChildrenAtLoanStart"))
    }
}

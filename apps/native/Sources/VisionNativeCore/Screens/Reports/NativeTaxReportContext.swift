import Foundation

/// Report presentation only. The backend overview selects and computes every fiscal figure.
public enum NativeTaxReportContext {
    public static func make(
        overview: TaxValue, requestedYear: Int, projectedProfile: TaxValue?,
        localize: (String) -> String
    ) throws -> TaxValue {
        guard overview["year"] == .number(Decimal(requestedYear)),
            let hasProfile = overview["hasProfile"]?.boolValue
        else { throw invalid("year/hasProfile: invalid overview authority") }
        // ExportDialog: only a year that can be filed (the live year, one with its own saved
        // snapshot, or one with a frozen calculation) carries the annual figures.
        let fileable =
            overview["liveYear"] == .number(Decimal(requestedYear)) || overview["hasSnapshot"]?.boolValue == true
            || truthy(overview["metadata"]?["frozenCalculation"])
        guard hasProfile, fileable else { return .object([:]) }
        guard let household = overview["household"], household.objectValue != nil,
            household["taxYear"] == .number(Decimal(requestedYear)),
            let profile = projectedProfile, profile.objectValue != nil,
            profile["taxYear"] == .number(Decimal(requestedYear)),
            let calculation = overview["calculation"], calculation.objectValue != nil,
            let breakdown = calculation["breakdown"]?.arrayValue
        else { throw invalid("household/profile/calculation: missing or mismatched source authority") }
        var reportProfile: [String: TaxValue] = [:]
        // The report prints this as "Filing status": the legal field, not the employment type
        // the web ExportDialog passed under it (Astra report 1, finding 21).
        reportProfile["filingStatus"] = profile["filingStatus"]
        reportProfile["region"] = profile["region"]
        reportProfile["taxYear"] = profile["taxYear"]
        var pit: [String: TaxValue] = [:]
        pit["taxableIncome"] = calculation["taxableIncome"]
        pit["totalTax"] = calculation["totalPIT"]
        pit["brackets"] = .array(
            try breakdown.filter { truthy($0["bracket"]) }.map { entry in
                guard entry.objectValue != nil else { throw invalid("breakdown: invalid bracket entry") }
                var bracket: [String: TaxValue] = [:]
                if truthy(entry["bracketNumber"]), let number = entry["bracketNumber"]?.decimalValue {
                    bracket["label"] = .string(localize("tax.pit.row.bracket\(number.description)"))
                } else {
                    bracket["label"] = entry["label"]
                }
                bracket["rate"] = entry["rate"]
                bracket["taxAmount"] = entry["amount"]
                return .object(bracket)
            })
        var context: [String: TaxValue] = ["taxProfile": .object(reportProfile), "precomputedPIT": .object(pit)]
        guard let partners = household["partners"]?.arrayValue else { throw invalid("household.partners: missing") }
        if partners.count == 2 {
            context["household"] = household
            let metadata = overview["metadata"]
            // A legacy frozen calculation never borrows a newly computed household result.
            if truthy(metadata?["frozenCalculation"]) && !truthy(metadata?["frozenHouseholdResult"]) {
                return .object(context)
            }
            if let result = overview["result"], result != .null {
                context["precomputedHousehold"] = try householdSummary(result)
            }
        }
        return .object(context)
    }
    private static func householdSummary(_ result: TaxValue) throws -> TaxValue {
        guard let assessment = result["assessment"], assessment.objectValue != nil,
            let quotient = result["quotient"], quotient.objectValue != nil,
            let partners = result["partners"]?.arrayValue
        else { throw invalid("result: invalid source household result") }
        var summary: [String: TaxValue] = [:]
        summary["assessmentMode"] = assessment["mode"]
        summary["legalBasis"] = assessment["legalBasis"]
        var quotientFields: [String: TaxValue] = [:]
        for key in ["applied", "transfer", "benefit"] { quotientFields[key] = quotient[key] }
        for key in ["fromPartnerId", "toPartnerId"] {
            if truthy(quotient[key]) { quotientFields[key] = quotient[key] }
        }
        summary["quotient"] = .object(quotientFields)
        summary["partners"] = .array(
            try partners.map { partner in
                guard partner.objectValue != nil else { throw invalid("result.partners: invalid entry") }
                var fields: [String: TaxValue] = [:]
                for key in ["partnerId", "grossIncome", "taxableIncome", "totalPIT"] { fields[key] = partner[key] }
                return .object(fields)
            })
        return .object(summary)
    }
    private static func truthy(_ value: TaxValue?) -> Bool {
        switch value {
        case nil, .null?: return false
        case .bool(let value)?: return value
        case .number(let value)?: return !value.isZero && !value.isNaN
        case .string(let value)?: return !value.isEmpty
        case .array?, .object?: return true
        }
    }
    private static func invalid(_ issue: String) -> APIError {
        .contract(APIContractError(endpoint: "/api/belgian-tax/overview", issues: [issue]))
    }
}

/// The report's v1 profile fields (`projectHouseholdToProfileV1` in
/// `@vision/shared-utils/belgian-tax/householdMigration`): partner A's primary activity sets
/// the employment type; region and tax year are the household's. `filingStatus` is `single`
/// without partner B; with partner B it is `married_joint` when `jointFiling` says so, else
/// `single`, and left out when `jointFiling` is nil. Only the fields the report reads are
/// projected (ADR-211).
public enum NativeTaxReportProfile {
    /// `PRIMARY_ACTIVITY_ID`.
    static let primaryActivityID = "act_A_1"

    public static func project(_ household: TaxValue, jointFiling: Bool? = nil) throws -> TaxValue {
        guard household.objectValue != nil, let partners = household["partners"]?.arrayValue else {
            throw APIError.contract(
                APIContractError(endpoint: "/api/belgian-tax/overview", issues: ["household: invalid source household"]))
        }
        let partnerA = partners.first { $0["id"] == .string("A") } ?? partners.first
        let activities = partnerA?["activities"]?.arrayValue ?? []
        let primary =
            activities.first { $0["id"] == .string(primaryActivityID) }
            ?? activities.first { $0["kind"] != .string(ActivityKind.netProfessionalAmount.rawValue) }
            ?? activities.first
        let kind = primary?["kind"]?.stringValue.map { ActivityKind(rawValue: $0) } ?? .employee
        var profile: [String: TaxValue] = ["employmentType": .string(employmentType(kind))]
        profile["region"] = household["region"]
        profile["taxYear"] = household["taxYear"]
        if !partners.contains(where: { $0["id"] == .string("B") }) {
            profile["filingStatus"] = .string("single")
        } else if let jointFiling {
            profile["filingStatus"] = .string(jointFiling ? "married_joint" : "single")
        }
        return .object(profile)
    }

    /// `employmentTypeFor`.
    static func employmentType(_ kind: ActivityKind) -> String {
        switch kind {
        case .employee: return "employee"
        case .civilServant: return "civil_servant"
        case .director: return "director"
        case .selfEmployedProfits, .selfEmployedFees: return "self_employed"
        case .pension: return "retired"
        case .helpingSpouse, .otherProfessional, .netProfessionalAmount, .unknown: return "other"
        }
    }

    /// The activity kinds of a household partner (`BelgianTaxInputPartnerActivity.kind`).
    typealias ActivityKind = OpenAPI.BelgianTaxInputPartnerActivity.Kind
}

@MainActor public struct NativeTaxReportContextService {
    private let client: APIClient
    private let localize: @MainActor (String) -> String
    private let projectProfile: (@MainActor (TaxValue, Int) async throws -> TaxValue)?
    /// `projectProfile` nil: the native projection, with the joint-filing answer the overview's
    /// assessment gives (`filesJointly`).
    public init(
        client: APIClient, localize: @escaping @MainActor (String) -> String,
        projectProfile: (@MainActor (TaxValue, Int) async throws -> TaxValue)? = nil
    ) {
        self.client = client
        self.localize = localize
        self.projectProfile = projectProfile
    }
    /// Every four-digit report year reads the overview: years outside the storable 1900–2200
    /// range are the year-pinned live estimate the web report's fallback computes.
    public func context(year: Int) async throws -> TaxValue {
        guard (0...9999).contains(year) else { throw APIError.invalidRequest("Report tax year") }
        let overview = try await client.send(NativeTaxReportOverviewOperation(year: year))
        let profile: TaxValue?
        if overview["hasProfile"]?.boolValue == true {
            guard let household = overview["household"] else { throw APIError.invalidRequest("Report household") }
            if let projectProfile {
                profile = try await projectProfile(household, year)
            } else {
                profile = try NativeTaxReportProfile.project(household, jointFiling: Self.filesJointly(household, overview))
            }
        } else {
            profile = nil
        }
        return try NativeTaxReportContext.make(
            overview: overview, requestedYear: year, projectedProfile: profile, localize: localize)
    }

    /// `filesJointly`: a legacy joint profile without relationship events stays joint;
    /// otherwise the assessment of the household's tax year decides (nil: no assessment).
    static func filesJointly(_ household: TaxValue, _ overview: TaxValue) -> Bool? {
        let relationship = household["relationship"]
        if relationship?["legacyAssumedJoint"]?.boolValue == true,
            relationship?["events"]?.arrayValue?.isEmpty ?? true
        {
            return true
        }
        let result = overview["metadata"]?["frozenHouseholdResult"] ?? overview["result"]
        guard let mode = result?["assessment"]?["mode"], mode.stringValue != nil else { return nil }
        return mode == .string("joint")
    }
}

private struct NativeTaxReportOverviewOperation: APIOperation {
    typealias Response = TaxValue
    static let operationId = "getBelgianTaxOverview"
    static let method = HTTPMethod.get
    static let pathTemplate = "/api/belgian-tax/overview"
    let year: Int
    var path: String { Self.pathTemplate }
    // The route accepts exactly four digits.
    var queryItems: [URLQueryItem] { [URLQueryItem(name: "year", value: String(format: "%04d", year))] }
}

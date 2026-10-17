import Foundation

/// Report presentation only. The backend overview selects and computes every fiscal figure.
public enum NativeTaxReportContext {
    public static func make(
        overview: TaxValue, requestedYear: Int, projectedProfile: TaxValue?,
        localize: (String) -> String
    ) throws -> TaxValue {
        guard overview["year"] == .number(Decimal(requestedYear)),
            let configured = overview["hasProfile"]?.boolValue
        else { throw invalid("year/hasProfile: invalid overview authority") }
        guard configured else { return .object([:]) }
        guard let household = overview["household"], household.objectValue != nil,
            household["taxYear"] == .number(Decimal(requestedYear)),
            let profile = projectedProfile, profile.objectValue != nil,
            profile["taxYear"] == .number(Decimal(requestedYear)),
            let calculation = overview["calculation"], calculation.objectValue != nil,
            let breakdown = calculation["breakdown"]?.arrayValue
        else { throw invalid("household/profile/calculation: missing or mismatched source authority") }
        var reportProfile: [String: TaxValue] = [:]
        // ExportDialog passes employmentType under filingStatus, not the legal filing-status field.
        reportProfile["filingStatus"] = profile["employmentType"]
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
/// the employment type; region and tax year are the household's. Only the three fields the
/// report reads are projected (ADR-208).
public enum NativeTaxReportProfile {
    /// `PRIMARY_ACTIVITY_ID`.
    static let primaryActivityID = "act_A_1"

    public static func project(_ household: TaxValue) throws -> TaxValue {
        guard household.objectValue != nil, let partners = household["partners"]?.arrayValue else {
            throw APIError.contract(
                APIContractError(endpoint: "/api/belgian-tax/overview", issues: ["household: invalid source household"]))
        }
        let partnerA = partners.first { $0["id"] == .string("A") } ?? partners.first
        let activities = partnerA?["activities"]?.arrayValue ?? []
        let primary =
            activities.first { $0["id"] == .string(primaryActivityID) }
            ?? activities.first { $0["kind"] != .string("net_professional_amount") }
            ?? activities.first
        let kind = primary?["kind"]?.stringValue ?? "employee"
        var profile: [String: TaxValue] = ["employmentType": .string(employmentType(kind))]
        profile["region"] = household["region"]
        profile["taxYear"] = household["taxYear"]
        return .object(profile)
    }

    /// `employmentTypeFor`.
    static func employmentType(_ kind: String) -> String {
        switch kind {
        case "employee": return "employee"
        case "civil_servant": return "civil_servant"
        case "director": return "director"
        case "self_employed_profits", "self_employed_fees": return "self_employed"
        case "pension": return "retired"
        default: return "other"
        }
    }
}

@MainActor public struct NativeTaxReportContextService {
    private let client: APIClient
    private let localize: @MainActor (String) -> String
    private let projectProfile: @MainActor (TaxValue, Int) async throws -> TaxValue
    public init(
        client: APIClient, localize: @escaping @MainActor (String) -> String,
        projectProfile: @escaping @MainActor (TaxValue, Int) async throws -> TaxValue = { household, _ in
            try NativeTaxReportProfile.project(household)
        }
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
            profile = try await projectProfile(household, year)
        } else {
            profile = nil
        }
        return try NativeTaxReportContext.make(
            overview: overview, requestedYear: year, projectedProfile: profile, localize: localize)
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

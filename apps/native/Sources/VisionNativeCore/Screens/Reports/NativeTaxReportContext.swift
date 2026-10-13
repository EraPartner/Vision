import Foundation

/// Report presentation only. The existing TypeScript overview selects and computes every fiscal figure.
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

@MainActor public struct NativeTaxReportContextService {
    private let client: APIClient
    private let localize: @MainActor (String) -> String
    private let projectProfile: @MainActor (TaxValue, Int) async throws -> TaxValue
    private let sourceContext: (@MainActor (TaxValue, Int) async throws -> TaxValue)?
    public static let fiscalSettingKeys = [
        "belgian_tax_profile", "belgian_tax_profile_snapshots_v1", "belgian_tax_household_v2",
        "belgian_tax_household_snapshots_v2", "belgian_tax_profile_snapshot_meta_v1",
    ]
    public init(
        client: APIClient, localize: @escaping @MainActor (String) -> String,
        projectProfile: @escaping @MainActor (TaxValue, Int) async throws -> TaxValue,
        sourceContext: (@MainActor (TaxValue, Int) async throws -> TaxValue)? = nil
    ) {
        self.client = client
        self.localize = localize
        self.projectProfile = projectProfile
        self.sourceContext = sourceContext
    }
    public func context(year: Int) async throws -> TaxValue {
        if !(1900...2200).contains(year) {
            guard let sourceContext else { throw APIError.invalidRequest("Original tax report context unavailable") }
            let raw = try await client.send(NativeTaxReportSettingsOperation())
            guard let settings = raw.objectValue else {
                throw APIError.contract(
                    APIContractError(endpoint: "/api/settings", issues: ["settings: not an object"]))
            }
            // Source custom-date years exceed the overview API's bounds. Shared TS resolves the
            // fresh original settings; never clamp a year or silently omit configured fiscal blocks.
            let fiscal = Dictionary(
                uniqueKeysWithValues: Self.fiscalSettingKeys.compactMap { key in
                    settings[key].map { (key, $0) }
                })
            let value = try await sourceContext(.object(fiscal), year)
            guard let fields = value.objectValue,
                Set(fields.keys).isSubset(of: ["taxProfile", "precomputedPIT", "household", "precomputedHousehold"])
            else { throw APIError.invalidRequest("Invalid original tax report context") }
            return value
        }
        let overview = try await client.send(NativeTaxReportOverviewOperation(year: year))
        let profile: TaxValue?
        if overview["hasProfile"]?.boolValue == true {
            guard let household = overview["household"] else { throw APIError.invalidRequest("Report household") }
            // Shared TypeScript supplies the profile projection; Swift only formats the returned fields.
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
    var queryItems: [URLQueryItem] { [URLQueryItem(name: "year", value: String(year))] }
}

private struct NativeTaxReportSettingsOperation: APIOperation {
    typealias Response = TaxValue
    static let operationId = "getSettings"
    static let method = HTTPMethod.get
    static let pathTemplate = "/api/settings"
    var path: String { Self.pathTemplate }
}

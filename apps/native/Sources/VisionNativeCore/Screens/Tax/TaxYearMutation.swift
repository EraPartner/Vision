import Foundation

public enum TaxYearAction: Equatable, Sendable {
    case createSnapshot
    case freeze
    case unfreeze
    case file(reference: String?)
    case unfile

    public func needsComputation(_ overview: OpenAPI.BelgianTaxOverview) -> Bool {
        switch self {
        case .freeze: return true
        case .file: return overview.calculationSource != "frozen"
        default: return false
        }
    }
}

/// A conditional whole-value replacement using the existing settings API. All three tax keys
/// participate so a changed source household cannot produce a frozen result from stale inputs.
public struct TaxSettingsPatch: Encodable, Equatable, Sendable {
    public let settings: [String: TaxValue]
    public let expected: [String: JSONValue]
    public init(settings: [String: TaxValue], records: [OpenAPI.Setting]) throws {
        let allowed: Set<String> = [
            TaxYearMutation.householdKey, TaxYearMutation.snapshotsKey, TaxYearMutation.metadataKey,
        ]
        guard Set(settings.keys).isSubset(of: allowed), !settings.isEmpty else {
            throw APIError.invalidRequest("Unknown or empty tax setting write")
        }
        var baselines: [String: JSONValue] = [:]
        for key in settings.keys {
            let matches = records.filter { $0.key == key }
            guard matches.count == 1, let baseline = matches.first?.expected,
                let fields = baseline.objectValue, let exists = fields["exists"]?.boolValue,
                Set(fields.keys) == (exists ? ["exists", "value"] : ["exists"])
            else {
                throw APIError.contract(
                    APIContractError(
                        endpoint: "/api/belgian-tax/overview", issues: ["\(key): missing or invalid baseline"]))
            }
            baselines[key] = baseline
        }
        self.settings = settings
        self.expected = baselines
    }
}

public enum TaxYearMutation {
    /// MarkAsFiledDialog: a configured profile and a year that can be filed (the live year, one
    /// with its own household snapshot, or one with a frozen calculation), not filed yet.
    public static func canFile(_ overview: OpenAPI.BelgianTaxOverview) -> Bool {
        let filed = (try? TaxValue(encoding: overview.metadata))?["filing"]?.objectValue != nil
        let frozen = overview.calculationSource == "frozen"
        return overview.hasProfile && !filed && (!overview.isHistorical || overview.hasSnapshot || frozen)
    }
    public static let householdKey = "belgian_tax_household_v2"
    public static let snapshotsKey = "belgian_tax_household_snapshots_v2"
    public static let metadataKey = "belgian_tax_profile_snapshot_meta_v1"

    public static func patch(
        action: TaxYearAction, overview: OpenAPI.BelgianTaxOverview,
        computation: OpenAPI.BelgianTaxComputation? = nil, at: Date = Date()
    ) throws -> TaxSettingsPatch? {
        let year = String(overview.year)
        let records = overview.records
        // An action is not a repair of unreadable stored values. The profile editor handles
        // an explicit replacement; never discard unrelated snapshots or filings here.
        guard !overview.storedValueInvalid else {
            throw APIError.invalidRequest("Unreadable stored household settings")
        }
        var live =
            try storedObject(key: householdKey, records: records)
            ?? TaxValue(encoding: overview.liveHousehold)
        live["profileConfigured"] = .bool(overview.liveHousehold.profileConfigured)
        var snapshots =
            try storedObject(key: snapshotsKey, records: records)
            ?? TaxValue(encoding: overview.householdSnapshots)
        var metas = try storedObject(key: metadataKey, records: records) ?? .object([:])
        var meta = metas[year] ?? .object([:])
        guard meta.objectValue != nil else { throw APIError.invalidRequest("Invalid tax year metadata") }
        let filed = meta["filing"] != nil && meta["filing"] != .null
        let frozen = meta["frozenCalculation"] != nil && meta["frozenCalculation"] != .null
        var events: [(String, [String: TaxValue])] = []
        switch action {
        case .createSnapshot:
            guard snapshots[year] == nil else { return nil }
            var snapshot = live
            snapshot["taxYear"] = .number(Decimal(overview.year))
            snapshots[year] = snapshot
            events.append(("created", [:]))
        case .freeze:
            guard !filed, !frozen else { return nil }
            let value = try requireComputation(computation, year: overview.year)
            meta["frozenCalculation"] = try TaxValue(encoding: value.calculation)
            meta["frozenHouseholdResult"] = try TaxValue(encoding: value.result)
            events.append(("frozen", [:]))
        case .unfreeze:
            guard !filed, frozen else { return nil }
            meta["frozenCalculation"] = nil
            meta["frozenHouseholdResult"] = nil
            events.append(("unfrozen", [:]))
        case .file(let reference):
            guard !filed, canFile(overview) else { return nil }
            // Filing the live year pins its household as that year's snapshot. A frozen year is
            // filed as it is: today's inputs beside old frozen figures would misstate them.
            if !frozen, snapshots[year] == nil {
                var snapshot = live
                snapshot["taxYear"] = .number(Decimal(overview.year))
                snapshots[year] = snapshot
                events.append(("created", [:]))
            }
            if !frozen {
                let value = try requireComputation(computation, year: overview.year)
                meta["frozenCalculation"] = try TaxValue(encoding: value.calculation)
                meta["frozenHouseholdResult"] = try TaxValue(encoding: value.result)
            }
            let trimmed = reference?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var filing: [String: TaxValue] = ["filedAt": .string(timestamp(at))]
            if !trimmed.isEmpty { filing["reference"] = .string(trimmed) }
            meta["filing"] = .object(filing)
            events.append(("filed", trimmed.isEmpty ? [:] : ["reference": .string(trimmed)]))
        case .unfile:
            guard filed else { return nil }
            meta["filing"] = nil
            events.append(("unfiled", [:]))
        }
        var history: [TaxValue] = []
        if let stored = meta["history"] {
            guard let entries = stored.arrayValue else { throw APIError.invalidRequest("Invalid tax snapshot history") }
            history = entries
        }
        for (kind, extras) in events {
            var entry = extras
            entry["kind"] = .string(kind)
            entry["at"] = .string(timestamp(at))
            history.append(.object(entry))
        }
        meta["history"] = .array(Array(history.suffix(200)))
        metas[year] = meta
        return try TaxSettingsPatch(
            settings: [householdKey: live, snapshotsKey: snapshots, metadataKey: metas], records: records)
    }

    private static func storedObject(key: String, records: [OpenAPI.Setting]) throws -> TaxValue? {
        guard let record = records.first(where: { $0.key == key }) else { return nil }
        if record.value == .null { return nil }
        let value = try TaxValue(encoding: record.value)
        guard value.objectValue != nil else { throw APIError.invalidRequest("\(key): expected object") }
        return value
    }
    private static func requireComputation(_ value: OpenAPI.BelgianTaxComputation?, year: Int) throws
        -> OpenAPI.BelgianTaxComputation
    {
        guard let value, value.result.incomeYear == year else {
            throw APIError.invalidRequest("Missing computation for the selected tax year")
        }
        return value
    }
    private static func timestamp(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }
}

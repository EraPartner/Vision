import Foundation

/// `settings.ts`, `profileDefaults.ts`, `overview.ts` and `recordedIncomeAttribution.ts`: the
/// stored tax settings read into a household, and the overview a tax year's screen shows.
enum HouseholdTaxSettings {
    static let householdKey = "belgian_tax_household_v2"
    static let snapshotsKey = "belgian_tax_household_snapshots_v2"
    static let snapshotMetaKey = "belgian_tax_profile_snapshot_meta_v1"

    private static func object(_ pairs: [(String, JSValue)]) -> JSValue { .object(JSObject(pairs)) }

    /// `DEFAULT_BELGIAN_TAX_PROFILE`.
    static let defaultProfile: JSObject = {
        let zero = JSValue.number(0)
        let no = JSValue.bool(false)
        return JSObject([
            ("profileConfigured", no), ("employmentType", .string("employee")), ("grossAnnualIncome", zero),
            ("professionalExpenseMethod", .string("lump_sum")), ("actualProfessionalExpenses", zero),
            ("communalSurchargePercent", .number(7)), ("region", .string("flanders")), ("dependentChildren", zero),
            ("dependentChildrenUnder3", zero), ("dependentChildrenDisabled", zero), ("dependentOtherPersons", zero),
            ("dependentOtherPersonsDisabled", zero), ("isDisabled", no), ("isSpouseDisabled", no),
            ("isIsolatedParent", no), ("cadastralIncome", zero), ("additionalResidences", .array([])),
            ("otherTaxableIncome", zero), ("alimonyPaid", zero), ("personalPensionContributions", zero),
            ("pensionScheme", .string("1050")), ("pensionEligible", no), ("lifeInsurancePremiums", zero),
            ("lifeInsuranceEligible", no), ("mortgageInterestPaid", zero), ("mortgageCapitalRepaid", zero),
            ("mortgageIsPrimaryResidence", no), ("charitableDonations", zero), ("charitableDonationsEligible", no),
            ("childcareCosts", zero), ("childcareEligibleDays", zero), ("childcareEligible", no),
            ("employeeGroupInsuranceContributions", zero), ("employeeGroupInsuranceEligible", no), ("unionDues", zero),
            ("medicalExpenses", zero), ("domesticHelpCosts", zero), ("domesticHelpEligible", no),
            ("serviceVoucherCount", zero), ("serviceVoucherEligible", no), ("filingStatus", .string("single")),
            ("spouseProfessionalIncome", zero), ("annualDividendIncome", zero), ("annualSavingsInterest", zero),
            ("taxIncomeCategoryIds", .array([])), ("taxYear", .number(BelgianTaxTable.latestYear)),
        ])
    }()

    /// `hasMeaningfulBelgianTaxData(profile)`.
    static func hasMeaningfulData(_ profile: JSObject) -> Bool {
        if profile["profileConfigured"] == .bool(true) { return true }
        let keys = [
            "grossAnnualIncome", "otherTaxableIncome", "cadastralIncome", "dependentChildren", "dependentOtherPersons",
            "actualProfessionalExpenses",
        ]
        return keys.contains { (profile[$0] ?? .null).javaScriptNumber > 0 }
    }

    /// `{ ...base, ...overrides }`.
    private static func merged(_ base: JSObject, _ overrides: JSObject) -> JSObject {
        var result = base
        for (key, value) in overrides.entries { result[key] = value }
        return result
    }

    private static func issues(_ failure: ZodFailure) -> JSValue {
        .array(
            failure.issues.map { issue in
                let path = issue.path.map(\.text).joined(separator: ".")
                return .string((path.isEmpty ? "(root)" : path) + ": " + issue.message)
            })
    }

    /// `defaultHousehold(defaults)`.
    static func defaultHousehold(_ defaults: JSObject) throws -> JSObject {
        var household = try HouseholdMigration.upgrade(defaults)
        household["migratedFrom"] = nil
        return household
    }

    /// `StoredBelgianTaxSettings`.
    struct Stored {
        var defaults: JSObject
        var profile: JSObject
        var hasProfile: Bool
        var snapshotsV1: JSValue?
        var householdV2: JSValue?
        var snapshotsV2: JSValue?
    }

    /// `LoadedHouseholdSettings`.
    struct Loaded {
        var household: JSObject
        var snapshots: JSObject
        var writeHousehold = false
        var writeSnapshots = false
        var warnings: [JSObject] = []

        var storedValueInvalid: Bool { warnings.contains { $0["kind"] == .string("invalid_stored") } }

        var jsonValue: JSValue {
            .object(
                JSObject([
                    ("household", .object(household)), ("snapshots", .object(snapshots)),
                    ("writeHousehold", .bool(writeHousehold)), ("writeSnapshots", .bool(writeSnapshots)),
                    ("storedValueInvalid", .bool(storedValueInvalid)), ("warnings", .array(warnings.map(JSValue.object))),
                ]))
        }
    }

    private static func present(_ value: JSValue?) -> JSValue? { value == .null ? nil : value }

    private static func normalizedSnapshots(_ value: JSValue?, _ defaults: JSObject) -> JSObject {
        var result = JSObject()
        guard let snapshots = value?.objectValue else { return result }
        for (key, snapshot) in snapshots.entries {
            let year = JavaScriptNumber.fromString(key)
            guard year.isFinite, year.rounded(.down) == year, let snapshot = snapshot.objectValue else { continue }
            var profile = merged(defaults, HouseholdMigration.withoutNullFields(snapshot))
            profile["taxYear"] = .number(year)
            result[JavaScriptNumber.text(year)] = .object(profile)
        }
        return result
    }

    /// `loadHouseholdSettings(stored)`.
    static func load(_ stored: Stored) throws -> Loaded {
        let profile = merged(stored.defaults, HouseholdMigration.withoutNullFields(stored.profile))
        func upgradeProfile() throws -> JSObject {
            try stored.hasProfile ? HouseholdMigration.upgrade(profile) : defaultHousehold(profile)
        }
        func warning(_ key: String, _ kind: String, _ failure: ZodFailure, stored: JSValue? = nil) -> JSObject {
            var warning = JSObject([("key", .string(key)), ("kind", .string(kind)), ("issues", issues(failure))])
            warning["stored"] = stored
            return warning
        }
        var loaded = Loaded(household: JSObject(), snapshots: JSObject())
        if let storedHousehold = present(stored.householdV2) {
            switch SettingSchemas.belgianTaxHouseholdV2.parse(storedHousehold) {
            case .success(let value): loaded.household = value?.objectValue ?? JSObject()
            case .failure(let failure):
                loaded.warnings.append(warning(householdKey, "invalid_stored", failure, stored: storedHousehold))
                loaded.household = try upgradeProfile()
            }
        } else {
            loaded.household = try upgradeProfile()
            loaded.writeHousehold = stored.hasProfile
            if loaded.writeHousehold,
                case .failure(let failure) = SettingSchemas.belgianTaxHouseholdV2.parse(.object(loaded.household))
            {
                loaded.warnings.append(warning(householdKey, "invalid_upgrade", failure))
                loaded.writeHousehold = false
            }
        }
        func upgradeSnapshots() throws -> JSObject {
            try HouseholdMigration.upgradeSnapshots(normalizedSnapshots(stored.snapshotsV1, stored.defaults))
        }
        if let storedSnapshots = present(stored.snapshotsV2) {
            switch SettingSchemas.belgianTaxHouseholdSnapshotsV2.parse(storedSnapshots) {
            case .success(let value): loaded.snapshots = value?.objectValue ?? JSObject()
            case .failure(let failure):
                loaded.warnings.append(warning(snapshotsKey, "invalid_stored", failure, stored: storedSnapshots))
                loaded.snapshots = try upgradeSnapshots()
            }
        } else {
            loaded.snapshots = try upgradeSnapshots()
            loaded.writeSnapshots = present(stored.snapshotsV1) != nil
            if loaded.writeSnapshots,
                case .failure(let failure) = SettingSchemas.belgianTaxHouseholdSnapshotsV2.parse(.object(loaded.snapshots))
            {
                loaded.warnings.append(warning(snapshotsKey, "invalid_upgrade", failure))
                loaded.writeSnapshots = false
            }
        }
        return loaded
    }

    /// `filesJointly` on a household's JSON.
    static func filesJointly(_ household: JSObject) -> Bool { HouseholdAssessment.filesJointly(TaxHousehold(household)) }

    /// `buildTaxOverview(settings, expected, requestedYear)`.
    static func overview(settings: JSObject, expected: JSObject, requestedYear: Double?) throws -> JSValue {
        func record(_ value: JSValue?) -> JSObject { value?.objectValue ?? JSObject() }
        let storedProfile = settings["belgian_tax_profile"]
        var profile = merged(defaultProfile, record(storedProfile))
        profile["profileConfigured"] = .bool(hasMeaningfulData(profile))
        let loaded = try load(
            Stored(
                defaults: defaultProfile, profile: profile, hasProfile: present(storedProfile) != nil,
                snapshotsV1: settings["belgian_tax_profile_snapshots_v1"], householdV2: settings[householdKey],
                snapshotsV2: settings[snapshotsKey]))
        var live = loaded.household
        if !live.flag("profileConfigured"),
            hasMeaningfulData(try HouseholdMigration.project(live, jointFiling: filesJointly))
        {
            live["profileConfigured"] = .bool(true)
        }
        let year = requestedYear.map(JSValue.number) ?? live["taxYear"]
        let yearKey = year?.javaScriptString ?? "undefined"
        var household = live
        if year != live["taxYear"] {
            if let snapshot = present(loaded.snapshots[yearKey]) {
                household = snapshot.objectValue ?? JSObject()
            } else {
                household["taxYear"] = year
            }
        }
        let snapshotMetas = record(settings[snapshotMetaKey])
        let metadata = record(snapshotMetas[yearKey])
        let frozenCalculation = present(metadata["frozenCalculation"])
        let frozenResult = present(metadata["frozenHouseholdResult"])
        var computed: HouseholdTaxResult?
        let model = TaxHousehold(household)
        func current() throws -> HouseholdTaxResult {
            if let computed { return computed }
            let result = try HouseholdTax.compute(model)
            computed = result
            return result
        }
        let calculation = try frozenCalculation ?? BelgianTaxCalculation.json(try current(), model)
        let result = try frozenResult ?? (try current()).jsonValue
        var overview = JSObject()
        overview["year"] = year
        overview["liveYear"] = live["taxYear"]
        overview["isHistorical"] = .bool(year != live["taxYear"])
        overview["hasSnapshot"] = .bool(loaded.snapshots.has(yearKey))
        overview["hasProfile"] = live["profileConfigured"]
        overview["household"] = .object(household)
        overview["liveHousehold"] = .object(live)
        overview["householdSnapshots"] = .object(loaded.snapshots)
        overview["snapshotMetas"] = .object(snapshotMetas)
        overview["metadata"] = .object(metadata)
        overview["calculation"] = calculation
        overview["result"] = result
        overview["calculationSource"] = .string(frozenCalculation != nil ? "frozen" : "computed")
        overview["householdResultSource"] = .string(frozenResult != nil ? "frozen" : "computed")
        overview["householdMigrationNeeded"] = .bool(loaded.writeHousehold)
        overview["snapshotsMigrationNeeded"] = .bool(loaded.writeSnapshots)
        overview["storedValueInvalid"] = .bool(loaded.storedValueInvalid)
        overview["warnings"] = .array(
            loaded.warnings.map { warning in
                var copy = warning
                copy["stored"] = nil
                return .object(copy)
            })
        overview["records"] = .array(
            [householdKey, snapshotsKey, snapshotMetaKey].map { key in
                object([
                    ("key", .string(key)), ("value", settings[key] ?? .null),
                    ("expected", present(expected[key]) ?? object([("exists", .bool(false))])),
                ])
            })
        return .object(overview)
    }
}

/// `recordedIncomeAttribution.ts`: recorded income split between the partners by account owner.
enum RecordedIncomeAttribution {
    // lint:allow double-money the TypeScript helper rounds a JavaScript number to cents
    private static func cents(_ value: Double) -> Double { JavaScriptNumber.round(value * 100) / 100 }

    /// `householdHasPartnerB(household)`.
    static func hasPartnerB(_ household: JSObject?) -> Bool {
        household?.objects("partners").contains { $0["id"] == .string("B") } ?? false
    }

    /// `partnerBShare(byOwner, hasPartnerB)`: the partner's own amount and half of the joint one.
    static func partnerBShare(_ byOwner: JSObject?, hasPartnerB: Bool) -> Double {
        guard hasPartnerB, let byOwner else { return 0 }
        return cents((byOwner.number("partner") ?? 0) + (byOwner.number("joint") ?? 0) / 2)
    }

    /// `attributeToPartners(total, byOwner, hasPartnerB)`.
    static func attribute(_ total: Double, _ byOwner: JSObject?, hasPartnerB: Bool) -> (a: Double, b: Double) {
        let share = partnerBShare(byOwner, hasPartnerB: hasPartnerB)
        return share == 0 ? (total, 0) : (cents(total - share), share)
    }

    private static let netAmountKind = JSValue.string(HouseholdActivityKind.netProfessionalAmount.rawValue)

    /// `householdWithRecordedIncome(household, total, partnerB)`.
    static func household(_ household: JSObject, total: Double, partnerB: Double) throws -> JSObject? {
        func grossActivity(_ partner: JSObject) -> Int? {
            partner.objects("activities").firstIndex { $0["kind"] != netAmountKind }
        }
        guard let stored = household.objects("partners").first(where: { $0["id"] == .string("B") }),
            grossActivity(stored) != nil
        else { return nil }
        var next = try HouseholdMigration.apply(
            patch: JSObject([("grossAnnualIncome", .number(TaxMath.max(0, cents(total - partnerB))))]), to: household,
            jointFiling: nil)
        var partners = next.objects("partners")
        if let index = partners.firstIndex(where: { $0["id"] == .string("B") }), let at = grossActivity(partners[index]) {
            var activities = partners[index].objects("activities")
            activities[at]["grossIncome"] = .number(TaxMath.max(0, partnerB))
            partners[index]["activities"] = .array(activities.map(JSValue.object))
            next["partners"] = .array(partners.map(JSValue.object))
        }
        return next
    }

    /// `householdForRecordedIncome(household, total, byOwner)`.
    static func household(_ household: JSObject?, total: Double, byOwner: JSObject?) throws -> JSObject? {
        let hasAmounts = (byOwner?.number("partner") ?? 0) != 0 || (byOwner?.number("joint") ?? 0) != 0
        guard let household, hasAmounts, hasPartnerB(household) else { return nil }
        return try self.household(household, total: total, partnerB: partnerBShare(byOwner, hasPartnerB: true))
    }
}

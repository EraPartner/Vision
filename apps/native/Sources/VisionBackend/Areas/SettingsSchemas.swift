import Foundation

/// The per-key value schemas, defaults and known keys of `routes/settings.ts` and
/// `routes/belgianTaxSettingsSchemas.ts`, with zod's messages and issue order. Every object is
/// loose: settings blobs carry frontend-owned fields that must be stored, not stripped.
enum SettingSchemas {
    // MARK: - belgian_tax_profile (v1)

    private static let profileMoneyFields = [
        "grossAnnualIncome", "actualProfessionalExpenses", "cadastralIncome", "otherTaxableIncome", "alimonyPaid",
        "personalPensionContributions", "lifeInsurancePremiums", "mortgageInterestPaid", "mortgageCapitalRepaid",
        "charitableDonations", "childcareCosts", "employeeGroupInsuranceContributions", "unionDues",
        "medicalExpenses", "domesticHelpCosts", "spouseProfessionalIncome", "annualDividendIncome",
        "annualSavingsInterest", "serviceVoucherSpend",
    ]
    private static let profileCountFields = [
        "dependentChildren", "dependentChildrenUnder3", "dependentChildrenDisabled", "dependentOtherPersons",
        "dependentOtherPersonsDisabled", "childcareEligibleDays", "serviceVoucherCount",
    ]

    private static let money = Zod.number(min: 0, max: 1e12)
    private static let count = Zod.number(min: 0, max: 1000, int: true)
    private static let year = Zod.number(min: 1900, max: 2200, int: true)
    private static let centimes = Zod.number(min: 0, max: 100_000)

    static let belgianTaxProfile: Zod = {
        var shape: [(String, Zod)] = [("communalSurchargePercent", Zod.number(min: 0, max: 9).nullish)]
        for field in profileMoneyFields { shape.append((field, money.nullish)) }
        for field in profileCountFields { shape.append((field, count.nullish)) }
        let residence = Zod.looseObject([("cadastralIncome", money.nullish), ("centimesOverride", centimes.nullish)])
        shape += [
            ("taxYear", year.nullish),
            ("mortgageStartYear", year.nullish),
            ("cadastralCentimesOverride", centimes.nullish),
            ("selfEmployedIncomeKind", Zod.enumeration(["profits", "fees"]).nullish),
            ("additionalResidences", Zod.array(residence).nullish),
        ]
        return .looseObject(shape)
    }()

    // MARK: - theme, dashboard, rebalance plans, brokerage cash categories

    /// `/^([01]\d|2[0-3]):[0-5]\d$/` with the message "must be HH:MM".
    private static let hhmm = Zod.checked(.string, [.format("must be HH:MM") { isHHMM($0) }])

    static func isHHMM(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 5, bytes[2] == UInt8(ascii: ":") else { return false }
        func digit(_ index: Int) -> Int? { (48...57).contains(bytes[index]) ? Int(bytes[index] - 48) : nil }
        guard let h1 = digit(0), let h2 = digit(1), let m1 = digit(3), digit(4) != nil else { return false }
        return (h1 <= 1 || (h1 == 2 && h2 <= 3)) && m1 <= 5
    }

    private static let themeSettings = Zod.looseObject([
        ("variant", Zod.enumeration(["default", "dracula", "solarized", "nord", "high-contrast"]).optional),
        ("mode", Zod.enumeration(["light", "dark", "system", "schedule"]).optional),
        ("schedule", Zod.looseObject([("lightFrom", hhmm.optional), ("darkFrom", hhmm.optional)]).optional),
    ])

    /// `intArrayField`: an array of ids, coerced to numbers by `validateIntArray`.
    private static func intArrayField(_ field: String) -> Zod {
        Zod.transform(.unknown) { value, issues in
            guard case .array(let items)? = value else {
                issues.append(ZodIssue(message: "\(field) must be an array"))
                return nil
            }
            var ids: [JSValue] = []
            for item in items {
                guard let id = RequestID.valid(item) else {
                    issues.append(ZodIssue(message: "\(field) contains invalid value: \(item.javaScriptString)"))
                    return nil
                }
                ids.append(.number(id))
            }
            return .array(ids)
        }.optional
    }

    private static let dashboardSettings = Zod.looseObject([
        ("excludedCategoryIds", intArrayField("excludedCategoryIds")),
        ("excludedRecipientIds", intArrayField("excludedRecipientIds")),
        ("excludeHiddenCategories", Zod.boolean.optional),
        ("exclusionScope", Zod.enumeration(["everywhere", "dashboard", "statistics"]).optional),
    ])

    private static let rebalancePlan = Zod.looseObject([
        ("id", Zod.string(min: 1, max: 100)),
        (
            "name",
            Zod.string(max: 80).check(
                .refine("name must not be blank") { value in
                    guard let text = value?.stringValue else { return true }
                    return !JavaScriptWhitespace.trim(text).isEmpty
                })
        ),
        (
            "targetWeights",
            Zod.record(key: .string, value: .unknown, partial: false).check(.superRefine { targetWeightIssues($0) })
        ),
        (
            "cashCap",
            Zod.unknown.check(
                .refine("cashCap must be a non-negative number") { value in
                    let number = value?.javaScriptNumber ?? .nan
                    return number.isFinite && number >= 0
                }
            ).optional
        ),
    ])

    /// The `targetWeights` superRefine: at least one sleeve, each `Number()`-coercible to a
    /// finite non-negative weight (the first bad one ends the check), and a positive sum.
    private static func targetWeightIssues(_ value: JSValue?) -> [ZodIssue] {
        guard let weights = value?.objectValue else { return [] }
        let entries = weights.entries
        if entries.isEmpty { return [ZodIssue(message: "targetWeights must have at least one sleeve")] }
        var sum = 0.0
        for (sleeve, weight) in entries {
            let number = weight.javaScriptNumber
            if !number.isFinite || number < 0 {
                return [ZodIssue(path: [.key(sleeve)], message: "must be a non-negative number")]
            }
            sum += number
        }
        return sum > 0 ? [] : [ZodIssue(message: "targetWeights must include at least one positive weight")]
    }

    private static let nullableCategoryId = Zod.number(min: 1, max: 2_147_483_647, int: true).nullable

    private static let brokerageCashCategoryIds = Zod.strictObject([
        ("dividend", nullableCategoryId), ("interest", nullableCategoryId), ("fee", nullableCategoryId),
        ("tax", nullableCategoryId),
    ])

    /// Any plain JSON object (null, an array or a scalar is rejected; every key passes).
    private static let jsonObject = Zod.looseObject([])

    private static let snapshotMetaEntry = Zod.looseObject([
        ("frozenCalculation", jsonObject.optional),
        ("frozenHouseholdResult", jsonObject.optional),
    ]).check(
        .superRefine { value in
            guard let calculation = value?.objectValue?["frozenCalculation"]?.objectValue,
                calculation.has("federalPITTotal")
            else { return [] }
            return [
                ZodIssue(
                    path: [.key("frozenCalculation"), .key("federalPITTotal")],
                    message: "legacy field is no longer accepted; use federalPITBeforeExemption")
            ]
        })

    // MARK: - Belgian tax household (ADR-200)

    private static let region = Zod.enumeration(["flanders", "wallonia", "brussels"])
    private static let partnerId = Zod.enumeration(["A", "B"])
    private static let activityPattern = "/^act_[A-Za-z0-9_-]{1,64}$/"
    private static let activityId = Zod.checked(
        .string, [.format("Invalid string: must match pattern \(activityPattern)") { isActivityId($0) }])

    static func isActivityId(_ text: String) -> Bool {
        guard text.hasPrefix("act_") else { return false }
        let rest = text.unicodeScalars.dropFirst(4)
        return (1...64).contains(rest.count)
            && rest.allSatisfy { scalar in
                switch scalar {
                case "A"..."Z", "a"..."z", "0"..."9", "_", "-": return true
                default: return false
                }
            }
    }

    private static let activitySchema = Zod.looseObject([
        ("id", activityId),
        (
            "kind",
            Zod.enumeration([
                "employee", "civil_servant", "director", "self_employed_profits", "self_employed_fees",
                "helping_spouse", "pension", "other_professional", "net_professional_amount",
            ])
        ),
        ("label", Zod.string(max: 200).optional),
        ("grossIncome", money),
        ("netProfessionalIncome", money.optional),
        ("pensionKind", Zod.enumeration(["statutory_from_legal_age", "survivor_or_transition", "other"]).optional),
        ("startDate", Zod.isoDate.optional),
        ("endDate", Zod.isoDate.optional),
        ("selfEmployedOccupation", Zod.enumeration(["main", "secondary"]).optional),
        ("socialContributionsPaid", money.optional),
        ("withholdingTax", money.optional),
        ("prepayments", money.optional),
        ("sourceRefs", Zod.array(Zod.string(max: 200), max: 100).optional),
    ])

    private static let reductionsSchema = Zod.looseObject([
        ("personalPensionContributions", money),
        ("pensionScheme", Zod.enumeration(["1050", "1350"]).optional),
        ("pensionEligible", Zod.boolean.optional),
        ("lifeInsurancePremiums", money),
        ("lifeInsuranceEligible", Zod.boolean.optional),
        ("employeeGroupInsuranceContributions", money.optional),
        ("employeeGroupInsuranceEligible", Zod.boolean.optional),
        ("charitableDonations", money),
        ("charitableDonationsEligible", Zod.boolean.optional),
        ("childcareCosts", money),
        ("childcareEligibleDays", count.optional),
        ("childcareEligible", Zod.boolean.optional),
        ("domesticHelpCosts", money.optional),
        ("domesticHelpEligible", Zod.boolean.optional),
        ("serviceVoucherCount", count.optional),
        ("serviceVoucherSpend", money.optional),
        ("serviceVoucherEligible", Zod.boolean.optional),
        ("medicalExpenses", money),
    ])

    private static let partnerSchema = Zod.looseObject([
        ("id", partnerId),
        ("displayName", Zod.string(max: 80).optional),
        ("birthYear", year.optional),
        ("isDisabled", Zod.boolean),
        ("isIsolatedParent", Zod.boolean.optional),
        ("activities", Zod.array(activitySchema, max: 20)),
        (
            "professionalExpenses",
            Zod.record(
                key: .enumeration(["remuneration", "profits", "director", "fees", "helping_spouse", "none"]),
                value: .looseObject([
                    ("method", Zod.enumeration(["lump_sum", "actual"])), ("actualAmount", money),
                ]),
                partial: true)
        ),
        ("unionDues", money),
        ("otherTaxableIncome", money),
        ("alimonyPaid", money),
        ("treatyExemptProfessionalIncome", money.optional),
        ("reductions", reductionsSchema),
        ("annualDividendIncome", money.optional),
        ("annualSavingsInterest", money.optional),
    ])

    private static let eventSchema = Zod.looseObject([
        ("id", Zod.string(min: 1, max: 64)),
        (
            "kind",
            Zod.enumeration([
                "marriage", "legal_cohabitation", "legal_cohabitation_ended", "factual_cohabitation_start",
                "factual_separation", "divorce", "death",
            ])
        ),
        ("date", Zod.isoDate),
        ("partnerId", partnerId.optional),
    ])

    private static let homeSchema = Zod.looseObject([
        ("cadastralIncome", money),
        ("cadastralCentimesOverride", centimes.optional),
        (
            "additionalResidences",
            Zod.array(
                .looseObject([
                    ("label", Zod.string(max: 200).optional),
                    ("cadastralIncome", money),
                    ("region", region.optional),
                    ("isOwnHome", Zod.boolean.optional),
                    ("centimesOverride", centimes.optional),
                ]),
                max: 50
            ).optional
        ),
        ("mortgageInterestPaid", money),
        ("mortgageCapitalRepaid", money.optional),
        ("mortgageStartYear", year.optional),
        ("mortgageRegion", region.optional),
        ("mortgageIsPrimaryResidence", Zod.boolean.optional),
        ("mortgageCreditPartnerId", partnerId.optional),
        ("mortgageSharePartnerB", Zod.number(min: 0, max: 100).optional),
        ("firstQualifyingYear", year.optional),
        ("woonbonusChildrenAtLoanStart", count.optional),
    ])

    static let belgianTaxHouseholdV2 = Zod.looseObject([
        ("version", Zod.literal(.number(2))),
        ("taxYear", year),
        ("profileConfigured", Zod.boolean),
        ("region", region),
        ("communalSurchargePercent", Zod.number(min: 0, max: 9)),
        ("partners", Zod.array(partnerSchema, min: 1, max: 2)),
        (
            "relationship",
            Zod.looseObject([
                ("events", Zod.array(eventSchema, max: 50)),
                ("deathYearElection", Zod.enumeration(["joint", "separate"]).optional),
                ("legacyAssumedJoint", Zod.boolean.optional),
            ])
        ),
        (
            "dependents",
            Zod.looseObject([
                ("children", count),
                ("childrenUnder3", count.optional),
                ("childrenDisabled", count.optional),
                ("otherPersons", count),
                ("otherPersonsDisabled", count.optional),
                ("claimantPartnerId", partnerId.optional),
            ])
        ),
        ("home", homeSchema),
        ("taxIncomeCategoryIds", Zod.array(Zod.number(min: 1, int: true), max: 1000).optional),
        (
            "migratedFrom",
            Zod.looseObject([
                ("fromVersion", Zod.literal(.number(1))),
                (
                    "unmappedFields",
                    Zod.array(
                        .looseObject([
                            ("field", Zod.string(max: 100)), ("note", Zod.string(max: 100)),
                            ("value", Zod.unknown.optional),
                        ]),
                        max: 200)
                ),
            ]).optional
        ),
    ]).check(.superRefine { householdIssues($0) })

    /// The household superRefine: unique partner ids with an A, unique activity ids, kind-bound
    /// activity fields, and partner references that name a partner.
    private static func householdIssues(_ value: JSValue?) -> [ZodIssue] {
        guard let household = value?.objectValue else { return [] }
        var issues: [ZodIssue] = []
        let partners: [JSObject] = arrayOfObjects(household["partners"])
        let ids = partners.compactMap { $0["id"]?.stringValue }
        if Set(ids).count != ids.count {
            issues.append(ZodIssue(path: [.key("partners")], message: "partner ids must be unique"))
        }
        if !ids.contains("A") {
            issues.append(ZodIssue(path: [.key("partners")], message: "partner A is required"))
        }
        var activityIds = Set<String>()
        for (pi, partner) in partners.enumerated() {
            for (ai, activity) in arrayOfObjects(partner["activities"]).enumerated() {
                let path: [ZodIssue.PathElement] = [.key("partners"), .index(pi), .key("activities"), .index(ai)]
                let id = activity["id"]?.stringValue ?? ""
                if activityIds.contains(id) {
                    issues.append(ZodIssue(path: path + [.key("id")], message: "activity ids must be unique"))
                }
                activityIds.insert(id)
                let kind = activity["kind"]?.stringValue
                if activity.has("netProfessionalIncome"), kind != "net_professional_amount" {
                    issues.append(
                        ZodIssue(
                            path: path + [.key("netProfessionalIncome")],
                            message: "netProfessionalIncome is only allowed on net_professional_amount"))
                }
                if activity.has("pensionKind"), kind != "pension" {
                    issues.append(
                        ZodIssue(path: path + [.key("pensionKind")], message: "pensionKind is only allowed on pension"))
                }
            }
        }
        let known = Set(ids)
        let events = arrayOfObjects(household["relationship"]?.objectValue?["events"])
        for (ei, event) in events.enumerated() {
            let path: [ZodIssue.PathElement] = [.key("relationship"), .key("events"), .index(ei), .key("partnerId")]
            let partner = event["partnerId"]?.stringValue
            if let partner, !known.contains(partner) {
                issues.append(ZodIssue(path: path, message: "unknown partner"))
            }
            if event["kind"]?.stringValue == "death", !event.has("partnerId") {
                issues.append(ZodIssue(path: path, message: "a death event names the deceased partner"))
            }
        }
        if let claimant = household["dependents"]?.objectValue?["claimantPartnerId"]?.stringValue,
            !known.contains(claimant)
        {
            issues.append(ZodIssue(path: [.key("dependents"), .key("claimantPartnerId")], message: "unknown partner"))
        }
        if let mortgagePartner = household["home"]?.objectValue?["mortgageCreditPartnerId"]?.stringValue,
            !known.contains(mortgagePartner)
        {
            issues.append(ZodIssue(path: [.key("home"), .key("mortgageCreditPartnerId")], message: "unknown partner"))
        }
        return issues
    }

    private static func arrayOfObjects(_ value: JSValue?) -> [JSObject] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap(\.objectValue)
    }

    /// Year-keyed household snapshots: four-digit keys, each equal to its household's `taxYear`.
    static let belgianTaxHouseholdSnapshotsV2 = Zod.record(
        key: .checked(
            .string,
            [
                .format("keys must be four-digit income years") { key in
                    key.utf8.count == 4 && key.utf8.allSatisfy { (48...57).contains($0) }
                }
            ]),
        value: belgianTaxHouseholdV2, partial: false
    ).check(
        .superRefine { value in
            guard let snapshots = value?.objectValue else { return [] }
            var issues: [ZodIssue] = []
            for (key, household) in snapshots.entries {
                let taxYear = household.objectValue?["taxYear"]
                if taxYear != .number(JavaScriptNumber.fromString(key)) {
                    issues.append(
                        ZodIssue(path: [.key(key), .key("taxYear")], message: "must equal the snapshot key \(key)"))
                }
            }
            return issues
        })

    // MARK: - The key maps

    /// `SETTING_SCHEMAS`.
    static let schemas: [String: Zod] = [
        "dashboard_settings": dashboardSettings,
        "theme_settings": themeSettings,
        "cost_basis_method": .enumeration(["weighted_avg", "fifo", "lifo"]),
        "includeTransfers": .boolean,
        "brokerage_cash_category_ids": brokerageCashCategoryIds,
        "onboarding_complete": .boolean,
        "app_settings": jsonObject,
        "backup_settings": jsonObject,
        "services_settings": jsonObject,
        "widget_visibility": jsonObject,
        "rebalance_plans": Zod.array(rebalancePlan, max: 50),
        "belgian_tax_profile": belgianTaxProfile,
        "belgian_tax_profile_snapshots_v1": .record(key: .string, value: belgianTaxProfile, partial: false),
        "belgian_tax_profile_snapshot_meta_v1": .record(key: .string, value: snapshotMetaEntry, partial: false),
        "belgian_tax_household_v2": belgianTaxHouseholdV2,
        "belgian_tax_household_snapshots_v2": belgianTaxHouseholdSnapshotsV2,
        "dismissed_recurring_patterns": .array(.unknown),
        "portfolio_tax_adjustments_v1": .record(key: .string, value: jsonObject, partial: false),
        "portfolio_tax_classifications_v1": .record(key: .string, value: jsonObject, partial: false),
        "fx_full_history_repair_done": .boolean,
    ]

    private static func object(_ pairs: [(String, JSValue)]) -> JSValue { .object(JSObject(pairs)) }

    /// `SETTING_DEFAULTS`: what a GET of an absent key answers.
    static let defaults: [String: JSValue] = [
        "onboarding_complete": .bool(false),
        "dismissed_recurring_patterns": .array([]),
        "app_settings": object([
            ("defaultCurrency", .string("EUR")), ("dateFormat", .string("DD/MM/YYYY")), ("numberFormat", .string("eu")),
            ("defaultPageSize", .number(50)), ("startOfWeek", .string("monday")), ("showDecimalPlaces", .number(2)),
            ("language", .string("en")), ("autoClearPlannedOnMatch", .bool(true)),
            ("costBasisMethod", .string("weighted_avg")), ("adminMode", .bool(false)),
            ("visualEffects", .string("standard")), ("autoAdaptDisplay", .bool(true)), ("fullEffects", .string("auto")),
            ("startupSection", .string("budgeting")), ("colorblindGainLoss", .bool(false)),
        ]),
        "dashboard_settings": object([
            ("excludedCategoryIds", .array([])), ("excludedRecipientIds", .array([])),
            ("excludeHiddenCategories", .bool(true)), ("exclusionScope", .string("everywhere")),
        ]),
        "theme_settings": object([
            ("mode", .string("system")),
            ("schedule", object([("lightFrom", .string("07:00")), ("darkFrom", .string("20:00"))])),
            ("variant", .string("default")),
        ]),
        "backup_settings": object([("backupDir", .string("")), ("backupOnQuit", .bool(false))]),
        "services_settings": object([("keepServicesOnQuit", .bool(false))]),
        "widget_visibility": object([]),
        "cost_basis_method": .string("weighted_avg"),
        "rebalance_plans": .array([]),
        "includeTransfers": .bool(false),
        "brokerage_cash_category_ids": object([
            ("dividend", .null), ("interest", .null), ("fee", .null), ("tax", .null),
        ]),
    ]

    /// `KNOWN_SETTING_KEYS`, and the sorted list its 400 names.
    static let knownKeys = Set(schemas.keys).union(defaults.keys)
    static let knownKeysText = knownKeys.sorted().joined(separator: ", ")
}

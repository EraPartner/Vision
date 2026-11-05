import Foundation
import Testing

@testable import VisionNativeCore

private struct Box<Value: Codable & Equatable>: Codable, Equatable {
    let value: Value
}

/// Decodes `{"value": raw}` as `Value`, encodes it back and returns the decoded value and the text
/// that was written.
private func roundTrip<Value: Codable & Equatable>(_ type: Value.Type, _ raw: String) throws -> (Value, String) {
    let json = Data(("{\"value\":\"" + raw + "\"}").utf8)
    let decoded = try JSONDecoder().decode(Box<Value>.self, from: json)
    let encoded = try JSONEncoder().encode(decoded)
    let written = try JSONDecoder().decode(Box<String>.self, from: encoded).value
    return (decoded.value, written)
}

@Suite("Typed settings, setting keys, notice keys and routes")
struct NativeTypedSettingsTests {
    @Test func everyPersistedValueOfASettingsEnumRoundTripsUnchanged() throws {
        let persisted: [(String, [String])] = [
            ("language", ["en", "nl"]), ("startOfWeek", ["monday", "sunday"]),
            ("costBasisMethod", ["weighted_avg", "fifo", "lifo"]),
            ("startupSection", ["budgeting", "portfolio", "research", "ai-chat", "last"]),
            ("aiAnswerDepth", ["quick", "detailed"]), ("visualEffects", ["reduced", "standard", "enhanced"]),
        ]
        for (field, raws) in persisted {
            for raw in raws {
                let results: [(String, String)]
                switch field {
                case "language":
                    let (value, written) = try roundTrip(AppLanguage.self, raw)
                    results = [(value.rawValue, written)]
                case "startOfWeek":
                    let (value, written) = try roundTrip(StartOfWeek.self, raw)
                    results = [(value.rawValue, written)]
                case "costBasisMethod":
                    let (value, written) = try roundTrip(CostBasisMethod.self, raw)
                    results = [(value.rawValue, written)]
                case "startupSection":
                    let (value, written) = try roundTrip(StartupSection.self, raw)
                    results = [(value.rawValue, written)]
                case "aiAnswerDepth":
                    let (value, written) = try roundTrip(AIAnswerDepth.self, raw)
                    results = [(value.rawValue, written)]
                default:
                    let (value, written) = try roundTrip(VisualEffects.self, raw)
                    results = [(value.rawValue, written)]
                }
                #expect(results.allSatisfy { $0.0 == raw && $0.1 == raw }, "\(field) \(raw)")
            }
        }
    }

    @Test func theCasesCarryTheWebRawValues() {
        #expect(AppLanguage.allCases == [.en, .nl])
        #expect(StartOfWeek.allCases.map(\.rawValue) == ["monday", "sunday"])
        #expect(CostBasisMethod.allCases.map(\.rawValue) == ["weighted_avg", "fifo", "lifo"])
        #expect(StartupSection.allCases.map(\.rawValue) == ["budgeting", "portfolio", "research", "ai-chat", "last"])
        #expect(AIAnswerDepth.allCases == [.quick, .detailed])
        #expect(VisualEffects.allCases.map(\.rawValue) == ["reduced", "standard", "enhanced"])
        #expect(CostBasisMethod(rawValue: "weighted_avg") == .weightedAvg)
        #expect(StartupSection(rawValue: "ai-chat") == .aiChat)
    }

    @Test func aValueFromANewerClientDecodesToUnknownAndEncodesBackUnchanged() throws {
        let language = try roundTrip(AppLanguage.self, "fr")
        #expect(language.0 == .unknown("fr") && language.1 == "fr")
        let week = try roundTrip(StartOfWeek.self, "saturday")
        #expect(week.0 == .unknown("saturday") && week.1 == "saturday")
        let basis = try roundTrip(CostBasisMethod.self, "hifo")
        #expect(basis.0 == .unknown("hifo") && basis.1 == "hifo")
        let section = try roundTrip(StartupSection.self, "/research")
        #expect(section.0 == .unknown("/research") && section.1 == "/research")
        let depth = try roundTrip(AIAnswerDepth.self, "exhaustive")
        #expect(depth.0 == .unknown("exhaustive") && depth.1 == "exhaustive")
        let effects = try roundTrip(VisualEffects.self, "ultra")
        #expect(effects.0 == .unknown("ultra") && effects.1 == "ultra")
        // An unknown value is not one of the cases a picker offers.
        #expect(!VisualEffects.allCases.contains(.unknown("ultra")))
        #expect(!StartupSection.allCases.contains(.unknown("last ")))
    }

    @Test func settingsMigrationKeepsPersistedValuesAndFallsBackOnlyForValuesOutsideTheWebUnion() {
        let fields: [(String, [String], (NativeAppSettings) -> String)] = [
            ("language", ["en", "nl"], { $0.language.rawValue }),
            ("startOfWeek", ["monday", "sunday"], { $0.startOfWeek.rawValue }),
            ("costBasisMethod", ["weighted_avg", "fifo", "lifo"], { $0.costBasisMethod.rawValue }),
            (
                "startupSection", ["budgeting", "portfolio", "research", "ai-chat", "last"],
                { $0.startupSection.rawValue }
            ),
            ("aiAnswerDepth", ["quick", "detailed"], { $0.aiAnswerDepth.rawValue }),
            ("visualEffects", ["reduced", "standard", "enhanced"], { $0.visualEffects.rawValue }),
        ]
        for (key, raws, read) in fields {
            for raw in raws {
                #expect(read(NativeAppSettings.migrate(.object([key: .string(raw)]))) == raw, "\(key) \(raw)")
            }
            let unknown = NativeAppSettings.migrate(.object([key: .string("future-value")]))
            #expect(read(unknown) == read(.defaults), "\(key) keeps its default for a value it does not know")
        }
    }

    @Test func theDefaultsMatchTheStoredDefaultsDocument() {
        let defaults = NativeAppSettings.defaults
        let stored = NativeSettingsDefaults.app
        #expect(stored["language"] == .string(defaults.language.rawValue))
        #expect(stored["startOfWeek"] == .string(defaults.startOfWeek.rawValue))
        #expect(stored["costBasisMethod"] == .string(defaults.costBasisMethod.rawValue))
        #expect(stored["startupSection"] == .string(defaults.startupSection.rawValue))
        #expect(stored["visualEffects"] == .string(defaults.visualEffects.rawValue))
        #expect(defaults.aiAnswerDepth == .quick)
    }

    @Test func settingKeysKeepTheStoredKeyNames() {
        #expect(SettingKey.appSettings.rawValue == "app_settings")
        #expect(SettingKey.dashboardSettings.rawValue == "dashboard_settings")
        #expect(SettingKey.themeSettings.rawValue == "theme_settings")
        #expect(SettingKey.backupSettings.rawValue == "backup_settings")
        #expect(SettingKey.servicesSettings.rawValue == "services_settings")
        #expect(SettingKey.widgetVisibility.rawValue == "widget_visibility")
        #expect(SettingKey.costBasisMethod.rawValue == "cost_basis_method")
        #expect(SettingKey.includeTransfers.rawValue == "includeTransfers")
        #expect(SettingKey.brokerageCashCategoryIds.rawValue == "brokerage_cash_category_ids")
        #expect(SettingKey.onboardingComplete.rawValue == "onboarding_complete")
        #expect(SettingKey.rebalancePlans.rawValue == "rebalance_plans")
        #expect(SettingKey.dismissedRecurringPatterns.rawValue == "dismissed_recurring_patterns")
        #expect(SettingKey.belgianTaxHouseholdV2.rawValue == "belgian_tax_household_v2")
        #expect(SettingKey.belgianTaxHouseholdSnapshotsV2.rawValue == "belgian_tax_household_snapshots_v2")
        #expect(SettingKey.belgianTaxProfileSnapshotMetaV1.rawValue == "belgian_tax_profile_snapshot_meta_v1")
        #expect(SettingKey.portfolioTaxAdjustmentsV1.rawValue == "portfolio_tax_adjustments_v1")
        #expect(SettingKey.portfolioTaxClassificationsV1.rawValue == "portfolio_tax_classifications_v1")
        #expect(Set(SettingKey.allCases.map(\.rawValue)).count == SettingKey.allCases.count)
        #expect(NativeAppSettings.settingsKey == .appSettings)
        #expect(TaxYearMutation.householdKey == SettingKey.belgianTaxHouseholdV2.rawValue)
        #expect(PortfolioTaxSettingsDraft.adjustmentsKey == SettingKey.portfolioTaxAdjustmentsV1.rawValue)
    }

    @Test func noticeKeysKeepTheToastIdsOfTheWebApp() {
        #expect(NoticeKey.portfolioRefreshPrices.rawValue == "portfolio-refresh-prices")
        #expect(NoticeKey.backendHealth.rawValue == "backend-health")
        let action: LocalizedKey = "common.undo"
        #expect(action == LocalizedKey("common.undo") && action.rawValue == "common.undo")
    }

    @Test func routeDestinationsAreTheRegistryPages() {
        let registry = Set(NavigationRegistry.allItems.map(\.url))
        #expect(Set(NativeRoute.Destination.allCases.map(\.rawValue)) == registry)
        #expect(NativeRoute.home == NativeRoute(path: "/"))
        #expect(NativeRoute(.marketLookup).path == "/research/market")
        let search = NativeRoute(.transactions, query: [URLQueryItem(name: "search", value: "a b")])
        #expect(search == NativeRoute(path: "/transactions", query: [URLQueryItem(name: "search", value: "a b")]))
        #expect(search.string == "/transactions?search=a%20b")
        #expect(NativeRoute(path: "/portfolio/net-worth").destination == .netWorth)
        #expect(NativeRoute(path: "/accounts/4").destination == nil)
    }

    @Test func startupSectionsOpenTheirRegistryPages() {
        let cases: [(StartupSection, String?)] = [
            (.budgeting, nil), (.portfolio, "/portfolio"), (.research, "/research"), (.aiChat, "/ai-chat"),
            (.unknown("future"), nil),
        ]
        for (section, target) in cases {
            var startup = NativeNavigationStartup(context: .documentReload, mirroredStartupSection: nil, lastRoute: nil)
            let result = startup.evaluate(currentLocation: "/", settings: .loaded(startupSection: section))
            let expected: NativeNavigationStartup.Resolution =
                target.map(NativeNavigationStartup.Resolution.replaceCurrentEntry) ?? .unchanged
            #expect(result == expected)
        }
    }
}

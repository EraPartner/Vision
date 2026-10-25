import Foundation

/// The keys of the settings store (`PUT /api/settings/{key}`): the keys of `SETTING_SCHEMAS` and
/// `SETTING_DEFAULTS` in apps/node-backend/src/routes/settings.ts, which rejects any other key on
/// write. The raw values are the stored key names, so nothing persisted changes. Keys that only a
/// restored backup can hold stay plain `String`s in `NativeSettingsSnapshot`.
public enum SettingKey: String, CaseIterable, Hashable, Sendable {
    case appSettings = "app_settings"
    case dashboardSettings = "dashboard_settings"
    case themeSettings = "theme_settings"
    case backupSettings = "backup_settings"
    case servicesSettings = "services_settings"
    case widgetVisibility = "widget_visibility"
    case costBasisMethod = "cost_basis_method"
    case includeTransfers = "includeTransfers"
    case brokerageCashCategoryIds = "brokerage_cash_category_ids"
    case onboardingComplete = "onboarding_complete"
    case rebalancePlans = "rebalance_plans"
    case dismissedRecurringPatterns = "dismissed_recurring_patterns"
    case belgianTaxProfile = "belgian_tax_profile"
    case belgianTaxProfileSnapshotsV1 = "belgian_tax_profile_snapshots_v1"
    case belgianTaxProfileSnapshotMetaV1 = "belgian_tax_profile_snapshot_meta_v1"
    case belgianTaxHouseholdV2 = "belgian_tax_household_v2"
    case belgianTaxHouseholdSnapshotsV2 = "belgian_tax_household_snapshots_v2"
    case portfolioTaxAdjustmentsV1 = "portfolio_tax_adjustments_v1"
    case portfolioTaxClassificationsV1 = "portfolio_tax_classifications_v1"
    case fxFullHistoryRepairDone = "fx_full_history_repair_done"
}

extension OpenAPIOperations.GetSetting {
    public init(key: SettingKey) { self.init(key: key.rawValue) }
}

extension OpenAPIOperations.SaveSetting {
    public init(key: SettingKey, body: Body) { self.init(key: key.rawValue, body: body) }
}

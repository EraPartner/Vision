import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Settings appearance and exact read projections")
struct NativeSettingsAppearanceTests {
    @Test func requiredPreferenceProjectionUsesSourceDefaultsAndIndependentFieldValidation() {
        let defaults = NativeAppSettings.defaults
        #expect(
            defaults.startOfWeek == "monday" && defaults.costBasisMethod == "weighted_avg"
                && defaults.startupSection == "budgeting")
        #expect(defaults.autoClearPlannedOnMatch && defaults.visualEffects == "standard" && defaults.autoAdaptDisplay)
        let projected = NativeAppSettings.migrate(
            .object([
                "startOfWeek": .string("sunday"), "costBasisMethod": .string("lifo"), "startupSection": .string("last"),
                "autoClearPlannedOnMatch": .bool(false), "visualEffects": .string("enhanced"),
                "autoAdaptDisplay": .bool(false),
            ]))
        #expect(
            projected.startOfWeek == "sunday" && projected.costBasisMethod == "lifo"
                && projected.startupSection == "last")
        #expect(
            !projected.autoClearPlannedOnMatch && projected.visualEffects == "enhanced" && !projected.autoAdaptDisplay)
        let malformed = NativeAppSettings.migrate(
            .object([
                "startOfWeek": .string("Saturday"), "costBasisMethod": .string("average"),
                "startupSection": .string("/research"),
                "autoClearPlannedOnMatch": .string("false"), "visualEffects": .string("high"),
                "autoAdaptDisplay": .int(1),
            ]))
        #expect(malformed == defaults)
    }
    @Test func fullEffectsDefaultsOffAndKeepsOnlyABooleanLikeTheSourceStore() {
        // ADR-244: `AppSettings.fullEffects`, off by default, validated on its own.
        #expect(!NativeAppSettings.defaults.fullEffects)
        #expect(NativeSettingsDefaults.app["fullEffects"] == .bool(false))
        #expect(NativeAppSettings.migrate(.object(["fullEffects": .bool(true)])).fullEffects)
        #expect(!NativeAppSettings.migrate(.object(["fullEffects": .string("true")])).fullEffects)
        #expect(!NativeAppSettings.migrate(.object(["fullEffects": .int(1)])).fullEffects)
        // A stored blob without the key (older installs) migrates to off and keeps the other fields.
        let migrated = NativeSettingsDefaults.migrateApp(.object(["visualEffects": .string("enhanced")]))
        #expect(migrated["fullEffects"] == .bool(false) && migrated["visualEffects"] == .string("enhanced"))
        #expect(NativeSettingsDefaults.appValue("fullEffects", raw: .object(["fullEffects": .string("on")])) == .bool(false))
    }
    @Test func explicitAndSystemModesRetainVariantAccentAndGainLossSkin() {
        var settings = NativeAppSettings.defaults
        settings.colorblindGainLoss = true
        let theme: TaxValue = .object([
            "mode": .string("light"), "variant": .string("nord"), "systemAccent": .bool(true),
        ])
        let result = NativeSettingsAppearanceResolver.resolve(
            theme: theme, settings: settings, systemIsDark: true, physicalPixelCount: 4_000_000)
        #expect(result.theme.appearance == .light && result.theme.variant == .nord && result.theme.colorblindGainLoss)
        #expect(result.systemAccent && !result.invalidSchedule)
        #expect(resolve(mode: "system", hour: 1, systemIsDark: false).theme.appearance == .light)
        #expect(resolve(mode: "system", hour: 1, systemIsDark: true).theme.appearance == .dark)
    }
    @Test func normalAndInvertedSchedulesUseInclusiveStartAndExclusiveEnd() {
        #expect(resolve(hour: 6).theme.appearance == .dark)
        #expect(resolve(hour: 7).theme.appearance == .light)
        #expect(resolve(hour: 19, minute: 59).theme.appearance == .light)
        #expect(resolve(hour: 20).theme.appearance == .dark)
        #expect(resolve(hour: 20, light: "20:00", dark: "07:00").theme.appearance == .light)
        #expect(resolve(hour: 6, light: "20:00", dark: "07:00").theme.appearance == .light)
        #expect(resolve(hour: 7, light: "20:00", dark: "07:00").theme.appearance == .dark)
        #expect(resolve(hour: 12, light: "07:00", dark: "07:00").theme.appearance == .light)
    }
    @Test func legacyClockNumberQuirksMatchSourceWithoutInventingValidTime() {
        #expect(resolve(hour: 1, light: "", dark: "20:00").theme.appearance == .light)
        #expect(resolve(hour: 7, light: "bad:Infinity", dark: "20:00").theme.appearance == .dark)
        #expect(resolve(hour: 8, light: "bad:Infinity", dark: "20:00").theme.appearance == .light)
        #expect(resolve(hour: 8, light: "0x8:0b1", dark: "20:00").theme.appearance == .dark)
        #expect(resolve(hour: 8, minute: 1, light: "0x8:0b1", dark: "20:00").theme.appearance == .light)
        #expect(resolve(hour: 5, light: "0x1p2:00", dark: "20:00").theme.appearance == .dark)
        #expect(resolve(hour: 8, light: "8:30:59", dark: "20:00").theme.appearance == .dark)
        #expect(resolve(hour: 8, minute: 30, light: "8:30:59", dark: "20:00").theme.appearance == .light)
        #expect(resolve(mode: "unknown", hour: 7).theme.appearance == .light)
    }
    @Test func malformedClockShapeRetainsPreviousResolvedAppearanceAndReportsInvalidity() {
        let result = NativeSettingsAppearanceResolver.resolve(
            theme: .object([
                "mode": .string("schedule"),
                "schedule": .object(["lightFrom": .number(7), "darkFrom": .string("20:00")]),
            ]), settings: .defaults, systemIsDark: false, physicalPixelCount: 0, previousAppearance: .light)
        #expect(result.invalidSchedule && result.theme.appearance == .light)
    }
    @Test func physicalPixelThresholdAndSessionOverrideOnlyApplyUnderActiveCap() {
        var settings = NativeAppSettings.defaults
        settings.visualEffects = "enhanced"
        let boundary = NativeSettingsAppearanceResolver.resolve(
            theme: nil, settings: settings, systemIsDark: true, physicalPixelCount: 6_000_000)
        #expect(!boundary.isLargeDisplay && boundary.effectiveVisualEffects == "enhanced")
        let capped = NativeSettingsAppearanceResolver.resolve(
            theme: nil, settings: settings, systemIsDark: true, physicalPixelCount: 6_000_001)
        #expect(capped.isLargeDisplay && capped.effectiveVisualEffects == "reduced")
        let override = NativeSettingsAppearanceResolver.resolve(
            theme: nil, settings: settings, systemIsDark: true, physicalPixelCount: 8_294_400,
            sessionTierOverride: "standard")
        #expect(override.effectiveVisualEffects == "standard")
        settings.autoAdaptDisplay = false
        let uncapped = NativeSettingsAppearanceResolver.resolve(
            theme: nil, settings: settings, systemIsDark: true, physicalPixelCount: 8_294_400,
            sessionTierOverride: "reduced")
        #expect(uncapped.effectiveVisualEffects == "enhanced")
    }
    @Test func builtInDisplayIsNeverLargeAndUnknownFallsBackToPixels() {
        // A "More Space" MacBook Air mode: 7.06 MP backing store on a built-in panel (ADR-244).
        #expect(!NativeSettingsAppearanceResolver.isLargeDisplay(physicalPixelCount: 7_056_000, isBuiltIn: true))
        #expect(NativeSettingsAppearanceResolver.isLargeDisplay(physicalPixelCount: 7_056_000, isBuiltIn: false))
        #expect(NativeSettingsAppearanceResolver.isLargeDisplay(physicalPixelCount: 7_056_000, isBuiltIn: nil))
        var settings = NativeAppSettings.defaults
        settings.visualEffects = "enhanced"
        let builtIn = NativeSettingsAppearanceResolver.resolve(
            theme: nil, settings: settings, systemIsDark: true, physicalPixelCount: 8_294_400, isBuiltInDisplay: true)
        #expect(!builtIn.isLargeDisplay && builtIn.effectiveVisualEffects == "enhanced")
    }
}

private func resolve(
    mode: String = "schedule", hour: Int, minute: Int = 0, light: String = "07:00", dark: String = "20:00",
    systemIsDark: Bool = false
) -> NativeSettingsAppearance {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 13, hour: hour, minute: minute))!
    return NativeSettingsAppearanceResolver.resolve(
        theme: .object([
            "mode": .string(mode), "schedule": .object(["lightFrom": .string(light), "darkFrom": .string(dark)]),
        ]), settings: .defaults, date: date, calendar: calendar, systemIsDark: systemIsDark, physicalPixelCount: 0)
}

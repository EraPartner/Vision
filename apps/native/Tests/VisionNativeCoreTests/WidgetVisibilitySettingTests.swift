import Testing

@testable import VisionNativeCore

/// useWidgetVisibility (main, 2026-10-18): only pages of boolean flags load or get overwritten.
@Suite struct WidgetVisibilitySettingTests {
    @Test func acceptsAbsentOrBooleanPages() {
        #expect(InsightWidgetVisibility.isValidSetting(.null))
        #expect(InsightWidgetVisibility.isValidSetting(.object([:])))
        #expect(
            InsightWidgetVisibility.isValidSetting(
                .object(["dashboard": .object(["statCards": .bool(true), "bankBalances": .bool(false)])])))
    }

    @Test func refusesAnyOtherShape() {
        for raw: JSONValue in [
            .array([]), .string("x"), .object(["dashboard": .array([])]), .object(["dashboard": .null]),
            .object(["dashboard": .object(["statCards": .string("true")])]),
        ] {
            #expect(!InsightWidgetVisibility.isValidSetting(raw))
        }
    }
}

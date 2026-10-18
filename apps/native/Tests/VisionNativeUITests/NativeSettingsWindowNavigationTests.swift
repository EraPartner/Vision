import Testing

@testable import VisionNativeUI

struct NativeSettingsWindowNavigationTests {
    @Test func sectionKeysRetainSourceRoutesAndOrder() {
        #expect(
            NativeSettingsWindowSection.allCases.map(\.rawValue) == [
                "general", "appearance", "statistics", "behavior", "ai", "backup", "about",
            ])
        #expect(NativeSettingsWindowSection(rawValue: "insights") == nil)
        #expect(NativeSettingsWindowSection(rawValue: "statistics")?.titleKey == "settings.section.statistics")
    }
    @Test func railNavigationWrapsAndSupportsBothEndpoints() {
        #expect(NativeSettingsWindowSection.general.moving(.previous) == .about)
        #expect(NativeSettingsWindowSection.about.moving(.next) == .general)
        #expect(NativeSettingsWindowSection.behavior.moving(.first) == .general)
        #expect(NativeSettingsWindowSection.ai.moving(.last) == .about)
    }
}

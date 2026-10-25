import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native Settings delta bridge")
struct NativeSettingsPatchTests {
    @Test func onlyPreferenceEnvelopesAndKnownFieldsCanBeChanged() throws {
        let patch = try NativeSettingsPatch(
            key: "app_settings", updates: ["language": .string("nl")], removed: ["analysisBenchmark"])
        #expect(patch.key == "app_settings" && patch.removed == ["analysisBenchmark"])
        for key in ["backup_settings", "provider_keys", "life_scenarios", "onboarding_complete"] {
            #expect(throws: APIError.self) { try NativeSettingsPatch(key: key, updates: [:], removed: []) }
        }
        #expect(throws: APIError.self) {
            try NativeSettingsPatch(key: "app_settings", updates: ["futureSecret": .string("synthetic")], removed: [])
        }
    }
    @Test func requiredFieldsAndConflictingDeltasCannotBeRemoved() {
        #expect(throws: APIError.self) {
            try NativeSettingsPatch(key: "app_settings", updates: [:], removed: ["defaultCurrency"])
        }
        #expect(throws: APIError.self) {
            try NativeSettingsPatch(key: "theme_settings", updates: [:], removed: ["mode"])
        }
        #expect(throws: APIError.self) {
            try NativeSettingsPatch(
                key: "app_settings", updates: ["analysisBenchmark": .string("ABC")], removed: ["analysisBenchmark"])
        }
    }
    @Test func malformedDeltaArgumentsNeverReachAHost() {
        let valid = BridgeRequest(
            channel: .settingsChange,
            arguments: [.string("theme_settings"), .object(["mode": .string("dark")]), .array([])])
        guard case .call(.settingsChange(let value)) = BridgeCodec.validate(valid) else {
            Issue.record("Expected validated settings delta")
            return
        }
        #expect(value.updates["mode"] == .string("dark"))
        for arguments: [JSONValue] in [
            [.string("theme_settings"), .array([]), .array([])],
            [.string("app_settings"), .object([:]), .array([.int(1)])],
            [.string("provider_keys"), .object([:]), .array([])],
            [.string("app_settings"), .object([:]), .array([]), .bool(true)],
        ] {
            guard case .invalid = BridgeCodec.validate(.init(channel: .settingsChange, arguments: arguments)) else {
                Issue.record("Malformed settings delta accepted")
                continue
            }
        }
    }
}

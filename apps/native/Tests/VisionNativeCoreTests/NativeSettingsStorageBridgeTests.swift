import Foundation
import Testing

@testable import VisionNativeCore

#if canImport(JavaScriptCore)
    import JavaScriptCore
#endif

@Suite struct NativeSettingsStorageBridgeTests {
    @Test func snapshotKeepsRegistryCachesAndExcludesUnregisteredCredentials() throws {
        let keys = NativeSettingsStorageBridge.knownKeys
        #expect(keys.count == 15)
        #expect(Set(keys).count == keys.count)
        #expect(keys.contains("vision.palette.recents"))
        #expect(keys.contains("vision.lastRoute"))
        #expect(keys.contains("vision.language"))
        #expect(keys.contains("vision.startupSection"))
        #expect(!keys.contains("vision.adminToken"))
        #expect(!keys.contains("researchProviderKeys"))
        let original = "{\"keys\":{\"vision_theme\":\"dark\",\"vision.analysis.sqlHistory\":\"[bad json preserved]\"}}"
        #expect(try NativeSettingsStorageBridge.readReply(.string(original)) == original)
        #expect(try NativeSettingsStorageBridge.readReply(.null) == nil)
    }
    @Test func malformedCaptureIsDistinctFromUnavailableStorage() {
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.readReply(.string("{\"keys\":{\"vision_theme\":false}}"))
        }
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.readReply(.string("{\"keys\":{\"unregistered\":\"value\"}}"))
        }
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.readReply(.bool(false))
        }
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.readReply(.string("not JSON"))
        }
    }
    @Test func restorePayloadIsBoundSeparatelyAndRetainsHistoricalKeysAndRawStrings() throws {
        let text = "quotes \" and \\ and \n and \u{2028}; globalThis.injected=true;"
        let state: JSONValue = .object([
            "keys": .object(["historical-key": .string(text), "vision_theme": .string("null")])
        ])
        let arguments = try NativeSettingsStorageBridge.restoreArguments(state)
        let encoded = try #require(arguments["stateJSON"]?.stringValue)
        #expect(try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8)) == state)
        #expect(!NativeSettingsStorageBridge.restoreScript.contains(text))
        #expect(NativeSettingsStorageBridge.restoreScript.contains("JSON.parse(stateJSON)"))
        #expect(!NativeSettingsStorageBridge.restoreScript.contains("localStorage.clear"))
    }
    @Test func localControlsHaveOnlyTypedAllowedKeysAndNullableRawReplies() throws {
        #expect(
            Set(NativeSettingsStorageBridge.LocalKey.allCases.map(\.rawValue))
                == Set([
                    "vision.backup.passphrase.reminder.dismissed", "vision.onboarding.draft.v1",
                    "dismissed_recurring_patterns",
                    "vision.palette.recents", "fx-status-banner-dismissed-at", "dismissed_upcoming_planned_payments",
                    "vision.startupSection", "vision.lastRoute",
                ]))
        #expect(
            NativeSettingsStorageBridge.arguments(for: .reminder, value: "1") == [
                "key": .string("vision.backup.passphrase.reminder.dismissed"), "value": .string("1"),
            ])
        #expect(try NativeSettingsStorageBridge.readLocalReply(.string("not JSON")) == "not JSON")
        #expect(try NativeSettingsStorageBridge.readLocalReply(.null) == nil)
        #expect(try NativeSettingsStorageBridge.mutationReply(.bool(false)) == false)
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.readLocalReply(.int(1))
        }
        #expect(throws: NativeSettingsStorageBridge.ReplyError.invalidReply) {
            try NativeSettingsStorageBridge.mutationReply(.null)
        }
    }

    #if canImport(JavaScriptCore)
        @MainActor private func context() throws -> JSContext {
            let context = try #require(JSContext())
            context.evaluateScript(
                """
                var saved = { vision_theme: "dark", unregistered: "untouched", "vision.adminToken": "not exported" };
                var fail = false, failAt = "", writes = 0;
                var window = { localStorage: {
                    getItem(key) { if (fail || key === failAt) throw new Error("restricted"); return Object.hasOwn(saved, key) ? saved[key] : null; },
                    setItem(key, value) { writes++; if (fail) throw new Error("restricted"); saved[key] = String(value); },
                    removeItem(key) { if (fail) throw new Error("restricted"); delete saved[key]; }
                } };
                """)
            return context
        }
        @MainActor @Test func editingDetectorMatchesSourceAndFailsSafeWithoutDOM() throws {
            let context = try context()
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.editingScript)})()")?.toBool() == true
            )
            context.evaluateScript(
                """
                class HTMLElement { constructor(tag, editable = false) { this.tagName = tag; this.isContentEditable = editable; } }
                var document = { activeElement: new HTMLElement("INPUT") };
                """)
            for tag in ["INPUT", "TEXTAREA", "SELECT"] {
                context.setObject(tag, forKeyedSubscript: "tag" as NSString)
                context.evaluateScript("document.activeElement = new HTMLElement(tag)")
                #expect(
                    context.evaluateScript("(function(){\(NativeSettingsStorageBridge.editingScript)})()")?.toBool()
                        == true)
            }
            context.evaluateScript("document.activeElement = new HTMLElement('DIV', true)")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.editingScript)})()")?.toBool() == true
            )
            context.evaluateScript("document.activeElement = new HTMLElement('BUTTON')")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.editingScript)})()")?.toBool()
                    == false)
            context.evaluateScript("document.activeElement = null")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.editingScript)})()")?.toBool()
                    == false)
        }
        @MainActor @Test func legacyThemeReadsRawValuesWithoutDiscardingAPartialRead() throws {
            let context = try context()
            context.evaluateScript("saved.vision_theme = 'light'; saved.vision_theme_variant = 'nord'")
            let script = "(function(){\(NativeSettingsStorageBridge.legacyThemeScript)})()"
            let text = try #require(context.evaluateScript(script)?.toString())
            #expect(
                try JSONValue.parse(Data(text.utf8)) == .object(["mode": .string("light"), "variant": .string("nord")]))
            context.evaluateScript("failAt = 'vision_theme_variant'")
            let partial = try #require(context.evaluateScript(script)?.toString())
            #expect(try JSONValue.parse(Data(partial.utf8)) == .object(["mode": .string("light"), "variant": .null]))
            context.evaluateScript("fail = true")
            let unavailable = try #require(context.evaluateScript(script)?.toString())
            #expect(try JSONValue.parse(Data(unavailable.utf8)) == .object(["mode": .null, "variant": .null]))
        }
        @MainActor @Test func actualScriptsCaptureKnownKeysAndTreatReadFailureAsNoCapture() throws {
            let context = try context()
            let result = context.evaluateScript("(function(){\(NativeSettingsStorageBridge.exportScript)})()")
            let text = try #require(result?.toString())
            #expect(
                try NativeSettingsStorageBridge.readReply(.string(text)) == "{\"keys\":{\"vision_theme\":\"dark\"}}")
            context.evaluateScript("fail = true")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.exportScript)})()")?.isNull == true)
        }
        @MainActor @Test func actualRestoreUsesBoundPayloadAndStopsNonfatallyOnStorageFailure() throws {
            let context = try context()
            let raw = "\"; globalThis.injected = true; //\n"
            let state: JSONValue = .object([
                "keys": .object(["historical-key": .string(raw), "vision_theme": .string("light")])
            ])
            let args = try NativeSettingsStorageBridge.restoreArguments(state)
            context.setObject(try #require(args["stateJSON"]?.stringValue), forKeyedSubscript: "stateJSON" as NSString)
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.restoreScript)})()")?.toBool() == true
            )
            #expect(context.evaluateScript("saved['historical-key']")?.toString() == raw)
            #expect(context.evaluateScript("saved.unregistered")?.toString() == "untouched")
            #expect(context.evaluateScript("typeof injected")?.toString() == "undefined")
            context.evaluateScript("fail = true; writes = 0")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.restoreScript)})()")?.toBool()
                    == false)
            #expect(context.evaluateScript("writes")?.toInt32() == 1)
        }
        @MainActor @Test func actualLocalScriptsCannotMutateAnUnallowedKey() throws {
            let context = try context()
            context.setObject("unregistered", forKeyedSubscript: "key" as NSString)
            context.setObject("changed", forKeyedSubscript: "value" as NSString)
            context.evaluateScript("(function(){\(NativeSettingsStorageBridge.writeScript)})()")
            #expect(context.exception != nil)
            context.exception = nil
            #expect(context.evaluateScript("saved.unregistered")?.toString() == "untouched")
            context.setObject(
                NativeSettingsStorageBridge.LocalKey.reminder.rawValue, forKeyedSubscript: "key" as NSString)
            context.setObject("1", forKeyedSubscript: "value" as NSString)
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.writeScript)})()")?.toBool() == true)
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.readScript)})()")?.toString() == "1")
            #expect(
                context.evaluateScript("(function(){\(NativeSettingsStorageBridge.removeScript)})()")?.toBool() == true)
            #expect(context.evaluateScript("(function(){\(NativeSettingsStorageBridge.readScript)})()")?.isNull == true)
        }
    #endif
}

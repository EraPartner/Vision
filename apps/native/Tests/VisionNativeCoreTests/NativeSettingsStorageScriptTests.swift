#if canImport(JavaScriptCore)
    import Foundation
    import JavaScriptCore
    import Testing
    @testable import VisionNativeCore

    @MainActor @Suite struct NativeSettingsStorageScriptTests {
        private func context() throws -> JSContext {
            let context = try #require(JSContext())
            context.evaluateScript(
                """
                var values = Object.create(null);
                var calls = [];
                var window = { localStorage: {
                    getItem: function (key) { calls.push(key); return values[key] === undefined ? null : values[key]; },
                    setItem: function (key, value) { calls.push(key); values[key] = String(value); },
                    removeItem: function (key) { calls.push(key); delete values[key]; }
                } };
                """)
            #expect(context.exception == nil)
            return context
        }
        private func execute(_ script: String, in context: JSContext) -> JSValue? {
            context.evaluateScript("(function () {\n\(script)\n})()")
        }
        @Test func everyTypedKeyRoundTripsThroughTheActualScripts() throws {
            let context = try context()
            let raw = "quotes \" and \\ and \n and \u{2028}; values.injected = true;"
            context.setObject(raw, forKeyedSubscript: "value" as NSString)
            for key in NativeSettingsStorageBridge.LocalKey.allCases {
                context.setObject(key.rawValue, forKeyedSubscript: "key" as NSString)
                #expect(execute(NativeSettingsStorageBridge.writeScript, in: context)?.toBool() == true)
                #expect(context.exception == nil)
                #expect(execute(NativeSettingsStorageBridge.readScript, in: context)?.toString() == raw)
                #expect(context.exception == nil)
                #expect(execute(NativeSettingsStorageBridge.removeScript, in: context)?.toBool() == true)
                #expect(execute(NativeSettingsStorageBridge.readScript, in: context)?.isNull == true)
            }
            #expect(context.evaluateScript("values.injected === undefined")?.toBool() == true)
            #expect(!NativeSettingsStorageBridge.knownKeys.contains("fx-status-banner-dismissed-at"))
        }
        @Test(arguments: [
            "vision.adminToken", "vision_theme", "provider_api_key", "", "vision.palette.recents; injected=true",
        ])
        func unknownKeysFailBeforeAnyStorageAccess(_ key: String) throws {
            let context = try context()
            context.setObject(key, forKeyedSubscript: "key" as NSString)
            context.setObject("synthetic", forKeyedSubscript: "value" as NSString)
            for script in [
                NativeSettingsStorageBridge.readScript, NativeSettingsStorageBridge.writeScript,
                NativeSettingsStorageBridge.removeScript,
            ] {
                _ = execute(script, in: context)
                #expect(context.exception?.toString()?.contains("Unsupported Settings storage key") == true)
                context.exception = nil
                #expect(context.evaluateScript("calls.length")?.toInt32() == 0)
            }
        }
    }
#endif

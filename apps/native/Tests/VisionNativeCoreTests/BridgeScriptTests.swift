#if canImport(JavaScriptCore)
    import Foundation
    import JavaScriptCore
    import Testing
    @testable import VisionNativeCore

    /// Runs the generated user script in JavaScriptCore with a stub message handler, so a
    /// syntax error or a broken `window.*` object fails here instead of on a Mac at runtime.
    @Suite struct BridgeScriptTests {
        /// A page-like global: `window` is the global object, `addEventListener` records nothing,
        /// and `postMessage` records the body and resolves like `WKScriptMessageHandlerWithReply`.
        static let stub = """
            var window = globalThis;
            var posted = [];
            window.addEventListener = function () {};
            window.setTimeout = function () {};
            window.webkit = {
              messageHandlers: {
                visionNative: {
                  postMessage: function (body) {
                    posted.push(body);
                    return Promise.resolve('{"success":true}');
                  },
                },
              },
            };
            """

        private func makeContext() throws -> JSContext {
            let created: JSContext? = JSContext()
            let context = try #require(created)
            context.evaluateScript(Self.stub)
            #expect(context.exception == nil, "stub: \(String(describing: context.exception))")
            context.evaluateScript(BridgeScript.source)
            #expect(context.exception == nil, "user script: \(String(describing: context.exception))")
            return context
        }

        private func bool(_ context: JSContext, _ expression: String) -> Bool {
            let value = context.evaluateScript(expression)
            #expect(context.exception == nil, "\(expression): \(String(describing: context.exception))")
            context.exception = nil
            return value?.toBool() ?? false
        }

        @Test func everyBridgeExistsWithFunctionMethods() throws {
            let context = try makeContext()
            for bridge in BridgeContract.bridges {
                #expect(bool(context, "typeof window.\(bridge) === 'object' && window.\(bridge) !== null"), "\(bridge)")
                #expect(
                    bool(
                        context,
                        "Object.entries(window.\(bridge)).every(([key, value]) => key === 'platform' || typeof value === 'function')"
                    ), "\(bridge)")
                #expect(bool(context, "Object.isFrozen(window.\(bridge))"), "\(bridge)")
            }
            for entry in BridgeContract.entries {
                guard let method = entry.method else { continue }
                let exposed = bool(context, "typeof window.\(entry.bridge).\(method) === 'function'")
                #expect(exposed == (entry.availability != .removed), "\(entry.bridge).\(method)")
            }
            #expect(bool(context, "window.electronAPI.platform === 'darwin'"))
        }

        @Test func theDispatcherIsNotWritable() throws {
            let context = try makeContext()
            #expect(bool(context, "Object.getOwnPropertyDescriptor(window, '__visionNativeDispatch').writable === false"))
            #expect(bool(context, "Object.getOwnPropertyDescriptor(window, '__visionNativeDispatch').configurable === false"))
            context.evaluateScript("window.__visionNativeDispatch = function () {};")
            context.exception = nil
            #expect(bool(context, "window.__visionNativeDispatch.toString().indexOf('listeners') !== -1"))
        }

        @Test func dispatchedEventsReachSubscribers() throws {
            let context = try makeContext()
            context.evaluateScript(
                """
                var received = [];
                var unsubscribe = window.electronAPI.onMenuAction(function (payload) { received.push(payload); });
                """)
            context.evaluateScript(BridgeDispatcher.eventScript(.menuAction, payload: BridgeDispatcher.menuActionPayload(.navigate("/import"))))
            #expect(bool(context, "received.length === 1 && received[0].action === 'navigate' && received[0].payload === '/import'"))
            context.evaluateScript("unsubscribe();")
            context.evaluateScript(BridgeDispatcher.eventScript(.menuAction, payload: BridgeDispatcher.menuActionPayload(.openSettings)))
            #expect(bool(context, "received.length === 1"))
        }

        @Test func methodsPostTheChannelAndArguments() throws {
            let context = try makeContext()
            context.evaluateScript("window.electronAPI.setDockBadge(3);")
            #expect(bool(context, "posted.length === 1"))
            let body = context.evaluateScript("posted[0]")?.toString()
            #expect(body == #"{"channel":"app:set-badge","args":[3]}"#)
            #expect(BridgeCodec.decode(body) == .request(BridgeRequest(channel: .setBadge, arguments: [.int(3)])))
        }
    }
#endif

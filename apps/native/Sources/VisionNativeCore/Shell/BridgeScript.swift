import Foundation

/// The user script injected at document start in the main frame. It defines the same
/// `window.*` objects, method names and promise semantics as packaging/electron/preload.ts,
/// so the unchanged frontend detects a desktop shell and calls it.
public enum BridgeScript {
    /// The non-enumerable, read-only function the shell calls to deliver events.
    public static let dispatchName = "__visionNativeDispatch"

    /// One `method: (a, b) => invoke("channel", [a, b])` line per exposed entry.
    static func methods(for bridge: String) -> [String] {
        BridgeContract.entries.compactMap { entry -> String? in
            guard entry.bridge == bridge, let method = entry.method else { return nil }
            switch entry.availability {
            case .removed:
                return nil
            case .implemented, .pending, .nativeOnly:
                let parameters = entry.parameters.joined(separator: ", ")
                return "    \(method): (\(parameters)) => invoke(\"\(entry.channel.rawValue)\", [\(parameters)]),"
            }
        }
    }

    static func bridgeObject(_ bridge: String, extra: [String] = []) -> String {
        let lines = methods(for: bridge) + extra
        return "  expose(\"\(bridge)\", {\n\(lines.joined(separator: "\n"))\n  });"
    }

    public static var source: String {
        let electronAPIExtras = [
            "    platform: \"\(BridgeContract.platform)\",",
            // AppLayout leaves the sidebar to the native NavigationSplitView (phase 2).
            "    nativeNavigation: true,",
            "    onAccentColorChanged: subscribe(\"\(BridgeEvent.accentColorChanged.rawValue)\"),",
            "    onMenuAction: subscribe(\"\(BridgeEvent.menuAction.rawValue)\"),",
            "    onCsvOpen: subscribe(\"\(BridgeEvent.csvOpened.rawValue)\"),",
            "    onFullScreenChange: subscribe(\"\(BridgeEvent.fullScreen.rawValue)\"),",
        ]
        let recoveryExtras = [
            "    onBackendLost: subscribe(\"\(BridgeEvent.backendLost.rawValue)\"),",
            "    onBackendRestored: (callback) => subscribe(\"\(BridgeEvent.backendRestored.rawValue)\")(() => callback()),",
        ]
        let objects = [
            bridgeObject("electronUpdater"),
            bridgeObject("electronBackup"),
            bridgeObject("electronAudit"),
            bridgeObject("electronServices"),
            bridgeObject("electronAPI", extra: electronAPIExtras),
            bridgeObject("electronRecovery", extra: recoveryExtras),
        ]
        return prelude + objects.joined(separator: "\n") + "\n" + epilogue
    }

    // Captured before any page script runs, so a page that replaces JSON or the handler
    // cannot change what the bridge sends.
    private static let prelude = """
        (() => {
          "use strict";
          const handlers = window.webkit && window.webkit.messageHandlers;
          const handler = handlers && handlers.\(BridgeContract.messageHandlerName);
          if (!handler) return;
          const post = handler.postMessage.bind(handler);
          const stringify = JSON.stringify;
          const parse = JSON.parse;
          const invoke = (channel, args) =>
            post(stringify({ channel, args })).then((raw) => (typeof raw === "string" ? parse(raw) : null));
          Object.defineProperty(window, "__VISION_NATIVE_SETTINGS__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_PALETTE__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_SHORTCUTS__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_SHELL_NOTIFICATIONS__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true });
          Object.defineProperty(window, "__VISION_NATIVE_ONBOARDING_STATE__", { value: { complete: null, presented: false } });
          Object.defineProperty(window, "__visionNativeOpenOverlay", {
            value: (kind) => invoke("shell:open-overlay", [kind]).then((reply) => {
              if (!reply || reply.success !== true) throw new Error("Could not open native overlay");
            }),
          });
          Object.defineProperty(window, "__VISION_NATIVE_SETTINGS_SNAPSHOT__", { value: Object.create(null) });
          Object.defineProperty(window, "__VISION_NATIVE_SETTINGS_SESSION_TIER__", { value: { value: null } });
          Object.defineProperty(window, "__visionNativeSettingsChange", {
            value: (key, updates, removed) => invoke("shell:settings-change", [key, updates, removed]).then((reply) => {
              if (!reply || reply.success !== true) throw new Error("Could not apply native settings");
            }),
          });
          const listeners = new Map();
          const subscribe = (channel) => (callback) => {
            if (typeof callback !== "function") return () => {};
            let set = listeners.get(channel);
            if (!set) {
              set = new Set();
              listeners.set(channel, set);
            }
            const listener = (payload) => callback(payload);
            set.add(listener);
            return () => {
              set.delete(listener);
            };
          };
          Object.defineProperty(window, "\(dispatchName)", {
            value: (channel, payload) => {
              const set = listeners.get(channel);
              if (!set) return;
              for (const listener of [...set]) {
                try {
                  listener(payload);
                } catch (error) {
                  setTimeout(() => {
                    throw error;
                  });
                }
              }
            },
          });
          const expose = (name, api) => {
            Object.defineProperty(window, name, { value: Object.freeze(api), enumerable: true });
          };

          // preload.ts: report structural failure metadata only, never messages or URLs.
          const property = (value, key) => (typeof value === "object" && value !== null ? value[key] : undefined);
          const failureSource = (event) => {
            const candidate = event.filename || property(event.target, "src") || property(event.target, "href") || "";
            try {
              return new URL(String(candidate)).pathname.split("/").pop() || "unknown";
            } catch {
              return "unknown";
            }
          };
          const reportFailure = (payload) => {
            invoke("\(BridgeChannel.rendererFailure.rawValue)", [payload]).catch(() => {});
          };
          window.addEventListener(
            "error",
            (event) => {
              const targetTag = property(event.target, "tagName");
              const isResource = targetTag === "SCRIPT" || targetTag === "LINK";
              if (event.target && event.target !== window && !isResource) return;
              const errorName = property(event.error, "name");
              reportFailure({
                kind: isResource ? "resource" : "error",
                name: !isResource && typeof errorName === "string" ? errorName : isResource ? "ResourceLoadError" : "UnknownError",
                source: failureSource(event),
                line: Number.isSafeInteger(event.lineno) ? event.lineno : 0,
              });
            },
            true,
          );
          window.addEventListener("unhandledrejection", (event) => {
            const reasonName = property(event.reason, "name");
            reportFailure({
              kind: "unhandledrejection",
              name: typeof reasonName === "string" ? reasonName : "UnhandledRejection",
              source: "unknown",
              line: 0,
            });
          });

          // index.css marks .app-topbar as the drag region (-webkit-app-region: drag) with
          // these controls excluded; WebKit has no app regions, so the shell drags the window.
          window.addEventListener(
            "mousedown",
            (event) => {
              if (event.button !== 0 || !(event.target instanceof Element)) return;
              if (!document.documentElement.classList.contains("electron-mac")) return;
              const bar = event.target.closest(".app-topbar");
              if (!bar || event.target.closest("button, a, input, [role='button'], [role='combobox']")) return;
              const channel = event.detail === 2 ? "\(BridgeChannel.windowTitlebarDoubleClick.rawValue)" : "\(BridgeChannel.windowDrag.rawValue)";
              invoke(channel, []).catch(() => {});
            },
            true,
          );

        """

    private static let epilogue = "})();\n"
}

import Foundation

/// ABI for the dormant, inert helper entry. These fixed scripts are host-private;
/// they add no arbitrary-code RPC and do not replace the existing financial APIs.
public enum NativeHelperDocumentBridge {
    public static let abi = 1
    public static let messageHandlerName = "visionNativeHelper"
    public enum BridgeError: Error, Equatable, Sendable {
        case invalidMessage, invalidReceipt, staleReceipt
    }
    public enum Language: String, Sendable { case en, nl }
    public enum Callback: Equatable, Sendable {
        case ready(NativeHelperDocumentSession.Provenance)
        case failed(NativeHelperDocumentSession.Provenance)
    }
    public enum Command: Equatable, Sendable {
        case bootstrap(Language)
        case locale(Language)
        case dispose
    }
    public enum Receipt: Equatable, Sendable {
        case started(NativeHelperDocumentSession.Provenance)
        case locale(NativeHelperDocumentSession.Provenance, Language)
        case disposed(NativeHelperDocumentSession.Provenance)
    }

    /// Capture the reply-capable handler before entry scripts run. No document
    /// token is read from an event/global and generic electronAPI.ready is unused.
    public static let documentStartScript = """
        (() => {
          'use strict';
          const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.visionNativeHelper;
          if (!handler) return;
          const post = handler.postMessage.bind(handler);
          const stringify = JSON.stringify;
          const parse = JSON.parse;
          const send = (kind, provenance, code) => {
            const message = {abi: 1, kind, documentId: provenance.documentId, generation: provenance.generation};
            if (kind === 'failed') {
              if (code !== 'bootstrap-failed') return Promise.reject(new Error('Invalid helper failure'));
              message.code = code;
            }
            return post(stringify(message)).then(raw => {
              const reply = typeof raw === 'string' ? parse(raw) : null;
              if (!reply || reply.success !== true) throw new Error('Helper acknowledgement rejected');
            });
          };
          // startNativeHelperDocument refuses to start without the two capabilities it serves.
          Object.defineProperty(window, '__VISION_NATIVE_PALETTE__', {value: true});
          Object.defineProperty(window, '__VISION_NATIVE_REPORTS__', {value: true});
          Object.defineProperty(window, '__visionNativeHelperReady', {value: provenance => send('ready', provenance)});
          Object.defineProperty(window, '__visionNativeHelperFailed', {value: (provenance, code) => send('failed', provenance, code)});
        })();
        """

    public static func decodeCallback(_ body: String?) throws -> Callback {
        guard let body, let value = try? JSONValue.parse(Data(body.utf8)),
            let fields = value.objectValue,
            fields["abi"] == .int(abi), let kind = fields["kind"]?.stringValue
        else { throw BridgeError.invalidMessage }
        let base: Set<String> = ["abi", "kind", "documentId", "generation"]
        switch kind {
        case "ready":
            guard Set(fields.keys) == base else { throw BridgeError.invalidMessage }
            return .ready(try provenance(fields, error: .invalidMessage))
        case "failed":
            guard Set(fields.keys) == base.union(["code"]), fields["code"] == .string("bootstrap-failed")
            else { throw BridgeError.invalidMessage }
            return .failed(try provenance(fields, error: .invalidMessage))
        default: throw BridgeError.invalidMessage
        }
    }

    public static func arguments(
        for command: Command, provenance: NativeHelperDocumentSession.Provenance,
        source: NativeHelperDocumentSession.Source
    ) -> [String: JSONValue] {
        var request = fields(provenance)
        switch command {
        case .bootstrap(let language): request["initialLanguage"] = .string(language.rawValue)
        case .locale(let language): request["language"] = .string(language.rawValue)
        case .dispose: break
        }
        return ["request": .object(request), "expectedURL": .string(source.helperURL.absoluteString)]
    }

    public static func script(for command: Command) -> String {
        let name: String
        switch command {
        case .bootstrap: name = "__visionNativeBootstrapHelper"
        case .locale: name = "__visionNativeUpdateHelperLocale"
        case .dispose: name = "__visionNativeDisposeHelper"
        }
        return """
            if (window.location.href !== expectedURL || window.__VISION_NATIVE_HELPER_ABI__ !== 1) {
              throw new Error('Helper document unavailable');
            }
            const operation = window.\(name);
            if (typeof operation !== 'function') throw new Error('Helper operation unavailable');
            return JSON.stringify(await operation(request));
            """
    }

    /// Receipts correlate actual WebKit completion only. The host must still
    /// check its current session/observation after every awaited callback.
    public static func decodeReceipt(
        _ reply: JSONValue, for command: Command,
        provenance expected: NativeHelperDocumentSession.Provenance
    ) throws -> Receipt {
        guard let text = reply.stringValue, let value = try? JSONValue.parse(Data(text.utf8)),
            let fields = value.objectValue, fields["abi"] == .int(abi)
        else { throw BridgeError.invalidReceipt }
        let actual = try provenance(fields, error: .invalidReceipt)
        guard actual == expected else { throw BridgeError.staleReceipt }
        let base: Set<String> = ["abi", "documentId", "generation"]
        switch command {
        case .bootstrap:
            guard Set(fields.keys) == base.union(["started"]), fields["started"] == .bool(true)
            else { throw BridgeError.invalidReceipt }
            return .started(actual)
        case .locale(let language):
            guard Set(fields.keys) == base.union(["language"]),
                fields["language"] == .string(language.rawValue)
            else { throw BridgeError.invalidReceipt }
            return .locale(actual, language)
        case .dispose:
            guard Set(fields.keys) == base.union(["disposed"]), fields["disposed"] == .bool(true)
            else { throw BridgeError.invalidReceipt }
            return .disposed(actual)
        }
    }

    private static func fields(_ provenance: NativeHelperDocumentSession.Provenance) -> [String:
        JSONValue]
    {
        [
            "abi": .int(abi), "documentId": .string(provenance.documentID.uuidString),
            "generation": .string(provenance.generationID.uuidString),
        ]
    }

    private static func provenance(_ fields: [String: JSONValue], error: BridgeError) throws
        -> NativeHelperDocumentSession.Provenance
    {
        guard let rawDocument = fields["documentId"]?.stringValue,
            let document = UUID(uuidString: rawDocument),
            let rawGeneration = fields["generation"]?.stringValue,
            let generation = UUID(uuidString: rawGeneration)
        else { throw error }
        return .init(documentID: document, generationID: generation)
    }
}

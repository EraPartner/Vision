import Foundation

/// Dormant, read-only capture for a future exclusive migration owner. The host
/// must drain physical write callbacks, hold ordinary storage admission paused,
/// and validate its generation/document authority before dispatch and after the
/// actual callback. Echoed identifiers correlate replies; they grant no authority.
public enum NativeRawStateCaptureBridge {
    public enum CaptureError: Error, Equatable, Sendable {
        case invalidRequest, invalidReply, staleRequest, sourceMismatch, unavailable, unstableStorage
    }

    public struct Request: Sendable {
        public let source: NativeRawStateStore.Source
        public let captureID: UUID
        public let documentID: UUID
        public let generationID: UUID
        fileprivate let browserOrigin: String

        public init(
            source: NativeRawStateStore.Source, captureID: UUID, documentID: UUID, generationID: UUID
        ) throws {
            guard let url = URL(string: source.webOrigin),
                let validated = try? NativeRawStateStore.Source(
                    webOrigin: url, storeIdentifier: source.storeIdentifier),
                validated == source,
                var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            else { throw CaptureError.invalidRequest }
            // location.origin omits default ports; the native store retains them.
            if (parts.scheme == "http" && parts.port == 80) || (parts.scheme == "https" && parts.port == 443) {
                parts.port = nil
            }
            guard let browserOrigin = parts.string else { throw CaptureError.invalidRequest }
            self.source = source
            self.captureID = captureID
            self.documentID = documentID
            self.generationID = generationID
            self.browserOrigin = browserOrigin
        }
    }

    public static func arguments(for request: Request) -> [String: JSONValue] {
        [
            "expectedOrigin": .string(request.browserOrigin),
            "storeIdentifier": .string(request.source.storeIdentifier),
            "captureID": .string(request.captureID.uuidString),
            "documentID": .string(request.documentID.uuidString),
            "generationID": .string(request.generationID.uuidString),
        ]
    }

    /// Fixed host-private script; no renderer RPC, mutations or supplied code.
    /// The website-data-store identity is supplied by the trusted host, not
    /// independently verified by JavaScript. All local keys are retained; the
    /// backup registry is deliberately insufficient for a complete migration.
    public static var script: String {
        let keys = try! JSONEncoder().encode(NativeRawStateStore.SessionKey.allCases.map(\.rawValue))
        let sessionKeys = String(decoding: keys, as: UTF8.self)
        return """
            const unstable = {};
            const receipt = (status, details = {}) => JSON.stringify({
                version: 1, status, captureID, documentID, generationID, ...details
            });
            const sessionKeys = \(sessionKeys);
            const readLocal = () => {
                const storage = window.localStorage;
                const count = storage.length;
                if (!Number.isInteger(count) || count < 0) throw unstable;
                const values = Object.create(null);
                for (let index = 0; index < count; index++) {
                    const key = storage.key(index);
                    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(values, key)) throw unstable;
                    const value = storage.getItem(key);
                    if (typeof value !== 'string') throw unstable;
                    values[key] = value;
                }
                if (storage.length !== count) throw unstable;
                return values;
            };
            const readSession = () => {
                const storage = window.sessionStorage;
                const values = Object.create(null);
                for (const key of sessionKeys) {
                    const value = storage.getItem(key);
                    if (value !== null && typeof value !== 'string') throw unstable;
                    values[key] = value;
                }
                return values;
            };
            const same = (left, right) => {
                const keys = Object.keys(left);
                return keys.length === Object.keys(right).length && keys.every(key =>
                    Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
            };
            try {
                const origin = window.location.origin;
                if (origin !== expectedOrigin) return receipt('wrong-source');
                const localValues = readLocal();
                const sessionValues = readSession();
                if (!same(localValues, readLocal()) || !same(sessionValues, readSession())) return receipt('unstable');
                if (window.location.origin !== origin) return receipt('wrong-source');
                return receipt('complete', {
                    source: {webOrigin: origin, storeIdentifier}, localValues, sessionValues
                });
            } catch (error) {
                return receipt(error === unstable ? 'unstable' : 'unavailable');
            }
            """
    }

    /// Missing, malformed, partial, foreign or stale replies cannot initialize a
    /// store. A successful empty map must be explicit and complete. The caller
    /// must still check current host authority after the physical callback.
    public static func decodeReply(_ reply: JSONValue, for request: Request) throws
        -> NativeRawStateStore.MigrationCapture
    {
        if reply == .null { throw CaptureError.unavailable }
        guard case .string(let text) = reply,
            let value = try? JSONValue.parse(Data(text.utf8)),
            let fields = value.objectValue,
            fields["version"] == .int(1), let status = fields["status"]?.stringValue
        else { throw CaptureError.invalidReply }
        for (key, expected) in [
            ("captureID", request.captureID), ("documentID", request.documentID),
            ("generationID", request.generationID),
        ] {
            guard let raw = fields[key]?.stringValue, let identifier = UUID(uuidString: raw) else {
                throw CaptureError.invalidReply
            }
            guard identifier == expected else { throw CaptureError.staleRequest }
        }
        let receiptKeys: Set<String> = ["version", "status", "captureID", "documentID", "generationID"]
        if status != "complete" {
            guard Set(fields.keys) == receiptKeys else { throw CaptureError.invalidReply }
            switch status {
            case "unavailable": throw CaptureError.unavailable
            case "unstable": throw CaptureError.unstableStorage
            case "wrong-source": throw CaptureError.sourceMismatch
            default: throw CaptureError.invalidReply
            }
        }
        guard Set(fields.keys) == receiptKeys.union(["source", "localValues", "sessionValues"]),
            let source = fields["source"]?.objectValue, Set(source.keys) == ["webOrigin", "storeIdentifier"],
            let origin = source["webOrigin"]?.stringValue, let url = URL(string: origin),
            let store = source["storeIdentifier"]?.stringValue,
            let actual = try? NativeRawStateStore.Source(webOrigin: url, storeIdentifier: store)
        else { throw CaptureError.invalidReply }
        guard actual == request.source else { throw CaptureError.sourceMismatch }
        guard let local = fields["localValues"]?.objectValue,
            let session = fields["sessionValues"]?.objectValue,
            Set(session.keys) == Set(NativeRawStateStore.SessionKey.allCases.map(\.rawValue))
        else { throw CaptureError.invalidReply }
        var localValues: [String: String] = [:]
        for (key, value) in local {
            guard case .string(let raw) = value else { throw CaptureError.invalidReply }
            localValues[key] = raw
        }
        var sessionValues: [NativeRawStateStore.SessionKey: String] = [:]
        for key in NativeRawStateStore.SessionKey.allCases {
            guard let value = session[key.rawValue] else { throw CaptureError.invalidReply }
            if value == .null { continue }
            guard case .string(let raw) = value else { throw CaptureError.invalidReply }
            sessionValues[key] = raw
        }
        return .init(
            source: request.source, identifier: request.captureID, status: .complete,
            localValues: localValues, sessionValues: sessionValues)
    }
}

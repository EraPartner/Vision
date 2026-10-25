import Foundation
import Testing

@testable import VisionNativeCore

#if canImport(JavaScriptCore)
    import JavaScriptCore
#endif

@Suite struct NativeRawStateCaptureBridgeTests {
    private func request(origin: String = "http://127.0.0.1:43123", store: String = "synthetic-wk-default") throws
        -> NativeRawStateCaptureBridge.Request
    {
        try .init(
            source: .init(webOrigin: URL(string: origin)!, storeIdentifier: store),
            captureID: UUID(), documentID: UUID(), generationID: UUID())
    }
    private func envelope(
        _ request: NativeRawStateCaptureBridge.Request, local: [String: JSONValue] = [:],
        sessions: [String: JSONValue]? = nil
    ) -> [String: JSONValue] {
        [
            "version": .int(1), "status": .string("complete"),
            "captureID": .string(request.captureID.uuidString), "documentID": .string(request.documentID.uuidString),
            "generationID": .string(request.generationID.uuidString),
            "source": .object([
                "webOrigin": .string(request.source.webOrigin),
                "storeIdentifier": .string(request.source.storeIdentifier),
            ]),
            "localValues": .object(local),
            "sessionValues": .object(
                sessions
                    ?? Dictionary(
                        uniqueKeysWithValues: NativeRawStateStore.SessionKey.allCases.map { ($0.rawValue, .null) })),
        ]
    }
    private func reply(_ fields: [String: JSONValue]) throws -> JSONValue {
        .string(String(decoding: try JSONEncoder().encode(JSONValue.object(fields)), as: UTF8.self))
    }
    private func receipt(_ request: NativeRawStateCaptureBridge.Request, status: String) -> [String: JSONValue] {
        envelope(request).filter { !["source", "localValues", "sessionValues"].contains($0.key) }
            .merging(["status": .string(status)]) { _, replacement in replacement }
    }

    @Test func completeCapturePreservesExactRawLocalAndSessionPresence() throws {
        let request = try request()
        let raw = "quotes \" \\ \n \u{2028}; malformed { JSON"
        var values = envelope(
            request, local: ["": .string(""), "__proto__": .string(raw), "future-key": .string("null")])
        var sessions = try #require(values["sessionValues"]?.objectValue)
        sessions[NativeRawStateStore.SessionKey.adminToken.rawValue] = .string("")
        sessions[NativeRawStateStore.SessionKey.portfolioSession.rawValue] = .string("null")
        values["sessionValues"] = .object(sessions)
        let capture = try NativeRawStateCaptureBridge.decodeReply(reply(values), for: request)
        #expect(capture.status == .complete && capture.identifier == request.captureID)
        #expect(capture.source == request.source)
        #expect(capture.localValues == ["": "", "__proto__": raw, "future-key": "null"])
        #expect(capture.sessionValues[.adminToken] == "")
        #expect(capture.sessionValues[.portfolioSession] == "null")
        #expect(capture.sessionValues[.portfolioReview] == nil)
        let empty = try NativeRawStateCaptureBridge.decodeReply(reply(envelope(request)), for: request)
        #expect(empty.localValues.isEmpty && empty.sessionValues.isEmpty)
    }

    @Test func unavailableMalformedAndPartialRepliesNeverBecomeEmptyCaptures() throws {
        let request = try request()
        for value in [JSONValue.bool(false), .string("null"), .string("{broken"), .string("{}")] {
            #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
                _ = try NativeRawStateCaptureBridge.decodeReply(value, for: request)
            }
        }
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.unavailable) {
            _ = try NativeRawStateCaptureBridge.decodeReply(.null, for: request)
        }
        for (status, error) in [
            ("unavailable", NativeRawStateCaptureBridge.CaptureError.unavailable),
            ("unstable", .unstableStorage), ("wrong-source", .sourceMismatch), ("partial", .invalidReply),
        ] {
            #expect(throws: error) {
                _ = try NativeRawStateCaptureBridge.decodeReply(reply(receipt(request, status: status)), for: request)
            }
        }
        for key in ["source", "localValues", "sessionValues", "documentID", "status", "version"] {
            var fields = envelope(request)
            fields.removeValue(forKey: key)
            #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
                _ = try NativeRawStateCaptureBridge.decodeReply(reply(fields), for: request)
            }
        }
        var foreignField = envelope(request)
        foreignField["unexpected"] = .string("ignored would be unsafe")
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
            _ = try NativeRawStateCaptureBridge.decodeReply(reply(foreignField), for: request)
        }
    }

    @Test func eachRequestIdentityAndSourceMustMatchBeforeMigrationCanBeAccepted() throws {
        let request = try request()
        for key in ["captureID", "documentID", "generationID"] {
            var fields = envelope(request)
            fields[key] = .string(UUID().uuidString)
            #expect(throws: NativeRawStateCaptureBridge.CaptureError.staleRequest) {
                _ = try NativeRawStateCaptureBridge.decodeReply(reply(fields), for: request)
            }
        }
        for source in [
            JSONValue.object([
                "webOrigin": .string("http://127.0.0.1:43124"),
                "storeIdentifier": .string(request.source.storeIdentifier),
            ]),
            .object(["webOrigin": .string(request.source.webOrigin), "storeIdentifier": .string("foreign-wk-store")]),
        ] {
            var fields = envelope(request)
            fields["source"] = source
            #expect(throws: NativeRawStateCaptureBridge.CaptureError.sourceMismatch) {
                _ = try NativeRawStateCaptureBridge.decodeReply(reply(fields), for: request)
            }
        }
    }

    @Test func strictRawValueTypesAndExactlyFourSessionKeysAreRequired() throws {
        let request = try request()
        for invalid in [JSONValue.null, .bool(false), .int(1), .array([]), .object([:])] {
            #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
                _ = try NativeRawStateCaptureBridge.decodeReply(
                    reply(envelope(request, local: ["future": invalid])), for: request)
            }
        }
        var session = Dictionary(
            uniqueKeysWithValues: NativeRawStateStore.SessionKey.allCases.map { ($0.rawValue, JSONValue.null) })
        session.removeValue(forKey: NativeRawStateStore.SessionKey.adminToken.rawValue)
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
            _ = try NativeRawStateCaptureBridge.decodeReply(reply(envelope(request, sessions: session)), for: request)
        }
        session[NativeRawStateStore.SessionKey.adminToken.rawValue] = .int(1)
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
            _ = try NativeRawStateCaptureBridge.decodeReply(reply(envelope(request, sessions: session)), for: request)
        }
        session[NativeRawStateStore.SessionKey.adminToken.rawValue] = .null
        session["unregistered-session"] = .null
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidReply) {
            _ = try NativeRawStateCaptureBridge.decodeReply(reply(envelope(request, sessions: session)), for: request)
        }
    }

    @Test func defaultPortsUseBrowserCanonicalOriginsAndOpaqueOriginsCannotFormRequests() throws {
        for (origin, expected) in [
            ("http://localhost:80", "http://localhost"), ("https://localhost:443", "https://localhost"),
            ("http://localhost:43123", "http://localhost:43123"),
        ] {
            let request = try request(origin: origin)
            #expect(NativeRawStateCaptureBridge.arguments(for: request)["expectedOrigin"] == .string(expected))
            var fields = envelope(request)
            fields["source"] = .object([
                "webOrigin": .string(expected), "storeIdentifier": .string(request.source.storeIdentifier),
            ])
            #expect(try NativeRawStateCaptureBridge.decodeReply(reply(fields), for: request).source == request.source)
        }
        let invalid = try JSONDecoder().decode(
            NativeRawStateStore.Source.self, from: Data(#"{"webOrigin":"null","storeIdentifier":"synthetic"}"#.utf8))
        #expect(throws: NativeRawStateCaptureBridge.CaptureError.invalidRequest) {
            _ = try NativeRawStateCaptureBridge.Request(
                source: invalid, captureID: UUID(), documentID: UUID(), generationID: UUID())
        }
    }

    @Test func completeLiveKeyCaptureMigratesUnknownValuesButBackupStillUsesItsOriginalSubset() async throws {
        let request = try request()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vision-capture-test-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("synthetic-state.json")
        var local = Dictionary(
            uniqueKeysWithValues: NativeRawStateStore.LocalKey.allCases.map {
                ($0.rawValue, JSONValue.string("raw:" + $0.rawValue))
            })
        local["future-unknown"] = .string("{malformed draft preserved")
        local["__proto__"] = .string("raw prototype-looking key")
        let capture = try NativeRawStateCaptureBridge.decodeReply(reply(envelope(request, local: local)), for: request)
        let store = try NativeRawStateStore(persistenceURL: url, source: request.source)
        try await store.migrate(capture)
        let backup = try await store.backupSnapshot()
        #expect(Set(backup.keys.keys) == Set(NativeSettingsStorageBridge.knownKeys))
        #expect(backup.keys.count == 15 && capture.localValues.count == 19)
        #expect(try await store.value(for: .fxDismissedAt) == "raw:fx-status-banner-dismissed-at")
        let document = try JSONValue.parse(Data(contentsOf: url))
        #expect(document["localValues"]?["future-unknown"] == .string("{malformed draft preserved"))
        #expect(document["localValues"]?["__proto__"] == .string("raw prototype-looking key"))
    }

    #if canImport(JavaScriptCore)
        @MainActor private func context(_ request: NativeRawStateCaptureBridge.Request) throws -> JSContext {
            let context = try #require(JSContext())
            context.evaluateScript(Self.fixture)
            for (key, value) in NativeRawStateCaptureBridge.arguments(for: request) {
                context.setObject(try #require(value.stringValue), forKeyedSubscript: key as NSString)
            }
            #expect(context.exception == nil)
            return context
        }
        @MainActor private func execute(_ context: JSContext) throws -> JSONValue {
            let result = context.evaluateScript("(function(){\n\(NativeRawStateCaptureBridge.script)\n})()")
            #expect(context.exception == nil)
            return .string(try #require(result?.toString()))
        }
        @MainActor @Test func actualScriptRetainsUnknownPrototypeLookingKeysAndRawSessionValuesWithoutWrites() throws {
            let request = try request()
            let context = try context(request)
            let capture = try NativeRawStateCaptureBridge.decodeReply(execute(context), for: request)
            #expect(capture.localValues == ["": "", "__proto__": "raw", "future": "null", "draft": "{malformed"])
            #expect(capture.sessionValues[.adminToken] == "synthetic-token")
            #expect(capture.sessionValues[.portfolioSession] == "")
            #expect(capture.sessionValues[.portfolioReview] == "null")
            #expect(capture.sessionValues[.dashboardArrival] == nil)
            #expect(context.evaluateScript("sessionReads.length")?.toInt32() == 8)
            #expect(context.evaluateScript("writes")?.toInt32() == 0)
        }
        @MainActor @Test func actualScriptRejectsForeignAndOpaqueOriginsBeforeAnyStorageAccess() throws {
            let request = try request()
            for origin in ["null", "http://127.0.0.1:43124", "https://127.0.0.1:43123"] {
                let context = try context(request)
                context.setObject(origin, forKeyedSubscript: "foreignOrigin" as NSString)
                context.evaluateScript("window.location.origin = foreignOrigin")
                #expect(throws: NativeRawStateCaptureBridge.CaptureError.sourceMismatch) {
                    _ = try NativeRawStateCaptureBridge.decodeReply(execute(context), for: request)
                }
                #expect(context.evaluateScript("storageAccesses")?.toInt32() == 0)
            }
        }
        @MainActor @Test func actualStorageFailureAndChangingValuesNeverProducePartialCaptures() throws {
            let request = try request()
            for (flag, error) in [
                ("failLocal", NativeRawStateCaptureBridge.CaptureError.unavailable), ("failSession", .unavailable),
                ("changeLocal", .unstableStorage), ("changeSession", .unstableStorage),
                ("missingLocal", .unstableStorage),
            ] {
                let context = try context(request)
                context.evaluateScript(flag + " = true")
                let result = try execute(context)
                #expect(throws: error) { _ = try NativeRawStateCaptureBridge.decodeReply(result, for: request) }
                let body = try JSONValue.parse(Data(try #require(result.stringValue).utf8))
                #expect(body["localValues"] == nil && body["sessionValues"] == nil)
                #expect(context.evaluateScript("writes")?.toInt32() == 0)
            }
        }
    #endif

    // Reused verbatim by the external Bun proof with the exact Swift-emitted script.
    static let fixture = #"""
        var localValues = Object.assign(Object.create(null), {'': '', future: 'null', draft: '{malformed'});
        localValues['__proto__'] = 'raw';
        var sessionValues = Object.assign(Object.create(null), {
            'vision.adminToken': 'synthetic-token', 'vision.portfolio-import.latest-session.v1': '',
            'vision.portfolio-import.latest-review-settings.v1': 'null'
        });
        var storageAccesses = 0, localReads = 0, sessionReads = [], writes = 0;
        var failLocal = false, failSession = false, changeLocal = false, changeSession = false, missingLocal = false;
        var window = {location: {origin: 'http://127.0.0.1:43123'}};
        Object.defineProperty(window, 'localStorage', {get() {
            storageAccesses++;
            if (failLocal) throw Error('restricted synthetic local storage');
            return {
                get length() { return Object.keys(localValues).length; },
                key(index) { return Object.keys(localValues)[index] ?? null; },
                getItem(key) {
                    localReads++;
                    if (missingLocal) return null;
                    if (changeLocal && localReads > Object.keys(localValues).length) return 'changed';
                    return Object.hasOwn(localValues, key) ? localValues[key] : null;
                },
                setItem() { writes++; throw Error('capture must not write'); },
                removeItem() { writes++; throw Error('capture must not write'); },
                clear() { writes++; throw Error('capture must not write'); }
            };
        }});
        Object.defineProperty(window, 'sessionStorage', {get() {
            storageAccesses++;
            if (failSession) throw Error('restricted synthetic session storage');
            return {
                getItem(key) {
                    sessionReads.push(key);
                    if (changeSession && sessionReads.length > 4) return 'changed';
                    return Object.hasOwn(sessionValues, key) ? sessionValues[key] : null;
                },
                setItem() { writes++; throw Error('capture must not write'); },
                removeItem() { writes++; throw Error('capture must not write'); },
                clear() { writes++; throw Error('capture must not write'); }
            };
        }});
        """#
}

import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct NativeHelperDocumentBridgeTests {
    typealias Bridge = NativeHelperDocumentBridge
    typealias Provenance = NativeHelperDocumentSession.Provenance

    private let provenance = Provenance(documentID: UUID(), generationID: UUID())

    private func fields(_ candidate: Provenance) -> [String: JSONValue] {
        [
            "abi": .int(1), "documentId": .string(candidate.documentID.uuidString),
            "generation": .string(candidate.generationID.uuidString),
        ]
    }

    private func text(_ fields: [String: JSONValue]) throws -> String {
        String(decoding: try JSONValue.object(fields).serialized(), as: UTF8.self)
    }

    @Test func callbacksHaveExactABIAndStructuralFailureOnly() throws {
        var body = fields(provenance)
        body["kind"] = .string("ready")
        #expect(try Bridge.decodeCallback(text(body)) == .ready(provenance))
        body["kind"] = .string("failed")
        body["code"] = .string("bootstrap-failed")
        #expect(try Bridge.decodeCallback(text(body)) == .failed(provenance))
        for invalid: [String: JSONValue] in [
            ["kind": .string("ready")], ["abi": .int(2)], ["code": .string("arbitrary-error")],
            ["error": .string("private text")], ["documentId": .string("not-a-uuid")],
            ["generation": .null],
        ] {
            let malformed = body.merging(invalid) { _, new in new }
            #expect(throws: Bridge.BridgeError.invalidMessage) {
                try Bridge.decodeCallback(text(malformed))
            }
        }
        for raw in [
            nil, "null", "[]", "false", "{}", "invalid",
            "{\"channel\":\"app:renderer-ready\",\"args\":[]}",
        ] {
            #expect(throws: Bridge.BridgeError.invalidMessage) { try Bridge.decodeCallback(raw) }
        }
    }

    @Test func receiptsRequireExactShapeCommandAndIssuedTuple() throws {
        let started = fields(provenance).merging(["started": .bool(true)]) { _, new in new }
        #expect(
            try Bridge.decodeReceipt(.string(text(started)), for: .bootstrap(.en), provenance: provenance)
                == .started(provenance))
        let locale = fields(provenance).merging(["language": .string("nl")]) { _, new in new }
        #expect(
            try Bridge.decodeReceipt(.string(text(locale)), for: .locale(.nl), provenance: provenance)
                == .locale(provenance, .nl))
        let disposed = fields(provenance).merging(["disposed": .bool(true)]) { _, new in new }
        #expect(
            try Bridge.decodeReceipt(.string(text(disposed)), for: .dispose, provenance: provenance)
                == .disposed(provenance))
        for raw in [JSONValue.null, .object(started), .string("{}"), .string(try text(locale))] {
            #expect(throws: Bridge.BridgeError.invalidReceipt) {
                try Bridge.decodeReceipt(raw, for: .bootstrap(.en), provenance: provenance)
            }
        }
        for invalid in [["started": JSONValue.bool(false)], ["unknown": .null], ["abi": .int(2)]] {
            let body = started.merging(invalid) { _, new in new }
            #expect(throws: Bridge.BridgeError.invalidReceipt) {
                try Bridge.decodeReceipt(.string(text(body)), for: .bootstrap(.en), provenance: provenance)
            }
        }
        #expect(throws: Bridge.BridgeError.invalidReceipt) {
            try Bridge.decodeReceipt(.string(text(locale)), for: .locale(.en), provenance: provenance)
        }
        let replacement = Provenance(documentID: UUID(), generationID: provenance.generationID)
        #expect(throws: Bridge.BridgeError.staleReceipt) {
            try Bridge.decodeReceipt(
                .string(text(started)), for: .bootstrap(.en), provenance: replacement)
        }
    }

    @Test func commandsBindIdentityLocaleAndSourceWithoutInterpolatingThemIntoCode() throws {
        let source = try NativeHelperDocumentSession.Source(
            isDebugBuild: true, rawVariant: "demo",
            supervisorReceipt: .init(
                runtimeIdentifier: "vision_native_demo",
                backendOrigin: URL(string: "http://127.0.0.1:49123")!),
            websiteDataStoreIdentifier: "expected-store")
        for (command, operation, added): (Bridge.Command, String, [String: JSONValue]) in [
            (.bootstrap(.en), "__visionNativeBootstrapHelper", ["initialLanguage": .string("en")]),
            (.locale(.nl), "__visionNativeUpdateHelperLocale", ["language": .string("nl")]),
            (.dispose, "__visionNativeDisposeHelper", [:]),
        ] {
            let arguments = Bridge.arguments(for: command, provenance: provenance, source: source)
            #expect(
                arguments == [
                    "expectedURL": .string(source.helperURL.absoluteString),
                    "request": .object(fields(provenance).merging(added) { _, new in new }),
                ])
            let script = Bridge.script(for: command)
            #expect(script.contains("window.\(operation)"))
            #expect(!script.contains(provenance.documentID.uuidString))
            #expect(!script.contains(provenance.generationID.uuidString))
            #expect(!script.contains(source.helperURL.absoluteString))
        }
        #expect(Bridge.documentStartScript.contains("const post = handler.postMessage.bind(handler)"))
        #expect(!Bridge.documentStartScript.contains("electronAPI"))
        // nativeHelperDocument.ts throws "Missing native helper capabilities" without these.
        #expect(Bridge.documentStartScript.contains("Object.defineProperty(window, '__VISION_NATIVE_PALETTE__', {value: true})"))
        #expect(Bridge.documentStartScript.contains("Object.defineProperty(window, '__VISION_NATIVE_REPORTS__', {value: true})"))
        #expect(!Bridge.documentStartScript.contains("app:renderer-ready"))
    }
}

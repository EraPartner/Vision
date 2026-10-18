import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Chart share and storage bridge boundaries")
struct ResearchChartBridgeTests {
    @Test func validLargeChartSharesRemainBoundedToTheChartRoute() throws {
        let token = String(repeating: "A", count: 20_000)
        let route = try #require(NativeRoute("/research/charts?chart=" + token + "&unrelated=keep"))
        #expect(route.value("chart") == token)
        #expect(route.value("unrelated") == "keep")
        #expect(NativeRoute("/research/compare?chart=" + token) == nil)
        #expect(NativeRoute("/research/charts/extra?chart=" + token) == nil)
        #expect(NativeRoute("//research/charts?chart=" + token) == nil)
        #expect(NativeRoute("/research/charts?chart=" + token + "#fragment") == nil)
        #expect(NativeRoute("/research/charts?chart=" + String(repeating: "A", count: 32_768)) == nil)
    }

    @Test func missingStorageIsDistinctFromAnUnavailableRead() throws {
        #expect(try ResearchChartStorageBridge.readReply(#"{"ok":true,"value":null}"#) == nil)
        #expect(throws: APIError.backendUnavailable) {
            try ResearchChartStorageBridge.readReply(#"{"ok":false}"#)
        }
        #expect(throws: APIError.self) {
            try ResearchChartStorageBridge.readReply(#"{"ok":true,"value":42}"#)
        }
        #expect(throws: APIError.self) {
            try ResearchChartStorageBridge.readReply(#"{"ok":true}"#)
        }
    }

    @Test func storageReturnsOriginalTextAndEnforcesTheSourceUTF8WriteBound() throws {
        let value = #"{"version":2,"draft":{"label":"Synthetic €","unknown":null}}"#
        let envelope = try JSONValue.object(["ok": .bool(true), "value": .string(value)]).serialized()
        #expect(try ResearchChartStorageBridge.readReply(String(decoding: envelope, as: UTF8.self)) == value)
        #expect(try ResearchChartStorageBridge.writeValue(Data(value.utf8)) == value)
        #expect(try ResearchChartStorageBridge.writeValue(Data(repeating: 65, count: 250_000)).utf8.count == 250_000)
        #expect(throws: APIError.self) {
            try ResearchChartStorageBridge.writeValue(Data(repeating: 65, count: 250_001))
        }
        #expect(throws: APIError.self) { try ResearchChartStorageBridge.writeValue(Data([0xFF])) }
    }
}

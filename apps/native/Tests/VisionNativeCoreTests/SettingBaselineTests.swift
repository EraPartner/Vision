import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct SettingBaselineTests {
    @Test func anAbsentSettingRoundTripsThroughJSON() throws {
        let json: JSONValue = .object(["exists": .bool(false)])
        let baseline = try OpenAPI.SettingBaseline(json: json)
        #expect(baseline.json == json)
        let data = try JSONEncoder().encode(baseline)
        #expect(try JSONDecoder().decode(OpenAPI.SettingBaseline.self, from: data) == baseline)
    }

    @Test func aPresentSettingKeepsItsValue() throws {
        let json: JSONValue = .object([
            "exists": .bool(true), "value": .object(["rate": .string("1.5")]),
        ])
        let baseline = try OpenAPI.SettingBaseline(json: json)
        #expect(baseline.json == json)
        let data = try JSONEncoder().encode(baseline)
        #expect(try JSONDecoder().decode(OpenAPI.SettingBaseline.self, from: data) == baseline)
    }

    @Test func existsTrueWithoutAValueIsRejected() {
        #expect(throws: APIError.self) {
            _ = try OpenAPI.SettingBaseline(json: .object(["exists": .bool(true)]))
        }
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                OpenAPI.SettingBaseline.self, from: Data(#"{"exists":true}"#.utf8))
        }
    }

    @Test func aBaselineWithoutABooleanExistsIsRejected() {
        #expect(throws: APIError.self) {
            _ = try OpenAPI.SettingBaseline(json: .object(["exists": .string("yes")]))
        }
        #expect(throws: APIError.self) {
            _ = try OpenAPI.SettingBaseline(json: .null)
        }
    }
}

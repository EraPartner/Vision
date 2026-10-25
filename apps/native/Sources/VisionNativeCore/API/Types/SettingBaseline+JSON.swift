import Foundation

/// The concurrency baseline of a setting (`{ exists: false }` or `{ exists: true, value }`) as the
/// JSON the settings screens keep between a read and the save that carries it back.
extension OpenAPI.SettingBaseline {
    /// The baseline as JSON, exactly the two shapes the API defines.
    public var json: JSONValue {
        switch self {
        case .existsFalse:
            return .object(["exists": .bool(false)])
        case .existsTrue(let present):
            return .object(["exists": .bool(true), "value": present.value])
        }
    }

    /// The typed baseline of JSON read from a setting; throws unless it is one of the two shapes
    /// (a boolean `exists`, and a `value` when it is `true`).
    public init(json: JSONValue) throws {
        guard let exists = json["exists"]?.boolValue else {
            throw APIError.invalidRequest("Setting baseline requires boolean exists")
        }
        if !exists {
            self = .existsFalse(.init(exists: false))
            return
        }
        guard let value = json["value"] else {
            throw APIError.invalidRequest("Setting baseline with exists true requires value")
        }
        self = .existsTrue(.init(exists: true, value: value))
    }
}

import Foundation
import Security

/// The independent checkpoint store (`AuditWitness` in `audit-anchor.ts`).
public protocol AuditWitness: Sendable {
    /// The stored value parsed as JSON, `nil` when there is none.
    func read() async throws -> JSONValue?
    /// Throws `audit_witness_already_exists` when an item exists.
    func create(_ value: AuditWitnessValue) async throws
    func replace(_ value: AuditWitnessValue) async throws
}

/// The error vocabulary of `audit-keychain.ts` (`audit_witness_unavailable`,
/// `audit_witness_invalid`, `audit_witness_already_exists`).
public struct AuditWitnessError: Error, Equatable, Sendable, LocalizedError {
    public let code: String

    public init(_ code: String) {
        self.code = code
    }

    public static let unavailable = AuditWitnessError("audit_witness_unavailable")
    public static let invalid = AuditWitnessError("audit_witness_invalid")
    public static let alreadyExists = AuditWitnessError("audit_witness_already_exists")

    public var errorDescription: String? { code }
}

/// The Keychain witness of `audit-keychain.ts` and `audit-keychain.swift`, called through
/// the Security framework in-process instead of through the helper executable. The item is
/// a generic password with the service `com.vaultvoyager.<runtime>.audit-witness` and the
/// account `latest-checkpoint`; its data is the witness JSON, at most 8 KiB.
public struct KeychainAuditWitness: AuditWitness {
    public static let account = "latest-checkpoint"
    public static let maximumBytes = 8192
    public let service: String

    public init(service: String) {
        self.service = service
    }

    /// `createKeychainWitness`' service name: the runtime id with underscores turned into
    /// hyphens. Electron Vision is `com.vaultvoyager.vision.audit-witness` and Vision Demo
    /// `com.vaultvoyager.vision-demo.audit-witness`.
    public static func service(runtimeId: String) -> String {
        "com.vaultvoyager.\(runtimeId.replacingOccurrences(of: "_", with: "-")).audit-witness"
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    public func read() async throws -> JSONValue? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= Self.maximumBytes else {
            throw AuditWitnessError.unavailable
        }
        guard let parsed = try? JSONValue.parse(data) else { throw AuditWitnessError.invalid }
        return parsed
    }

    private func payload(_ value: AuditWitnessValue) throws -> Data {
        let data = Data(value.serialized.utf8)
        guard !data.isEmpty, data.count <= Self.maximumBytes else { throw AuditWitnessError.unavailable }
        return data
    }

    public func create(_ value: AuditWitnessValue) async throws {
        var item = query
        item[kSecValueData as String] = try payload(value)
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem { throw AuditWitnessError.alreadyExists }
        guard status == errSecSuccess else { throw AuditWitnessError.unavailable }
    }

    public func replace(_ value: AuditWitnessValue) async throws {
        let data = try payload(value)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecSuccess else { throw AuditWitnessError.unavailable }
    }
}

import Foundation
import Security

// The checkpoint crosses this process boundary on stdin, never in argv.
// A test keychain path is accepted only when explicitly supplied by a test.
guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 4,
      ["read", "create", "replace"].contains(CommandLine.arguments[1]),
      CommandLine.arguments[2].range(of: #"^com\.vaultvoyager\.vision(?:-demo)?\.audit-witness$"#, options: .regularExpression) != nil else {
    exit(64)
}

let operation = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: "latest-checkpoint"
]

if CommandLine.arguments.count == 4 {
    var keychain: SecKeychain?
    let status = SecKeychainOpen(CommandLine.arguments[3], &keychain)
    guard status == errSecSuccess, let keychain else { exit(73) }
    query[kSecUseKeychain as String] = keychain
    query[kSecMatchSearchList as String] = [keychain]
}

if operation == "read" {
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(2) }
    guard status == errSecSuccess, let data = result as? Data else { exit(74) }
    FileHandle.standardOutput.write(data)
    exit(0)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard !data.isEmpty, data.count <= 8192 else { exit(65) }
if operation == "create" {
    query[kSecValueData as String] = data
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem { exit(3) }
    exit(status == errSecSuccess ? 0 : 74)
}

let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
if status == errSecItemNotFound { exit(2) }
exit(status == errSecSuccess ? 0 : 74)

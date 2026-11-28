import Foundation

/// The SSRF guard of `apps/node-backend/src/lib/urlSafety.ts`: a URL the backend fetches on a
/// user's behalf may only be http(s), carry no credentials, and every host literal or resolved
/// DNS address must be public.
enum URLSafety {
    /// `BlockedUrlError`.
    struct Blocked: Error, Sendable {
        let message: String
    }

    /// `ALLOWED_PROTOCOLS`.
    private static let allowedProtocols: Set<String> = ["http", "https"]

    /// `parseIpv4Octets` + `isOctetQuad`: four integers 0–255, nil otherwise.
    private static func ipv4Octets(_ ip: String) -> [Int]? {
        let raw = ip.split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard ip.split(separator: ".", omittingEmptySubsequences: false).count == 4,
            raw.count == 4
        else { return nil }
        let octets = raw
        guard octets.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return nil }
        return octets
    }

    /// `isBlockedIpv4` — unparseable fails closed.
    static func isBlockedIPv4(_ ip: String) -> Bool {
        guard let o = ipv4Octets(ip) else { return true }
        let a = o[0]
        let b = o[1]
        if a == 0 { return true }
        if a == 10 { return true }
        if a == 127 { return true }
        if a == 169 && b == 254 { return true }
        if a == 172 && (16...31).contains(b) { return true }
        if a == 192 && b == 168 { return true }
        if a == 100 && (64...127).contains(b) { return true }
        return false
    }

    /// `net.isIP` as a kind: 4, 6 or 0 (not an IP literal). A valid IPv4 is four dotted integers;
    /// an IPv6 contains at least one `:`.
    static func ipKind(_ host: String) -> Int {
        if ipv4Octets(host) != nil { return 4 }
        if host.contains(":") { return 6 }
        return 0
    }

    /// `isBlockedIpv6` — loopback, unspecified, IPv4-mapped, ULA and link-local are blocked.
    /// The rules apply to the parsed 16 bytes, so every spelling of one address (`::1`,
    /// `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, upper case) gets the same answer. An address that
    /// does not parse fails closed.
    static func isBlockedIPv6(_ ip: String) -> Bool {
        let addr = ip.split(separator: "%", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard let bytes = ipv6Bytes(addr) else { return true }
        let head = bytes[0..<10].allSatisfy { $0 == 0 }
        // ::/128 unspecified and ::1/128 loopback.
        if head && bytes[10] == 0 && bytes[11] == 0 && bytes[12] == 0 && bytes[13] == 0 && bytes[14] == 0
            && bytes[15] <= 1
        {
            return true
        }
        // ::ffff:0:0/96 IPv4-mapped: the embedded IPv4 address decides.
        if head && bytes[10] == 0xff && bytes[11] == 0xff {
            return isBlockedIPv4("\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])")
        }
        if bytes[0] & 0xfe == 0xfc { return true }  // fc00::/7 ULA
        if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 { return true }  // fe80::/10 link-local
        return false
    }

    /// `inet_pton(AF_INET6, ...)`: the address's 16 bytes, nil when it is not IPv6 text.
    static func ipv6Bytes(_ text: String) -> [UInt8]? {
        var address = in6_addr()
        guard inet_pton(AF_INET6, text, &address) == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0) }
    }

    /// `isBlockedAddress` for a literal: not a recognizable IP fails closed.
    static func isBlockedAddress(_ ip: String) -> Bool {
        let kind = ipKind(ip)
        if kind == 4 { return isBlockedIPv4(ip) }
        if kind == 6 { return isBlockedIPv6(ip) }
        return true
    }

    /// `assertPublicHttpUrl(rawUrl)`: throws `Blocked` on any violation, returns the parsed URL.
    /// `resolve` answers the DNS lookup (`dns.lookup(host, { all: true })`).
    static func assertPublicHTTP(
        _ rawURL: String, resolve: @Sendable (String) throws -> [String]
    ) throws -> URLComponents {
        func blocked(_ message: String) -> Blocked { Blocked(message: message) }

        guard let url = URLComponents(string: rawURL) else { throw blocked("Invalid URL: \(rawURL)") }
        guard let scheme = url.scheme?.lowercased() else { throw blocked("Invalid URL: \(rawURL)") }
        guard allowedProtocols.contains(scheme) else {
            throw blocked("Blocked URL scheme \"\(scheme):\" — only http and https are allowed")
        }
        if url.user != nil || url.password != nil {
            throw blocked("URLs with embedded credentials are blocked")
        }
        guard let host = url.host, !host.isEmpty else { throw blocked("URL has no host") }

        // `URL.hostname` keeps IPv6 brackets only in `host` (percent-encoded form); the literal
        // is the host without them.
        let literal = (host.first == "[") && (host.last == "]")  // lint:allow string-literal-compare the brackets an IPv6 literal carries
            ? String(host.dropFirst().dropLast()) : host  // lint:allow string-literal-compare as above
        if ipKind(literal) != 0 {
            if isBlockedAddress(literal) {
                throw blocked("Blocked private/loopback address: \(host)")
            }
            return url
        }

        let addresses: [String]
        do {
            addresses = try resolve(host)
        } catch {
            throw blocked("DNS resolution failed for host: \(host)")
        }
        guard !addresses.isEmpty else { throw blocked("No DNS records for host: \(host)") }
        for address in addresses where isBlockedAddress(address) {
            throw blocked("Host \(host) resolves to a blocked address: \(address)")
        }
        return url
    }
}

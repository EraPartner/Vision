import CryptoKit
import Foundation

/// scrypt (RFC 7914) as Node's `crypto.scryptSync` computes it: PBKDF2-HMAC-SHA256 with one
/// iteration around ROMix over BlockMix with Salsa20/8.
public enum Scrypt {
    public struct Parameters: Equatable, Sendable {
        public let n: Int
        public let r: Int
        public let p: Int

        public init(n: Int, r: Int, p: Int) {
            self.n = n
            self.r = r
            self.p = p
        }
    }

    /// `crypto.scryptSync` defaults, used by the legacy v1 (CBC) format.
    public static let legacy = Parameters(n: 1 << 14, r: 8, p: 1)
    /// `KDF_N`, `KDF_R`, `KDF_P` of the v2 (GCM) format.
    public static let v2 = Parameters(n: 1 << 15, r: 8, p: 1)

    public static func derive(password: [UInt8], salt: [UInt8], parameters: Parameters, length: Int) throws -> [UInt8] {
        let n = parameters.n
        let r = parameters.r
        let p = parameters.p
        guard n > 1, n & (n - 1) == 0, r > 0, p > 0, length > 0, r * p < (1 << 30), n <= (1 << 24) else {
            throw BackupFailure("Invalid scrypt parameters")
        }
        let blockBytes = 128 * r
        var b = pbkdf2SHA256(password: password, salt: salt, iterations: 1, length: p * blockBytes)
        let wordsPerBlock = 32 * r
        let x = UnsafeMutablePointer<UInt32>.allocate(capacity: wordsPerBlock)
        let y = UnsafeMutablePointer<UInt32>.allocate(capacity: wordsPerBlock)
        let v = UnsafeMutablePointer<UInt32>.allocate(capacity: wordsPerBlock * n)
        let scratch = UnsafeMutablePointer<UInt32>.allocate(capacity: 16)
        defer {
            scratch.deallocate()
            x.deallocate()
            y.deallocate()
            v.update(repeating: 0, count: wordsPerBlock * n)
            v.deallocate()
        }
        for index in 0..<p {
            let offset = index * blockBytes
            for word in 0..<wordsPerBlock {
                let at = offset + word * 4
                x[word] = UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
            }
            roMix(x, y, v, scratch, r: r, n: n)
            for word in 0..<wordsPerBlock {
                let value = x[word]
                let at = offset + word * 4
                b[at] = UInt8(truncatingIfNeeded: value)
                b[at + 1] = UInt8(truncatingIfNeeded: value >> 8)
                b[at + 2] = UInt8(truncatingIfNeeded: value >> 16)
                b[at + 3] = UInt8(truncatingIfNeeded: value >> 24)
            }
        }
        x.update(repeating: 0, count: wordsPerBlock)
        y.update(repeating: 0, count: wordsPerBlock)
        scratch.update(repeating: 0, count: 16)
        return pbkdf2SHA256(password: password, salt: b, iterations: 1, length: length)
    }

    /// PBKDF2-HMAC-SHA256 (RFC 8018).
    public static func pbkdf2SHA256(password: [UInt8], salt: [UInt8], iterations: Int, length: Int) -> [UInt8] {
        // HMAC zero-pads a short key to the block size, so an empty password is the same key
        // as 64 zero bytes; this avoids handing CryptoKit an empty key.
        let key = SymmetricKey(data: password.isEmpty ? [UInt8](repeating: 0, count: 64) : password)
        var output: [UInt8] = []
        output.reserveCapacity(length)
        var blockIndex: UInt32 = 1
        while output.count < length {
            var message = salt
            message.append(contentsOf: [
                UInt8(truncatingIfNeeded: blockIndex >> 24), UInt8(truncatingIfNeeded: blockIndex >> 16),
                UInt8(truncatingIfNeeded: blockIndex >> 8), UInt8(truncatingIfNeeded: blockIndex),
            ])
            var u = HMAC<SHA256>.authenticationCode(for: message, using: key).withUnsafeBytes { [UInt8]($0) }
            var t = u
            if iterations > 1 {
                for _ in 1..<iterations {
                    u = HMAC<SHA256>.authenticationCode(for: u, using: key).withUnsafeBytes { [UInt8]($0) }
                    for index in 0..<t.count { t[index] ^= u[index] }
                }
            }
            output.append(contentsOf: t.prefix(length - output.count))
            blockIndex += 1
        }
        return output
    }

    private static func roMix(
        _ x: UnsafeMutablePointer<UInt32>, _ y: UnsafeMutablePointer<UInt32>, _ v: UnsafeMutablePointer<UInt32>,
        _ scratch: UnsafeMutablePointer<UInt32>, r: Int, n: Int
    ) {
        let words = 32 * r
        for index in 0..<n {
            (v + index * words).update(from: x, count: words)
            blockMix(x, y, scratch, r: r)
        }
        let mask = UInt32(truncatingIfNeeded: n - 1)
        for _ in 0..<n {
            let j = Int(x[(2 * r - 1) * 16] & mask)
            let source = v + j * words
            for word in 0..<words { x[word] ^= source[word] }
            blockMix(x, y, scratch, r: r)
        }
    }

    /// BlockMix: `Y_i = Salsa(X ^ B_i)`, then the even blocks followed by the odd ones.
    private static func blockMix(
        _ b: UnsafeMutablePointer<UInt32>, _ y: UnsafeMutablePointer<UInt32>, _ block: UnsafeMutablePointer<UInt32>,
        r: Int
    ) {
        block.update(from: b + (2 * r - 1) * 16, count: 16)
        for index in 0..<(2 * r) {
            let input = b + index * 16
            for word in 0..<16 { block[word] ^= input[word] }
            salsa20_8(block)
            let destination = index % 2 == 0 ? y + (index / 2) * 16 : y + (r + index / 2) * 16
            destination.update(from: block, count: 16)
        }
        b.update(from: y, count: 32 * r)
    }

    @inline(__always)
    private static func rotl(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }

    /// The Salsa20/8 core on 16 little-endian words, in place.
    static func salsa20_8(_ b: UnsafeMutablePointer<UInt32>) {
        var x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3]
        var x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7]
        var x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11]
        var x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15]
        for _ in 0..<4 {
            x4 ^= rotl(x0 &+ x12, 7)
            x8 ^= rotl(x4 &+ x0, 9)
            x12 ^= rotl(x8 &+ x4, 13)
            x0 ^= rotl(x12 &+ x8, 18)
            x9 ^= rotl(x5 &+ x1, 7)
            x13 ^= rotl(x9 &+ x5, 9)
            x1 ^= rotl(x13 &+ x9, 13)
            x5 ^= rotl(x1 &+ x13, 18)
            x14 ^= rotl(x10 &+ x6, 7)
            x2 ^= rotl(x14 &+ x10, 9)
            x6 ^= rotl(x2 &+ x14, 13)
            x10 ^= rotl(x6 &+ x2, 18)
            x3 ^= rotl(x15 &+ x11, 7)
            x7 ^= rotl(x3 &+ x15, 9)
            x11 ^= rotl(x7 &+ x3, 13)
            x15 ^= rotl(x11 &+ x7, 18)
            x1 ^= rotl(x0 &+ x3, 7)
            x2 ^= rotl(x1 &+ x0, 9)
            x3 ^= rotl(x2 &+ x1, 13)
            x0 ^= rotl(x3 &+ x2, 18)
            x6 ^= rotl(x5 &+ x4, 7)
            x7 ^= rotl(x6 &+ x5, 9)
            x4 ^= rotl(x7 &+ x6, 13)
            x5 ^= rotl(x4 &+ x7, 18)
            x11 ^= rotl(x10 &+ x9, 7)
            x8 ^= rotl(x11 &+ x10, 9)
            x9 ^= rotl(x8 &+ x11, 13)
            x10 ^= rotl(x9 &+ x8, 18)
            x12 ^= rotl(x15 &+ x14, 7)
            x13 ^= rotl(x12 &+ x15, 9)
            x14 ^= rotl(x13 &+ x12, 13)
            x15 ^= rotl(x14 &+ x13, 18)
        }
        b[0] = b[0] &+ x0
        b[1] = b[1] &+ x1
        b[2] = b[2] &+ x2
        b[3] = b[3] &+ x3
        b[4] = b[4] &+ x4
        b[5] = b[5] &+ x5
        b[6] = b[6] &+ x6
        b[7] = b[7] &+ x7
        b[8] = b[8] &+ x8
        b[9] = b[9] &+ x9
        b[10] = b[10] &+ x10
        b[11] = b[11] &+ x11
        b[12] = b[12] &+ x12
        b[13] = b[13] &+ x13
        b[14] = b[14] &+ x14
        b[15] = b[15] &+ x15
    }
}

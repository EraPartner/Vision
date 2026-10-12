import CommonCrypto
import Foundation

/// A CommonCrypto AES cryptor (`CCCryptorRef`) owned by one stream.
final class AESCryptor {
    private var reference: CCCryptorRef?

    /// `options` is `kCCOptionECBMode` for raw blocks, 0 for CBC without padding, or
    /// `kCCOptionPKCS7Padding` for padded CBC.
    init(operation: Int, key: [UInt8], iv: [UInt8]?, options: Int) throws {
        guard key.count == kCCKeySizeAES256 else { throw BackupFailure("AES-256 requires a 32-byte key") }
        var created: CCCryptorRef?
        let status: CCCryptorStatus = key.withUnsafeBytes { keyBytes in
            if let iv {
                return iv.withUnsafeBytes { ivBytes in
                    CCCryptorCreate(
                        CCOperation(operation), CCAlgorithm(kCCAlgorithmAES), CCOptions(options),
                        keyBytes.baseAddress, key.count, ivBytes.baseAddress, &created)
                }
            }
            return CCCryptorCreate(
                CCOperation(operation), CCAlgorithm(kCCAlgorithmAES), CCOptions(options), keyBytes.baseAddress,
                key.count, nil, &created)
        }
        guard status == CCCryptorStatus(kCCSuccess), let created else {
            throw BackupFailure("AES is unavailable (CommonCrypto status \(status))")
        }
        reference = created
    }

    deinit {
        if let reference { CCCryptorRelease(reference) }
    }

    /// `CCCryptorUpdate`; throws `AESCryptorError` with the CommonCrypto status.
    func update(_ input: [UInt8]) throws -> [UInt8] {
        guard !input.isEmpty else { return [] }
        var output = [UInt8](repeating: 0, count: input.count + kCCBlockSizeAES128)
        var moved = 0
        let capacity = output.count
        let status = input.withUnsafeBytes { inBytes in
            output.withUnsafeMutableBytes { outBytes in
                CCCryptorUpdate(reference, inBytes.baseAddress, input.count, outBytes.baseAddress, capacity, &moved)
            }
        }
        guard status == CCCryptorStatus(kCCSuccess) else { throw AESCryptorError(status: status) }
        output.removeSubrange(moved...)
        return output
    }

    /// `CCCryptorFinal`: the last block, with PKCS#7 padding checked when decrypting CBC.
    func finish() throws -> [UInt8] {
        var output = [UInt8](repeating: 0, count: kCCBlockSizeAES128 * 2)
        var moved = 0
        let capacity = output.count
        let status = output.withUnsafeMutableBytes { outBytes in
            CCCryptorFinal(reference, outBytes.baseAddress, capacity, &moved)
        }
        guard status == CCCryptorStatus(kCCSuccess) else { throw AESCryptorError(status: status) }
        output.removeSubrange(moved...)
        return output
    }
}

/// A CommonCrypto failure, for example bad CBC padding (`kCCDecodeError`).
struct AESCryptorError: Error {
    let status: CCCryptorStatus
}

/// GHASH (NIST SP 800-38D) with 4-bit tables (Shoup's method).
struct GHash {
    private var tableHigh = [UInt64](repeating: 0, count: 16)
    private var tableLow = [UInt64](repeating: 0, count: 16)
    private var stateHigh: UInt64 = 0
    private var stateLow: UInt64 = 0
    private var pending: [UInt8] = []
    private(set) var byteCount: UInt64 = 0

    private static let last4: [UInt64] = [
        0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
        0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
    ]

    init(h: [UInt8]) {
        var vh = GHash.bigEndian(h, 0)
        var vl = GHash.bigEndian(h, 8)
        tableHigh[8] = vh
        tableLow[8] = vl
        var index = 4
        while index > 0 {
            let carry: UInt64 = (vl & 1) == 1 ? 0xe100_0000 : 0
            vl = (vh << 63) | (vl >> 1)
            vh = (vh >> 1) ^ (carry << 32)
            tableHigh[index] = vh
            tableLow[index] = vl
            index >>= 1
        }
        var power = 2
        while power <= 8 {
            let high = tableHigh[power]
            let low = tableLow[power]
            for j in 1..<power {
                tableHigh[power + j] = high ^ tableHigh[j]
                tableLow[power + j] = low ^ tableLow[j]
            }
            power *= 2
        }
    }

    private static func bigEndian(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in 0..<8 { value = (value << 8) | UInt64(bytes[offset + index]) }
        return value
    }

    private func byte(_ high: UInt64, _ low: UInt64, _ index: Int) -> Int {
        let word = index < 8 ? high : low
        return Int((word >> UInt64(56 - 8 * (index % 8))) & 0xff)
    }

    /// `X = (X ^ block) · H`.
    private mutating func multiply(blockHigh: UInt64, blockLow: UInt64) {
        let xh = stateHigh ^ blockHigh
        let xl = stateLow ^ blockLow
        var lo = byte(xh, xl, 15) & 0xf
        var zh = tableHigh[lo]
        var zl = tableLow[lo]
        var index = 15
        while index >= 0 {
            let value = byte(xh, xl, index)
            lo = value & 0xf
            let hi = (value >> 4) & 0xf
            if index != 15 {
                let rem = Int(zl & 0xf)
                zl = (zh << 60) | (zl >> 4)
                zh = zh >> 4
                zh ^= GHash.last4[rem] << 48
                zh ^= tableHigh[lo]
                zl ^= tableLow[lo]
            }
            let rem = Int(zl & 0xf)
            zl = (zh << 60) | (zl >> 4)
            zh = zh >> 4
            zh ^= GHash.last4[rem] << 48
            zh ^= tableHigh[hi]
            zl ^= tableLow[hi]
            index -= 1
        }
        stateHigh = zh
        stateLow = zl
    }

    mutating func update(_ bytes: [UInt8]) {
        byteCount += UInt64(bytes.count)
        var data = bytes
        if !pending.isEmpty {
            data = pending + bytes
            pending = []
        }
        var offset = 0
        while data.count - offset >= 16 {
            multiply(blockHigh: GHash.bigEndian(data, offset), blockLow: GHash.bigEndian(data, offset + 8))
            offset += 16
        }
        if offset < data.count { pending = Array(data[offset...]) }
    }

    /// GHASH over the ciphertext with no additional data, then the length block.
    mutating func finish() -> [UInt8] {
        if !pending.isEmpty {
            let padded = pending + [UInt8](repeating: 0, count: 16 - pending.count)
            multiply(blockHigh: GHash.bigEndian(padded, 0), blockLow: GHash.bigEndian(padded, 8))
            pending = []
        }
        multiply(blockHigh: 0, blockLow: byteCount &* 8)
        var output: [UInt8] = []
        for word in [stateHigh, stateLow] {
            for shift in stride(from: 56, through: 0, by: -8) { output.append(UInt8((word >> UInt64(shift)) & 0xff)) }
        }
        return output
    }
}

/// AES-256-GCM with a 96-bit nonce and no additional data, as a stream: Node's
/// `createCipheriv("aes-256-gcm")` / `createDecipheriv` output, without holding the whole
/// message in memory (CryptoKit's `AES.GCM` is one-shot). The keystream is AES-ECB over
/// the counter blocks `nonce || inc32(1 + i)`; the tag is `E(K, nonce || 1) ^ GHASH`.
final class AESGCMStream {
    private let cipher: AESCryptor
    private let nonce: [UInt8]
    private let encrypting: Bool
    private var ghash: GHash
    private var counter: UInt32 = 2
    private var keystream: [UInt8] = []
    private var keystreamOffset = 0
    private let tagMask: [UInt8]

    init(key: [UInt8], nonce: [UInt8], encrypting: Bool) throws {
        guard nonce.count == 12 else { throw BackupFailure("AES-GCM requires a 12-byte nonce") }
        cipher = try AESCryptor(operation: kCCEncrypt, key: key, iv: nil, options: kCCOptionECBMode)
        self.nonce = nonce
        self.encrypting = encrypting
        let h = try cipher.update([UInt8](repeating: 0, count: 16))
        ghash = GHash(h: h)
        tagMask = try cipher.update(nonce + [0, 0, 0, 1])
    }

    private func refill(blocks: Int) throws {
        var counters: [UInt8] = []
        counters.reserveCapacity(blocks * 16)
        for _ in 0..<blocks {
            guard counter != 0 else { throw BackupFailure("AES-GCM message is too long") }
            counters.append(contentsOf: nonce)
            counters.append(contentsOf: [
                UInt8(truncatingIfNeeded: counter >> 24), UInt8(truncatingIfNeeded: counter >> 16),
                UInt8(truncatingIfNeeded: counter >> 8), UInt8(truncatingIfNeeded: counter),
            ])
            counter &+= 1
        }
        keystream = try cipher.update(counters)
        keystreamOffset = 0
    }

    /// Encrypts or decrypts the next bytes of the message.
    func process(_ input: [UInt8]) throws -> [UInt8] {
        var output = [UInt8](repeating: 0, count: input.count)
        var index = 0
        while index < input.count {
            if keystreamOffset == keystream.count {
                try refill(blocks: min(4096, (input.count - index + 15) / 16))
            }
            let count = min(keystream.count - keystreamOffset, input.count - index)
            for k in 0..<count { output[index + k] = input[index + k] ^ keystream[keystreamOffset + k] }
            keystreamOffset += count
            index += count
        }
        ghash.update(encrypting ? output : input)
        return output
    }

    /// The 16-byte authentication tag over everything processed.
    func tag() -> [UInt8] {
        let s = ghash.finish()
        return zip(s, tagMask).map { $0 ^ $1 }
    }
}

/// Constant-time comparison of two tags.
func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for index in 0..<a.count { difference |= a[index] ^ b[index] }
    return difference == 0
}

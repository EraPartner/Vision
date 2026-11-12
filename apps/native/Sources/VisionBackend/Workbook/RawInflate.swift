import Foundation

/// Raw DEFLATE (RFC 1951) in plain Swift, for the ZIP entries of a workbook. It runs the same
/// on every platform, stops at a stated output limit, and reports how much input the stream
/// used, so a caller can tell a stream followed by other bytes.
enum RawInflate {
    struct Failure: Error, Equatable, Sendable {}

    struct Output: Equatable, Sendable {
        var bytes: [UInt8]
        /// Input bytes up to the end of the final block.
        var consumed: Int
    }

    private struct Reader {
        let input: [UInt8]
        var position = 0
        var buffer: UInt32 = 0
        var count = 0

        mutating func bits(_ need: Int) throws -> Int {
            while count < need {
                guard position < input.count else { throw Failure() }
                buffer |= UInt32(input[position]) << UInt32(count)
                position += 1
                count += 8
            }
            let value = Int(buffer & ((1 << UInt32(need)) - 1))
            buffer >>= UInt32(need)
            count -= need
            return value
        }
    }

    /// A canonical Huffman code: how many codes each length has, and the symbols in code order.
    private struct Code {
        var counts = [Int](repeating: 0, count: 16)
        var symbols: [Int] = []
        /// More codes than the lengths allow.
        var oversubscribed = false
        /// Fewer codes than the lengths allow.
        var incomplete = false

        init(lengths: ArraySlice<Int>) {
            for length in lengths { counts[length] += 1 }
            var left = 1
            for length in 1...15 {
                left = (left << 1) - counts[length]
                if left < 0 {
                    oversubscribed = true
                    return
                }
            }
            incomplete = left > 0
            var offsets = [Int](repeating: 0, count: 16)
            for length in 1..<15 { offsets[length + 1] = offsets[length] + counts[length] }
            symbols = [Int](repeating: 0, count: lengths.count)
            for (symbol, length) in lengths.enumerated() where length != 0 {
                symbols[offsets[length]] = symbol
                offsets[length] += 1
            }
        }

        func decode(_ reader: inout Reader) throws -> Int {
            var code = 0
            var first = 0
            var index = 0
            for length in 1...15 {
                code |= try reader.bits(1)
                let count = counts[length]
                if code - count < first { return symbols[index + (code - first)] }
                index += count
                first = (first + count) << 1
                code <<= 1
            }
            throw Failure()
        }
    }

    private static let lengthBase = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
    ]
    private static let lengthExtra = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ]
    private static let distanceBase = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
        8193, 12289, 16385, 24577,
    ]
    private static let distanceExtra = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
    ]
    private static let fixedLiterals: Code = {
        var lengths = [Int](repeating: 8, count: 288)
        for symbol in 144..<256 { lengths[symbol] = 9 }
        for symbol in 256..<280 { lengths[symbol] = 7 }
        return Code(lengths: lengths[...])
    }()
    private static let fixedDistances = Code(lengths: [Int](repeating: 5, count: 30)[...])
    private static let lengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

    private static func codes(_ reader: inout Reader, literals: Code, distances: Code, into out: inout [UInt8], limit: Int)
        throws
    {
        while true {
            let symbol = try literals.decode(&reader)
            if symbol < 256 {
                guard out.count < limit else { throw Failure() }
                out.append(UInt8(symbol))
            } else if symbol == 256 {
                return
            } else {
                let slot = symbol - 257
                guard slot < 29 else { throw Failure() }
                let length = lengthBase[slot] + (try reader.bits(lengthExtra[slot]))
                let distanceSymbol = try distances.decode(&reader)
                guard distanceSymbol < 30 else { throw Failure() }
                let distance = distanceBase[distanceSymbol] + (try reader.bits(distanceExtra[distanceSymbol]))
                guard distance <= out.count, out.count + length <= limit else { throw Failure() }
                var from = out.count - distance
                for _ in 0..<length {
                    out.append(out[from])
                    from += 1
                }
            }
        }
    }

    private static func dynamic(_ reader: inout Reader) throws -> (Code, Code) {
        let literalCount = try reader.bits(5) + 257
        let distanceCount = try reader.bits(5) + 1
        let codeCount = try reader.bits(4) + 4
        guard literalCount <= 286, distanceCount <= 30 else { throw Failure() }
        var lengths = [Int](repeating: 0, count: 19)
        for index in 0..<codeCount { lengths[lengthOrder[index]] = try reader.bits(3) }
        let lengthCode = Code(lengths: lengths[...])
        guard !lengthCode.oversubscribed, !lengthCode.incomplete else { throw Failure() }
        lengths = [Int](repeating: 0, count: literalCount + distanceCount)
        var index = 0
        while index < literalCount + distanceCount {
            let symbol = try lengthCode.decode(&reader)
            if symbol < 16 {
                lengths[index] = symbol
                index += 1
                continue
            }
            var previous = 0
            var times: Int
            switch symbol {
            case 16:
                guard index > 0 else { throw Failure() }
                previous = lengths[index - 1]
                times = 3 + (try reader.bits(2))
            case 17: times = 3 + (try reader.bits(3))
            default: times = 11 + (try reader.bits(7))
            }
            guard index + times <= literalCount + distanceCount else { throw Failure() }
            while times > 0 {
                lengths[index] = previous
                index += 1
                times -= 1
            }
        }
        guard lengths[256] != 0 else { throw Failure() }
        let literals = Code(lengths: lengths[..<literalCount])
        // zlib: an incomplete code is allowed only as one code of one bit (or, for distances, none).
        func single(_ code: Code, of count: Int) -> Bool { count - code.counts[0] == 1 && code.counts[1] == 1 }
        guard !literals.oversubscribed, !literals.incomplete || single(literals, of: literalCount) else {
            throw Failure()
        }
        let distances = Code(lengths: lengths[literalCount...])
        guard !distances.oversubscribed,
            !distances.incomplete || distanceCount == distances.counts[0] || single(distances, of: distanceCount)
        else { throw Failure() }
        return (literals, distances)
    }

    /// Inflates one stream. Fails on a damaged or cut-off stream and when the output would
    /// pass `limit` bytes.
    static func inflate(_ input: [UInt8], limit: Int = .max) throws -> Output {
        var reader = Reader(input: input)
        var out: [UInt8] = []
        var last = false
        while !last {
            last = try reader.bits(1) == 1
            switch try reader.bits(2) {
            case 0:
                reader.buffer = 0
                reader.count = 0
                guard reader.position + 4 <= input.count else { throw Failure() }
                let length = Int(input[reader.position]) | Int(input[reader.position + 1]) << 8
                let check = Int(input[reader.position + 2]) | Int(input[reader.position + 3]) << 8
                guard length == (~check & 0xFFFF) else { throw Failure() }
                reader.position += 4
                guard reader.position + length <= input.count, out.count + length <= limit else { throw Failure() }
                out.append(contentsOf: input[reader.position..<reader.position + length])
                reader.position += length
            case 1: try codes(&reader, literals: fixedLiterals, distances: fixedDistances, into: &out, limit: limit)
            case 2:
                let (literals, distances) = try dynamic(&reader)
                try codes(&reader, literals: literals, distances: distances, into: &out, limit: limit)
            default: throw Failure()
            }
        }
        return Output(bytes: out, consumed: reader.position)
    }
}

/// SHA-256 (FIPS 180-4) as lower-case hexadecimal; plain Swift so the backend needs no
/// platform library for a statement's file hash.
enum SHA256Digest {
    private static let k: [UInt32] = [
        0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
        0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
        0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
        0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
        0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
        0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
        0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
        0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
    ]

    static func hex(_ bytes: [UInt8]) -> String {
        var h: [UInt32] = [
            0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
        ]
        var message = bytes
        message.append(0x80)
        while message.count % 64 != 56 { message.append(0) }
        let bitCount = UInt64(bytes.count) * 8
        for shift in stride(from: 56, through: 0, by: -8) { message.append(UInt8(truncatingIfNeeded: bitCount >> UInt64(shift))) }
        var w = [UInt32](repeating: 0, count: 64)
        for block in stride(from: 0, to: message.count, by: 64) {
            for i in 0..<16 {
                let at = block + i * 4
                w[i] =
                    UInt32(message[at]) << 24 | UInt32(message[at + 1]) << 16 | UInt32(message[at + 2]) << 8
                    | UInt32(message[at + 3])
            }
            for i in 16..<64 {
                let a = w[i - 15]
                let b = w[i - 2]
                let s0 = (a >> 7 | a << 25) ^ (a >> 18 | a << 14) ^ (a >> 3)
                let s1 = (b >> 17 | b << 15) ^ (b >> 19 | b << 13) ^ (b >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var v = h
            for i in 0..<64 {
                let s1 = (v[4] >> 6 | v[4] << 26) ^ (v[4] >> 11 | v[4] << 21) ^ (v[4] >> 25 | v[4] << 7)
                let choice = (v[4] & v[5]) ^ (~v[4] & v[6])
                let t1 = v[7] &+ s1 &+ choice &+ k[i] &+ w[i]
                let s0 = (v[0] >> 2 | v[0] << 30) ^ (v[0] >> 13 | v[0] << 19) ^ (v[0] >> 22 | v[0] << 10)
                let majority = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2])
                v = [t1 &+ s0 &+ majority, v[0], v[1], v[2], v[3] &+ t1, v[4], v[5], v[6]]
            }
            for i in 0..<8 { h[i] = h[i] &+ v[i] }
        }
        return h.map { word in
            let text = String(word, radix: 16)
            return String(repeating: "0", count: 8 - text.count) + text
        }.joined()
    }
}

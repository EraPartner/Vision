import Foundation

/// The seeded generator of `calculations/forecast/prng.ts`: 32-bit xorshift, seeded with a
/// number or with the FNV-1a hash of a text. The same seed gives the same sequence as the
/// TypeScript, draw for draw, so a forecast or projection repeats across both backends.
struct ForecastRandom {
    enum Seed: Equatable, Sendable {
        case number(Double)
        case text(String)
    }

    private var state: UInt32

    /// `fnv1aHash(text)`: over UTF-16 code units, as `charCodeAt` reads them.
    static func hash(_ text: String) -> UInt32 {
        var h: UInt32 = 0x811C_9DC5
        for unit in text.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x0100_0193
        }
        return h
    }

    /// `value >>> 0` (ToUint32).
    static func toUInt32(_ value: Double) -> UInt32 {
        guard value.isFinite else { return 0 }
        let wrapped = value.rounded(.towardZero).truncatingRemainder(dividingBy: 4_294_967_296)
        return UInt32(wrapped < 0 ? wrapped + 4_294_967_296 : wrapped)
    }

    init(_ seed: Seed) {
        switch seed {
        case .number(let value): state = Self.toUInt32(value)
        case .text(let text): state = Self.hash(text)
        }
        if state == 0 { state = 1 }
    }

    /// The next draw in [0, 1).
    mutating func next() -> Double {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return Double(state) / 4_294_967_296
    }

    /// `gaussian(rng)`: one standard normal by Box-Muller, two draws per call.
    mutating func gaussian() -> Double {
        var u1 = next()
        let u2 = next()
        if u1 < 1e-12 { u1 = 1e-12 }
        return (-2 * log(u1)).squareRoot() * cos(2 * Double.pi * u2)
    }
}

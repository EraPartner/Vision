import SwiftUI
import VisionNativeCore

/// lib/motion.ts and tokens.css curves and durations.
enum VisionMotion {
    /// `easings.outExpo` / `--ease-out-expo`.
    static func outExpo(_ duration: Double) -> Animation { .timingCurve(0.16, 1, 0.3, 1, duration: duration) }
    /// `--ease-glide`.
    static func glide(_ duration: Double) -> Animation { .timingCurve(0.32, 0.72, 0, 1, duration: duration) }
    /// `durations.page`.
    static let page = 0.52
    /// `--duration-reveal`.
    static let reveal = 0.6
}

/// PageTransition: each pathname enters with opacity 0 → 1, y 14 → 0 and scale 0.995 → 1
/// over 0.52 s on the out-expo curve; enter-only, and none under Reduce Motion.
struct PageEntrance: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var entered = false

    func body(content: Content) -> some View {
        let shown = entered || reduceMotion
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 14)
            .scaleEffect(shown ? 1 : 0.995)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(VisionMotion.outExpo(VisionMotion.page)) { entered = true }
            }
    }
}

/// RollingNumber: every digit is a reel of 0–9 that rolls to its value (from 0 on first
/// appearance) over 0.6 s on the glide curve; reels keep their place from the right so
/// 999 → 1.000 rolls rather than jumps. A currency symbol is smaller and raised and the
/// decimal part is smaller and dimmed, as with `formatToParts`. VoiceOver reads the value.
struct RollingNumber: View {
    let value: String
    var decimalSeparator: Character?
    var animate = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false

    private enum Role { case plain, currency, minor }

    var body: some View {
        let characters = Array(value)
        let roles = Self.roles(characters, decimalSeparator: decimalSeparator)
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ForEach(Array(characters.enumerated()), id: \.offset) { index, character in
                styled(character, role: roles[index])
                    // Identity from the right keeps a reel when the string grows.
                    .id(characters.count - index)
            }
        }
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(value)
        .onAppear {
            guard animate, !reduceMotion else { return }
            DispatchQueue.main.async { settled = true }
        }
    }

    @ViewBuilder
    private func styled(_ character: Character, role: Role) -> some View {
        let glyph = glyphView(character)
        switch role {
        case .plain: glyph
        case .currency:
            // `text-[0.85em] self-start`: smaller and raised to the cap line.
            glyph.fontWeight(.medium).scaleEffect(0.85, anchor: .topLeading).opacity(0.85).padding(.trailing, 1)
        case .minor: glyph.scaleEffect(0.88, anchor: .bottomLeading).opacity(0.75)
        }
    }

    @ViewBuilder
    private func glyphView(_ character: Character) -> some View {
        if let digit = character.wholeNumberValue, character.isASCII, animate, !reduceMotion {
            DigitReel(digit: settled ? digit : 0)
        } else {
            Text(String(character))
        }
    }

    private static func roles(_ characters: [Character], decimalSeparator: Character?) -> [Role] {
        var roles = [Role](repeating: .plain, count: characters.count)
        for (index, character) in characters.enumerated()
        where character.unicodeScalars.contains(where: { $0.properties.generalCategory == .currencySymbol }) {
            roles[index] = .currency
        }
        if let separator = decimalSeparator, let last = characters.lastIndex(of: separator) {
            var index = last
            while index < characters.count, characters[index] == separator || characters[index].isNumber {
                roles[index] = .minor
                index += 1
            }
        }
        return roles
    }
}

/// One digit: a clipped vertical strip of 0–9 offset by the digit's height.
private struct DigitReel: View {
    let digit: Int

    var body: some View {
        Text("0")
            .hidden()
            .overlay(alignment: .top) {
                GeometryReader { proxy in
                    VStack(spacing: 0) {
                        ForEach(0..<10, id: \.self) { value in
                            Text(String(value)).frame(height: proxy.size.height)
                        }
                    }
                    .offset(y: -CGFloat(digit) * proxy.size.height)
                    .animation(VisionMotion.glide(VisionMotion.reveal), value: digit)
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }
}

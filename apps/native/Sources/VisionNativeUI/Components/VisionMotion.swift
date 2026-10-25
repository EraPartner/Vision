import SwiftUI
import VisionNativeCore

/// lib/motion.ts and tokens.css curves and durations.
enum VisionMotion {
    /// `easings.outExpo` / `--ease-out-expo`.
    static func outExpo(_ duration: Double) -> Animation { .visionCurve(DesignTokens.Ease.outExpo, duration: duration) }
    /// `--ease-glide`.
    static func glide(_ duration: Double) -> Animation { .visionCurve(DesignTokens.Ease.glide, duration: duration) }
    /// `durations.page`.
    static let page = 0.52
    /// `--duration-reveal`.
    static let reveal = DesignTokens.Duration.reveal
}

/// PageTransition: each pathname enters with opacity 0 → 1 and y 14 → 0 over 0.52 s on the
/// out-expo curve; enter-only, and none under Reduce Motion. The web's scale 0.995 → 1 is left
/// out: an invisible half-percent, it made every layer of the page re-render each frame.
struct PageEntrance: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var entered = false

    func body(content: Content) -> some View {
        let shown = entered || reduceMotion
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 14)
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
    /// The display face the figure is drawn in (see `MoneyDisplaySize`); nil keeps the caller's `.font`.
    var display: MoneyDisplaySize?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.visionTheme) private var theme
    @State private var settled = false

    /// Printed pages and reduced motion show the final figures without reels.
    private var rolls: Bool { animate && !reduceMotion && !theme.isPrintReport }

    enum Role { case plain, currency, minor }

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
        .modifier(DisplayFontModifier(display: display))
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(value)
        .onAppear {
            guard rolls else { return }
            DispatchQueue.main.async { settled = true }
        }
    }

    @ViewBuilder
    private func styled(_ character: Character, role: Role) -> some View {
        let glyph = glyphView(character)
        switch role {
        case .plain: glyph
        case .currency:
            // `text-[0.85em]`: a smaller glyph. Text scale resizes the layout too; a scale
            // effect left each glyph's full-size slot, which spread the figures apart.
            if let display {
                glyph.font(display.font(scale: MoneyDisplaySize.currencyScale)).opacity(0.85).padding(.trailing, 1)
            } else {
                glyph.fontWeight(.medium).textScale(.secondary).opacity(0.85).padding(.trailing, 1)
            }
        case .minor:
            if let display {
                glyph.font(display.font(scale: MoneyDisplaySize.fractionScale)).opacity(0.75)
            } else {
                glyph.textScale(.secondary).opacity(0.75)
            }
        }
    }

    @ViewBuilder
    private func glyphView(_ character: Character) -> some View {
        if let digit = character.wholeNumberValue, character.isASCII, rolls {
            DigitReel(digit: settled ? digit : 0)
        } else {
            Text(String(character))
        }
    }

    static func roles(_ characters: [Character], decimalSeparator: Character?) -> [Role] {
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

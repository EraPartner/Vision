import SwiftUI

/// `DeltaPill`: the standard change chip, a tinted translucent capsule with a direction
/// arrow. The sign of `value` picks the arrow and, with `invert` (spending: down is good),
/// the gain, loss or neutral tint. `label` is the pre-formatted change.
struct DeltaPill: View {
    let value: Double
    let label: String
    var invert = false
    @Environment(\.visionTheme) private var theme

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .bold))
                .accessibilityHidden(true)
            Text(label).monospacedDigit()
        }
        .font(.footnote.weight(.medium))
        .lineLimit(1)
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(Capsule().fill(tint.opacity(isNeutral ? 0.10 : 0.12)))
        .overlay(Capsule().strokeBorder(tint.opacity(isNeutral ? 0.20 : 0.25), lineWidth: 1))
        .fixedSize()
    }

    private var symbol: String {
        value > 0 ? "arrow.up.right" : value < 0 ? "arrow.down.right" : "arrow.right"
    }

    private var isNeutral: Bool { value == 0 }

    private var tint: Color {
        let positive = invert ? value < 0 : value > 0
        let negative = invert ? value > 0 : value < 0
        return positive ? theme.gain : negative ? theme.loss : theme.secondaryLabel
    }
}

extension DeltaPill {
    init(_ value: Double, label: String, invert: Bool = false) {
        self.init(value: value, label: label, invert: invert)
    }

    init(_ value: Decimal, label: String, invert: Bool = false) {
        self.init(value: NSDecimalNumber(decimal: value).doubleValue, label: label, invert: invert)
    }
}

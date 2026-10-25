import SwiftUI
import VisionNativeCore

/// The web `Alert` (components/ui/alert.tsx, default variant): a `rounded-card` box with a
/// `border-border/60` frame and a `bg-foreground/[0.03]` fill, a 16 pt icon at the top left, a
/// `type-headline` title and a `type-body` description in `text-label-secondary`.
struct VisionCallout<Content: View>: View {
    var symbol = "info.circle"
    let title: String
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.Radius.card), style: .continuous)
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(theme.foreground.opacity(0.8))
                .frame(width: 16, height: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(theme.foreground)
                    .accessibilityAddTraits(.isHeader)
                content()
                    .font(.body)
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .background(shape.fill(theme.foreground.opacity(0.03)))
        .overlay(shape.strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

/// `<ul className="mt-2 list-disc space-y-1 pl-4">`: bullet rows in the surrounding text style.
struct VisionBulletList: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: "•").accessibilityHidden(true)
                    Text(item).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.leading, 4)
    }
}

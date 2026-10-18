import SwiftUI
import VisionNativeCore

/// The web `<Card>` surface (`card-material glass-thin premium-frame rounded-card`, index.css):
/// a vertical glass-surface gradient, the `--border`/0.7 frame, the embossed inset edge (a
/// top highlight and, in light mode, a bottom hairline) and the soft drop shadow. Print
/// reports keep a flat white card with a hairline.
struct VisionCardBackground: View {
    var cornerRadius: CGFloat = DesignTokens.Radius.card
    /// A coloured frame (selection, warning) replacing the neutral `--border`/0.7.
    var stroke: Color?
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if theme.isPrintReport {
            shape.fill(theme.card).overlay(shape.strokeBorder(stroke ?? theme.border, lineWidth: 1))
        } else {
            let palette = theme.palette
            shape
                .fill(
                    LinearGradient(
                        colors: theme.isDark
                            ? [
                                Color(token: palette.glassSurface, opacity: 0.64),
                                Color(token: palette.glassSurfaceDeep, opacity: 0.78),
                            ]
                            : [
                                Color(token: palette.glassSurface, opacity: 0.72),
                                Color(token: palette.glassSurface, opacity: 0.56),
                            ],
                        startPoint: .top, endPoint: .bottom)
                )
                // premium-frame's inset edge: `0 1px 0 highlight inset` and, light only,
                // `0 -1px 0 shadow/0.05 inset`.
                .overlay(
                    shape.inset(by: 1).strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(
                                    color: Color(token: palette.glassHighlight, opacity: theme.isDark ? 0.06 : 0.16),
                                    location: 0),
                                .init(color: .clear, location: 0.12),
                                .init(color: .clear, location: 0.88),
                                .init(
                                    color: Color(token: palette.glassShadow, opacity: theme.isDark ? 0 : 0.05),
                                    location: 1),
                            ], startPoint: .top, endPoint: .bottom),
                        lineWidth: 1)
                )
                .overlay(shape.strokeBorder(stroke ?? theme.border.opacity(0.7), lineWidth: 1))
                // `0 4px 12px shadow/0.04` light, `0 5px 16px shadow/0.2` dark (CSS blur ≈ 2 × radius).
                .shadow(
                    color: Color(token: palette.glassShadow, opacity: theme.isDark ? 0.2 : 0.04),
                    radius: theme.isDark ? 8 : 6, y: theme.isDark ? 5 : 4)
        }
    }
}

extension View {
    /// Draws the view on the web `<Card>` surface.
    func visionCardBackground(cornerRadius: CGFloat = DesignTokens.Radius.card, stroke: Color? = nil) -> some View {
        background(VisionCardBackground(cornerRadius: cornerRadius, stroke: stroke))
    }

    /// A full-width card: `padding`, leading-aligned, on the web `<Card>` surface.
    func visionCard(padding: CGFloat = 20, stroke: Color? = nil) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground(stroke: stroke)
    }
}

/// The page frame every native screen shares: the web `<main>` padding (`p-6`, 24 pt) and
/// `PageShell`'s 24 pt rhythm, filling the detail column's width as the web pages do.
enum VisionPageLayout {
    static let padding: CGFloat = 24
    static let spacing: CGFloat = 24
}

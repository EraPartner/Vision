import SwiftUI
import VisionNativeCore

public struct NativeNotFoundView: View {
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    public init(shell: NativeShellModel) { self.shell = shell }
    public var body: some View {
        VStack(spacing: 24) {
            NativeNotFoundBrandMark().fill(theme.primary).frame(width: 40, height: 40).padding(20)
                .background(theme.primary.opacity(0.12), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text(shell.strings.t("notFound.title")).font(.visionLargeTitle).monospacedDigit()
                    .accessibilityAddTraits(.isHeader)
                Text(shell.strings.t("notFound.heading")).font(Font.visionTitle3)
                    .foregroundStyle(theme.secondaryLabel)
            }
            Text(shell.strings.t("notFound.description")).foregroundStyle(theme.secondaryLabel)
            Button {
                shell.navigate(to: "/")
            } label: {
                Label(shell.strings.t("notFound.backHome"), systemImage: "arrow.left")
            }.buttonStyle(.borderedProminent)
            HStack(spacing: 12) {
                Button(shell.strings.t("nav.transactions")) { shell.navigate(to: "/transactions") }
                Text("·").accessibilityHidden(true)
                Button(shell.strings.t("nav.importExport")) { shell.navigate(to: "/import") }
            }.buttonStyle(.plain).font(.callout).foregroundStyle(theme.secondaryLabel)
                .accessibilityAddTraits(.isLink)
        }.multilineTextAlignment(.center).frame(maxWidth: 448).padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity).foregroundStyle(theme.foreground)
            .background(theme.background)
    }
}

/// Verbatim VisionMark.tsx geometry, in its 262 296 500 500 view box.
private struct NativeNotFoundBrandMark: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + (x - 262) / 500 * rect.width, y: rect.minY + (y - 296) / 500 * rect.height)
        }
        var path = Path()
        path.move(to: point(268, 300))
        for pair: (CGFloat, CGFloat) in [(512, 792), (756, 300), (656, 300), (512, 596), (368, 300)] {
            path.addLine(to: point(pair.0, pair.1))
        }
        path.closeSubpath()
        let center = point(512, 444)
        path.addEllipse(
            in: CGRect(
                x: center.x - rect.width * 0.08, y: center.y - rect.height * 0.08, width: rect.width * 0.16,
                height: rect.height * 0.16))
        return path
    }
}

import AppKit
import SwiftUI
import VisionNativeCore

/// A behind-window `NSVisualEffectView`: the desktop glows through, like Electron's
/// vibrancy under the web page.
struct VibrancyBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}

/// `.glass-chrome` for the sidebar column: the sidebar material under the
/// `--sidebar-background` gradient, the inset highlight and the rail border.
struct SidebarGlassBackground: View {
    @Environment(\.visionTheme) var theme

    var body: some View {
        let glass = theme.glass
        ZStack(alignment: .trailing) {
            VibrancyBackground(material: .sidebar)
            LinearGradient(
                colors: [
                    Color(token: glass.sidebarTop, opacity: glass.sidebarTopOpacity),
                    Color(token: glass.sidebarTop, opacity: glass.sidebarBottomOpacity),
                ], startPoint: .top, endPoint: .bottom)
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Color(token: glass.highlight, opacity: glass.highlightOpacity))
                    .frame(height: 1)
                Spacer(minLength: 0)
            }
            Rectangle()
                .fill(Color(token: glass.border, opacity: glass.borderOpacity))
                .frame(width: 1)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// The detail column behind native screens: a vibrant material tinted with the page's
/// `--background`, so the opaque cards and tables stay as legible as on the web page.
struct DetailGlassBackground: View {
    @Environment(\.visionTheme) var theme

    var body: some View {
        let glass = theme.glass
        ZStack {
            VibrancyBackground(material: .underWindowBackground)
            Color(token: glass.detailTint, opacity: glass.detailTintOpacity)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// The emerald pill of the active row (`data-[active=true]:bg-primary/[0.12]`).
struct SidebarSelectionPill: View {
    let isActive: Bool
    @Environment(\.visionTheme) var theme

    var body: some View {
        let glass = theme.glass
        RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
            .fill(isActive ? Color(token: glass.selection, opacity: glass.selectionOpacity) : Color.clear)
            .padding(.horizontal, 8)
    }
}

import AppKit
import SwiftUI
import VisionNativeCore

private struct VisionVisualEffectsKey: EnvironmentKey {
    static let defaultValue = VisualEffects.standard
}

extension EnvironmentValues {
    /// The effective tier after the settings model applies the display-size cap.
    var visionVisualEffects: VisualEffects {
        get { self[VisionVisualEffectsKey.self] }
        set { self[VisionVisualEffectsKey.self] = newValue }
    }
}

/// Native material using the page's appearance. Desktop vibrancy is reserved for Enhanced;
/// Standard blends the sidebar with the window's own content.
struct VibrancyBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blendingMode: NSVisualEffectView.BlendingMode = .withinWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .followsWindowActiveState
        view.appearance = Self.appearance(context.environment.colorScheme)
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blendingMode
        view.appearance = Self.appearance(context.environment.colorScheme)
    }

    static func appearance(_ scheme: ColorScheme) -> NSAppearance? {
        NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
    }
}

/// `.glass-chrome` for the sidebar column: the sidebar material under the
/// `--sidebar-background` gradient, the inset highlight and the rail border.
struct SidebarGlassBackground: View {
    @Environment(\.visionTheme) var theme
    @Environment(\.visionVisualEffects) private var visualEffects
    @Environment(\.visionFullEffects) private var fullEffects
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let glass = theme.glass
        ZStack(alignment: .trailing) {
            if visualEffects == .reduced || reduceTransparency {
                Color(token: glass.sidebarTop)
            } else {
                VibrancyBackground(
                    material: .sidebar,
                    blendingMode: visualEffects == .enhanced ? .behindWindow : .withinWindow)
                if fullEffects && visualEffects == .enhanced {
                    // Full effects keep both blur passes under native vibrancy: the system
                    // blur behind the window and the chrome's own `backdrop-filter: blur(24px)
                    // saturate(...)` over it (index.css `html.electron-mac.vibrancy:not(.fx-full)`
                    // drops the second pass only when Full effects are off; ADR-129, ADR-244).
                    // The nearest system material to `Glass.chromeBlur` is regular.
                    Rectangle().fill(.regularMaterial)
                }
                LinearGradient(
                    colors: [
                        Color(token: glass.sidebarTop, opacity: glass.sidebarTopOpacity),
                        Color(token: glass.sidebarTop, opacity: glass.sidebarBottomOpacity),
                    ], startPoint: .top, endPoint: .bottom)
            }
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

/// The detail column is opaque in Standard and Reduced. Enhanced opts into desktop
/// vibrancy, tinted with the page's background; Reduce Transparency always wins.
struct DetailGlassBackground: View {
    @Environment(\.visionTheme) var theme
    @Environment(\.visionVisualEffects) private var visualEffects
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let glass = theme.glass
        ZStack {
            if visualEffects == .enhanced && !reduceTransparency {
                VibrancyBackground(material: .underWindowBackground, blendingMode: .behindWindow)
                Color(token: glass.detailTint, opacity: glass.detailTintOpacity)
            } else {
                Color(token: glass.detailTint)
            }
            AuroraCanvas()
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

/// Gives the hosting window the theme's appearance (the web follows its own theme, not macOS),
/// so system materials, scrollers and menus in the window match the app theme. Without it a
/// dialog's `Material` follows the macOS appearance: light glass over a dark theme.
struct WindowAppearanceSync: NSViewRepresentable {
    let isDark: Bool

    func makeNSView(context: Context) -> NSView {
        let view = WindowAppearanceView()
        view.isDark = isDark
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        (view as? WindowAppearanceView)?.isDark = isDark
    }
}

private final class WindowAppearanceView: NSView {
    var isDark = false {
        didSet { apply() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        apply()
    }

    private func apply() {
        guard let window else { return }
        let name: NSAppearance.Name = isDark ? .darkAqua : .aqua
        if window.appearance?.name != name { window.appearance = NSAppearance(named: name) }
    }
}

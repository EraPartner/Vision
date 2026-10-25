import SwiftUI
import VisionNativeCore

/// `variant` of `buttonVariants` (apps/frontend/src/components/ui/button.tsx). `link` is
/// `VisionLinkButtonStyle` (`.visionLink`).
enum VisionButtonVariant: Sendable {
    /// `bg-primary text-primary-foreground shadow-sm hover:bg-primary/92`.
    case `default`
    /// `bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/92`.
    case destructive
    /// `border border-input/70 bg-background/80 text-foreground hover:bg-background`.
    case outline
    /// `border border-border/50 bg-secondary text-secondary-foreground hover:bg-secondary/90`.
    case secondary
    /// `text-foreground/80 hover:text-foreground hover:bg-foreground/[0.06]`.
    case ghost
    /// `bg-accent text-accent-foreground shadow-sm hover:bg-accent/92`.
    case accent
}

/// `size` of `buttonVariants`: `default` h-9 px-4, `sm` h-8 px-3, `xs` h-7 px-2.5 type-footnote,
/// `lg` h-10 px-6, and the `icon`, `icon-sm`, `icon-xs` squares.
enum VisionButtonSize: Sendable {
    case `default`
    case sm
    case xs
    case lg
    case icon
    case iconSm
    case iconXs
}

/// The single source of control geometry: button sizes, field and text-area metrics, and the
/// constants every form control shares (disabled opacity, `shadow-sm`, border width). Heights come
/// from `DesignTokens.Control`; Tailwind spacing steps that have no token (`px-3` is 12 pt) are
/// named here once so no view carries a literal.
struct VisionControlMetrics: Equatable, Sendable {
    let height: CGFloat
    let horizontalPadding: CGFloat
    /// Font size in points: `type-body` (14), or `type-footnote` (12) for `xs`.
    let fontSize: CGFloat
    let isIcon: Bool

    /// The metrics of one `buttonVariants` size.
    init(size: VisionButtonSize) {
        let body = CGFloat(DesignTokens.Typography.body.size)
        let footnote = CGFloat(DesignTokens.Typography.footnote.size)
        let values: (CGFloat, CGFloat, CGFloat, Bool) =
            switch size {
            case .default: (Self.heightDefault, 16, body, false)
            case .sm: (Self.heightSm, 12, body, false)
            case .xs: (Self.heightXs, 10, footnote, false)
            case .lg: (Self.heightLg, 24, body, false)
            case .icon: (Self.heightDefault, 0, body, true)
            case .iconSm: (Self.heightSm, 0, body, true)
            case .iconXs: (Self.heightXs, 0, footnote, true)
            }
        height = values.0
        horizontalPadding = values.1
        fontSize = values.2
        isIcon = values.3
    }

    /// The button size a SwiftUI `.controlSize` maps to, so `.controlSize(.small)` call sites keep
    /// working: regular is `default`, small `sm`, mini `xs`, large and extra large `lg`.
    static func buttonSize(for controlSize: ControlSize) -> VisionButtonSize {
        switch controlSize {
        case .mini: return .xs
        case .small: return .sm
        case .large, .extraLarge: return .lg
        default: return .default
        }
    }

    /// The button font: `type-body font-medium` (weight 500) at `fontSize`.
    var font: Font { VisionFonts.body(fontSize, weight: 500, relativeTo: .body) }

    static let heightDefault = CGFloat(DesignTokens.Control.height)
    static let heightSm = CGFloat(DesignTokens.Control.heightSm)
    static let heightXs = CGFloat(DesignTokens.Control.heightXs)
    static let heightLg = CGFloat(DesignTokens.Control.heightLg)

    /// Inputs, selects and segmented tracks: `h-9` (input.tsx).
    static let fieldHeight = heightDefault
    /// `px-3` of input.tsx, select.tsx and textarea.tsx.
    static let fieldHorizontalPadding: CGFloat = 12
    /// `py-2` of textarea.tsx.
    static let textAreaVerticalPadding: CGFloat = 8
    /// `min-h-20` of textarea.tsx.
    static let textAreaMinHeight: CGFloat = 80
    /// The font of fields and text areas: `type-body`.
    static var fieldFont: Font {
        VisionFonts.body(
            CGFloat(DesignTokens.Typography.body.size), weight: DesignTokens.Typography.body.weight,
            relativeTo: .body)
    }
    /// `disabled:opacity-50` on every control.
    static let disabledOpacity = 0.5
    /// `border` (1 px).
    static let borderWidth: CGFloat = 1
    /// `shadow-sm` (Tailwind: `0 1px 2px 0 rgb(0 0 0 / 0.05)`); CSS blur is twice a SwiftUI radius.
    static let shadowSmAlpha = 0.05
    static let shadowSmRadius: CGFloat = 1
    static let shadowSmY: CGFloat = 1

    /// The corner radius of every control: `rounded-control`.
    static let radius = CGFloat(DesignTokens.Radius.control)

    /// `--duration-fast` on `--ease-glide`, the colour transition of controls; none under Reduce Motion.
    static func fastTransition(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.fast)
    }

    /// `--duration-press` ease-out, the press feedback transform; none under Reduce Motion.
    static func pressTransition(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: DesignTokens.Duration.press)
    }

    /// The snappy spring of switches and the segmented pill; none under Reduce Motion.
    static func snappySpring(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .visionSpring(DesignTokens.Spring.snappy)
    }
}

/// One `buttonVariants` button: variant colours, size geometry, hover, press feedback, disabled
/// opacity and the focus ring. `size` nil follows the SwiftUI `.controlSize`.
struct VisionButtonChrome: View {
    let configuration: ButtonStyleConfiguration
    let variant: VisionButtonVariant
    let size: VisionButtonSize?

    @Environment(\.visionTheme) private var theme
    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        let metrics = VisionControlMetrics(size: size ?? VisionControlMetrics.buttonSize(for: controlSize))
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        let resolved = resolvedVariant
        let hover = hovering && isEnabled
        configuration.label
            .font(metrics.font)
            .lineLimit(1)
            .foregroundStyle(foreground(resolved, hover: hover))
            .padding(.horizontal, metrics.horizontalPadding)
            .frame(minWidth: metrics.isIcon ? metrics.height : nil, minHeight: metrics.height)
            .background(shape.fill(fill(resolved, hover: hover)))
            .overlay(shape.strokeBorder(stroke(resolved), lineWidth: VisionControlMetrics.borderWidth))
            .shadow(
                color: .black.opacity(hasShadow(resolved) ? VisionControlMetrics.shadowSmAlpha : 0),
                radius: VisionControlMetrics.shadowSmRadius, y: VisionControlMetrics.shadowSmY
            )
            .contentShape(shape)
            .visionFocusRing(cornerRadius: VisionControlMetrics.radius)
            .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
            .scaleEffect(configuration.isPressed && isEnabled ? CGFloat(DesignTokens.Press.scale) : 1)
            .animation(VisionControlMetrics.pressTransition(reduceMotion: reduceMotion), value: configuration.isPressed)
            .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hover)
            .onHover { hovering = $0 }
    }

    /// A destructive role turns the default variant into the destructive one, as the web
    /// `variant="destructive"` does for delete actions.
    private var resolvedVariant: VisionButtonVariant {
        variant == .default && configuration.role == .destructive ? .destructive : variant
    }

    private func hasShadow(_ variant: VisionButtonVariant) -> Bool {
        switch variant {
        case .default, .destructive, .accent: return true
        case .outline, .secondary, .ghost: return false
        }
    }

    private func foreground(_ variant: VisionButtonVariant, hover: Bool) -> Color {
        let destructiveRole = configuration.role == .destructive
        switch variant {
        case .default: return theme.primaryForeground
        case .destructive: return Color(token: theme.palette.destructiveForeground)
        case .accent: return theme.accentForeground
        case .secondary: return theme.secondaryForeground
        case .outline: return destructiveRole ? theme.destructive : theme.foreground
        case .ghost:
            if destructiveRole { return theme.destructive }
            return theme.foreground.opacity(hover || configuration.isPressed ? 1 : 0.8)
        }
    }

    private func fill(_ variant: VisionButtonVariant, hover: Bool) -> AnyShapeStyle {
        let lit = hover || configuration.isPressed
        let hoverAlpha = lit ? DesignTokens.Hover.fillAlpha : 1
        switch variant {
        case .default:
            // The environment tint, so `.tint(...)` call sites keep their colour; it stays coloured
            // while the window is inactive, as the web does.
            return AnyShapeStyle(TintShapeStyle().opacity(hoverAlpha))
        case .destructive: return AnyShapeStyle(theme.destructive.opacity(hoverAlpha))
        case .accent: return AnyShapeStyle(theme.accent.opacity(hoverAlpha))
        case .outline:
            return AnyShapeStyle(Color(token: theme.palette.background, opacity: lit ? 1 : 0.8))
        case .secondary:
            return AnyShapeStyle(theme.secondary.opacity(lit ? 0.9 : 1))
        case .ghost:
            return AnyShapeStyle(theme.foreground.opacity(lit ? DesignTokens.Hover.ghostFillAlpha : 0))
        }
    }

    private func stroke(_ variant: VisionButtonVariant) -> Color {
        switch variant {
        case .outline: return Color(token: theme.palette.input, opacity: 0.7)
        case .secondary: return Color(token: theme.palette.border, opacity: 0.5)
        case .default, .destructive, .accent, .ghost: return .clear
        }
    }
}

/// Any `buttonVariants` variant and size: `.buttonStyle(.vision(.ghost, size: .icon))`.
struct VisionButtonStyle: ButtonStyle {
    var variant: VisionButtonVariant = .default
    /// nil follows `.controlSize`.
    var size: VisionButtonSize?

    func makeBody(configuration: Configuration) -> some View {
        VisionButtonChrome(configuration: configuration, variant: variant, size: size)
    }
}

/// The web `variant="outline"` button: `border-input/70`, `bg-background/80`, a brighter
/// fill on hover. Destructive-role buttons take the destructive colour for their label.
/// Sizes follow `.controlSize` (mini 28, small 32, regular 36, large 40).
struct VisionOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionButtonChrome(configuration: configuration, variant: .outline, size: nil)
    }
}

/// The web default button: a filled `--primary` (or the environment tint, so `.tint(...)`
/// call sites keep their colour) with `--primary-foreground` text and `shadow-sm`, `/0.92` on
/// hover. A destructive role gives the destructive variant. Unlike `.borderedProminent` it
/// stays coloured while the window is inactive, as the web does.
struct VisionPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionButtonChrome(configuration: configuration, variant: .default, size: nil)
    }
}

extension ButtonStyle where Self == VisionOutlineButtonStyle {
    static var visionOutline: VisionOutlineButtonStyle { VisionOutlineButtonStyle() }
}

extension ButtonStyle where Self == VisionPrimaryButtonStyle {
    static var visionPrimary: VisionPrimaryButtonStyle { VisionPrimaryButtonStyle() }
}

extension ButtonStyle where Self == VisionButtonStyle {
    /// `variant="secondary"`.
    static var visionSecondary: VisionButtonStyle { VisionButtonStyle(variant: .secondary) }
    /// `variant="ghost"`.
    static var visionGhost: VisionButtonStyle { VisionButtonStyle(variant: .ghost) }
    /// `variant="accent"`.
    static var visionAccent: VisionButtonStyle { VisionButtonStyle(variant: .accent) }
    /// `variant="destructive"`.
    static var visionDestructive: VisionButtonStyle { VisionButtonStyle(variant: .destructive) }
    /// A variant at an explicit size, including the `icon` squares.
    static func vision(_ variant: VisionButtonVariant, size: VisionButtonSize? = nil) -> VisionButtonStyle {
        VisionButtonStyle(variant: variant, size: size)
    }
}

/// The web filter chip (`Button variant="outline" size="sm"` in `TransactionsToolbar`): the
/// outline chrome drawn on a label, for `Menu` and toggle labels that cannot take a
/// `ButtonStyle`. `active` adds the primary tint the web uses for a set filter.
struct VisionChipChrome: ViewModifier {
    var active = false
    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    func body(content: Content) -> some View {
        let metrics = VisionControlMetrics(size: .sm)
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        content
            .font(metrics.font)
            .padding(.horizontal, metrics.horizontalPadding)
            .frame(height: metrics.height)
            .background(
                shape.fill(
                    active
                        ? AnyShapeStyle(theme.primary.opacity(0.12))
                        : AnyShapeStyle(
                            Color(token: theme.palette.background, opacity: hovering && isEnabled ? 1 : 0.8)))
            )
            .overlay(
                shape.strokeBorder(
                    active ? theme.primary.opacity(0.45) : Color(token: theme.palette.input, opacity: 0.7),
                    lineWidth: VisionControlMetrics.borderWidth)
            )
            .contentShape(shape)
            .visionFocusRing(cornerRadius: VisionControlMetrics.radius)
            .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
            .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
            .onHover { hovering = $0 }
    }
}

extension View {
    func visionChipChrome(active: Bool = false) -> some View { modifier(VisionChipChrome(active: active)) }

    /// The page-header "View" menu (`Button variant="outline"` with the sliders icon and the label,
    /// the trigger of the Categories, Planned and Payees view dropdowns): the outline button chrome
    /// on a `Menu` whose label is a `Label`, with no menu indicator.
    func visionViewMenu() -> some View {
        menuStyle(.button)
            .buttonStyle(.vision(.outline))
            .menuIndicator(.hidden)
            .fixedSize()
    }

    /// The page-header "more actions" menu (`RowMenu variant="outline" size="icon"`): an outline
    /// icon square (`h-9 w-9`) with no menu indicator, for a `Menu` whose label is the ellipsis.
    /// Without the explicit button style a bare `Menu` draws a tiny grey pill.
    func visionMoreActionsMenu() -> some View {
        menuStyle(.button)
            .buttonStyle(.vision(.outline, size: .icon))
            .menuIndicator(.hidden)
            .fixedSize()
    }
}

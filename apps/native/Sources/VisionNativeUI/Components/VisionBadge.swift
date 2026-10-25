import SwiftUI
import VisionNativeCore

/// The variants of `Badge` (apps/frontend/src/components/ui/badge.tsx).
enum BadgeTone: Sendable {
    case primary
    case secondary
    case muted
    case outline
    case accent
    case success
    case warning
    case destructive
}

/// `Badge` (components/ui/badge.tsx): `inline-flex items-center rounded-full border px-2.5 py-0.5
/// type-footnote font-medium` with a fast colour transition and the focus ring. Hover brightens the
/// fill as `hover:bg-*` does for the variants that define one.
struct VisionBadge: View {
    let text: String
    var tone: BadgeTone = .secondary
    /// `size="sm"`: `px-2 py-0.5`.
    var small = false
    /// `className="font-mono"`: tickers and other identifiers.
    var monospaced = false
    @Environment(\.visionTheme) var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        Text(text)
            .font(
                monospaced
                    ? Font.system(size: CGFloat(DesignTokens.Typography.footnote.size), weight: .medium, design: .monospaced)
                    : VisionFonts.body(CGFloat(DesignTokens.Typography.footnote.size), weight: 500, relativeTo: .footnote)
            )
            .lineLimit(1)
            .padding(.horizontal, small ? 8 : 10)
            .padding(.vertical, 2)
            .foregroundStyle(foreground)
            .background(Capsule().fill(fill))
            .overlay(Capsule().strokeBorder(stroke, lineWidth: VisionControlMetrics.borderWidth))
            .visionFocusRing(in: Capsule())
            .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
            .onHover { hovering = $0 }
    }

    private var foreground: Color {
        switch tone {
        case .primary: return theme.primary
        case .secondary, .outline: return theme.foreground.opacity(0.8)
        case .muted: return Color(token: theme.palette.mutedForeground)
        case .accent: return Color(token: theme.palette.accentForeground)
        case .success: return theme.success
        case .warning: return theme.warning
        case .destructive: return theme.destructive
        }
    }

    private var fill: Color {
        switch tone {
        case .primary: return theme.primary.opacity(hovering ? 0.2 : 0.15)
        case .secondary: return theme.foreground.opacity(hovering ? 0.1 : 0.06)
        case .muted: return theme.muted
        case .outline: return theme.foreground.opacity(hovering ? 0.04 : 0)
        case .accent: return Color(token: theme.palette.accent, opacity: hovering ? 0.25 : 0.2)
        case .success: return theme.success.opacity(0.15)
        case .warning: return theme.warning.opacity(hovering ? 0.2 : 0.15)
        case .destructive: return theme.destructive.opacity(hovering ? 0.2 : 0.15)
        }
    }

    private var stroke: Color {
        switch tone {
        case .primary: return theme.primary.opacity(0.25)
        case .secondary, .muted: return Color.clear
        case .outline: return theme.border.opacity(0.7)
        case .accent: return Color(token: theme.palette.accent, opacity: 0.35)
        case .success: return theme.success.opacity(0.3)
        case .warning: return theme.warning.opacity(0.4)
        case .destructive: return theme.destructive.opacity(0.3)
        }
    }
}

/// `PlannedDueBadge`: no date, invalid, today, overdue, tomorrow, in N days or the date.
struct PlannedDueBadge: View {
    let state: PlannedDueState
    let strings: any Localizing
    let format: AppDateFormat

    var body: some View {
        VisionBadge(text: state.text(strings, format: format), tone: tone)
    }

    private var tone: BadgeTone {
        switch state {
        case .noDate, .invalid, .date: return .secondary
        case .today: return .warning
        case .overdue: return .destructive
        case .tomorrow, .inDays: return .accent
        }
    }
}

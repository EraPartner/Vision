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

/// `Badge`: a small capsule label.
struct VisionBadge: View {
    let text: String
    var tone: BadgeTone = .secondary
    /// `size="sm"`.
    var small = false
    @Environment(\.visionTheme) var theme

    var body: some View {
        Text(text)
            .font(small ? .caption2.weight(.medium) : .caption.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, small ? 6 : 8)
            .padding(.vertical, small ? 1 : 2)
            .foregroundStyle(foreground)
            .background(Capsule().fill(fill))
            .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
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
        case .primary: return theme.primary.opacity(0.15)
        case .secondary: return theme.foreground.opacity(0.06)
        case .muted: return theme.muted
        case .outline: return Color.clear
        case .accent: return Color(token: theme.palette.accent, opacity: 0.2)
        case .success: return theme.success.opacity(0.15)
        case .warning: return theme.warning.opacity(0.15)
        case .destructive: return theme.destructive.opacity(0.15)
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

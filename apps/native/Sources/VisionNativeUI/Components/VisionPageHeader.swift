import SwiftUI
import VisionNativeCore

/// `PageHeader` with its icon: the page's SF Symbol in a rounded square, the title and the
/// subtitle, and the header actions on the trailing side.
struct VisionPageHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    @ViewBuilder var actions: () -> Actions
    @Environment(\.visionTheme) var theme

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // PageHeader's default icon: a bare 20 pt muted glyph in a 36 pt slot (its gradient
            // tile only shows when a page passes an icon colour).
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(Color(token: theme.palette.mutedForeground))
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.visionLargeTitle)
                    .accessibilityAddTraits(.isHeader)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            Spacer(minLength: 16)
            actions()
        }
    }
}

extension VisionPageHeader where Actions == EmptyView {
    init(title: String, subtitle: String, symbol: String) {
        self.init(title: title, subtitle: subtitle, symbol: symbol) { EmptyView() }
    }
}

/// `EmptyState` (compact): an icon, a title, a description and an action.
struct VisionEmptyState<Action: View>: View {
    let symbol: String
    let title: String
    var description: String?
    @ViewBuilder var action: () -> Action
    @Environment(\.visionTheme) var theme

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(theme.tertiaryLabel)
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if let description {
                Text(description)
                    .font(.callout)
                    .foregroundStyle(theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
            action()
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

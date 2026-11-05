import SwiftUI

/// DisclosureGroup is AppKit-backed, and ImageRenderer cannot draw platform controls into a
/// printed page. Print reports show the same title and, when expanded, the same content
/// as plain SwiftUI; on screen this is an ordinary DisclosureGroup.
struct VisionDisclosure<Content: View>: View {
    let title: String
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content
    @Environment(\.visionTheme) private var theme

    var body: some View {
        if theme.isPrintReport {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(theme.secondaryLabel)
                    Text(title)
                }
                if isExpanded { content() }
            }
        } else {
            DisclosureGroup(title, isExpanded: $isExpanded) { content() }
        }
    }
}

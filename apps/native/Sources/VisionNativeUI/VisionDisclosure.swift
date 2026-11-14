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

/// The web `<details>`/`<summary>` (components/ui/disclosure.tsx): the whole summary row, not
/// only the marker, opens and closes the section (`cursor-pointer select-none`). The marker is a
/// chevron in `text-label-tertiary` before the label that turns down when open. Set once at the
/// shell root, so every `DisclosureGroup` behaves this way.
struct VisionDisclosureGroupStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VisionDisclosureGroupBody(configuration: configuration)
    }
}

private struct VisionDisclosureGroupBody: View {
    let configuration: DisclosureGroupStyleConfiguration
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(theme.tertiaryLabel)
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                    configuration.label
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}

extension DisclosureGroupStyle where Self == VisionDisclosureGroupStyle {
    static var vision: VisionDisclosureGroupStyle { VisionDisclosureGroupStyle() }
}

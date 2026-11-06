import SwiftUI
import VisionNativeCore

extension EnvironmentValues {
    /// The shell's strings, for leaf views (charts) that are not handed them. `nil` outside the shell.
    @Entry var visionStrings: (any Localizing)? = nil
}

extension View {
    /// The web chart's default `aria-label` summary (`chartAria.ts`), spoken as this chart's
    /// accessibility value; the chart keeps its title as the label.
    func chartAccessibilitySummary(_ summary: @escaping (any Localizing) -> String) -> some View {
        modifier(ChartAccessibilitySummaryModifier(summary: summary))
    }
}

private struct ChartAccessibilitySummaryModifier: ViewModifier {
    let summary: (any Localizing) -> String
    @Environment(\.visionStrings) private var strings

    func body(content: Content) -> some View {
        if let strings { content.accessibilityValue(summary(strings)) } else { content }
    }
}

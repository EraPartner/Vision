import SwiftUI

/// Runs its content in its own `body`, so the observable model reads of a page section invalidate
/// this view and not the page that holds it: one widget's data arriving re-renders that widget,
/// not every section of the page. The page still rebuilds every scope when its own state changes,
/// since a closure cannot be compared. The content keeps its place in the tree, so a section's
/// `@State` stays where it was.
struct ObservationScope<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder _ content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View { content() }
}

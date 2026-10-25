import SwiftUI
import VisionNativeCore

struct ResearchDossierConfirmationView: View {
    let model: ResearchDossiersModel
    /// The review being asked about. The dialog keeps it through its exit motion, after the model
    /// has already cleared `pendingReview`.
    let review: ResearchDossierReview
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var blocksConfirmation: Bool {
        guard let pending = model.pendingReview else { return true }
        switch pending.action {
        case .delete, .restore: return model.busy
        default: return false
        }
    }
    var body: some View {
        // `AlertDialogContent`: no close control, title-2 heading, secondary body description,
        // and the actions right-aligned with the confirming action last.
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t(review.titleKey)).font(.visionCardTitle).foregroundStyle(theme.foreground)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(strings.t(review.descriptionKey)).font(.body).foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VisionDialogFooter {
                Button(strings.t("common.cancel")) { model.cancelPendingReview() }.keyboardShortcut(.cancelAction)
                    .buttonStyle(.visionOutline)
                Button(strings.t(review.confirmKey), role: review.destructive ? .destructive : nil) {
                    Task { await model.confirmPendingReview() }
                }.buttonStyle(.visionPrimary).tint(review.destructive ? theme.destructive : theme.primary)
                    .keyboardShortcut(.defaultAction).disabled(blocksConfirmation)
            }
        }.visionDialogPadding().frame(width: 512).accessibilityElement(children: .contain)
    }
}

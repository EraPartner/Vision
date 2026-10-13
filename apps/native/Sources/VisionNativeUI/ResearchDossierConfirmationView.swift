import SwiftUI
import VisionNativeCore

struct ResearchDossierConfirmationView: View {
    let model: ResearchDossiersModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var blocksConfirmation: Bool {
        guard let review = model.pendingReview else { return true }
        switch review.action {
        case .delete, .restore: return model.busy
        default: return false
        }
    }
    var body: some View {
        if let review = model.pendingReview {
            VStack(alignment: .leading, spacing: 18) {
                Text(strings.t(review.titleKey)).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(strings.t(review.descriptionKey)).font(.callout).foregroundStyle(theme.secondaryLabel)
                HStack {
                    Button(strings.t("common.cancel")) { model.cancelPendingReview() }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button(strings.t(review.confirmKey), role: review.destructive ? .destructive : nil) {
                        Task { await model.confirmPendingReview() }
                    }.buttonStyle(.borderedProminent).tint(review.destructive ? theme.destructive : theme.primary)
                        .keyboardShortcut(.defaultAction).disabled(blocksConfirmation)
                }
            }.padding(24).frame(width: 470).accessibilityElement(children: .contain)
        }
    }
}

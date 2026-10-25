import SwiftUI
import VisionNativeCore

/// The review's successful commit notice survives its replacement navigation to Portfolio.
struct PortfolioImportSuccessToast: View {
    let model: PortfolioImportReviewModel
    let shell: NativeShellModel
    @State private var notice: ScreenNotice?
    @State private var sequence = 0

    var body: some View {
        NoticeToast(notice: notice, strings: shell.strings) { id in
            if notice?.id == id { notice = nil }
        }
        .allowsHitTesting(false)
        .onChange(of: model.commitResult) { _, result in
            guard let result else { return }
            sequence &+= 1
            notice = ScreenNotice(
                id: sequence, kind: .success, key: "portfolioImport.toast.importSuccess",
                variables: ["n": String(result.imported), "dups": String(result.duplicates)])
        }
    }
}

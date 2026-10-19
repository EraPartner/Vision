import SwiftUI
import VisionNativeCore

struct ResearchChartBuilderSaveSheet: View {
    @Bindable var model: ResearchChartBuilderModel
    let shell: NativeShellModel
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(strings.t("research.builder.saveAsTitle")).font(.title2.weight(.semibold))
                Spacer()
                Button {
                    model.isSaveDialogPresented = false
                } label: {
                    Image(systemName: "xmark")
                }.accessibilityLabel(strings.t("common.close"))
            }
            Text(strings.t("research.builder.saveAsDescription")).font(.callout).foregroundStyle(theme.secondaryLabel)
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("research.builder.layoutName")).font(.caption)
                TextField("", text: Binding(get: { model.layoutName }, set: { model.layoutName = Self.limit($0) }))
                    .textFieldStyle(.vision).focused($focused).disabled(model.isStorageAction)
                    .accessibilityLabel(strings.t("research.builder.layoutName"))
                    .onSubmit { Task { await model.saveAs() } }
            }
            if !model.isStorageLoaded && model.storageStatus == .failed {
                Button(strings.t("common.retry")) { Task { await model.retryStorageLoad() } }
            }
            HStack {
                Button(strings.t("common.cancel")) { model.isSaveDialogPresented = false }
                Spacer()
                Button(strings.t("research.builder.saveLayout")) { Task { await model.saveAs() } }.buttonStyle(.visionPrimary
                ).disabled(
                    model.layoutName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isStorageAction
                        || !model.isStorageLoaded)
            }
        }.padding(24).frame(width: 470).interactiveDismissDisabled(model.isStorageAction).onAppear { focused = true }
            .overlay(alignment: .bottom) {
                if model.notice?.kind == .error {
                    NoticeToast(notice: model.notice, strings: strings, clear: model.clearNotice)
                }
            }
    }
    private static func limit(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            let part = String(scalar)
            if result.utf16.count + part.utf16.count > 80 { break }
            result += part
        }
        return result
    }
}

struct ResearchChartBuilderNoticeView: View {
    let model: ResearchChartBuilderModel
    let shell: NativeShellModel
    var body: some View {
        if !model.isSaveDialogPresented
            && (model.notice?.key != "research.builder.layoutDeleted" || model.canUndoDelete)
        {
            ActionToast(
                notice: model.notice, strings: shell.strings,
                actionTitle: model.notice?.key == "research.builder.layoutDeleted" && model.canUndoDelete
                    ? shell.strings.t("common.undo") : nil,
                duration: model.notice?.key == "research.builder.layoutDeleted" ? .seconds(8) : .seconds(4),
                action: {
                    let noticeId = model.notice?.id
                    Task { if await model.undoDelete(), let noticeId { model.clearNotice(noticeId) } }
                }, clear: model.clearNotice)
        }
    }
}

import SwiftUI
import VisionNativeCore

struct PortfolioImportSessionView: View {
    let model: PortfolioImportSessionModel
    let shell: NativeShellModel
    var isLocked = false
    var onReviewHistory: () -> Void = {}
    var onRecover: () async -> Void = {}
    @State private var fileErrorKey: String?
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var locked: Bool { isLocked || model.locked }
    var body: some View {
        AdminCard {
            VStack(alignment: .leading, spacing: 20) {
                Text(strings.t("portfolioImport.session.title")).font(.headline)
                Text(strings.t("portfolioImport.session.description")).foregroundStyle(theme.secondaryLabel)
                PortfolioImportFileDropzone(
                    multiple: true, strings: strings, isDisabled: locked,
                    maximumFiles: max(0, 100 - model.statements.count),
                    onFiles: { files in
                        fileErrorKey = nil
                        await model.addFiles(files)
                    }, onUnreadable: { fileErrorKey = "portfolioImport.invalidFile" },
                    onTooMany: { fileErrorKey = "portfolioImport.session.tooMany" })
                if let key = fileErrorKey { Text(strings.t(key)).foregroundStyle(theme.destructive) }
                ForEach(model.statements) { statement in
                    PortfolioImportStatementView(statement: statement, model: model, shell: shell, isLocked: isLocked)
                }
                policySettings
                HStack(spacing: 12) {
                    Button(strings.t("portfolioImport.session.stage")) { Task { await model.stage() } }
                        .buttonStyle(.visionPrimary).disabled(
                            !model.canStage || model.operation != .idle || isLocked)
                    if model.operation == .staging {
                        Button(strings.t("portfolioImport.session.stop")) { model.stop() }
                    }
                    Button(strings.t("portfolioImport.session.preview")) { Task { await model.preview() } }
                        .disabled(!model.canPreview || isLocked)
                    if !model.statements.isEmpty {
                        Button(strings.t("portfolioImport.session.clear")) { model.clear() }.disabled(locked)
                    }
                }
                if model.stopped {
                    Text(strings.t("portfolioImport.session.stopped")).foregroundStyle(theme.secondaryLabel)
                }
                if model.operation == .preview {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(strings.t("portfolioImport.session.previewing"))
                    }
                }
                if let error = model.error {
                    Text(strings.t(error)).foregroundStyle(theme.destructive).textSelection(.enabled)
                }
                if model.outcomeUncertain {
                    Text(strings.t("portfolioImport.session.responseUnverified")).foregroundStyle(theme.warning)
                    HStack {
                        Button(strings.t("portfolioImport.session.history.title"), action: onReviewHistory)
                        Button(strings.t("common.retry")) { Task { await onRecover() } }.disabled(
                            locked || model.isBusy)
                    }
                }
                PortfolioImportReconciliationView(model: model, shell: shell)
            }
        }
    }
    private var policySettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(
                strings.t("portfolioImport.session.policy"),
                selection: Binding(get: { model.policy }, set: { model.setPolicy($0) })
            ) {
                Text(strings.t("portfolioImport.session.auto")).tag(PortfolioImportSessionPolicy.auto)
                Text(strings.t("portfolioImport.session.preserve")).tag(PortfolioImportSessionPolicy.preserveExisting)
                Text(strings.t("portfolioImport.session.source")).tag(PortfolioImportSessionPolicy.preferSource)
            }.disabled(locked)
            Text(strings.t("portfolioImport.session.policyHint." + model.policy.rawValue)).font(.caption).foregroundStyle(
                theme.secondaryLabel)
        }
    }
}

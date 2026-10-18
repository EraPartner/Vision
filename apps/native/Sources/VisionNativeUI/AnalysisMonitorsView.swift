import SwiftUI
import VisionNativeCore

public struct AnalysisMonitorsView: View {
    let model: AnalysisMonitorsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    public init(model: AnalysisMonitorsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VisionPageLayout.spacing) {
                VisionPageHeader(
                    title: strings.t("monitors.title"), subtitle: strings.t("monitors.intro"), symbol: "bell.badge"
                ) {}
                if let error = model.actionError { Text(error).foregroundStyle(theme.destructive) }
                if let validation = model.validation {
                    Text(validationMessage(validation)).foregroundStyle(theme.destructive)
                }
                if let notice = model.notice {
                    Text(noticeMessage(notice)).foregroundStyle(theme.primary).accessibilityAddTraits(
                        .updatesFrequently)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 24) {
                        left.frame(width: 350)
                        right.frame(minWidth: 460, maxWidth: .infinity)
                    }
                    VStack(alignment: .leading, spacing: 24) {
                        left
                        right
                    }
                }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            await model.load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { break }
                await model.poll()
            }
        }
        .confirmationDialog(
            strings.t("monitors.deleteTitle"),
            isPresented: Binding(
                get: { model.deletingRule != nil }, set: { if !$0 { model.deletingRule = nil } }),
            titleVisibility: .visible
        ) {
            Button(strings.t("common.delete"), role: .destructive) { Task { await model.deleteConfirmed() } }
            Button(strings.t("common.cancel"), role: .cancel) { model.deletingRule = nil }
        } message: {
            Text(strings.t("monitors.deleteConfirm"))
        }
    }
    private var left: some View {
        VStack(alignment: .leading, spacing: 24) {
            AnalysisMonitorsCreationView(model: model, shell: shell)
            AnalysisMonitorsRulesView(model: model, strings: strings)
        }
    }
    private var right: some View {
        VStack(alignment: .leading, spacing: 24) {
            AnalysisMonitorsDetailsView(model: model, strings: strings)
            AnalysisMonitorsHistoryView(model: model, strings: strings)
            AnalysisMonitorsNotificationsView(model: model, strings: strings)
        }
    }
    private func validationMessage(_ input: AnalysisMonitorInput) -> String {
        switch input {
        case .title: return strings.t("monitors.titleRequired")
        case .target: return strings.t("monitors.dossierRequired")
        case .field, .threshold: return strings.t("monitors.thresholdRequired")
        case .interval: return strings.t("monitors.interval") + " (15–10080)"
        case .cooldown: return strings.t("monitors.cooldown") + " (0–10080)"
        }
    }
    private func noticeMessage(_ notice: ScreenNotice) -> String {
        if let status = notice.variables["statusKey"] { return strings.t(notice.key, ["status": strings.t(status)]) }
        return strings.t(notice.key, notice.variables)
    }
}

struct AnalysisMonitorsRetry: View {
    let message: String
    let loading: Bool
    let strings: any Localizing
    let retry: () async -> Void
    @Environment(\.visionTheme) private var theme
    var body: some View {
        HStack(alignment: .top) {
            Text(message).font(.callout).foregroundStyle(theme.destructive)
            Spacer(minLength: 8)
            Button(strings.t("common.retry")) { Task { await retry() } }.disabled(loading)
        }
    }
}

struct AnalysisMonitorsPager: View {
    let offset: Int
    let total: Int
    let pageSize: Int
    var showRange = true
    let strings: any Localizing
    let change: (Int) async -> Void
    var body: some View {
        HStack(spacing: 8) {
            Button(strings.t("monitors.previous")) { Task { await change(max(0, offset - pageSize)) } }.disabled(
                offset == 0)
            if showRange {
                Text(
                    strings.t(
                        "monitors.pageRange",
                        [
                            "first": String(offset + 1), "last": String(min(offset + pageSize, total)),
                            "total": String(total),
                        ])
                )
                .font(.caption).monospacedDigit()
            }
            Button(strings.t("monitors.next")) { Task { await change(offset + pageSize) } }.disabled(
                offset + pageSize >= total)
        }.buttonStyle(.bordered).controlSize(.small)
    }
}

import SwiftUI
import VisionNativeCore

/// Native setup keeps the seven source steps, resource receipts and v1 resumable draft.
public struct NativeOnboardingView: View {
    @Bindable var model: NativeOnboardingModel
    let shell: NativeShellModel
    @AccessibilityFocusState private var headingFocused: Bool
    @Environment(\.visionTheme) private var theme
    public init(model: NativeOnboardingModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(strings.t("onboarding.\(model.draft.step.rawValue).title"))
                        .font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($headingFocused)
                    if model.draft.step != .importData {
                        Text(strings.t("onboarding.\(model.draft.step.rawValue).desc"))
                            .foregroundStyle(theme.secondaryLabel)
                    }
                    switch model.draft.step {
                    case .welcome: welcome
                    case .overview: overview
                    case .categories: NativeOnboardingCategoriesView(model: model, strings: strings)
                    case .bank: NativeOnboardingBankView(model: model, strings: strings)
                    case .importData: NativeOnboardingImportView(model: model, strings: strings)
                    case .tour: tour
                    case .backup: backup
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(26)
            }
            Divider()
            footer
        }
        .frame(width: 680, height: 650)
        .background(theme.background)
        .environment(\.nativeNoticeCenter, shell.notices)
        .accessibilityLabel(strings.t("onboarding.wizard.title"))
        .disabled(model.isCompleting)
        .onAppear { model.strings = strings }
        .onChange(of: shell.settings.language) { _, _ in model.strings = strings }
        .onChange(of: model.draft.step) { _, _ in headingFocused = true }
        .onKeyPress(.escape) {
            Task { await model.finish() }
            return .handled
        }
        .overlay(alignment: .bottom) {
            NativeNoticeHost(center: shell.notices, strings: strings)
            if let notice = model.notice {
                NoticeToast(notice: notice, strings: strings, clear: model.clearNotice)
            }
        }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Vision", systemImage: "sparkles").font(.title3.weight(.semibold))
                Spacer()
                Button {
                    Task { await model.finish() }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain).accessibilityLabel(strings.t("aria.close"))
                .keyboardShortcut(.cancelAction).help(strings.t("aria.close"))
            }
            ProgressView(value: Double(model.stepIndex + 1), total: 7)
                .accessibilityLabel(
                    strings.t(
                        "onboarding.stepOf",
                        [
                            "n": String(model.stepIndex + 1), "total": "7",
                            "label": strings.t("onboarding.step.\(model.draft.step.rawValue).label"),
                        ]))
            Text(
                strings.t(
                    "onboarding.stepOf",
                    [
                        "n": String(model.stepIndex + 1), "total": "7",
                        "label": strings.t("onboarding.step.\(model.draft.step.rawValue).label"),
                    ])
            )
            .font(.caption).foregroundStyle(theme.secondaryLabel)
        }.padding(22)
    }
    private var footer: some View {
        HStack {
            if model.stepIndex > 0 {
                Button(strings.t("onboarding.back"), action: model.back)
            } else {
                Button(strings.t("onboarding.skipSetup")) { Task { await model.finish() } }
            }
            Spacer()
            if model.isCompleting { ProgressView().controlSize(.small) }
            if model.draft.step == .backup {
                Button(
                    strings.t(model.draft.reviewBatch == nil ? "onboarding.goToDashboard" : "onboarding.finishImport")
                ) {
                    Task { await model.finishFinalStep() }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            } else {
                Button(
                    strings.t(model.draft.step == .welcome ? "onboarding.getStarted" : "onboarding.nextStep"),
                    action: model.next
                )
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(20)
    }
    private var welcome: some View {
        VStack(spacing: 24) {
            Image(systemName: "sparkles").font(.system(size: 64)).foregroundStyle(theme.primary).accessibilityHidden(
                true)
            HStack(spacing: 20) {
                Label(strings.t("onboarding.importCSV"), systemImage: "square.and.arrow.up")
                Label(strings.t("onboarding.step.categories.label"), systemImage: "tag")
                Label(strings.t("onboarding.analytics"), systemImage: "chart.bar")
            }.font(.callout)
            NativeOnboardingRestoreView(onboarding: model, shell: shell)
        }.frame(maxWidth: .infinity)
    }
    private var overview: some View {
        VStack(spacing: 18) {
            overviewGroup("budgeting", items: Array(NativeOnboardingFeature.all.prefix(4)))
            overviewGroup("portfolio", items: Array(NativeOnboardingFeature.all.suffix(2)))
        }
    }
    private func overviewGroup(_ section: String, items: [NativeOnboardingFeature]) -> some View {
        GroupBox(strings.t("onboarding.overview.\(section).label")) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(items) { feature in featureLabel(feature) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
        }
    }
    private var tour: some View {
        LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
            ForEach(NativeOnboardingFeature.all) { feature in
                Button {
                    Task { await model.finish(path: feature.path) }
                } label: {
                    featureLabel(feature).frame(maxWidth: .infinity, minHeight: 65, alignment: .leading).padding(10)
                }.buttonStyle(.bordered)
            }
        }
    }
    private func featureLabel(_ feature: NativeOnboardingFeature) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: feature.symbol).foregroundStyle(theme.primary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("onboarding.feature.\(feature.id).title")).font(.headline)
                Text(strings.t("onboarding.feature.\(feature.id).desc")).font(.caption).foregroundStyle(
                    theme.secondaryLabel)
            }
        }
    }
    private var backup: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(["safe", "local", "restore"], id: \.self) { reason in
                Label(strings.t("onboarding.backup.reason.\(reason)"), systemImage: "checkmark.shield")
            }
            Text(strings.t("onboarding.backup.hint")).font(.caption).foregroundStyle(theme.secondaryLabel)
            Button(strings.t("onboarding.backup.openSettings")) {
                Task { await model.finish(settingsSection: "backup") }
            }
            .buttonStyle(.borderedProminent)
            Divider()
            Text(strings.t("onboarding.restore.orTitle")).font(.caption).foregroundStyle(theme.secondaryLabel)
            NativeOnboardingRestoreView(onboarding: model, shell: shell)
        }
    }
}

struct NativeOnboardingFeature: Identifiable {
    let id: String
    let path: String
    let symbol: String
    static let all: [Self] = [
        .init(id: "transactions", path: "/transactions", symbol: "list.bullet.rectangle"),
        .init(id: "categories", path: "/categories", symbol: "tag"),
        .init(id: "planned", path: "/planned", symbol: "calendar"),
        .init(id: "statistics", path: "/statistics", symbol: "chart.bar"),
        .init(id: "portfolio", path: "/portfolio", symbol: "chart.line.uptrend.xyaxis"),
        .init(id: "market", path: "/research/market", symbol: "magnifyingglass"),
    ]
}

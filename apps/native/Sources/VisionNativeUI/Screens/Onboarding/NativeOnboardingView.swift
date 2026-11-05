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
                        .font(
                            model.draft.step == .welcome
                                ? Font.visionTitle1 : .visionCardTitle
                        )
                        .accessibilityAddTraits(.isHeader)
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
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            }
            Divider()
            footer
        }
        // The web wizard is `DialogContent sm:max-w-2xl` (672 pt).
        .frame(width: 672, height: 650)
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
                HStack(spacing: 8) {
                    Image(systemName: "sparkles").font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.primaryForeground).frame(width: 32, height: 32)
                        .background(
                            theme.primary,
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                        )
                        .accessibilityHidden(true)
                    Text(verbatim: "Vision").font(.visionDisplayHeadline)
                }
                Spacer()
                VisionDialogCloseButton(label: strings.t("aria.close")) {
                    Task { await model.finish() }
                }
                .keyboardShortcut(.cancelAction)
            }
            // The web step indicator: one `h-1.5` pill per step, filled up to the current one.
            HStack(spacing: 6) {
                ForEach(0..<7, id: \.self) { index in
                    Capsule()
                        .fill(index <= model.stepIndex ? theme.primary : theme.muted)
                        .frame(height: 6)
                        .frame(maxWidth: .infinity)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(stepOfText)
            HStack(spacing: 8) {
                Image(systemName: stepSymbol).font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.primary).accessibilityHidden(true)
                Text(stepOfText).font(.callout.weight(.medium)).foregroundStyle(theme.secondaryLabel)
            }
            .padding(.top, 4)
        }.padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 16)
            .background(
                LinearGradient(
                    colors: [theme.primary.opacity(0.1), theme.primary.opacity(0.05), .clear],
                    startPoint: .leading, endPoint: .trailing))
    }
    private var stepOfText: String {
        strings.t(
            "onboarding.stepOf",
            [
                "n": String(model.stepIndex + 1), "total": "7",
                "label": strings.t("onboarding.step.\(model.draft.step.rawValue).label"),
            ])
    }
    private var stepSymbol: String {
        switch model.draft.step {
        case .welcome: "sparkles"
        case .overview: "square.grid.2x2"
        case .categories: "tag"
        case .bank: "creditcard"
        case .importData: "square.and.arrow.up"
        case .tour: "map"
        case .backup: "externaldrive"
        }
    }
    /// The web footer: `border-t bg-foreground/[0.02] px-6 py-4`, a ghost Back or Skip on
    /// the leading edge and the primary step action, with its trailing arrow, opposite.
    private var footer: some View {
        HStack {
            if model.stepIndex > 0 {
                Button(action: model.back) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.left").accessibilityHidden(true)
                        Text(strings.t("onboarding.back"))
                    }
                }.buttonStyle(NativeSettingsGhostButtonStyle())
            } else {
                Button(strings.t("onboarding.skipSetup")) { Task { await model.finish() } }
                    .buttonStyle(NativeSettingsGhostButtonStyle())
            }
            Spacer()
            if model.isCompleting { ProgressView().controlSize(.small) }
            if model.draft.step == .backup {
                Button {
                    Task { await model.finishFinalStep() }
                } label: {
                    HStack(spacing: 6) {
                        Text(
                            strings.t(
                                model.draft.reviewBatch == nil ? "onboarding.goToDashboard" : "onboarding.finishImport")
                        )
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                }.buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
            } else {
                Button(action: model.next) {
                    HStack(spacing: 6) {
                        Text(strings.t(model.draft.step == .welcome ? "onboarding.getStarted" : "onboarding.nextStep"))
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                }
                .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 16)
        .background(theme.foreground.opacity(0.02))
    }
    private var welcome: some View {
        VStack(spacing: 24) {
            Image(systemName: "sparkles").font(.system(size: 64)).foregroundStyle(theme.primary).accessibilityHidden(
                true)
            // The web `Badge variant="secondary"` row.
            HStack(spacing: 8) {
                welcomeBadge(strings.t("onboarding.importCSV"), symbol: "square.and.arrow.up")
                welcomeBadge(strings.t("onboarding.step.categories.label"), symbol: "tag")
                welcomeBadge(strings.t("onboarding.analytics"), symbol: "chart.bar")
            }
            NativeOnboardingRestoreView(onboarding: model, shell: shell)
        }.frame(maxWidth: .infinity)
    }
    private func welcomeBadge(_ text: String, symbol: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).accessibilityHidden(true)
            Text(text)
        }
        .font(.caption.weight(.medium)).foregroundStyle(theme.foreground.opacity(0.8))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(Capsule().fill(theme.foreground.opacity(0.06)))
    }
    private var overview: some View {
        VStack(spacing: 18) {
            overviewGroup("budgeting", items: Array(NativeOnboardingFeature.all.prefix(4)))
            overviewGroup("portfolio", items: Array(NativeOnboardingFeature.all.suffix(2)))
        }
    }
    private func overviewGroup(_ section: String, items: [NativeOnboardingFeature]) -> some View {
        let tint = section == "budgeting" ? Color(token: theme.palette.chart3) : theme.primary
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        return VStack(alignment: .leading, spacing: 12) {
            Text(strings.t("onboarding.overview.\(section).label")).font(.footnote.weight(.medium))
                .foregroundStyle(tint).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 14) {
                ForEach(items) { feature in featureLabel(feature) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        .background(
            LinearGradient(
                colors: [tint.opacity(0.2), tint.opacity(0.05)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: shape
        )
        .overlay(shape.strokeBorder(tint.opacity(0.2), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
    private var tour: some View {
        LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
            ForEach(NativeOnboardingFeature.all) { feature in
                Button {
                    Task { await model.finish(path: feature.path) }
                } label: {
                    featureLabel(feature).frame(maxWidth: .infinity, minHeight: 65, alignment: .leading).padding(
                        .vertical, 8)
                }.buttonStyle(.visionOutline)
            }
        }
    }
    private func featureLabel(_ feature: NativeOnboardingFeature) -> some View {
        HStack(alignment: .top, spacing: 12) {
            // The web icon plate: `h-9 w-9 rounded-control bg-primary/10`.
            Image(systemName: feature.symbol).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.primary)
                .frame(width: 32, height: 32)
                .background(
                    theme.primary.opacity(0.1),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(strings.t("onboarding.feature.\(feature.id).title")).font(.headline)
                    .foregroundStyle(theme.foreground)
                Text(strings.t("onboarding.feature.\(feature.id).desc")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel
                ).lineLimit(2).multilineTextAlignment(.leading)
            }
        }
    }
    private func backupReasonSymbol(_ reason: String) -> String {
        switch reason {
        case "safe": "checkmark.shield"
        case "local": "internaldrive"
        default: "folder"
        }
    }
    private var backup: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(["safe", "local", "restore"], id: \.self) { reason in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: backupReasonSymbol(reason)).font(.system(size: 13, weight: .medium))
                            .foregroundStyle(theme.primary).frame(width: 32, height: 32)
                            .background(
                                theme.primary.opacity(0.1),
                                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
                            )
                            .accessibilityHidden(true)
                        Text(strings.t("onboarding.backup.reason.\(reason)")).font(.body)
                            .foregroundStyle(theme.foreground).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    }
                    .padding(12)
                    .visionCardBackground()
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("onboarding.backup.hint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                Button {
                    Task { await model.finish(settingsSection: "backup") }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "folder").accessibilityHidden(true)
                        Text(strings.t("onboarding.backup.openSettings"))
                    }
                }
                .buttonStyle(.visionPrimary)
            }
            HStack(spacing: 12) {
                Rectangle().fill(theme.border).frame(height: 1).accessibilityHidden(true)
                Text(strings.t("onboarding.restore.orTitle")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                    .fixedSize()
                Rectangle().fill(theme.border).frame(height: 1).accessibilityHidden(true)
            }
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

import SwiftUI
import VisionNativeCore

/// One owner on PortfolioScreenView replaces repeated refresh notices across all asset pages.
struct PortfolioPriceRefreshToast: View {
    let model: PortfolioModel
    let shell: NativeShellModel
    @State private var notice: RefreshNotice?
    @Environment(\.visionTheme) private var theme

    private struct RefreshNotice: Identifiable {
        let id: Int
        let result: PortfolioPriceRefresh?
        let error: String?
        let offline: Bool
    }

    var body: some View {
        Group {
            if let notice, !model.usesExternalPriceNotices {
                let title =
                    notice.error != nil
                    ? shell.strings.t("portfolio.refreshPricesFailedTitle")
                    : shell.strings.t("portfolio.refreshedPrices", ["n": String(notice.result?.total ?? 0)])
                let detail = description(notice)
                VStack(alignment: .leading, spacing: 2) {
                    Label(title, systemImage: symbol(notice))
                    if let detail {
                        Text(detail).font(.footnote).foregroundStyle(theme.secondaryLabel).lineLimit(3)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
                .foregroundStyle(color(notice))
                .frame(maxWidth: 560, alignment: .leading)
                .padding(.bottom, 20)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .combine)
                .task(id: notice.id) {
                    AccessibilityNotification.Announcement([title, detail].compactMap { $0 }.joined(separator: ". "))
                        .post()
                    try? await Task.sleep(for: .seconds(4))
                    guard !Task.isCancelled, self.notice?.id == notice.id else { return }
                    self.notice = nil
                }
            }
        }
        .allowsHitTesting(false)
        .animation(.easeInOut(duration: 0.2), value: notice?.id)
        .onChange(of: model.priceNoticeRevision) { _, revision in
            guard !model.usesExternalPriceNotices else { return }
            guard model.priceError != nil || model.priceRefreshResult != nil else { return }
            notice = RefreshNotice(
                id: revision, result: model.priceRefreshResult, error: model.priceError, offline: !model.isOnline)
        }
    }

    private func description(_ notice: RefreshNotice) -> String? {
        if let error = notice.error {
            return notice.offline ? shell.strings.t("portfolio.refreshPricesOffline") : error
        }
        guard let result = notice.result, result.staleCount > 0 else { return nil }
        return shell.strings.t(
            "portfolio.refreshedPricesStale",
            ["n": String(result.staleCount), "total": String(result.total ?? 0)])
    }

    private func symbol(_ notice: RefreshNotice) -> String {
        if notice.error != nil { return "exclamationmark.circle.fill" }
        return (notice.result?.staleCount ?? 0) > 0 ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
    }

    private func color(_ notice: RefreshNotice) -> Color {
        if notice.error != nil { return theme.destructive }
        return (notice.result?.staleCount ?? 0) > 0 ? theme.warning : theme.foreground
    }
}

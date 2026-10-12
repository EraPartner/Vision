import SwiftUI
import VisionNativeCore

/// `PageHeader` of the admin pages: title and subtitle.
struct AdminPageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.visionTheme) var theme

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.largeTitle.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .font(.body)
                    .foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 0)
            trailing()
        }
    }
}

extension AdminPageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// `Card`: the card background and border, with an optional status ring.
struct AdminCard<Content: View>: View {
    var padding: CGFloat = 16
    var ring: Color?
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) var theme

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                    .fill(theme.card))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                    .strokeBorder(ring ?? theme.border.opacity(0.6), lineWidth: 1))
    }
}

/// The rounded icon square of the admin cards (`bg-primary/12 text-primary`).
struct AdminIconBadge: View {
    let symbol: String
    @Environment(\.visionTheme) var theme

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(theme.primary)
            .frame(width: 40, height: 40)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control)
                    .fill(theme.primary.opacity(0.12)))
            .accessibilityHidden(true)
    }
}

/// A `Skeleton` bar.
struct SkeletonBar: View {
    let width: CGFloat?
    let height: CGFloat
    @Environment(\.visionTheme) var theme

    var body: some View {
        RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
            .fill(theme.muted)
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// `AdminErrorState`: the auth alert with its link to the token card, or the page's
/// fallback title over the humanized error.
struct AdminErrorBanner: View {
    let state: AdminErrorState
    let strings: any Localizing
    let goToToken: () -> Void
    @Environment(\.visionTheme) var theme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: state == .authentication ? "key" : "exclamationmark.triangle")
                .foregroundStyle(theme.destructive)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                switch state {
                case .authentication:
                    Text(strings.t("admin.authError.title")).font(.headline)
                    Text(strings.t("admin.authError.description"))
                    Button(strings.t("admin.authError.action"), action: goToToken)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .padding(.top, 4)
                case .message(let title, let message):
                    Text(title).font(.headline)
                    Text(message)
                }
            }
            .foregroundStyle(theme.destructive)
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.destructive.opacity(0.06)))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.destructive.opacity(0.4), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// `toast.success` / `toast.error` at the bottom of a screen, with its description line.
struct NoticeToast: View {
    let notice: ScreenNotice?
    let strings: any Localizing
    let clear: (Int) -> Void
    @Environment(\.visionTheme) var theme

    var body: some View {
        if let notice {
            let title = strings.t(notice.key, notice.variables)
            VStack(alignment: .leading, spacing: 2) {
                Label(
                    title, systemImage: notice.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                if let detail = notice.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(3)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .foregroundStyle(notice.kind == .success ? theme.foreground : theme.destructive)
            .frame(maxWidth: 520)
            .padding(.bottom, 20)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
            .task(id: notice.id) {
                AccessibilityNotification.Announcement(title).post()
                try? await Task.sleep(for: .seconds(4))
                clear(notice.id)
            }
        }
    }
}

/// The scrolling page frame of the admin screens.
struct AdminPage<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                content()
            }
            .padding(24)
            .frame(maxWidth: 1200, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(theme.foreground)
    }
}

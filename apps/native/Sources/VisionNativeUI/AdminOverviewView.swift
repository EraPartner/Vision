import SwiftUI
import VisionNativeCore

/// `/admin` (apps/frontend/src/pages/admin/AdminOverviewPage.tsx) in SwiftUI: the three
/// tiles, the admin token card and the audit history card, with the parity rows of
/// docs/reference/native-parity/admin.md.
public struct AdminOverviewView: View {
    private let model: AdminOverviewModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: AdminOverviewModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        AdminPage {
            AdminPageHeader(title: strings.t("admin.overview.title"), subtitle: strings.t("admin.overview.description"))
            tiles
            tokenCard
            AuditHistoryCardView(model: model.audit, strings: strings)
        }
        .task { await model.appear() }
        .onDisappear { model.disappear() }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: model.notice, strings: strings) { model.clearNotice($0) }
        }
    }

    // MARK: Tiles

    private var grid: [GridItem] { [GridItem(.adaptive(minimum: 260), spacing: 16)] }

    @ViewBuilder
    private var tiles: some View {
        if model.showsTileSkeleton {
            LazyVGrid(columns: grid, spacing: 16) {
                ForEach(0..<3, id: \.self) { _ in
                    AdminCard(padding: 24) {
                        HStack(spacing: 16) {
                            SkeletonBar(width: 40, height: 40)
                            VStack(alignment: .leading, spacing: 8) {
                                SkeletonBar(width: 96, height: 12)
                                SkeletonBar(width: 64, height: 24)
                            }
                        }
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(strings.t("admin.overview.title")))
            .accessibilityAddTraits(.updatesFrequently)
        } else {
            LazyVGrid(columns: grid, spacing: 16) {
                ForEach(model.tiles(settings: shell.settings, strings: strings)) { tile in
                    tileView(tile)
                }
            }
        }
    }

    private func ring(_ status: AdminOverviewTile.Status) -> Color? {
        switch status {
        case .ok: return nil
        case .warn: return theme.warning.opacity(0.4)
        case .error: return theme.destructive.opacity(0.4)
        }
    }

    /// The whole card is a link.
    private func tileView(_ tile: AdminOverviewTile) -> some View {
        Button {
            shell.navigate(to: tile.route)
        } label: {
            AdminCard(padding: 24, ring: ring(tile.status)) {
                HStack(spacing: 16) {
                    AdminIconBadge(symbol: tile.symbol)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tile.title)
                            .font(.callout)
                            .foregroundStyle(theme.secondaryLabel)
                        Text(tile.value)
                            .font(.visionCardTitle)
                            .monospacedDigit()
                        if let subtext = tile.subtext {
                            Text(subtext)
                                .font(.footnote)
                                .foregroundStyle(theme.secondaryLabel)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isLink)
    }

    // MARK: Admin token

    private var tokenDraft: Binding<String> {
        Binding(get: { model.tokenDraft }, set: { model.tokenDraft = $0 })
    }

    private var tokenCard: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    AdminIconBadge(symbol: "key")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(strings.t("admin.token.title"))
                            .font(VisionFonts.display(17, relativeTo: .title3))
                            .accessibilityAddTraits(.isHeader)
                        Text(strings.t("admin.token.description"))
                            .font(.body)
                            .foregroundStyle(theme.secondaryLabel)
                    }
                }
                HStack(spacing: 8) {
                    SecureField(strings.t("admin.token.placeholder"), text: tokenDraft)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 320)
                        .accessibilityLabel(strings.t("admin.token.title"))
                        .onSubmit { Task { await model.saveToken() } }
                    Button(strings.t("admin.token.save")) {
                        Task { await model.saveToken() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canSaveToken)
                    Button(strings.t("admin.token.clear")) {
                        Task { await model.clearToken() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!model.canClearToken)
                }
                if model.hasToken {
                    Text(strings.t("admin.token.active"))
                        .font(.footnote)
                        .foregroundStyle(theme.success)
                }
            }
        }
    }
}

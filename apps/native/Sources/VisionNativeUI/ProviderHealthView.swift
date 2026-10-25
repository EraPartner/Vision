import SwiftUI
import VisionNativeCore

/// `/admin/providers` (apps/frontend/src/pages/admin/ProviderHealthPage.tsx) in SwiftUI.
public struct ProviderHealthView: View {
    private let model: ProviderHealthModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: ProviderHealthModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        AdminPage {
            AdminPageHeader(title: strings.t("admin.providers.title"), subtitle: strings.t("admin.providers.description"))
            if let error = model.errorState(strings: strings) {
                AdminErrorBanner(state: error, strings: strings)
            }
            AdminCard(padding: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(strings.t("admin.providers.tableTitle"))
                        .font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                        .padding(24)
                    table
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
            }
        }
        .task { await model.appear() }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: model.notice, strings: strings) { model.clearNotice($0) }
        }
    }

    private func tone(_ tone: ProviderHealthRow.Tone) -> Color {
        switch tone {
        case .success: return theme.success
        case .warning: return theme.warning
        case .destructive: return theme.destructive
        }
    }

    private func badgeTone(_ tone: ProviderHealthRow.Tone) -> BadgeTone {
        switch tone {
        case .success: return .success
        case .warning: return .warning
        case .destructive: return .destructive
        }
    }

    private var table: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                header(strings.t("admin.providers.colProvider"))
                header(strings.t("admin.providers.colKind"))
                header(strings.t("admin.providers.colLastSuccess"))
                header(strings.t("admin.providers.colFailures"))
                header(strings.t("admin.providers.colLastError"))
                // `sr-only`: read by VoiceOver, not drawn.
                Text(strings.t("dbMaintenance.col.actions"))
                    .font(.caption)
                    .foregroundStyle(Color.clear)
                    .accessibilityAddTraits(.isHeader)
            }
            if model.providers.isLoading {
                ForEach(0..<7, id: \.self) { _ in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(0..<6, id: \.self) { _ in SkeletonBar(width: 72, height: 14).padding(.vertical, 10) }
                    }
                }
            } else {
                ForEach(model.rows(settings: shell.settings, strings: strings)) { row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    providerRow(row)
                    if model.isExpanded(row.provider), let error = row.lastError {
                        errorRow(error, at: row.lastErrorAt)
                    }
                }
            }
        }
    }

    private func header(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(theme.secondaryLabel)
            .padding(.vertical, 8)
            .accessibilityAddTraits(.isHeader)
    }

    private func providerRow(_ row: ProviderHealthRow) -> GridRow<some View> {
        GridRow {
            HStack(spacing: 8) {
                Image(systemName: row.tone.symbol)
                    .foregroundStyle(tone(row.tone))
                    .accessibilityHidden(true)
                Text(row.label).fontWeight(.medium)
            }
            .padding(.vertical, 6)
            VisionBadge(text: row.kind, tone: .muted, small: true)
            Text(row.lastSuccess)
                .foregroundStyle(theme.secondaryLabel)
            VisionBadge(text: row.failures, tone: badgeTone(row.tone), small: true)
                .monospacedDigit()
            if let error = row.lastError {
                Button {
                    model.toggleExpanded(row.provider)
                } label: {
                    Text(error)
                        .font(.footnote)
                        .underline()
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 200, alignment: .leading)
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.destructive)
                // `aria-expanded` without an English-only value: VoiceOver reads the toggle
                // state in the system language.
                .accessibilityAddTraits(model.isExpanded(row.provider) ? [.isToggle, .isSelected] : [.isToggle])
            } else {
                Text(verbatim: "—")
                    .font(.footnote)
                    .foregroundStyle(theme.tertiaryLabel)
            }
            Button {
                Task { await model.probe(row.provider) }
            } label: {
                Label {
                    Text(strings.t("admin.providers.checkNow"))
                } icon: {
                    Image(systemName: model.isProbing(row.provider) ? "arrow.clockwise" : "waveform.path.ecg")
                        .symbolEffect(
                            .rotate, options: .repeat(.continuous), isActive: model.isProbing(row.provider))
                }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(model.isProbing(row.provider))
            .gridColumnAlignment(.trailing)
        }
    }

    private func errorRow(_ error: String, at timestamp: String?) -> GridRow<some View> {
        GridRow {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(error)
                    .foregroundStyle(theme.destructive)
                if let timestamp {
                    Text(verbatim: "(\(timestamp))")
                        .foregroundStyle(theme.secondaryLabel)
                }
                Spacer(minLength: 0)
            }
            .font(.footnote.monospaced())
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.destructive.opacity(0.05))
            .gridCellColumns(6)
        }
    }
}

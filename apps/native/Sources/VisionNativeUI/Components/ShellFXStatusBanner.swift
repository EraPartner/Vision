import SwiftUI
import VisionNativeCore

public struct ShellFXStatusBanner: View {
    let model: ShellFXStatusModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: ShellFXStatusModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    public var body: some View {
        if model.shouldShow, let data = model.data {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.warning)
                    .frame(width: 16, height: 28)
                    .accessibilityHidden(true)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        message(data)
                        refresh
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        message(data)
                        refresh
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    model.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(theme.secondaryLabel)
                .accessibilityLabel(shell.strings.t("layout.dismiss"))
            }
            .padding(.leading, 16)
            .padding(.trailing, 10)
            .padding(.vertical, 10)
            .background(
                theme.warning.opacity(0.08),
                in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                    .strokeBorder(theme.warning.opacity(0.3), lineWidth: 1))
            .accessibilityElement(children: .contain)
        }
    }

    private func message(_ data: OpenAPI.ExchangeRates) -> some View {
        Text(
            data.source == .fallback
                ? shell.strings.t("exchangeRates.fallbackInUse")
                : shell.strings.t(
                    "exchangeRates.staleWarning",
                    [
                        "date": data.lastFetchedAt.map {
                            VisionFormat.appDateTime(
                                $0, format: shell.settings.dateFormat, locale: shell.settings.numberFormat.locale)
                        } ?? "—"
                    ])
        )
        .foregroundStyle(theme.foreground)
    }
    private var refresh: some View {
        Button {
            Task { await model.refresh() }
        } label: {
            Label(shell.strings.t("exchangeRates.refresh"), systemImage: "arrow.clockwise")
        }.buttonStyle(.visionOutline).controlSize(.small).disabled(model.isBusy)
    }
}

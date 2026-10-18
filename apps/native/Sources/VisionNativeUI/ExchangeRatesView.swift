import SwiftUI
import VisionNativeCore

/// `/admin/exchange-rates` (apps/frontend/src/pages/admin/ExchangeRatesPage.tsx) in
/// SwiftUI, with the parity rows of docs/reference/native-parity/admin.md.
public struct ExchangeRatesView: View {
    private let model: ExchangeRatesModel
    private let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme

    public init(model: ExchangeRatesModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }

    private var strings: any Localizing { shell.strings }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VisionPageLayout.spacing) {
                header
                content
            }
            .padding(VisionPageLayout.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(theme.foreground)
        .task { await model.appear() }
        .overlay(alignment: .bottom) { noticeView }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("exchangeRates.title"))
                    .font(.visionLargeTitle)
                    .accessibilityAddTraits(.isHeader)
                Text(strings.t("exchangeRates.subtitle"))
                    .font(.body)
                    .foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 0)
            refreshButton(disabled: model.isRefreshDisabled)
        }
    }

    /// The header and empty-state Refresh: a spinning icon while refreshing.
    private func refreshButton(disabled: Bool) -> some View {
        Button {
            Task { await model.refresh() }
        } label: {
            Label {
                Text(strings.t("exchangeRates.refresh"))
            } icon: {
                Image(systemName: "arrow.clockwise")
                    .symbolEffect(.rotate, options: .repeat(.continuous), isActive: model.isRefreshing)
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(disabled)
    }

    // MARK: States

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            loadingView
        case .failed:
            errorView
        case .loaded(let data):
            loadedView(
                ExchangeRatesPresentation(
                    data: data, tab: ExchangeRatesTab(route: shell.route), settings: shell.settings, strings: strings))
        }
    }

    private var loadingView: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                ForEach(0..<3, id: \.self) { _ in
                    card {
                        VStack(alignment: .leading, spacing: 10) {
                            placeholder(width: 112, height: 14)
                            placeholder(width: 80, height: 26)
                            placeholder(width: 144, height: 12)
                        }
                    }
                }
            }
            placeholder(width: 224, height: 34)
            placeholder(width: nil, height: 288)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(strings.t("exchangeRates.title")))
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func placeholder(width: CGFloat?, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
            .fill(Color(token: theme.palette.muted))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }

    /// `PageError`.
    private var errorView: some View {
        card {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title)
                    .foregroundStyle(theme.destructive)
                    .accessibilityHidden(true)
                Text(strings.t("common.error"))
                    .font(.headline)
                Text(strings.t("exchangeRates.failedToLoad"))
                    .foregroundStyle(theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                Button(strings.t("common.retry")) {
                    Task { await model.retry() }
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        }
    }

    private func loadedView(_ presentation: ExchangeRatesPresentation) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 16)], spacing: 16) {
                ForEach(presentation.cards) { summary in
                    summaryCard(summary)
                }
            }
            Picker(strings.t("exchangeRates.viewLabel"), selection: tabSelection) {
                ForEach(ExchangeRatesTab.allCases, id: \.self) { tab in
                    Label(strings.t(tab.titleKey), systemImage: tab.symbol).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityLabel(strings.t("exchangeRates.viewLabel"))
            switch presentation.content {
            case .empty(let title, let message):
                emptyState(title: title, message: message)
            case .table(let table):
                ratesTable(table, columns: presentation.columns)
            }
        }
    }

    /// `useTabParam`: the tab lives in `?tab`, written with `replace`.
    private var tabSelection: Binding<ExchangeRatesTab> {
        Binding(
            get: { ExchangeRatesTab(route: shell.route) },
            set: { shell.replaceQuery(ExchangeRatesTab.parameter, with: $0.rawValue) })
    }

    private func summaryCard(_ summary: ExchangeRatesPresentation.SummaryCard) -> some View {
        card(padding: 20) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(summary.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(theme.secondaryLabel)
                    Spacer(minLength: 8)
                    Image(systemName: summary.symbol)
                        .foregroundStyle(theme.tertiaryLabel)
                        .accessibilityHidden(true)
                }
                Text(summary.value)
                    .font(Font.visionTitle1)
                    .monospacedDigit()
                Text(summary.subtext)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private func emptyState(title: String, message: String) -> some View {
        card {
            VStack(spacing: 10) {
                Image(systemName: "cylinder.split.1x2")
                    .font(.title2)
                    .foregroundStyle(theme.tertiaryLabel)
                    .accessibilityHidden(true)
                Text(title).font(.headline)
                Text(message)
                    .foregroundStyle(theme.secondaryLabel)
                    .multilineTextAlignment(.center)
                // The empty state's button is disabled only while refreshing.
                refreshButton(disabled: model.isRefreshing)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
    }

    private func ratesTable(_ table: ExchangeRatesPresentation.Table, columns: [String]) -> some View {
        card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(table.title).font(Font.visionTitle3)
                    Text(table.description)
                        .foregroundStyle(theme.secondaryLabel)
                }
                .padding(VisionPageLayout.padding)
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                    GridRow {
                        ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                            Text(column)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(theme.secondaryLabel)
                                .padding(.vertical, 8)
                                .gridColumnAlignment(index == 0 ? .leading : .trailing)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                    ForEach(table.rows) { row in
                        Divider().gridCellUnsizedAxes(.horizontal)
                        GridRow {
                            cell(row.currency, font: .body.monospaced().weight(.medium))
                            cell(row.rate, font: .body.monospaced())
                            cell(row.inverse, font: .body.monospaced())
                            cell(row.hundredInEuro, font: .body)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, table.note == nil ? 8 : 0)
                if let note = table.note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                        .padding(16)
                }
            }
        }
    }

    private func cell(_ text: String, font: Font) -> some View {
        Text(text)
            .font(font)
            .monospacedDigit()
            .padding(.vertical, 8)
    }

    private func card<Content: View>(padding: CGFloat = 16, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .visionCardBackground()
    }

    // MARK: Toast

    @ViewBuilder
    private var noticeView: some View {
        if let notice = model.notice {
            Label(
                strings.t(notice.key),
                systemImage: notice.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .foregroundStyle(notice.kind == .success ? theme.foreground : theme.destructive)
            .padding(.bottom, 20)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityAddTraits(.isStaticText)
            .task(id: notice.id) {
                AccessibilityNotification.Announcement(strings.t(notice.key)).post()
                try? await Task.sleep(for: .seconds(4))
                model.clearNotice(notice.id)
            }
        }
    }
}

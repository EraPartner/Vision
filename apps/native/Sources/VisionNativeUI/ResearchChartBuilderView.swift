import SwiftUI
import VisionNativeCore

public struct ResearchChartBuilderView: View {
    @Bindable var model: ResearchChartBuilderModel
    let shell: NativeShellModel
    @State private var showsOptions = false
    @Environment(\.visionTheme) private var theme
    public init(model: ResearchChartBuilderModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var controlsEnabled: Bool { model.isStorageLoaded && !model.isStorageAction }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VisionPageLayout.spacing) {
                header
                layoutControls
                if model.state.series.isEmpty {
                    ResearchCard {
                        VisionEmptyState(
                            symbol: "chart.xyaxis.line", title: strings.t("research.builder.emptyTitle"),
                            description: strings.t("research.builder.emptyHint")
                        ) {}.padding(.vertical, 46)
                    }
                } else {
                    ResearchCard {
                        Text(strings.t("research.builder.chartHelp")).font(.callout).foregroundStyle(
                            theme.secondaryLabel)
                        if model.isLoading || model.isPreparing && model.presentation == nil {
                            ProgressView().frame(maxWidth: .infinity).frame(height: 400)
                        } else if let presentation = model.presentation, !presentation.rows.isEmpty {
                            ResearchChartBuilderChart(
                                rows: presentation.rows, marks: priceMarks, logLeft: model.state.logLeft,
                                rebased: model.state.rebase, oscillator: nil, shell: shell)
                        } else {
                            emptyChart(height: 400)
                        }
                    }
                }
                ResearchChartBuilderSeriesView(model: model, shell: shell)
                if !model.state.series.isEmpty { oscillator }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlay(alignment: .bottom) { ResearchChartBuilderNoticeView(model: model, shell: shell) }
        .visionDialog(
            isPresented: $model.isSaveDialogPresented,
            metrics: VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0),
            accessibilityTitle: strings.t("research.builder.saveAsTitle")
        ) { ResearchChartBuilderSaveSheet(model: model, shell: shell) }
        .visionConfirmationDialog(
            title: strings.t(
                model.pendingConfirmation == .share ? "research.builder.shareReplaceTitle" : "research.builder.newTitle"
            ),
            message: strings.t(
                model.pendingConfirmation == .share
                    ? "research.builder.shareReplaceDescription" : "research.builder.newDescription"),
            isPresented: Binding(get: { model.pendingConfirmation != nil }, set: { if !$0 { model.cancelPending() } })
        ) {
            VisionDialogAction(strings.t("common.cancel"), role: .cancel) { model.cancelPending() }
            VisionDialogAction(
                strings.t(
                    model.pendingConfirmation == .share ? "research.builder.openShared" : "research.builder.newChart")
            ) { model.confirmPending() }
        }
    }
    private var header: some View {
        VisionPageHeader(
            title: strings.t("research.builder.title"), subtitle: strings.t("research.builder.subtitle"),
            symbol: "chart.xyaxis.line"
        ) {
            Menu {
                Button(strings.t("research.builder.newChart")) { model.requestNew() }
                Button(strings.t("research.builder.copyLink")) { Task { await model.copyShareLink() } }
                Divider()
                Button(strings.t("research.builder.deleteSavedLayout"), role: .destructive) {
                    Task { await model.deleteLayout() }
                }.disabled(model.activeLayout == nil)
            } label: {
                Image(systemName: "ellipsis")
            }
            .visionMoreActionsMenu().accessibilityLabel(strings.t("research.builder.menu")).disabled(!controlsEnabled)
            Button {
                model.isSaveDialogPresented = true
            } label: {
                Label(strings.t("research.builder.saveAs"), systemImage: "square.and.arrow.down")
            }.buttonStyle(.visionPrimary).disabled(!controlsEnabled)
        }
    }
    private var layoutControls: some View {
        ResearchCard {
            HStack(alignment: .bottom, spacing: 20) {
                layoutPicker
                rangePicker
                Spacer()
                Text(strings.t(storageKey)).font(.caption).foregroundStyle(
                    model.storageStatus == .failed ? theme.destructive : theme.secondaryLabel)
            }.disabled(!controlsEnabled)
            if !model.isStorageLoaded && model.storageStatus == .failed {
                Button(strings.t("common.retry")) { Task { await model.retryStorageLoad() } }
                    .buttonStyle(.visionOutline)
            }
            DisclosureGroup(isExpanded: $showsOptions) {
                VStack(alignment: .leading, spacing: 16) {
                    Toggle(strings.t("research.builder.logScale"), isOn: state(\.logLeft)).toggleStyle(.visionSwitch)
                    Toggle(strings.t("research.builder.rebase"), isOn: state(\.rebase)).toggleStyle(.visionSwitch)
                    Text(strings.t("research.builder.presets")).font(.caption).foregroundStyle(theme.secondaryLabel)
                    ViewThatFits(in: .horizontal) {
                        HStack { presets }
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 125))], alignment: .leading, spacing: 8) {
                            presets
                        }
                    }
                }.padding(.top, 12).disabled(!controlsEnabled)
            } label: {
                HStack {
                    Text(strings.t("research.builder.options"))
                    if model.state.logLeft || model.state.rebase {
                        Text(
                            [
                                model.state.logLeft ? strings.t("research.builder.logScale") : nil,
                                model.state.rebase ? strings.t("research.builder.rebase") : nil,
                            ].compactMap { $0 }.joined(separator: " · ")
                        ).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
            }
        }
    }
    private var layoutPicker: some View {
        var options = [VisionSelectOption(value: "", title: strings.t("research.builder.unnamedDraft"))]
        options += model.library.layouts.map { VisionSelectOption(value: $0.id, title: $0.name) }
        return VStack(alignment: .leading, spacing: 6) {
            Text(strings.t("research.builder.layout")).font(.callout.weight(.medium)).foregroundStyle(theme.foreground)
            VisionSelect(
                selection: Binding(
                    get: { model.library.activeLayoutId ?? "" },
                    set: { model.selectLayout(id: $0.isEmpty ? nil : $0) }),
                options: options, accessibilityLabel: strings.t("research.builder.layout"), expands: true)
        }.frame(maxWidth: 320)
    }
    private var rangePicker: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t("research.builder.range")).font(.callout.weight(.medium)).foregroundStyle(theme.foreground)
            VisionSegmentedControl(
                selection: Binding(
                    get: { model.state.range },
                    set: { range in
                        var candidate = model.state
                        candidate.range = range
                        model.state = candidate
                    }),
                values: ResearchRangeOption.research.map(\.range),
                title: { strings.t("research.range." + $0) }, size: .sm, compact: true
            ).fixedSize().accessibilityLabel(strings.t("research.builder.range"))
        }
    }
    private var presets: some View {
        ForEach(ResearchChartBuilderPreset.allCases, id: \.self) { name in
            Button(strings.t("research.builder.preset." + name.rawValue)) { model.preset(name) }
                .buttonStyle(.vision(.outline, size: .sm))
                .disabled(!model.state.series.contains { $0.field == "price" })
        }
    }
    private var storageKey: String {
        switch model.storageStatus {
        case .saved: "research.builder.savedLocally"
        case .failed: "research.builder.storageFailed"
        default: "research.builder.savingLocally"
        }
    }
    private var oscillator: some View {
        ResearchCard {
            HStack {
                Text(strings.t("research.builder.oscillator")).font(.researchCardTitle)
                Spacer()
                VisionSelect(
                    selection: state(\.oscillator),
                    options: [
                        VisionSelectOption(value: "none", title: strings.t("research.builder.oscNone")),
                        VisionSelectOption(value: "rsi", title: "RSI"),
                        VisionSelectOption(value: "macd", title: "MACD"),
                    ], accessibilityLabel: strings.t("research.builder.oscillator")
                ).frame(width: 135).disabled(!controlsEnabled)
            }
            if model.state.oscillator != "none" {
                if model.isLoading || model.isPreparing && model.presentation == nil {
                    ProgressView().frame(maxWidth: .infinity).frame(height: 160)
                } else if let presentation = model.presentation, !presentation.oscillatorRows.isEmpty {
                    ResearchChartBuilderChart(
                        rows: presentation.oscillatorRows, marks: oscillatorMarks, logLeft: false, rebased: false,
                        oscillator: model.state.oscillator, shell: shell)
                } else {
                    emptyChart(height: 160)
                }
            }
        }
    }
    private func emptyChart(height: CGFloat) -> some View {
        Text(strings.t("market.noChartData")).foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity).frame(
            height: height)
    }
    private func state<Value>(_ path: WritableKeyPath<ResearchChartBuilderState, Value>) -> Binding<Value> {
        .init(
            get: { model.state[keyPath: path] },
            set: { value in
                var candidate = model.state
                candidate[keyPath: path] = value
                model.state = candidate
            })
    }
    private var priceMarks: [ResearchChartBuilderMark] {
        var marks = model.state.series.enumerated().map { index, series in
            ResearchChartBuilderMark(
                id: series.id,
                label: series.label + (series.field == "volume" ? " " + strings.t("research.builder.volume") : ""),
                kind: series.type == "candlestick" && series.field != "price" ? "line" : series.type, axis: series.axis,
                color: ResearchCompareStyle.color(index, palette: theme.palette),
                opacity: series.field == "volume" ? 0.4 : series.type == "bar" ? 0.5 : 0.18)
        }
        for (index, indicator) in model.state.indicators.enumerated() {
            let color = ResearchCompareStyle.color(model.state.series.count + index, palette: theme.palette)
            let label =
                (indicator.type == "bollinger" ? "BB" : indicator.type.uppercased()) + "(" + String(indicator.period)
                + ")"
            marks.append(.init(id: indicator.id, label: label, kind: "line", axis: "left", color: color))
            if indicator.type == "bollinger" {
                marks.append(
                    .init(
                        id: indicator.id + "_u", label: label + " ↑", kind: "line", axis: "left", color: color,
                        dashed: true, width: 1))
                marks.append(
                    .init(
                        id: indicator.id + "_l", label: label + " ↓", kind: "line", axis: "left", color: color,
                        dashed: true, width: 1))
            }
        }
        return marks
    }
    private var oscillatorMarks: [ResearchChartBuilderMark] {
        model.state.oscillator == "rsi"
            ? [.init(id: "rsi", label: "RSI(14)", kind: "line", axis: "left", color: theme.primary)]
            : [
                .init(id: "macd", label: "MACD", kind: "line", axis: "left", color: theme.primary),
                .init(
                    id: "signal", label: "Signal", kind: "line", axis: "left",
                    color: Color(token: theme.palette.accent), dashed: true),
            ]
    }
}

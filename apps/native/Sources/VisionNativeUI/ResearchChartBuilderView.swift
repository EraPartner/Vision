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
            VStack(alignment: .leading, spacing: 20) {
                header
                layoutControls
                if model.state.series.isEmpty {
                    ResearchCard {
                        VStack(spacing: 9) {
                            Image(systemName: "chart.xyaxis.line").font(.largeTitle).foregroundStyle(
                                theme.secondaryLabel
                            ).accessibilityHidden(true)
                            Text(strings.t("research.builder.emptyTitle")).font(.headline)
                            Text(strings.t("research.builder.emptyHint")).foregroundStyle(theme.secondaryLabel)
                        }.padding(.vertical, 46).frame(maxWidth: .infinity)
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
            }.padding(24).frame(maxWidth: 1500, alignment: .leading).frame(maxWidth: .infinity)
        }
        .overlay(alignment: .bottom) { ResearchChartBuilderNoticeView(model: model, shell: shell) }
        .sheet(isPresented: $model.isSaveDialogPresented) { ResearchChartBuilderSaveSheet(model: model, shell: shell) }
        .confirmationDialog(
            strings.t(
                model.pendingConfirmation == .share ? "research.builder.shareReplaceTitle" : "research.builder.newTitle"
            ),
            isPresented: Binding(get: { model.pendingConfirmation != nil }, set: { if !$0 { model.cancelPending() } }),
            titleVisibility: .visible
        ) {
            Button(
                strings.t(
                    model.pendingConfirmation == .share ? "research.builder.openShared" : "research.builder.newChart")
            ) { model.confirmPending() }
            Button(strings.t("common.cancel"), role: .cancel) { model.cancelPending() }
        } message: {
            Text(
                strings.t(
                    model.pendingConfirmation == .share
                        ? "research.builder.shareReplaceDescription" : "research.builder.newDescription"))
        }
    }
    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Label(strings.t("research.builder.title"), systemImage: "chart.xyaxis.line").font(
                    .largeTitle.weight(.semibold)
                ).accessibilityAddTraits(.isHeader)
                Text(strings.t("research.builder.subtitle")).foregroundStyle(theme.secondaryLabel)
            }
            Spacer()
            Menu {
                Button(strings.t("research.builder.newChart")) { model.requestNew() }
                Button(strings.t("research.builder.copyLink")) { Task { await model.copyShareLink() } }
                Divider()
                Button(strings.t("research.builder.deleteSavedLayout"), role: .destructive) {
                    Task { await model.deleteLayout() }
                }.disabled(model.activeLayout == nil)
            } label: {
                Image(systemName: "ellipsis")
            }.accessibilityLabel(strings.t("research.builder.menu")).disabled(!controlsEnabled)
            Button {
                model.isSaveDialogPresented = true
            } label: {
                Label(strings.t("research.builder.saveAs"), systemImage: "square.and.arrow.down")
            }.disabled(!controlsEnabled)
        }
    }
    private var layoutControls: some View {
        ResearchCard {
            HStack(alignment: .bottom, spacing: 20) {
                Picker(
                    strings.t("research.builder.layout"),
                    selection: Binding(
                        get: { model.library.activeLayoutId ?? "" },
                        set: { model.selectLayout(id: $0.isEmpty ? nil : $0) })
                ) {
                    Text(strings.t("research.builder.unnamedDraft")).tag("")
                    ForEach(model.library.layouts) { Text($0.name).tag($0.id) }
                }.frame(maxWidth: 320)
                VStack(alignment: .leading, spacing: 5) {
                    Text(strings.t("research.builder.range")).font(.caption)
                    HStack(spacing: 6) {
                        ForEach(ResearchRangeOption.research) { option in
                            Button {
                                var candidate = model.state
                                candidate.range = option.range
                                model.state = candidate
                            } label: {
                                Text(strings.t("research.range." + option.range)).font(.callout).padding(
                                    .horizontal, 10
                                ).padding(.vertical, 6)
                                    .background(
                                        model.state.range == option.range
                                            ? theme.primary.opacity(0.12) : theme.foreground.opacity(0.035),
                                        in: RoundedRectangle(cornerRadius: 6)
                                    )
                                    .foregroundStyle(
                                        model.state.range == option.range ? theme.primary : theme.secondaryLabel)
                            }.buttonStyle(.plain).accessibilityAddTraits(
                                model.state.range == option.range ? .isSelected : [])
                        }
                    }.accessibilityElement(children: .contain).accessibilityLabel(strings.t("research.builder.range"))
                }
                Spacer()
                Text(strings.t(storageKey)).font(.caption).foregroundStyle(
                    model.storageStatus == .failed ? theme.destructive : theme.secondaryLabel)
            }.disabled(!controlsEnabled)
            if !model.isStorageLoaded && model.storageStatus == .failed {
                Button(strings.t("common.retry")) { Task { await model.retryStorageLoad() } }
            }
            DisclosureGroup(isExpanded: $showsOptions) {
                VStack(alignment: .leading, spacing: 16) {
                    Toggle(strings.t("research.builder.logScale"), isOn: state(\.logLeft))
                    Toggle(strings.t("research.builder.rebase"), isOn: state(\.rebase))
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
    private var presets: some View {
        ForEach(["priceVolume", "sma", "bollinger", "rsi", "macd", "rebased"], id: \.self) { name in
            Button(strings.t("research.builder.preset." + name)) { model.preset(name) }.disabled(
                !model.state.series.contains { $0.field == "price" })
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
                Text(strings.t("research.builder.oscillator")).font(.headline)
                Spacer()
                Picker(strings.t("research.builder.oscillator"), selection: state(\.oscillator)) {
                    Text(strings.t("research.builder.oscNone")).tag("none")
                    Text("RSI").tag("rsi")
                    Text("MACD").tag("macd")
                }.labelsHidden().frame(width: 135).disabled(!controlsEnabled)
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

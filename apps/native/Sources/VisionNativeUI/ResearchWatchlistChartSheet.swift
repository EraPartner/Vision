import Charts
import SwiftUI
import VisionNativeCore

struct ResearchWatchlistChartSheet: View {
    let model: ResearchWatchlistModel
    let shell: NativeShellModel
    @FocusState private var targetFocused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        if let item = model.selectedItem {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text(item.name).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    if let symbol = item.symbol { Text(symbol).font(.caption.monospaced()) }
                    Spacer()
                    Button {
                        model.closeChart()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.borderless).keyboardShortcut(.cancelAction).accessibilityLabel(
                        strings.t("common.close"))
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack(alignment: .top, spacing: 14) {
                            target(item).frame(maxWidth: .infinity, alignment: .leading)
                            current(item).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if model.chartMetrics?.isAtOrBelowTarget == true {
                            Text(strings.t("watchlistChart.atTarget")).font(.callout.weight(.medium)).foregroundStyle(
                                theme.gain
                            )
                            .padding(12).frame(maxWidth: .infinity)
                            .background(theme.gain.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        }
                        Picker(
                            "",
                            selection: Binding(
                                get: { model.range }, set: { range in Task { await model.selectRange(range) } })
                        ) {
                            ForEach(ResearchWatchlistRange.allCases, id: \.self) {
                                Text(strings.t("research.range." + $0.rawValue)).tag($0)
                            }
                        }.pickerStyle(.segmented).labelsHidden().accessibilityLabel(strings.t("research.builder.range"))
                        if model.isChartLoading {
                            ProgressView().frame(maxWidth: .infinity).frame(height: 320)
                        } else if let points = model.chart?.points, points.contains(where: { $0.close != nil }) {
                            ResearchWatchlistPriceChart(
                                points: points, item: item, metrics: model.chartMetrics, shell: shell,
                                close: model.closeChart)
                        } else {
                            Text(strings.t("watchlistChart.noData")).foregroundStyle(theme.secondaryLabel)
                                .frame(maxWidth: .infinity).frame(height: 200)
                        }
                        if let notes = item.notes, !notes.isEmpty {
                            ResearchCard(title: strings.t("watchlistChart.notes")) {
                                Text(notes).font(.callout).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }.padding(24).frame(width: 760, height: 640)
                .onChange(of: model.isEditingTarget) { _, editing in if editing { targetFocused = true } }
                .onChange(of: model.validationRevision) { _, _ in targetFocused = true }
        }
    }
    private func target(_ item: ResearchWatchlistItem) -> some View {
        ResearchCard {
            Label(strings.t("watchlistChart.targetPrice"), systemImage: "scope").font(.caption).foregroundStyle(
                theme.secondaryLabel)
            if model.isEditingTarget {
                HStack {
                    TextField("0", text: Binding(get: { model.targetDraft }, set: { model.targetDraft = $0 }))
                        .textFieldStyle(.roundedBorder).focused($targetFocused)
                        .accessibilityLabel(
                            strings.t("watchlistChart.targetPrice") + ": " + item.name + " (" + (item.symbol ?? "")
                                + ")"
                        )
                        .onSubmit { save() }.disabled(model.isMutating)
                    Button(action: save) {
                        if model.isMutating {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "checkmark")
                        }
                    }.accessibilityLabel(strings.t("common.save")).disabled(model.isMutating)
                    Button(strings.t("watchlistChart.cancelEdit")) { model.cancelTargetEdit() }.disabled(
                        model.isMutating)
                }
                if model.targetValidationFailed {
                    Text(strings.t("watchlistChart.invalidTarget")).font(.caption).foregroundStyle(theme.destructive)
                }
                if let error = model.actionError {
                    Text(strings.t("watchlist.updateFailed")).font(.caption).foregroundStyle(theme.destructive)
                    Text(error).font(.caption).foregroundStyle(theme.secondaryLabel)
                }
            } else {
                Button(ResearchWatchlistUI.money(item.targetPrice, currency: item.currency, shell: shell)) {
                    model.beginTargetEdit(numberFormat: shell.settings.numberFormat)
                }.buttonStyle(.link).font(.title2.weight(.semibold)).monospacedDigit()
                    .help(editLabel(item)).accessibilityLabel(
                        editLabel(item) + ", "
                            + ResearchWatchlistUI.money(item.targetPrice, currency: item.currency, shell: shell)
                    )
                    .disabled(model.isMutating)
            }
        }
    }
    private func current(_ item: ResearchWatchlistItem) -> some View {
        ResearchCard {
            Text(strings.t("watchlistChart.currentPrice")).font(.caption).foregroundStyle(theme.secondaryLabel)
            if let price = model.chartQuote?.price {
                Text(ResearchWatchlistUI.money(price, currency: item.currency, shell: shell)).font(
                    .title2.weight(.semibold)
                ).monospacedDigit()
                if let metrics = model.chartMetrics, let percent = metrics.absoluteDistancePercent,
                    let signed = metrics.distancePercent
                {
                    Label(
                        ResearchWatchlistUI.percent(percent, digits: 2, shell: shell) + " "
                            + strings.t(signed > 0 ? "watchlistChart.aboveTarget" : "watchlistChart.belowTarget"),
                        systemImage: signed > 0 ? "arrow.up.right" : "arrow.down.right"
                    )
                    .font(.caption).foregroundStyle(signed > 0 ? theme.loss : theme.gain)
                }
            } else {
                ProgressView().frame(height: 30)
            }
        }
    }
    private func editLabel(_ item: ResearchWatchlistItem) -> String {
        strings.t("common.edit") + ": " + strings.t("watchlistChart.targetPrice") + ", " + item.name + " ("
            + (item.symbol ?? "") + ")"
    }
    private func save() { Task { await model.saveTarget(numberFormat: shell.settings.numberFormat) } }
}

private struct ResearchWatchlistPriceChart: View {
    let points: [ResearchChartPoint]
    let item: ResearchWatchlistItem
    let metrics: ResearchWatchlistChartMetrics?
    let shell: NativeShellModel
    let close: () -> Void
    @State private var selected: Int?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var visible: [ResearchChartPoint] { points.filter { $0.close != nil } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            plot
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let value = value.as(Double.self) {
                                Text(
                                    VisionFormat.currency(
                                        Decimal(value), code: item.currency, locale: shell.settings.numberFormat.locale,
                                        fractionDigits: shell.settings.showDecimalPlaces))
                            }
                        }
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                guard let frame = proxy.plotFrame,
                                    let date: Date = proxy.value(atX: location.x - geometry[frame].origin.x)
                                else { return }
                                selected = visible.indices.min(by: {
                                    abs(instant(visible[$0]).timeIntervalSince(date))
                                        < abs(instant(visible[$1]).timeIntervalSince(date))
                                })
                            case .ended: if !focused { selected = nil }
                            }
                        }.onTapGesture { focused = true }
                    }
                }
                .frame(height: 320).focusable().focused($focused).focusEffectDisabled()
                .accessibilityLabel(shell.strings.t("watchlist.openChart") + ": " + item.name)
                .onKeyPress(.leftArrow) { move(-1) }.onKeyPress(.rightArrow) { move(1) }
                .onKeyPress(.escape) {
                    close()
                    return .handled
                }
                .onChange(of: points) { _, _ in selected = nil }
            if let selected, visible.indices.contains(selected), let close = visible[selected].close {
                HStack {
                    Text(
                        VisionFormat.appDate(
                            instant(visible[selected]), format: shell.settings.dateFormat, timeZone: .current))
                    Spacer()
                    Text(ResearchWatchlistUI.money(close, currency: item.currency, shell: shell)).monospacedDigit()
                }.font(.caption).padding(10).background(
                    theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
    @ViewBuilder private var plot: some View {
        if let domain = metrics?.domain, domain.count == 2 {
            marks.chartYScale(domain: coordinate(domain[0])...coordinate(domain[1]))
        } else {
            marks
        }
    }
    private var marks: some View {
        Chart {
            ForEach(Array(visible.enumerated()), id: \.offset) { _, point in
                if let close = point.close {
                    AreaMark(
                        x: .value(shell.strings.t("networth.date"), instant(point)),
                        y: .value(shell.strings.t("watchlistChart.priceLabel"), coordinate(close))
                    )
                    .foregroundStyle(theme.primary.opacity(0.12)).accessibilityHidden(true)
                    LineMark(
                        x: .value(shell.strings.t("networth.date"), instant(point)),
                        y: .value(shell.strings.t("watchlistChart.priceLabel"), coordinate(close))
                    )
                    .foregroundStyle(theme.primary).lineStyle(StrokeStyle(lineWidth: 2))
                    .accessibilityLabel(
                        VisionFormat.appDate(instant(point), format: shell.settings.dateFormat, timeZone: .current)
                    )
                    .accessibilityValue(ResearchWatchlistUI.money(close, currency: item.currency, shell: shell))
                }
            }
            if metrics?.hasValidTarget == true {
                RuleMark(y: .value(shell.strings.t("watchlistChart.targetPrice"), coordinate(item.targetPrice)))
                    .lineStyle(
                        StrokeStyle(lineWidth: 1, dash: [5, 4])
                    )
                    .foregroundStyle(theme.secondaryLabel)
                    .annotation(position: .top, alignment: .trailing) {
                        Text(
                            shell.strings.t(
                                "watchlistChart.targetLabel",
                                [
                                    "currency": item.currency,
                                    "price": ResearchWatchlistUI.money(
                                        item.targetPrice, currency: item.currency, shell: shell),
                                ])
                        ).font(.caption2)
                    }
            }
            if let selected, visible.indices.contains(selected) {
                RuleMark(x: .value(shell.strings.t("networth.date"), instant(visible[selected]))).foregroundStyle(
                    theme.secondaryLabel.opacity(0.5))
            }
        }
    }
    private func move(_ delta: Int) -> KeyPress.Result {
        guard !visible.isEmpty else { return .ignored }
        selected = max(0, min(visible.count - 1, (selected ?? (delta > 0 ? -1 : visible.count)) + delta))
        return .handled
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func instant(_ point: ResearchChartPoint) -> Date {
        Date(timeIntervalSince1970: coordinate(point.time) / 1000)
    }
}

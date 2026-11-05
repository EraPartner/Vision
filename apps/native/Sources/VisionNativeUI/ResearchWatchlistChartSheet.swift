import Charts
import SwiftUI
import VisionNativeCore

struct ResearchWatchlistChartSheet: View {
    let model: ResearchWatchlistModel
    /// The item being charted. The dialog keeps it through its exit motion, after the model has
    /// already cleared `selectedItem`.
    let item: ResearchWatchlistItem
    let shell: NativeShellModel
    @FocusState private var targetFocused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.name).font(.visionCardTitle).foregroundStyle(theme.foreground)
                    .accessibilityAddTraits(.isHeader)
                if let symbol = item.symbol {
                    Text(symbol).font(.caption.monospaced()).foregroundStyle(theme.secondaryLabel)
                }
                Spacer()
                VisionDialogCloseButton(label: strings.t("common.close")) { model.closeChart() }
                    .keyboardShortcut(.cancelAction)
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
                        .background(
            theme.gain.opacity(0.08),
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous))
                    }
                    VisionSegmentedControl(
                        selection: Binding(
                            get: { model.range }, set: { range in Task { await model.selectRange(range) } }),
                        values: ResearchWatchlistRange.allCases,
                        title: { strings.t("research.range." + $0.rawValue) }
                    ).accessibilityLabel(strings.t("research.builder.range"))
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
    private func target(_ item: ResearchWatchlistItem) -> some View {
        ResearchCard {
            Label(strings.t("watchlistChart.targetPrice"), systemImage: "scope").font(.caption).foregroundStyle(
                theme.secondaryLabel)
            if model.isEditingTarget {
                targetEditor(item)
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
                }.buttonStyle(.visionLink).font(.title2.weight(.semibold)).monospacedDigit()
                    .visionTooltip(editLabel(item)).accessibilityLabel(
                        editLabel(item) + ", "
                            + ResearchWatchlistUI.money(item.targetPrice, currency: item.currency, shell: shell)
                    )
                    .disabled(model.isMutating)
            }
        }
    }
    private func targetEditor(_ item: ResearchWatchlistItem) -> some View {
        HStack {
            targetField(item)
            Button(action: save) {
                if model.isMutating {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "checkmark")
                }
            }.buttonStyle(.visionPrimary).accessibilityLabel(strings.t("common.save")).disabled(model.isMutating)
            Button(strings.t("watchlistChart.cancelEdit")) { model.cancelTargetEdit() }.buttonStyle(.visionOutline)
                .disabled(model.isMutating)
        }
    }
    private func targetField(_ item: ResearchWatchlistItem) -> some View {
        let label = strings.t("watchlistChart.targetPrice")
        let identity: String = "\(item.name) (\(item.symbol ?? ""))"
        return TextField("0", text: Binding<String>(get: { model.targetDraft }, set: { model.targetDraft = $0 }))
            .textFieldStyle(.vision).focused($targetFocused)
            .accessibilityLabel("\(label): \(identity)")
            .onSubmit { save() }.disabled(model.isMutating)
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
    @State private var plotCache = ChartLinePlotCache()
    @State private var labelMemo = ChartLabelMemo()
    @Environment(\.visionTheme) private var theme
    /// The points with a close, converted once per series (the hover re-renders per point).
    private var priceMarks: [ChartLinePlot.Mark] { plotCache.plot(for: points).closeMarks }
    var body: some View {
        let plot = plotCache.plot(for: points)
        VStack(alignment: .leading, spacing: 10) {
            marks(plot)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { value in
                        AxisTick()
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(VisionFormat.appDate(date, format: shell.settings.dateFormat, timeZone: .current))
                                    .font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }
                }
                .visionChartYAxis(domain: yDomain(plot)) { value in
                    VisionFormat.currency(
                        Decimal(value), code: item.currency, locale: shell.settings.numberFormat.locale,
                        fractionDigits: shell.settings.showDecimalPlaces)
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                guard let frame = proxy.plotFrame,
                                    let date: Date = proxy.value(atX: location.x - geometry[frame].origin.x)
                                else { return }
                                let nearest = plot.nearestCloseIndex(to: date)
                                if nearest != selected { selected = nearest }
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
            if let selected, plot.closeMarks.indices.contains(selected),
                let close = points[plot.closeMarks[selected].offset].close
            {
                HStack {
                    Text(
                        VisionFormat.appDate(
                            plot.closeMarks[selected].time, format: shell.settings.dateFormat, timeZone: .current))
                    Spacer()
                    Text(ResearchWatchlistUI.money(close, currency: item.currency, shell: shell)).monospacedDigit()
                }.font(.caption).padding(10).background(
                    theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
            }
        }
    }
    /// The web AreaChart's `yDomain={[minPrice, maxPrice]}`, niced; without metrics the closes and the
    /// target price, padded by 8 %.
    private func yDomain(_ plot: ChartLinePlot) -> ClosedRange<Double> {
        if let domain = metrics?.domain, domain.count == 2 {
            return ChartAxisTicks.niceDomain(coordinate(domain[0]), coordinate(domain[1]))
        }
        var values = plot.closes
        if metrics?.hasValidTarget == true { values.append(coordinate(item.targetPrice)) }
        return ChartAxisTicks.fittedDomain(values)
    }
    /// What the date and money strings of a point depend on besides the point.
    private var labelContext: String {
        let settings = shell.settings
        return "\(settings.dateFormat)|\(settings.numberFormat.locale.identifier)|\(item.currency.rawValue)|\(settings.showDecimalPlaces)"
    }
    @ViewBuilder private func marks(_ plot: ChartLinePlot) -> some View {
        let baseline = yDomain(plot).lowerBound
        let dateTitle = shell.strings.t("networth.date")
        let priceTitle = shell.strings.t("watchlistChart.priceLabel")
        let context = labelContext
        Chart {
            ForEach(plot.marks, id: \.offset) { mark in
                AreaMark(
                    x: .value(dateTitle, mark.time),
                    yStart: .value(priceTitle, baseline),
                    yEnd: .value(priceTitle, mark.close)
                )
                .foregroundStyle(ChartFill.areaGradient(theme.primary)).interpolationMethod(.monotone)
                .accessibilityHidden(true)
                LineMark(
                    x: .value(dateTitle, mark.time),
                    y: .value(priceTitle, mark.close)
                )
                .foregroundStyle(theme.primary).lineStyle(StrokeStyle(lineWidth: 2))
                .interpolationMethod(.monotone)
                .accessibilityLabel(
                    labelMemo.label("d|\(mark.offset)", context: context) {
                        VisionFormat.appDate(mark.time, format: shell.settings.dateFormat, timeZone: .current)
                    }
                )
                .accessibilityValue(
                    labelMemo.label("v|\(mark.offset)", context: context) {
                        let value = points[mark.offset].close ?? 0
                        return ResearchWatchlistUI.money(value, currency: item.currency, shell: shell)
                    })
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
                                    "currency": item.currency.rawValue,
                                    "price": ResearchWatchlistUI.money(
                                        item.targetPrice, currency: item.currency, shell: shell),
                                ])
                        ).font(.caption2)
                    }
            }
            if let selected, plot.closeMarks.indices.contains(selected) {
                RuleMark(x: .value(dateTitle, plot.closeMarks[selected].time)).foregroundStyle(
                    theme.secondaryLabel.opacity(0.5))
            }
        }
    }
    private func move(_ delta: Int) -> KeyPress.Result {
        let count = priceMarks.count
        guard count > 0 else { return .ignored }
        selected = max(0, min(count - 1, (selected ?? (delta > 0 ? -1 : count)) + delta))
        return .handled
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
}

import SwiftUI
import VisionNativeCore

public struct RebalanceView: View {
    @Bindable var model: RebalanceModel
    let shell: NativeShellModel
    @State private var methodology = false
    @FocusState var focus: String?
    @Environment(\.visionTheme) var theme
    var strings: any Localizing { shell.strings }
    var settings: NativeAppSettings { shell.settings }
    public init(model: RebalanceModel, shell: NativeShellModel) {
        _model = Bindable(wrappedValue: model)
        self.shell = shell
    }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VisionPageHeader(
                    title: strings.t("rebalance.title"), subtitle: strings.t("rebalance.subtitle"), symbol: "scalemass"
                ) { EmptyView() }
                inputsCard
                if let projection = model.projection { projectionCard(projection) }
                if model.showEditor { editorCard }
                Text(strings.t("rebalance.noSellNote")).foregroundStyle(theme.secondaryLabel)
                if model.errorKey == "rebalance.commitment.invalidFloor" {
                    Text(strings.t("rebalance.commitment.invalidFloor")).foregroundStyle(theme.destructive)
                }
                if let error = model.computeError { Text(verbatim: error).foregroundStyle(theme.destructive) }
                if let result = model.result { resultCards(result) }
            }.padding(VisionPageLayout.padding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: shell.route.string + settings.defaultCurrency + String(shell.settingsRevision)) {
            await model.load(route: shell.route, settings: settings)
        }
        .onChange(of: model.route) {
            if model.route.string != shell.route.string { shell.replace(with: model.route.string) }
        }
        .onChange(of: model.noticeRevision) {
            if model.errorKey == "rebalance.plan.nameRequired" { focus = "name" }
        }
        .overlay(alignment: .bottom) {
            ActionToast(
                notice: model.notice, strings: strings, actionTitle: nil, duration: .seconds(4), action: {},
                clear: model.clearNotice)
        }
        .confirmationDialog(
            strings.t("rebalance.plan.deleteTitle"),
            isPresented: Binding(
                get: { model.deletingPlan != nil }, set: { if !$0 { model.deletingPlan = nil } }),
            titleVisibility: .visible
        ) {
            Button(strings.t("rebalance.plan.delete"), role: .destructive) { Task { await model.deletePlan() } }
            Button(strings.t("common.cancel"), role: .cancel) { model.deletingPlan = nil }
        } message: {
            Text(strings.t("rebalance.plan.deleteConfirm", ["name": model.deletingPlan?.name ?? model.draft.name]))
        }
    }
    var inputsCard: some View {
        card(nil) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 20) {
                    sourcePicker
                    reserveInput
                    computeButton.padding(.top, 23)
                }
                VStack(alignment: .leading, spacing: 14) {
                    sourcePicker
                    reserveInput
                    computeButton
                }
            }
            if model.isLoadingInputs || model.isLoadingPlans { ProgressView().controlSize(.small) }
            if let error = model.inputsError {
                Text(verbatim: error).font(.footnote).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await reload() } }
            }
            if let error = model.plansError {
                Text(verbatim: error).font(.footnote).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await reload() } }
            }
            if let preset = model.draft.preset {
                Divider()
                Text(strings.t("rebalance.target")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        ForEach(preset.weights, id: \.0) { sleeve, weight in
                            targetChip(sleeve, weight)
                        }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(preset.weights, id: \.0) { sleeve, weight in targetChip(sleeve, weight) }
                    }
                }
            }
        }
    }
    var sourcePicker: some View {
        field("rebalance.targetModel") {
            Picker(
                strings.t("rebalance.targetModel"),
                selection: Binding(get: { model.draft.source }, set: { model.selectSource($0) })
            ) {
                Section(strings.t("rebalance.presets")) {
                    ForEach(RebalancePreset.allCases, id: \.self) { preset in
                        Text(strings.t("rebalance.model.\(preset.rawValue)")).tag("model:\(preset.rawValue)")
                    }
                }
                if !model.plans.isEmpty {
                    Section(strings.t("rebalance.savedPlans")) {
                        ForEach(model.plans) { plan in Text(verbatim: plan.name).tag("plan:\(plan.id)") }
                    }
                }
                Text(strings.t("rebalance.customNew")).tag("custom")
                if let id = model.draft.planId, !model.plans.contains(where: { $0.id == id }) {
                    Text(verbatim: model.draft.name.isEmpty ? id : model.draft.name).tag(model.draft.source)
                }
            }.labelsHidden().frame(width: 260)
        }
    }
    var reserveInput: some View {
        field("rebalance.commitment.reserveFloor") {
            TextField("0", text: Binding(get: { model.reserveFloor }, set: { model.setReserveFloor($0) }))
                .textFieldStyle(.vision).frame(width: 160).focused($focus, equals: "reserve")
                .accessibilityLabel(strings.t("rebalance.commitment.reserveFloor"))
            Text(strings.t("rebalance.reserveHelp", ["currency": model.currency.rawValue])).font(.footnote)
                .foregroundStyle(theme.secondaryLabel).frame(maxWidth: 260, alignment: .leading)
        }
    }
    var computeButton: some View {
        Button {
            Task { await model.compute() }
        } label: {
            HStack {
                if model.isComputing { ProgressView().controlSize(.small) }
                Text(strings.t("rebalance.compute"))
            }
        }.buttonStyle(.visionPrimary).disabled(!model.canCompute)
    }
    func projectionCard(_ value: RebalanceCashProjection) -> some View {
        card("rebalance.commitment.title") {
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(strings.t("rebalance.commitment.candidateLabel")).font(.caption)
                        .foregroundStyle(theme.tertiaryLabel)
                    Text(money(value.candidateCashCap)).font(Font.visionTitle3)
                        .monospacedDigit()
                    Text(strings.t("rebalance.commitment.estimateWarning")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Text(
                    strings.t(
                        "rebalance.commitment.minimum",
                        ["amount": money(value.minimumProjectedBalance), "date": value.minimumDate])
                )
                .foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity, alignment: .leading)
            }
            DisclosureGroup(strings.t("rebalance.commitment.methodology"), isExpanded: $methodology) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(strings.t("rebalance.commitment.includes", ["date": value.horizonEnd]))
                    Text(strings.t("rebalance.commitment.exchangeRates"))
                    Text(strings.t("rebalance.commitment.exclusions"))
                }.font(.footnote).foregroundStyle(theme.secondaryLabel).padding(.top, 8)
            }
        }
    }
    @ViewBuilder func resultCards(_ result: RebalanceResult) -> some View {
        HStack(alignment: .top, spacing: 16) {
            card("rebalance.availableCash", label: true) {
                Text(money(model.availableCash == 0 ? result.availableCash : model.availableCash))
                    .font(.visionCardTitle).monospacedDigit()
                Text(strings.t("rebalance.availableCashHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                // `(inputs.data ?? result).unconvertedCurrencies`: cash without a stored rate is left out.
                if !((model.inputs ?? result).unconvertedCurrencies ?? []).isEmpty {
                    Text(strings.t("accounts.totalIncomplete")).font(.footnote).foregroundStyle(theme.warning)
                }
            }
            card("rebalance.totalDeployed", label: true) {
                Text(money(result.totalDeployed)).font(.visionCardTitle).monospacedDigit()
                Text(strings.t("rebalance.totalDeployedHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
        }
        card("rebalance.deploymentPlan") {
            Grid(horizontalSpacing: 24, verticalSpacing: 12) {
                GridRow {
                    Text(strings.t("rebalance.sleeve")).frame(maxWidth: .infinity, alignment: .leading)
                    Text(strings.t("rebalance.current"))
                    Text(strings.t("rebalance.target"))
                    Text(strings.t("rebalance.deploy"))
                }.font(.callout.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(result.sleeves, id: \.self) { sleeve in
                    GridRow {
                        Text(label(sleeve)).frame(maxWidth: .infinity, alignment: .leading)
                        Text(money(result.actualValues[sleeve] ?? 0)).monospacedDigit().gridColumnAlignment(.trailing)
                        Text(percent(result.targetWeights[sleeve] ?? 0)).monospacedDigit().gridColumnAlignment(
                            .trailing)
                        if let deploy = result.deployment[sleeve], deploy > 0 {
                            VisionBadge(text: money(deploy, signed: true)).monospacedDigit()
                                .gridColumnAlignment(.trailing)
                        } else {
                            Text("—").foregroundStyle(theme.secondaryLabel).gridColumnAlignment(.trailing)
                        }
                    }
                }
            }
        }
    }
    func targetChip(_ sleeve: String, _ weight: Decimal) -> some View {
        Text("\(label(sleeve)) \(percent(weight))").font(.footnote).monospacedDigit()
            .padding(.horizontal, 10).padding(.vertical, 6).background(theme.muted, in: Capsule())
    }
    func label(_ sleeve: String) -> String {
        let key = "rebalance.sleeve.\(sleeve)"
        let value = strings.t(key)
        return value == key ? sleeve : value
    }
    func percent(_ fraction: Decimal) -> String {
        let number = (fraction * 100).formatted(
            Decimal.FormatStyle(locale: settings.numberFormat.locale).precision(.fractionLength(0...1)).rounded(
                rule: .toNearestOrAwayFromZero))
        return number + "%"
    }
    func money(_ value: Decimal, signed: Bool = false) -> String {
        VisionFormat.currency(
            value, code: model.currency, locale: settings.numberFormat.locale, fractionDigits: 0, signed: signed)
    }
    func card<Content: View>(_ title: String?, label: Bool = false, @ViewBuilder content: () -> Content)
        -> some View
    {
        VStack(alignment: .leading, spacing: 14) {
            if let title {
                if label {
                    Text(strings.t(title)).font(.body.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                } else {
                    Text(strings.t(title)).font(Font.visionTitle3)
                        .accessibilityAddTraits(.isHeader)
                }
            }
            content()
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
    func field<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(strings.t(key)).font(.callout.weight(.medium))
            content()
        }
    }
    func reload() async { await model.load(route: shell.route, settings: settings, force: true) }
}

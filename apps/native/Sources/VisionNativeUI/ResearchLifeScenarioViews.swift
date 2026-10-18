import SwiftUI
import VisionNativeCore

struct ResearchLifeScenarioPanel: View {
    let model: ResearchLifeScenarioModel
    let shell: NativeShellModel
    @State private var width: CGFloat = 0
    @Environment(\.visionTheme) private var theme
    init(model: ResearchLifeScenarioModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var currency: String { shell.settings.defaultCurrency.isEmpty ? "EUR" : shell.settings.defaultCurrency }
    private var comparison: ResearchLifeScenarioComparison? {
        guard model.currency.caseInsensitiveCompare(currency) == .orderedSame,
            model.settings.numberFormat == shell.settings.numberFormat,
            let result = model.comparison,
            !result.baseline.available || result.baseline.currency?.caseInsensitiveCompare(currency) == .orderedSame,
            !result.interrupted.available
                || result.interrupted.currency?.caseInsensitiveCompare(currency) == .orderedSame
        else { return nil }
        return result
    }
    var body: some View {
        ResearchCard(title: strings.t("research.lifeScenario.title"), titleFont: .visionCardTitle) {
            Text(strings.t("research.lifeScenario.subtitle")).font(.callout).foregroundStyle(theme.secondaryLabel)
            if model.savedError != nil {
                HStack(alignment: .top, spacing: 12) {
                    Label(strings.t("research.lifeScenario.loadFailed"), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(theme.destructive)
                    Spacer()
                    Button(strings.t("common.retry")) { Task { await model.loadSaved(force: true) } }
                        .disabled(model.loadingSaved)
                }.font(.callout)
            }
            HStack(alignment: .bottom, spacing: 12) {
                Picker(
                    strings.t("research.lifeScenario.saved"),
                    selection: Binding(
                        get: { model.draft.id ?? "__new__" },
                        set: {
                            if $0 == "__new__" { model.reset() } else { model.selectSaved($0) }
                        })
                ) {
                    Text(strings.t("research.lifeScenario.new")).tag("__new__")
                    ForEach(model.scenarios, id: \.id) { scenario in Text(scenario.name).tag(scenario.id) }
                }.disabled(model.saving)
                if model.draft.id != nil {
                    Button(strings.t("research.lifeScenario.new"), systemImage: "plus") { model.reset() }
                        .disabled(model.saving)
                }
            }
            field("research.lifeScenario.name", key: \.name, limit: 80)
            Text(strings.t("research.lifeScenario.amountsHelp", ["currency": currency])).font(.caption)
                .foregroundStyle(theme.secondaryLabel)
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 18), count: width >= 1024 ? 3 : width >= 640 ? 2 : 1),
                alignment: .leading, spacing: 14
            ) {
                amounts
            }
            VStack(alignment: .leading, spacing: 12) {
                Text(strings.t("research.lifeScenario.optionalGoal")).font(.headline)
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 18), count: width >= 640 ? 2 : 1),
                    alignment: .leading, spacing: 14
                ) {
                    field("research.lifeScenario.goalValue", key: \.goalValue)
                    ResearchGoalMonthField(value: binding(\.goalMonth), shell: shell).disabled(model.saving)
                }
            }
            Text(strings.t("research.lifeScenario.assumption")).font(.caption).foregroundStyle(theme.secondaryLabel)
            HStack(spacing: 12) {
                Button(strings.t(model.running ? "research.lifeScenario.running" : "research.lifeScenario.run")) {
                    Task { await model.run() }
                }.buttonStyle(.borderedProminent).disabled(model.running || model.saving)
                Button(strings.t("research.lifeScenario.save")) { Task { await model.saveDraft() } }
                    .buttonStyle(.bordered).disabled(!model.canSave)
                if model.draft.id != nil {
                    Button(strings.t("research.lifeScenario.delete"), role: .destructive) {
                        Task { await model.deleteDraft() }
                    }
                    .disabled(model.saving)
                }
            }
            if let error = model.error {
                Label(
                    error.hasPrefix("research.lifeScenario.") ? strings.t(error) : error,
                    systemImage: "exclamationmark.triangle"
                )
                .font(.callout).foregroundStyle(theme.destructive).textSelection(.enabled)
            }
            if let comparison = comparison {
                if !comparison.available {
                    Label(strings.t("research.lifeScenario.unavailable"), systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(theme.secondaryLabel)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(strings.t("research.lifeScenario.result")).font(.headline).accessibilityAddTraits(
                            .isHeader)
                        Text(strings.t("research.lifeScenario.resultHelp")).font(.caption).foregroundStyle(
                            theme.secondaryLabel)
                        moneyRow("research.lifeScenario.baselineMedian", comparison.baseline.projected?.p50)
                        moneyRow("research.lifeScenario.interruptedMedian", comparison.interrupted.projected?.p50)
                        moneyRow("research.lifeScenario.medianGap", comparison.medianGap)
                        if comparison.goalMonth != nil {
                            row(
                                "research.lifeScenario.baselineGoalProbability",
                                value: ResearchForecastDisplay.percent(
                                    comparison.baseline.probTarget, shell: shell, compact: true))
                            row(
                                "research.lifeScenario.interruptedGoalProbability",
                                value: ResearchForecastDisplay.percent(
                                    comparison.interrupted.probTarget, shell: shell, compact: true))
                        }
                        Text(
                            strings.t(
                                "research.lifeScenario.reducedContribution",
                                ["amount": money(comparison.reducedContribution)])
                        )
                        .font(.caption).foregroundStyle(theme.secondaryLabel)
                        if comparison.monthlyDeficit > 0 {
                            Text(
                                strings.t(
                                    "research.lifeScenario.deficitExcluded",
                                    ["amount": money(comparison.monthlyDeficit)])
                            )
                            .font(.caption).foregroundStyle(theme.destructive)
                        }
                    }
                }
            }
        }.onGeometryChange(for: CGFloat.self) {
            $0.size.width
        } action: {
            width = $0
        }
    }
    @ViewBuilder private var amounts: some View {
        field("research.lifeScenario.monthlySurplus", key: \.monthlySurplus)
        field("research.lifeScenario.monthlyIncomeLoss", key: \.monthlyIncomeLoss)
        field("research.lifeScenario.monthlyContribution", key: \.monthlyContribution)
    }
    private func field(_ key: String, key path: WritableKeyPath<ResearchLifeScenarioDraft, String>, limit: Int? = nil)
        -> some View
    {
        VStack(alignment: .leading, spacing: 7) {
            Text(strings.t(key)).font(.caption)
            TextField(
                "",
                text: Binding(
                    get: { model.draft[keyPath: path] },
                    set: { value in
                        model.draft[keyPath: path] = limit.map { String(value.prefix($0)) } ?? value
                    })
            ).textFieldStyle(.roundedBorder).disabled(model.saving).accessibilityLabel(strings.t(key))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func binding(_ key: WritableKeyPath<ResearchLifeScenarioDraft, String>) -> Binding<String> {
        Binding(get: { model.draft[keyPath: key] }, set: { model.draft[keyPath: key] = $0 })
    }
    private func money(_ value: Decimal?) -> String {
        ResearchForecastDisplay.money(value, currency: currency, shell: shell)
    }
    private func moneyRow(_ key: String, _ value: Decimal?) -> some View { row(key, value: money(value)) }
    private func row(_ key: String, value: String) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(strings.t(key)).font(.callout)
                Spacer()
                Text(value).font(.callout).monospacedDigit()
            }
            .padding(.vertical, 10)
            Divider()
        }
    }
}

struct ResearchLifeScenarioUndoToast: View {
    let model: ResearchLifeScenarioModel
    let shell: NativeShellModel
    init(model: ResearchLifeScenarioModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    var body: some View {
        ActionToast(
            notice: model.undoNotice, strings: shell.strings, actionTitle: shell.strings.t("common.undo"),
            duration: .seconds(8),
            action: { Task { await model.undo() } }, clear: model.clearUndoNotice)
    }
}

/// A month input keeps YYYY-MM editing, with native month/year controls alongside.
private struct ResearchGoalMonthField: View {
    @Binding var value: String
    let shell: NativeShellModel
    @State private var open = false
    @State private var year = Calendar(identifier: .gregorian).component(.year, from: Date())
    @State private var month = Calendar(identifier: .gregorian).component(.month, from: Date())
    init(value: Binding<String>, shell: NativeShellModel) {
        self._value = value
        self.shell = shell
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(shell.strings.t("research.lifeScenario.goalDate")).font(.caption)
            HStack(spacing: 6) {
                TextField("YYYY-MM", text: $value).textFieldStyle(.roundedBorder)
                    .accessibilityLabel(shell.strings.t("research.lifeScenario.goalDate"))
                Button {
                    let parts = value.split(separator: "-").compactMap { Int($0) }
                    if parts.count == 2, (1...9999).contains(parts[0]), (1...12).contains(parts[1]) {
                        year = parts[0]
                        month = parts[1]
                    } else {
                        year = Calendar(identifier: .gregorian).component(.year, from: Date())
                        month = Calendar(identifier: .gregorian).component(.month, from: Date())
                    }
                    open = true
                } label: {
                    Image(systemName: "calendar")
                }
                .accessibilityLabel(shell.strings.t("research.lifeScenario.goalDate"))
                .popover(isPresented: $open) {
                    VStack(spacing: 12) {
                        Stepper(String(year), value: $year, in: 1...9999)
                        Picker(shell.strings.t("research.lifeScenario.goalDate"), selection: $month) {
                            ForEach(1...12, id: \.self) { number in Text(monthName(number)).tag(number) }
                        }.labelsHidden()
                        if !value.isEmpty {
                            Button(shell.strings.t("common.clear")) {
                                value = ""
                                open = false
                            }
                        }
                    }.padding(16).frame(width: 230)
                        .onChange(of: year) { _, _ in write() }
                        .onChange(of: month) { _, _ in write() }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func write() { value = String(format: "%04d-%02d", year, month) }
    private func monthName(_ number: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = LanguageLocale.locale(shell.strings.language)
        return formatter.monthSymbols[number - 1]
    }
}

import SwiftUI
import VisionNativeCore

struct PortfolioProviderFields: View {
    let model: PortfolioEditingModel
    let shell: NativeShellModel
    private var strings: any Localizing { shell.strings }
    @Environment(\.visionTheme) private var theme
    private var draft: PortfolioProviderDraft { model.investmentDraft?.provider ?? .init() }
    private func text(_ path: WritableKeyPath<PortfolioProviderDraft, String>) -> Binding<String> {
        Binding(
            get: { draft[keyPath: path] },
            set: {
                model.investmentDraft?.provider[keyPath: path] = $0
                model.clearIssue()
            })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker(
                strings.t("addInv.label.priceProvider"),
                selection: Binding(get: { draft.provider }, set: { model.investmentDraft?.provider.select($0) })
            ) {
                ForEach(model.providers) { provider in
                    Text(provider.key == "manual" ? strings.t("addInv.provider.manual") : provider.name).tag(
                        provider.key)
                }
            }
            if let selected = model.providers.first(where: { $0.key == draft.provider }) {
                let known = ["manual", "binance", "yahoo", "custom", "kinesis"].contains(selected.key)
                Text(known ? strings.t("addInv.provider.hint." + selected.key) : selected.description)
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            if draft.provider != "manual" && draft.provider != "custom" {
                input("addInv.label.providerId", \.id)
            }
            if draft.provider == "custom" {
                input("addInv.label.latestJsonEndpoint", \.latestUrl)
                input("addInv.label.latestJsonPath", \.latestPath)
                input("addInv.label.historyJsonEndpoint", \.historyUrl)
                input("addInv.label.historyArrayPath", \.historyPath)
                input("addInv.label.historyTimestampPath", \.historyTimestampPath)
                input("addInv.label.historyPricePath", \.historyPricePath)
            }
        }
    }
    private func input(_ key: String, _ path: WritableKeyPath<PortfolioProviderDraft, String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key)).font(.callout)
            TextField("", text: text(path)).textFieldStyle(.vision).font(.system(.body, design: .monospaced))
                .accessibilityLabel(strings.t(key))
        }
    }
}

struct PortfolioBrokerField: View {
    let model: PortfolioEditingModel
    let shell: NativeShellModel
    let selected: Int?
    let wasChosen: Bool
    let onChoose: (Int?) -> Void
    var compact = false
    @State private var expanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var effective: Int? { wasChosen ? selected : model.defaultBrokerId }
    private var label: String {
        model.brokers.first { $0.id == effective }.map(AccountKinds.label)
            ?? strings.t("addPortTxn.broker.unassigned")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if compact && !expanded {
                HStack {
                    Image(systemName: "arrow.right")
                    Text(label)
                    Text("·").accessibilityHidden(true)
                    Button(strings.t("addPortTxn.broker.change")) { expanded = true }.buttonStyle(.visionLink)
                }.font(.footnote).foregroundStyle(theme.secondaryLabel)
            } else {
                Picker(
                    strings.t("addPortTxn.broker"),
                    selection: Binding(get: { effective ?? -1 }, set: { onChoose($0 == -1 ? nil : $0) })
                ) {
                    Text(strings.t("addPortTxn.broker.unassigned")).tag(-1)
                    ForEach(model.brokers, id: \.id) { broker in Text(AccountKinds.label(broker)).tag(broker.id)
                    }
                }.disabled(model.brokersLoading)
            }
            if let error = model.brokersError ?? model.brokerHistoryError {
                HStack {
                    Text(error).font(.footnote).foregroundStyle(theme.destructive)
                    Button(strings.t("common.retry")) { Task { await model.loadOptions() } }
                }
            }
        }
    }
}

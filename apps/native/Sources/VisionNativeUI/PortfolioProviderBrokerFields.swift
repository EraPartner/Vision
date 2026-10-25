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
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("addInv.label.priceProvider")).font(.callout)
                VisionSelect(
                    selection: Binding(get: { draft.provider }, set: { model.investmentDraft?.provider.select($0) }),
                    options: model.providers.map { provider in
                        VisionSelectOption(
                            value: provider.key,
                            title: provider.key == .manual ? strings.t("addInv.provider.manual") : provider.name)
                    }, accessibilityLabel: strings.t("addInv.label.priceProvider"), expands: true)
            }
            if let selected = model.providers.first(where: { $0.key == draft.provider }) {
                let known = [.manual, .binance, .yahoo, .custom, .kinesis].contains(selected.key)
                Text(known ? strings.t("addInv.provider.hint." + selected.key.rawValue) : selected.description)
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            if draft.provider != .manual && draft.provider != .custom {
                input("addInv.label.providerId", \.id)
            }
            if draft.provider == .custom {
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
    let selected: AccountID?
    let wasChosen: Bool
    let onChoose: (AccountID?) -> Void
    var compact = false
    @State private var expanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var effective: AccountID? { wasChosen ? selected : model.defaultBrokerId }
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
                Text(strings.t("addPortTxn.broker")).font(.callout)
                VisionSelect(
                    selection: Binding(get: { effective }, set: { onChoose($0) }),
                    options: [VisionSelectOption<AccountID?>(value: nil, title: strings.t("addPortTxn.broker.unassigned"))]
                        + model.brokers.map {
                            VisionSelectOption<AccountID?>(value: $0.id, title: AccountKinds.label($0))
                        },
                    accessibilityLabel: strings.t("addPortTxn.broker"), expands: true
                ).disabled(model.brokersLoading)
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

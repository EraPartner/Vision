import SwiftUI
import VisionNativeCore

/// A reviewed, complete-history batch. Its copied rows stay independent of detail selection.
struct PortfolioHoldingsUnassignedView: View {
    let holding: PortfolioHolding
    let model: PortfolioModel
    let editing: PortfolioEditingModel
    let shell: NativeShellModel
    @State private var history: [PortfolioTransaction]?
    @State private var loading = false
    @State private var loadFailed = false
    @State private var brokerId: Int?
    @State private var confirming = false
    @State private var loadRevision = UUID()
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var ids: [Int] {
        PortfolioEditingModel.unassignedLotIds(investmentId: holding.id, history: history ?? [])
    }
    private var effectiveBroker: Int? {
        brokerId ?? editing.preferredBrokerId(investmentId: holding.id) ?? editing.brokers.first?.id
    }
    var body: some View {
        Group {
            if !holding.fullyAssigned, holding.isActive {
                VStack(alignment: .leading, spacing: 8) {
                    if loading {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(strings.t("portfolio.unassignedLotsLoading"))
                        }
                    } else if loadFailed {
                        Text(strings.t("portfolio.unassignedLotsLoadFailed")).foregroundStyle(theme.warning)
                        Button(strings.t("common.retry")) { Task { await load() } }
                    } else if history == nil {
                        Button(strings.t("portfolio.assignLotsReviewTitle")) { Task { await load() } }
                    } else if !ids.isEmpty {
                        Label(
                            strings.t("portfolio.unassignedLots", ["count": String(ids.count)]),
                            systemImage: "exclamationmark.triangle"
                        )
                        .foregroundStyle(theme.warning)
                        if editing.brokers.isEmpty {
                            Text(strings.t("portfolio.unassignedLotsNoBroker")).foregroundStyle(theme.warning)
                        } else {
                            HStack {
                                Picker(
                                    strings.t("portfolio.assignLotsBroker"),
                                    selection: Binding(get: { effectiveBroker }, set: { brokerId = $0 })
                                ) {
                                    ForEach(editing.brokers, id: \.id) { broker in
                                        Text(broker.name).tag(Optional(broker.id))
                                    }
                                }.frame(maxWidth: 280)
                                Button(strings.t("portfolio.assignLots")) { confirming = true }
                                    .disabled(
                                        effectiveBroker == nil || ids.count > 500 || editing.isMutating
                                            || editing.isSaving || editing.brokersLoading || editing.brokersError != nil
                                            || editing.brokerHistoryLoading || editing.brokerHistoryError != nil
                                    )
                            }
                            if ids.count > 500 {
                                Text(strings.t("portfolio.assignLotsOverLimit")).foregroundStyle(theme.warning)
                            }
                        }
                        if let error = editing.error { Text(error).foregroundStyle(theme.destructive) }
                        if let error = editing.brokersError ?? editing.brokerHistoryError {
                            Text(error).foregroundStyle(theme.warning)
                            Button(strings.t("common.retry")) { Task { await editing.loadOptions() } }
                        }
                    }
                }.font(.caption).padding(.vertical, 6)
                    .confirmationDialog(
                        strings.t("portfolio.assignLotsReviewTitle"), isPresented: $confirming,
                        titleVisibility: .visible
                    ) {
                        Button(strings.t("portfolio.assignLotsConfirm")) {
                            guard let history, let broker = effectiveBroker, !editing.brokersLoading,
                                editing.brokersError == nil, !editing.brokerHistoryLoading,
                                editing.brokerHistoryError == nil
                            else { return }
                            Task {
                                if await editing.assignUnassignedLots(
                                    investmentId: holding.id, completeHistory: history, historyComplete: true,
                                    brokerId: broker)
                                {
                                    self.history = nil
                                }
                            }
                        }
                        Button(strings.t("common.cancel"), role: .cancel) {}
                    } message: {
                        Text(
                            strings.t(
                                "portfolio.assignLotsReviewDescription",
                                [
                                    "count": String(ids.count),
                                    "instrument": holding.name,
                                    "broker": editing.brokers.first { $0.id == effectiveBroker }?.name ?? "",
                                ]))
                    }
            }
        }.task(id: "\(holding.id)|\(model.historyVersion)") {
            if holding.isActive && !holding.fullyAssigned { await load(force: true) }
        }
    }
    private func load(force: Bool = false) async {
        guard force || !loading else { return }
        let revision = UUID()
        loadRevision = revision
        loading = true
        loadFailed = false
        history = nil
        confirming = false
        defer { if loadRevision == revision { loading = false } }
        do {
            let rows = try await model.independentHistory(investmentId: holding.id)
            guard loadRevision == revision, !Task.isCancelled else { return }
            history = rows
        } catch {
            guard loadRevision == revision, !Task.isCancelled else { return }
            loadFailed = true
            return
        }
        editing.bindTransactions(history ?? [], investmentId: holding.id)
        await editing.loadOptions()
        guard loadRevision == revision, !Task.isCancelled else { return }
    }
}

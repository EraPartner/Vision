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
    @State private var brokerId: AccountID?
    @State private var confirming = false
    @State private var loadRevision = UUID()
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var ids: [PortfolioTransactionID] {
        PortfolioEditingModel.unassignedLotIds(investmentId: holding.id, history: history ?? [])
    }
    private var effectiveBroker: AccountID? {
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
                            .buttonStyle(.visionOutline).controlSize(.small)
                    } else if history == nil {
                        Button(strings.t("portfolio.assignLotsReviewTitle")) { Task { await load() } }
                            .buttonStyle(.visionOutline).controlSize(.small)
                    } else if !ids.isEmpty {
                        callout
                        if let error = editing.error { Text(error).foregroundStyle(theme.destructive) }
                        if let error = editing.brokersError ?? editing.brokerHistoryError {
                            Text(error).foregroundStyle(theme.warning)
                            Button(strings.t("common.retry")) { Task { await editing.loadOptions() } }
                                .buttonStyle(.visionOutline).controlSize(.small)
                        }
                    }
                }.font(.caption)
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
    /// UnassignedLotsNudge: `flex flex-wrap items-center gap-2 rounded-card border border-warning/30
    /// bg-warning/10 px-3 py-2` holding the warning glyph, the count, the broker select and the
    /// assign button (or the over-limit / no-broker note).
    private var callout: some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
        return HStack(alignment: .center, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 14))
                .foregroundStyle(theme.warning).accessibilityHidden(true)
            Text(strings.t("portfolio.unassignedLots", ["count": String(ids.count)]))
                .foregroundStyle(theme.secondaryLabel)
            if editing.brokers.isEmpty {
                Text(strings.t("portfolio.unassignedLotsNoBroker")).fontWeight(.medium)
                    .foregroundStyle(theme.warning)
            } else {
                brokerSelect
                Button(strings.t("portfolio.assignLots")) { confirming = true }
                    .buttonStyle(.visionOutline).controlSize(.small)
                    .disabled(
                        effectiveBroker == nil || ids.count > 500 || editing.isMutating
                            || editing.isSaving || editing.brokersLoading || editing.brokersError != nil
                            || editing.brokerHistoryLoading || editing.brokerHistoryError != nil
                    )
                if ids.count > 500 {
                    Text(strings.t("portfolio.assignLotsOverLimit")).fontWeight(.medium)
                        .foregroundStyle(theme.warning)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(theme.warning.opacity(0.10), in: shape)
        .overlay(shape.strokeBorder(theme.warning.opacity(0.30), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
    private var brokerSelect: some View {
        VisionSelect(
            selection: Binding(get: { effectiveBroker }, set: { brokerId = $0 }),
            entries: editing.brokers.map { broker in
                VisionSelectEntry.option(VisionSelectOption(value: broker.id, title: broker.name))
            }, accessibilityLabel: strings.t("portfolio.assignLotsBroker")
        ).frame(minWidth: 128, maxWidth: 220)
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

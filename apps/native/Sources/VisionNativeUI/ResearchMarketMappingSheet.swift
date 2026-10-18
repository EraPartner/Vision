import SwiftUI
import VisionNativeCore

struct ResearchMarketMappingSheet: View {
    @Bindable var model: ResearchMarketMappingModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(strings.t("research.mapping.title")).font(.title2.weight(.semibold))
                Spacer()
                Button {
                    model.close()
                } label: {
                    Image(systemName: "xmark")
                }.accessibilityLabel(strings.t("common.close"))
            }
            Text(strings.t("research.mapping.desc", ["name": model.displayName])).foregroundStyle(theme.secondaryLabel)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        Text(strings.t("research.mapping.proposals")).font(.headline)
                        Spacer()
                        Button(strings.t("research.mapping.reresolve")) { Task { await model.resolve() } }.disabled(
                            model.isResolving)
                    }
                    if model.isResolving {
                        ProgressView().frame(maxWidth: .infinity).frame(height: 90)
                    } else if model.resolveError != nil {
                        Text(strings.t("research.mapping.resolveError")).foregroundStyle(theme.destructive)
                    } else if model.proposals.isEmpty {
                        Text(strings.t("research.mapping.noProposals")).foregroundStyle(theme.secondaryLabel)
                    } else {
                        ForEach(Array(model.proposals.enumerated()), id: \.offset) { _, proposal in
                            HStack(alignment: .top, spacing: 12) {
                                if proposal.isConfirmable {
                                    Toggle(
                                        "",
                                        isOn: Binding(
                                            get: { model.selected[proposal.provider] == true },
                                            set: { model.selected[proposal.provider] = $0 })
                                    ).labelsHidden().toggleStyle(.checkbox).accessibilityLabel(proposal.provider)
                                } else if proposal.fromHolding == true {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.success)
                                        .accessibilityLabel(strings.t("research.mapping.fromHolding"))
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(proposal.provider.uppercased()).font(.callout.weight(.medium))
                                        Text(strings.t("research.mapping.status." + status(proposal.status))).font(
                                            .caption
                                        ).foregroundStyle(statusTone(proposal.status))
                                    }
                                    if let symbol = proposal.providerSymbol { Text(symbol).monospaced() }
                                    let details = [proposal.resolvedName, proposal.exchange, proposal.currency]
                                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                                    if !details.isEmpty {
                                        Text(details).font(.caption).foregroundStyle(theme.secondaryLabel)
                                    }
                                    if let reason = proposal.reason {
                                        Text(reason).font(.caption).foregroundStyle(theme.secondaryLabel)
                                    }
                                    if let error = proposal.error {
                                        Text(error).font(.caption).foregroundStyle(theme.destructive)
                                    }
                                    if proposal.fromHolding == true {
                                        Text(strings.t("research.mapping.fromHolding")).font(.caption).foregroundStyle(
                                            theme.success)
                                    }
                                }
                                Spacer()
                            }.padding(.vertical, 6)
                        }
                    }
                    Divider()
                    HStack {
                        Text(strings.t("research.mapping.existing")).font(.headline)
                        Spacer()
                        Button(strings.t("research.mapping.audit")) { Task { await model.runAudit() } }.disabled(
                            model.existing.isEmpty || model.isAuditing)
                    }
                    if model.isLoading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if model.existing.isEmpty {
                        Text(strings.t("research.mapping.noExisting")).foregroundStyle(theme.secondaryLabel)
                    } else {
                        ForEach(model.existing) { mapping in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(mapping.provider.uppercased() + " · " + (mapping.providerSymbol ?? "—")).font(
                                        .callout.weight(.medium))
                                    Text(
                                        [mapping.resolvedName, mapping.exchange, mapping.currency].compactMap { $0 }
                                            .joined(separator: " · ")
                                    ).font(.caption).foregroundStyle(theme.secondaryLabel)
                                    if let date = mapping.verifiedAt {
                                        Text(
                                            strings.t(
                                                "research.mapping.verified",
                                                ["date": VisionFormat.appDate(date, format: shell.settings.dateFormat)])
                                        ).font(.caption).foregroundStyle(theme.secondaryLabel)
                                    }
                                }
                                Spacer()
                                Menu {
                                    Button(strings.t("research.mapping.remove"), role: .destructive) {
                                        model.pendingRemoval = mapping
                                    }
                                } label: {
                                    Image(systemName: "ellipsis")
                                }.accessibilityLabel(
                                    strings.t("research.mapping.rowMenu", ["provider": mapping.provider]))
                            }.padding(.vertical, 5)
                        }
                    }
                    if model.isAuditing { ProgressView().frame(maxWidth: .infinity) }
                    if let audit = model.audit {
                        if audit.discrepancies.isEmpty {
                            Label(strings.t("research.mapping.auditClean"), systemImage: "checkmark.circle")
                                .foregroundStyle(theme.success)
                        } else {
                            Text(strings.t("research.mapping.discrepancies")).font(.headline)
                            ForEach(Array(audit.discrepancies.enumerated()), id: \.offset) { _, issue in
                                Text(
                                    (issue["provider"]?.stringValue ?? "") + " · "
                                        + strings.t(
                                            issue["type"]?.stringValue == "currency_mismatch"
                                                ? "research.mapping.currencyMismatch" : "research.mapping.priceOutlier")
                                ).foregroundStyle(theme.warning)
                            }
                        }
                    }
                    if let key = model.noticeKey {
                        Text(strings.t(key)).font(.callout).foregroundStyle(
                            key.hasSuffix("Error") ? theme.destructive : theme.success)
                    }
                }
            }
            HStack {
                Button(strings.t("common.cancel")) { model.close() }
                Spacer()
                Button(strings.t("research.mapping.confirm", ["n": String(model.selectedCount)])) {
                    Task { await model.save() }
                }.buttonStyle(.visionPrimary).disabled(
                    model.selectedCount == 0 || model.isSaving || model.isResolving)
            }
        }.padding(24).frame(width: 650).frame(maxHeight: 760)
            .confirmationDialog(
                strings.t("research.mapping.remove"),
                isPresented: Binding(
                    get: { model.pendingRemoval != nil }, set: { if !$0 { model.pendingRemoval = nil } }),
                titleVisibility: .visible
            ) {
                Button(strings.t("common.delete"), role: .destructive) { Task { await model.remove() } }
                Button(strings.t("common.cancel"), role: .cancel) { model.pendingRemoval = nil }
            } message: {
                Text(
                    strings.t(
                        "research.mapping.removeDesc",
                        [
                            "provider": model.pendingRemoval?.provider ?? "",
                            "symbol": model.pendingRemoval?.providerSymbol ?? "—",
                        ]))
            }
    }
    private func status(_ value: String) -> String {
        switch value {
        case "auto", "confirmed", "skipped", "unavailable": value
        case "error", "failed": "error"
        default: "none"
        }
    }
    private func statusTone(_ value: String) -> Color {
        value == "confirmed"
            ? theme.success : ["error", "failed"].contains(value) ? theme.destructive : theme.secondaryLabel
    }
}

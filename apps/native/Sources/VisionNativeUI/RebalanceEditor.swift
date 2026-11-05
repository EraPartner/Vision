import SwiftUI
import VisionNativeCore

extension RebalanceView {
    var editorCard: some View {
        card("rebalance.editor.title") {
            HStack {
                Button(strings.t("rebalance.editor.loadCurrent")) { model.loadCurrentMix() }
                    .buttonStyle(.visionOutline).controlSize(.small)
                Menu {
                    ForEach(RebalancePreset.allCases, id: \.self) { preset in
                        Button(strings.t("rebalance.model.\(preset.rawValue)")) { model.loadPreset(preset) }
                    }
                } label: {
                    Text(strings.t("rebalance.editor.loadPreset")).visionChipChrome()
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            }
            ForEach(Array(model.draft.rows.enumerated()), id: \.offset) { index, row in
                allocationRow(index, row)
            }
            HStack {
                Button(strings.t("rebalance.editor.addSleeve")) { model.addRow() }
                    .buttonStyle(.visionOutline).controlSize(.small).disabled(model.draft.rows.count >= 8)
                Spacer()
                Text(
                    "\(strings.t("rebalance.editor.total")): \(VisionFormat.percent(model.weightTotal, digits: 0, locale: settings.numberFormat.locale))"
                )
                .monospacedDigit().foregroundStyle(totalIsHundred ? theme.secondaryLabel : theme.warning)
            }
            if !totalIsHundred && model.weightTotal > 0 {
                Text(strings.t("rebalance.editor.normalizeNote")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            Divider()
            Toggle(
                strings.t("rebalance.editor.capCash"),
                isOn: Binding(
                    get: { model.draft.capEnabled },
                    set: { enabled in
                        model.updateDraft { $0.capEnabled = enabled }
                    })
            ).toggleStyle(.visionSwitch)
            if model.draft.capEnabled {
                TextField(
                    VisionFormat.decimal(model.availableCash, fractionDigits: 0, locale: settings.numberFormat.locale),
                    text: Binding(
                        get: { model.draft.cap }, set: { value in model.updateDraft { $0.cap = value } })
                )
                .textFieldStyle(.vision).frame(width: 160).accessibilityLabel(
                    strings.t("rebalance.editor.capCash"))
                Text(strings.t("rebalance.editor.capHint", ["amount": money(model.availableCash)]))
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
            Divider()
            HStack(alignment: .bottom, spacing: 12) {
                field("rebalance.plan.name") {
                    TextField(
                        strings.t("rebalance.plan.namePlaceholder"),
                        text: Binding(
                            get: { model.draft.name },
                            set: { value in
                                model.updateDraft { $0.name = value }
                            })
                    ).textFieldStyle(.vision).frame(maxWidth: 300).focused($focus, equals: "name")
                }
                Button {
                    Task { await model.savePlan() }
                } label: {
                    HStack {
                        if model.isSaving { ProgressView().controlSize(.small) }
                        Text(strings.t(model.draft.planId == nil ? "rebalance.plan.save" : "rebalance.plan.update"))
                    }
                }.buttonStyle(.visionPrimary).disabled(!model.canSave)
                if model.draft.planId != nil {
                    Button(strings.t("rebalance.plan.delete"), role: .destructive) { model.requestDelete() }
                        .buttonStyle(.visionOutline).disabled(model.isSaving)
                }
            }
        }
    }
    var totalIsHundred: Bool {
        var number = model.weightTotal
        var rounded = Decimal.zero
        NSDecimalRound(&rounded, &number, 0, .plain)
        return rounded == 100
    }
    func allocationRow(_ index: Int, _ row: RebalanceDraftRow) -> some View {
        let name = row.sleeve.isEmpty ? strings.t("rebalance.editor.sleevePlaceholder") : label(row.sleeve)
        let sleeveLabel = "\(strings.t("rebalance.sleeve")) \(index + 1): \(name)"
        let targetLabel = "\(strings.t("rebalance.target")) \(index + 1): \(name) (%)"
        let removeLabel = "\(strings.t("rebalance.editor.removeSleeve")) \(index + 1): \(name)"
        return HStack(spacing: 12) {
            VisionSelect(
                selection: Binding(get: { row.sleeve }, set: { value in model.updateRow(index, sleeve: value) }),
                options: VisionSelectOption<String>.pairs(
                    [("", strings.t("rebalance.editor.sleevePlaceholder"))]
                        + RebalanceURLDraft.sleeves.map { ($0, label($0)) }),
                accessibilityLabel: sleeveLabel, expands: true
            ).frame(maxWidth: .infinity)
            TextField("%", text: Binding(get: { row.pct }, set: { value in model.updateRow(index, pct: value) }))
                .textFieldStyle(.vision).frame(width: 100).multilineTextAlignment(.trailing)
                .accessibilityLabel(targetLabel)
            Text("%").foregroundStyle(theme.secondaryLabel).accessibilityHidden(true)
            Button {
                model.removeRow(index)
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.vision(.ghost, size: .iconSm)).accessibilityLabel(removeLabel)
            .visionTooltip(removeLabel)
        }
    }
}

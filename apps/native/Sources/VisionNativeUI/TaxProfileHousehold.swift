import SwiftUI
import VisionNativeCore

extension TaxProfileSheet {
    var householdStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(strings.t("tax.household.section.title")).font(.headline)
            Text(strings.t("tax.household.section.desc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            if let assessment = model.assessment {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(
                            strings.t(
                                "tax.household.assessment.title",
                                [
                                    "year": draft.get(["taxYear"])?.decimalValue.map(VisionFormat.plain)
                                        ?? String(model.year)
                                ]))
                        Spacer()
                        Text(strings.t("tax.household.assessment.mode.\(assessment.mode.rawValue)")).font(.footnote)
                    }
                    Text(strings.t("tax.household.assessment.reason.\(assessment.reason.rawValue)")).font(.footnote)
                    Text(verbatim: assessment.legalBasis).font(.caption).foregroundStyle(theme.tertiaryLabel)
                }.padding(12).background(theme.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
            }
            if model.isComputing { ProgressView().controlSize(.small) }
            if let error = model.previewError {
                Text(verbatim: error).font(.footnote).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { model.retryPreview() }.buttonStyle(.visionOutline)
            }
            Toggle(
                strings.t("tax.household.field.hasPartner"),
                isOn: Binding(
                    get: { draft.partners.contains { $0["id"]?.stringValue == "B" } },
                    set: { value in model.edit { $0.setHasPartner(value) } })
            ).toggleStyle(.visionSwitch)
            Text(strings.t("tax.household.field.hasPartner.desc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            if model.assessment?.electable == true {
                Toggle(
                    strings.t("tax.household.field.deathYearJoint"),
                    isOn: Binding(
                        get: { draft.get(["relationship", "deathYearElection"])?.stringValue == "joint" },
                        set: { value in
                            model.edit {
                                $0.set(["relationship", "deathYearElection"], .string(value ? "joint" : "separate"))
                            }
                        })
                )
                .toggleStyle(.visionSwitch)
            }
            if draft.partners.count > 1 {
                Text(strings.t("tax.household.events.title")).font(.headline)
                let events = draft.get(["relationship", "events"])?.arrayValue ?? []
                if events.isEmpty {
                    Text(strings.t("tax.household.events.empty")).foregroundStyle(theme.secondaryLabel)
                }
                ForEach(TaxProfileRow.rows(events)) { row in
                    eventRow(row.index, row.value)
                }
                Button(strings.t("tax.household.event.add")) { model.edit { $0.addEvent() } }
                    .buttonStyle(.visionOutline)
                Divider()
                Text(strings.t("tax.household.claims.title")).font(.headline)
                claimant("tax.household.field.dependantsClaimant", path: ["dependents", "claimantPartnerId"])
                let share = draft.get(["home", "mortgageSharePartnerB"])?.decimalValue
                claimant(
                    "tax.household.field.ownHomeClaimant", path: ["home", "mortgageCreditPartnerId"],
                    shown: share == 100 ? "B" : (share == 0 ? "A" : nil)
                ).disabled(share != nil)
                if share != nil {
                    Text(strings.t("tax.household.field.ownHomeClaimant.shareSet")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                }
                number(
                    "tax.household.field.mortgageSharePartnerB", path: ["home", "mortgageSharePartnerB"], optional: true
                )
                Text(strings.t("tax.household.claims.note")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    func eventRow(_ index: Int, _ event: TaxValue) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(strings.t("tax.household.event.kindLabel")).foregroundStyle(theme.foreground)
                VisionSelect(
                    selection: Binding(
                        get: { event["kind"]?.stringValue ?? "marriage" },
                        set: { value in model.edit { $0.setEventKind(index: index, kind: value) } }),
                    options: TaxProfileDraft.eventKinds.map { kind in
                        VisionSelectOption(value: kind, title: strings.t("tax.household.event.kind.\(kind)"))
                    },
                    accessibilityLabel: strings.t("tax.household.event.kindLabel"))
                Button {
                    model.edit { $0.removeEvent(index: index) }
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.vision(.ghost, size: .iconSm))
                .accessibilityLabel(
                    strings.t(
                        "tax.household.event.remove",
                        ["event": strings.t("tax.household.event.kind.\(event["kind"]?.stringValue ?? "marriage")")]))
            }
            date("tax.household.event.date", path: ["relationship", "events", String(index), "date"], optional: false)
            if event["kind"]?.stringValue == "death" {
                claimant(
                    "tax.household.event.deceased", path: ["relationship", "events", String(index), "partnerId"],
                    fallback: "B")
            }
        }.padding(12).background(theme.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
    }
    func claimant(_ key: String, path: [String], fallback: String = "A", shown: String? = nil) -> some View {
        field(key) {
            VisionSelect(
                selection: Binding(
                    get: { shown ?? draft.get(path)?.stringValue ?? fallback },
                    set: { value in
                        model.edit { $0.set(path, .string(value)) }
                    }),
                options: [
                    VisionSelectOption(value: "A", title: label("A")),
                    VisionSelectOption(value: "B", title: label("B")),
                ],
                accessibilityLabel: strings.t(key), expands: true)
        }
    }
}

import SwiftUI
import VisionNativeCore

extension TaxProfileSheet {
    var incomeStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            intro("income")
            partnerPicker
            Text(strings.t("tax.household.activities.title", ["partner": label(model.partner)])).font(.headline)
            let activities = draft.get(partnerPath + ["activities"])?.arrayValue ?? []
            ForEach(TaxProfileRow.rows(activities)) { row in
                activityRow(row.index, row.value, removable: model.partner == "B" || activities.count > 1)
            }
            Button(strings.t("tax.household.activity.add")) { model.edit { $0.addActivity(partner: model.partner) } }
            Divider()
            Text(strings.t("tax.profile.section.professionalExpenses.title")).font(.headline)
            ForEach(draft.expenseCategories(model.partner), id: \.self) { category in
                expenseChoice(category)
            }
            number("tax.profile.field.otherTaxableIncome", path: partnerPath + ["otherTaxableIncome"])
            number("tax.profile.field.alimonyPaid", path: partnerPath + ["alimonyPaid"])
            number("tax.profile.field.unionDues", path: partnerPath + ["unionDues"])
            number(
                "tax.household.field.birthYear", path: partnerPath + ["birthYear"], integer: true, optional: true,
                bounds: 1900...2200)
            toggle(
                "tax.household.field.disability", path: partnerPath + ["isDisabled"],
                variables: ["partner": label(model.partner)])
        }
    }
    func activityRow(_ index: Int, _ activity: TaxValue, removable: Bool) -> some View {
        let path = partnerPath + ["activities", String(index)]
        let kind = activity["kind"]?.stringValue ?? "employee"
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker(
                    strings.t("tax.household.activity.kindLabel", ["n": String(index + 1)]),
                    selection: Binding(
                        get: { kind },
                        set: { value in
                            model.edit { $0.setActivityKind(partner: model.partner, index: index, kind: value) }
                        })
                ) {
                    ForEach(TaxProfileDraft.activityKinds, id: \.self) { kind in
                        Text(strings.t("tax.household.activity.kind.\(kind)")).tag(kind)
                    }
                }
                if removable {
                    Button {
                        model.edit { $0.removeActivity(partner: model.partner, index: index) }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .accessibilityLabel(strings.t("tax.household.activity.remove", ["n": String(index + 1)]))
                }
            }
            Text(strings.t("tax.household.activity.kind.\(kind).desc")).font(.footnote).foregroundStyle(
                theme.secondaryLabel)
            if kind == "pension" {
                choice(
                    "tax.household.activity.pensionKind", path: path + ["pensionKind"],
                    values: ["other", "statutory_from_legal_age", "survivor_or_transition"],
                    prefix: "tax.household.activity.pensionKind.",
                    labels: ["": "tax.household.activity.pensionKind.none"])
                Text(strings.t("tax.household.activity.pensionKind.desc")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
                if let pensionKind = activity["pensionKind"]?.stringValue {
                    Text(strings.t("tax.household.activity.pensionKind.\(pensionKind).desc")).font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
            }
            number(
                kind == "net_professional_amount"
                    ? "tax.household.activity.netIncome" : "tax.profile.field.grossAnnualIncome",
                path: path + [kind == "net_professional_amount" ? "netProfessionalIncome" : "grossIncome"])
            HStack(alignment: .top) {
                date("tax.household.activity.startDate", path: path + ["startDate"])
                date("tax.household.activity.endDate", path: path + ["endDate"])
            }
        }.padding(12).background(theme.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }
    func expenseChoice(_ category: String) -> some View {
        let path = partnerPath + ["professionalExpenses", category]
        let method = draft.get(path + ["method"])?.stringValue ?? "lump_sum"
        return VStack(alignment: .leading, spacing: 10) {
            if draft.expenseCategories(model.partner).count > 1 {
                Text(strings.t("tax.household.expenseCategory.\(category)")).font(.callout.weight(.medium))
            }
            Picker(
                strings.t("tax.profile.section.professionalExpenses.title"),
                selection: Binding(
                    get: { method },
                    set: { value in
                        model.edit {
                            $0.set(path + ["method"], .string(value))
                            if $0.get(path + ["actualAmount"]) == nil { $0.set(path + ["actualAmount"], .number(0)) }
                        }
                    })
            ) {
                Text(strings.t("tax.profile.profExp.lump.label")).tag("lump_sum")
                Text(strings.t("tax.profile.profExp.actual.label")).tag("actual")
            }.pickerStyle(.segmented).labelsHidden()
            Text(strings.t(method == "actual" ? "tax.profile.profExp.actual.desc" : "tax.profile.profExp.lump.desc"))
                .font(.footnote).foregroundStyle(theme.secondaryLabel)
            if method == "actual" {
                number("tax.profile.field.actualProfessionalExpenses", path: path + ["actualAmount"])
            }
        }
    }
}

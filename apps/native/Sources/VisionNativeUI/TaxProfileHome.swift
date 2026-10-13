import SwiftUI
import VisionNativeCore

extension TaxProfileSheet {
    var homeStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            intro("home")
            number("tax.profile.field.cadastralIncome", path: ["home", "cadastralIncome"])
            intro("residences")
            let residences = draft.get(["home", "additionalResidences"])?.arrayValue ?? []
            ForEach(TaxProfileRow.rows(residences)) { row in
                residenceRow(row.index)
            }
            HStack {
                Button(strings.t("tax.profile.addResidence")) {
                    model.edit {
                        $0.addResidence()
                        $0.set(["home", "mortgageRegion"], nil)
                    }
                }
                if !residences.isEmpty {
                    Button(strings.t("common.reset")) {
                        model.edit {
                            $0.set(["home", "additionalResidences"], .array([]))
                            $0.set(["home", "mortgageRegion"], nil)
                        }
                    }
                }
            }
            Divider()
            intro("ownHome")
            toggle("tax.profile.field.mortgageIsPrimaryResidence", path: ["home", "mortgageIsPrimaryResidence"])
            if draft.get(["home", "mortgageIsPrimaryResidence"])?.boolValue == true {
                number(
                    "tax.profile.field.mortgageStartYear", path: ["home", "mortgageStartYear"], integer: true,
                    optional: true)
                number("tax.profile.field.mortgageInterestPaid", path: ["home", "mortgageInterestPaid"])
                number("tax.profile.field.mortgageCapitalRepaid", path: ["home", "mortgageCapitalRepaid"])
                if draft.get(["region"])?.stringValue == "wallonia" {
                    number(
                        "tax.profile.field.chequeHabitatFirstYear", path: ["home", "firstQualifyingYear"],
                        integer: true, optional: true, bounds: 1900...2200)
                }
                if draft.get(["region"])?.stringValue == "flanders",
                    let year = draft.get(["home", "mortgageStartYear"])?.decimalValue, year < 2020
                {
                    number(
                        "tax.profile.field.woonbonusChildrenAtLoanStart",
                        path: ["home", "woonbonusChildrenAtLoanStart"], integer: true, optional: true, bounds: 0...1000)
                }
                Text(strings.t("tax.profile.section.ownHome.note")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
            }
        }
    }
    func residenceRow(_ index: Int) -> some View {
        let path = ["home", "additionalResidences", String(index)]
        return VStack(alignment: .leading, spacing: 10) {
            field("tax.profile.field.residenceLabel") {
                TextField(
                    strings.t("tax.profile.field.residenceLabel"),
                    text: Binding(
                        get: { draft.get(path + ["label"])?.stringValue ?? "" },
                        set: { value in
                            model.edit {
                                $0.set(path + ["label"], .string(value))
                                $0.set(["home", "mortgageRegion"], nil)
                            }
                        })
                ).textFieldStyle(.roundedBorder)
            }
            number("tax.profile.field.cadastralIncome", path: path + ["cadastralIncome"])
            choice(
                "tax.profile.field.regionLabel", path: path + ["region"], values: TaxProfileDraft.regions,
                prefix: "tax.profile.region.", suffix: ".label",
                fallback: draft.get(["region"])?.stringValue ?? "flanders")
        }.padding(12).background(theme.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }
    var regionStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            intro("region")
            field("tax.profile.field.regionLabel") {
                ForEach(TaxProfileDraft.regions, id: \.self) { region in
                    Button {
                        model.edit {
                            $0.set(["region"], .string(region))
                            $0.set(
                                ["communalSurchargePercent"],
                                .number(region == "wallonia" ? Decimal(string: "7.5")! : 7))
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(
                                systemName: draft.get(["region"])?.stringValue == region
                                    ? "largecircle.fill.circle" : "circle")
                            VStack(alignment: .leading, spacing: 4) {
                                Text(strings.t("tax.profile.region.\(region).label")).font(.callout.weight(.medium))
                                Text(strings.t("tax.profile.region.\(region).desc")).font(.footnote)
                                Text(
                                    strings.t(
                                        "tax.profile.region.defaultSurcharge",
                                        [
                                            "pct": region == "wallonia"
                                                ? LocaleNumber.editable(
                                                    Decimal(string: "7.5"), format: settings.numberFormat) : "7"
                                        ])
                                )
                                .font(.footnote).foregroundStyle(theme.secondaryLabel)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(12).contentShape(Rectangle())
                    }.buttonStyle(.plain).background(theme.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            number("tax.profile.field.communalSurcharge", path: ["communalSurchargePercent"])
            Text(strings.t("tax.profile.communalSurchargePct")).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
    }
}

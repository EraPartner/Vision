import SwiftUI
import VisionNativeCore

extension TaxProfileSheet {
    var sourcesStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            intro("incomeSources")
            Text(strings.t("tax.profile.section.incomeSources.note")).font(.footnote).foregroundStyle(
                theme.secondaryLabel)
            HStack {
                Text(strings.t("tax.profile.section.incomeSources.categoriesLabel")).font(.headline)
                Spacer()
                Text("\(selectedCategoryIds.count) \(strings.t("tax.profile.section.incomeSources.selected"))").font(
                    .footnote)
                if !selectedCategoryIds.isEmpty {
                    Button(strings.t("common.clear")) { model.edit { $0.set(["taxIncomeCategoryIds"], .array([])) } }
                }
            }
            TextField(strings.t("tax.profile.section.incomeSources.searchPlaceholder"), text: $model.categorySearch)
                .textFieldStyle(.vision)
            if model.categoriesLoading { ProgressView() }
            if let error = model.categoriesError {
                Text(verbatim: error).foregroundStyle(theme.destructive)
                Button(strings.t("common.retry")) { Task { await model.loadCategories() } }
            }
            if model.categories.isEmpty && !model.categoriesLoading {
                Text(strings.t("tax.profile.section.incomeSources.empty")).foregroundStyle(theme.secondaryLabel)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(
                        model.categories.filter {
                            model.categorySearch.isEmpty
                                || $0.path.joined(separator: " / ").localizedCaseInsensitiveContains(
                                    model.categorySearch)
                        }, id: \.id
                    ) { category in
                        Toggle(
                            category.path.joined(separator: " / "),
                            isOn: Binding(
                                get: { selectedCategoryIds.contains(category.id) },
                                set: { enabled in
                                    var ids = selectedCategoryIds
                                    if enabled { ids.append(category.id) } else { ids.removeAll { $0 == category.id } }
                                    model.edit {
                                        $0.set(["taxIncomeCategoryIds"], .array(ids.map { .number(Decimal($0)) }))
                                    }
                                })
                        ).toggleStyle(.checkbox)
                    }
                }.padding(.vertical, 8)
            }.frame(height: 260)
        }
    }
    var selectedCategoryIds: [Int] {
        (draft.get(["taxIncomeCategoryIds"])?.arrayValue ?? []).compactMap {
            $0.decimalValue.map { NSDecimalNumber(decimal: $0).intValue }
        }
    }
    var exemptionsStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            intro("exemptions")
            dependentCount("tax.profile.field.children", key: "children", maximum: 5)
            if dependent("children") > 0 {
                dependentCount(
                    "tax.profile.field.childrenDisabled", key: "childrenDisabled", maximum: dependent("children"))
            }
            dependentCount("tax.profile.field.others", key: "otherPersons", maximum: 3)
            if dependent("otherPersons") > 0 {
                dependentCount(
                    "tax.profile.field.othersDisabled", key: "otherPersonsDisabled", maximum: dependent("otherPersons"))
            }
            Divider()
            Text(strings.t("tax.profile.section.otherDeductions.title")).font(.headline)
            partnerPicker
            deduction("personalPensionContributions", eligibility: "pensionEligible")
            choice(
                "tax.profile.field.personalPensionContributions", path: partnerPath + ["reductions", "pensionScheme"],
                values: ["1050", "1350"], prefix: "tax.profile.pensionScheme.",
                labels: ["1050": "tax.profile.pensionScheme.standard", "1350": "tax.profile.pensionScheme.alternative"])
            deduction("employeeGroupInsuranceContributions", eligibility: "employeeGroupInsuranceEligible")
            deduction("lifeInsurancePremiums", eligibility: "lifeInsuranceEligible")
            deduction("charitableDonations", eligibility: "charitableDonationsEligible")
            deduction("childcareCosts", eligibility: "childcareEligible")
            number(
                "tax.profile.field.childcareEligibleDays", path: partnerPath + ["reductions", "childcareEligibleDays"],
                integer: true)
            deduction("domesticHelpCosts", eligibility: "domesticHelpEligible")
            number(
                "tax.profile.field.serviceVoucherSpend", path: partnerPath + ["reductions", "serviceVoucherSpend"],
                optional: true, clampMinimum: 0)
            Text(strings.t("tax.profile.field.serviceVoucherSpend.desc")).font(.footnote).foregroundStyle(
                theme.secondaryLabel)
            toggle(
                "tax.profile.flag.serviceVoucherEligible", path: partnerPath + ["reductions", "serviceVoucherEligible"])
            toggle("tax.profile.field.isolatedParent.label", path: partnerPath + ["isIsolatedParent"])
            Text(strings.t("tax.profile.field.isolatedParent.desc")).font(.footnote).foregroundStyle(
                theme.secondaryLabel)
        }
    }
    func deduction(_ fieldName: String, eligibility: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            number("tax.profile.field.\(fieldName)", path: partnerPath + ["reductions", fieldName])
            toggle("tax.profile.flag.\(eligibility)", path: partnerPath + ["reductions", eligibility], fallback: false)
        }
    }
    func dependent(_ key: String) -> Int {
        draft.get(["dependents", key])?.decimalValue.map { NSDecimalNumber(decimal: $0).intValue } ?? 0
    }
    func dependentCount(_ label: String, key: String, maximum: Int) -> some View {
        field(label) {
            Picker(
                strings.t(label),
                selection: Binding(
                    get: { dependent(key) },
                    set: { value in
                        model.edit { $0.setDependent(key, count: value) }
                    })
            ) {
                ForEach(Array(Set(Array(0...max(0, maximum)) + [dependent(key)])).sorted(), id: \.self) { count in
                    Text(count == 0 ? strings.t("common.none") : String(count)).tag(count)
                }
            }.labelsHidden()
        }
    }
}

import SwiftUI
import VisionNativeCore

struct SuggestedDeductionsView: View {
    let suggestions: [TaxDeductionSuggestion]
    let shell: NativeShellModel
    let onEditProfile: () -> Void
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }

    var body: some View {
        TaxCard(title: strings.t("tax.suggestions.title")) {
            if suggestions.isEmpty {
                Text(strings.t("tax.suggestions.none"))
                Text(strings.t("tax.suggestions.regionalNote")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            } else {
                ForEach(suggestions) { suggestion in
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(strings.t(suggestion.titleKey)).font(.headline)
                            Text(
                                strings.t(
                                    suggestion.descriptionKey,
                                    (suggestion.descriptionParams ?? [:]).mapValues { $0.description })
                            )
                            .font(.callout).foregroundStyle(theme.secondaryLabel)
                            if let key = suggestion.noteKey {
                                Text(strings.t(key)).font(.footnote).foregroundStyle(theme.secondaryLabel)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .trailing, spacing: 8) {
                            if let estimate = suggestion.estimate, estimate > 0 {
                                Text(
                                    MoneyText.text(
                                        estimate, currency: shell.settings.portfolioCurrency, settings: shell.settings)
                                )
                                .font(.headline).monospacedDigit().foregroundStyle(theme.gain)
                            } else {
                                Text(strings.t("tax.suggestions.estimateNote")).font(.footnote).foregroundStyle(
                                    theme.secondaryLabel)
                            }
                            Button(strings.t("tax.suggestions.cta"), action: onEditProfile)
                        }
                    }.padding(.vertical, 8)
                    Divider()
                }
                Text(strings.t("tax.suggestions.regionalTitle")).font(.headline)
                Text(strings.t("tax.suggestions.regionalDesc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
                Text(strings.t("tax.suggestions.multipleResidencesNote")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
            }
            Link(destination: URL(string: "https://taxsummaries.pwc.com/belgium/individual/deductions")!) {
                Label(strings.t("tax.suggestions.pwcLink"), systemImage: "arrow.up.right.square")
            }
        }
    }
}

struct TaxDeductionsView: View {
    let model: TaxDeductionsModel
    let shell: NativeShellModel
    let household: TaxValue?
    let canApply: Bool
    let onApply: (TaxDeductionApplication) async throws -> Bool
    @State private var notice: ScreenNotice?
    @State private var noticeCounter = 0
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var twoPartners: Bool {
        household?["partners"]?.arrayValue?.contains { $0["id"]?.stringValue == "B" } ?? false
    }
    private var currency: CurrencyCode { model.data?.currency ?? .eur }

    var body: some View {
        Group {
            if model.error != nil {
                TaxCard(title: strings.t("tax.deductionCandidates.title")) {
                    HStack {
                        Text(strings.t("tax.deductionCandidates.unavailable")).accessibilityAddTraits(
                            .updatesFrequently)
                        Spacer()
                        Button(strings.t("common.retry")) {
                            Task { await model.retry() }
                        }.disabled(model.isFetching)
                    }
                }
            } else if !model.groups.isEmpty {
                TaxCard(
                    title: strings.t("tax.deductionCandidates.title"),
                    description: strings.t("tax.deductionCandidates.description")
                ) {
                    Text(strings.t("tax.deductionCandidates.disclaimer")).font(.footnote).foregroundStyle(
                        theme.secondaryLabel)
                    ForEach(model.groups) { group in candidate(group) }
                    if let error = model.applyError {
                        Text(error).foregroundStyle(theme.destructive).textSelection(.enabled)
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            NoticeToast(notice: notice, strings: strings) { id in if notice?.id == id { notice = nil } }
        }
        .onChange(of: model.appliedTypes) { previous, next in
            if let type = next.subtracting(previous).first {
                noticeCounter += 1
                notice = ScreenNotice(
                    id: noticeCounter, kind: .success, key: "tax.deductionCandidates.toastConfirmed",
                    variables: ["type": strings.t("tax.deductionCandidates.type." + type)])
            }
        }
        .confirmationDialog(
            strings.t("tax.deductionCandidates.incompleteYearTitle", ["year": String(model.data?.year ?? 0)]),
            isPresented: Binding(get: { model.pending != nil }, set: { if !$0 { model.pending = nil } }),
            titleVisibility: .visible
        ) {
            if let group = model.pending {
                Button(strings.t("tax.deductionCandidates.incompleteYearConfirm")) {
                    Task { await model.apply(group, perform: onApply) }
                }
                .disabled(!canApply || !model.canConfirm)
            }
            Button(strings.t("common.cancel"), role: .cancel) { model.pending = nil }
        } message: {
            if let group = model.pending {
                Text(
                    strings.t(
                        "tax.deductionCandidates.incompleteYearDescription",
                        ["currentValue": money(currentTotal(group)), "candidateValue": money(group.total)]))
            }
        }
    }

    @ViewBuilder private func candidate(_ group: TaxDeductionGroup) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("tax.deductionCandidates.type." + group.deductionType)).font(.headline)
                Text(strings.t("tax.deductionCandidates.fromCategories", ["count": String(group.categoryCount)]))
                    .font(.footnote).foregroundStyle(theme.secondaryLabel)
                ForEach(Array(group.categories.enumerated()), id: \.offset) { _, category in
                    HStack {
                        Text(category.category).lineLimit(2)
                        Spacer()
                        Text(money(category.total)).monospacedDigit()
                    }.font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
                if twoPartners, let household, let mapping = group.mapping, !mapping.isHome {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(["A", "B"], id: \.self) { id in
                            Text(
                                strings.t(
                                    "tax.deductionCandidates.partnerShare",
                                    [
                                        "partner": partnerName(id), "value": group.partnerShares?[id].map(money) ?? "—",
                                        "current": money(mapping.currentValue(in: household, partner: id)),
                                    ]))
                        }
                    }.font(.footnote).foregroundStyle(theme.secondaryLabel)
                        .accessibilityLabel(strings.t("tax.deductionCandidates.byPartner"))
                } else {
                    Text(strings.t("tax.deductionCandidates.currentValue", ["value": money(currentTotal(group))]))
                        .font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 10) {
                Text(money(group.total)).font(.headline).monospacedDigit()
                if model.appliedTypes.contains(group.deductionType) {
                    Label(strings.t("tax.deductionCandidates.applied"), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(theme.gain).font(.callout)
                } else {
                    HStack {
                        Button(strings.t("tax.deductionCandidates.confirm")) {
                            guard model.canConfirm && canApply else { return }
                            if model.needsAcknowledgement() {
                                model.pending = group
                            } else {
                                Task { await model.apply(group, perform: onApply) }
                            }
                        }.disabled(!model.canConfirm || !canApply || !hasAttribution(group))
                        Button(strings.t("tax.deductionCandidates.dismiss")) { Task { await model.dismiss(group) } }
                            .disabled(model.isApplying)
                    }
                }
            }
        }.padding(16).background(
            theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
    }
    private func money(_ amount: Decimal) -> String {
        MoneyText.text(amount, currency: currency, settings: shell.settings)
    }
    private func currentTotal(_ group: TaxDeductionGroup) -> Decimal {
        guard let household, let mapping = group.mapping else { return 0 }
        let first = mapping.currentValue(in: household)
        return twoPartners && !mapping.isHome ? first + mapping.currentValue(in: household, partner: "B") : first
    }
    private func hasAttribution(_ group: TaxDeductionGroup) -> Bool {
        !twoPartners || group.mapping?.isHome == true
            || (group.partnerShares?["A"] != nil && group.partnerShares?["B"] != nil)
    }
    private func partnerName(_ id: String) -> String {
        let name = household?["partners"]?.arrayValue?.first { $0["id"]?.stringValue == id }?["displayName"]?
            .stringValue
        return name.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
            ?? strings.t("tax.household.partner." + id)
    }
}

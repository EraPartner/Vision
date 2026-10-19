import SwiftUI
import VisionNativeCore

public struct NativeSettingsInsightsView: View {
    let model: NativeSettingsModel
    let shell: NativeShellModel
    @State private var categorySearch = ""
    @State private var recipientSearch = ""
    @Environment(\.visionTheme) private var theme
    public init(model: NativeSettingsModel, shell: NativeShellModel) {
        self.model = model
        self.shell = shell
    }
    private var strings: any Localizing { shell.strings }
    private var groups: [NativeSettingsInsightsQuery.CategoryGroup] {
        NativeSettingsInsightsQuery.groups(model.categories, search: categorySearch)
    }
    private var recipients: [OpenAPI.Recipient] {
        NativeSettingsInsightsQuery.recipients(
            model.recipients, search: recipientSearch, excluded: model.excludedRecipientIds)
    }
    public var body: some View {
        NativeSettingsSection(title: strings.t("settings.section.statistics")) {
            NativeSettingsGroup(title: strings.t("settings.dashboard.exclusionScope")) {
                NativeSettingsSelectRow(
                    title: strings.t("settings.dashboard.exclusionScope"),
                    description: strings.t("settings.dashboard.exclusionScopeHint"),
                    value: Binding(
                        get: { model.dashboardString("exclusionScope", fallback: "everywhere") },
                        set: { model.updateDashboard(["exclusionScope": .string($0)]) }),
                    options: [
                        .init(value: "everywhere", label: strings.t("settings.dashboard.scope.everywhere")),
                        .init(value: "dashboard", label: strings.t("settings.dashboard.scope.dashboard")),
                        .init(value: "statistics", label: strings.t("settings.dashboard.scope.statistics")),
                    ])
                Divider()
                NativeSettingsRow(
                    title: strings.t("settings.dashboard.excludeHidden"),
                    description: strings.t("settings.dashboard.excludeHiddenHint")
                ) {
                    Toggle(
                        strings.t("settings.dashboard.excludeHidden"),
                        isOn: Binding(
                            get: { model.dashboardBool("excludeHiddenCategories", fallback: true) },
                            set: { model.updateDashboard(["excludeHiddenCategories": .bool($0)]) })
                    )
                    .labelsHidden().toggleStyle(.switch)
                }
                Divider()
                NativeSettingsRow(
                    title: strings.t("transfers.includeTransfers"),
                    description: strings.t("transfers.includeTransfersHint")
                ) {
                    Toggle(
                        strings.t("transfers.includeTransfers"),
                        isOn: Binding(
                            get: { model.includeTransfers },
                            set: { value in Task { await model.setIncludeTransfers(value) } })
                    )
                    .labelsHidden().toggleStyle(.switch)
                }
            }
            if model.optionsLoading && model.categories.isEmpty && model.recipients.isEmpty {
                ProgressView().frame(maxWidth: .infinity).padding(32).accessibilityLabel(strings.t("common.loading"))
            } else {
                categoryList
                recipientList
            }
        }
    }
    private var categoryList: some View {
        NativeSettingsGroup {
            listHeader(
                "settings.dashboard.excludedCategories", hint: "settings.dashboard.excludedCategoriesHint",
                count: model.excludedCategoryIds.count)
            TextField(strings.t("settings.dashboard.searchCategories"), text: $categorySearch)
                .textFieldStyle(.vision).accessibilityLabel(strings.t("settings.dashboard.searchCategories"))
                .padding(.horizontal, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if model.categories.isEmpty {
                        empty("settings.dashboard.noCategories")
                    } else if groups.isEmpty {
                        empty("settings.dashboard.noMatchingCategories")
                    } else {
                        ForEach(groups) { group in
                            HStack {
                                NativeSettingsInsightsMixedCheckbox(
                                    title: group.name,
                                    state: NativeSettingsInsightsQuery.checkState(
                                        group.items, excluded: model.excludedCategoryIds),
                                    foreground: theme.palette.foreground
                                ) {
                                    model.setExcludedCategoryIds(
                                        NativeSettingsInsightsQuery.toggledGroup(
                                            group.items, excluded: model.excludedCategoryIds))
                                }
                                Spacer()
                                Text(String(group.items.count)).font(.caption).monospacedDigit().foregroundStyle(
                                    theme.tertiaryLabel)
                            }.padding(8).background(theme.muted, in: RoundedRectangle(cornerRadius: 8))
                            ForEach(group.items, id: \.id) { category in
                                HStack {
                                    Toggle(
                                        isOn: Binding(
                                            get: { model.excludedCategoryIds.contains(category.id) },
                                            set: { _ in
                                                model.setExcludedCategoryIds(
                                                    NativeSettingsInsightsQuery.toggledID(
                                                        category.id, excluded: model.excludedCategoryIds))
                                            })
                                    ) {
                                        Text(verbatim: category.path.joined(separator: " / ")).frame(
                                            maxWidth: .infinity, alignment: .leading)
                                    }.toggleStyle(.checkbox)
                                    if !category.isActive { hiddenBadge }
                                }.font(.callout).padding(.leading, 26).padding(.horizontal, 8).padding(.vertical, 5)
                            }
                        }
                    }
                }.padding(.trailing, 8)
            }.frame(height: 230).padding(16)
        }
    }
    private var recipientList: some View {
        NativeSettingsGroup {
            listHeader(
                "settings.dashboard.excludedRecipients", hint: "settings.dashboard.excludedRecipientsHint",
                count: model.excludedRecipientIds.count)
            TextField(strings.t("settings.dashboard.searchRecipients"), text: $recipientSearch)
                .textFieldStyle(.vision).accessibilityLabel(strings.t("settings.dashboard.searchRecipients"))
                .padding(.horizontal, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if recipients.isEmpty {
                        empty(
                            recipientSearch.isEmpty
                                ? "settings.dashboard.noRecipients" : "settings.dashboard.noMatchingRecipients")
                    }
                    ForEach(recipients, id: \.id) { recipient in
                        HStack {
                            Toggle(
                                isOn: Binding(
                                    get: { model.excludedRecipientIds.contains(recipient.id) },
                                    set: { _ in
                                        model.setExcludedRecipientIds(
                                            NativeSettingsInsightsQuery.toggledID(
                                                recipient.id, excluded: model.excludedRecipientIds))
                                    })
                            ) {
                                Text(verbatim: recipient.name).frame(maxWidth: .infinity, alignment: .leading)
                            }.toggleStyle(.checkbox)
                            if !recipient.isActive { hiddenBadge }
                        }.font(.callout).padding(.horizontal, 8).padding(.vertical, 6)
                    }
                }.padding(.trailing, 8)
            }.frame(height: 200).padding(16)
        }
    }
    private func listHeader(_ key: String, hint: String, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(strings.t(key)).font(.body.weight(.medium)).foregroundStyle(theme.secondaryLabel)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                VisionBadge(text: strings.tc("settings.dashboard.excludedCount", count), tone: .secondary, small: true)
                    .monospacedDigit()
            }
            Text(strings.t(hint)).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 8)
    }
    private var hiddenBadge: some View {
        VisionBadge(text: strings.t("settings.dashboard.hidden"), tone: .outline, small: true)
    }
    private func empty(_ key: String) -> some View {
        Text(strings.t(key)).font(.callout).foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity).padding(
            .vertical, 20)
    }
}

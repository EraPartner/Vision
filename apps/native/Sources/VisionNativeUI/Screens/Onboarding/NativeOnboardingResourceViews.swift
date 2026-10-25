import SwiftUI
import VisionNativeCore

struct NativeOnboardingCategoriesView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if model.draft.categoriesCreated {
            VStack(alignment: .leading, spacing: 12) {
                Label(strings.t("onboarding.categories.created"), systemImage: "checkmark.circle")
                Text(strings.t("onboarding.categories.manage")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                // The web tiles: `Button variant="outline" aria-pressed`, emoji, name, group,
                // and a check when selected.
                LazyVGrid(
                    columns: [.init(.flexible(), spacing: 8), .init(.flexible(), spacing: 8), .init(.flexible())],
                    alignment: .leading, spacing: 8
                ) {
                    ForEach(NativeOnboardingPreset.categories.indices, id: \.self) { index in
                        categoryTile(index)
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        Task { await model.createCategories() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.creatingCategories {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "tag").accessibilityHidden(true)
                            }
                            Text(
                                strings.t(
                                    "onboarding.categories.create",
                                    ["n": String(model.draft.selectedCategoryIndexes.count)]))
                        }
                    }.buttonStyle(.visionPrimary)
                        .disabled(model.creatingCategories || model.draft.selectedCategoryIndexes.isEmpty)
                    Button(
                        strings.t(
                            model.draft.selectedCategoryIndexes.count == NativeOnboardingPreset.categories.count
                                ? "onboarding.categories.deselectAll" : "onboarding.categories.selectAll"),
                        action: model.toggleAllCategories
                    )
                    .buttonStyle(NativeSettingsGhostButtonStyle()).controlSize(.small)
                }
            }
        }
    }
    private func categoryTile(_ index: Int) -> some View {
        let category = NativeOnboardingPreset.categories[index]
        let selected = model.draft.selectedCategoryIndexes.contains(index)
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
        return Button {
            model.toggleCategory(index)
        } label: {
            HStack(spacing: 8) {
                Text(verbatim: category.emoji).font(.title3).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(strings.t(category.detailKey)).font(.footnote.weight(.medium))
                        .foregroundStyle(selected ? theme.foreground : theme.secondaryLabel)
                    Text(verbatim: category.general).font(.footnote).foregroundStyle(theme.tertiaryLabel)
                }.lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.primary)
                        .accessibilityHidden(true)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(selected ? theme.primary.opacity(0.05) : Color.clear))
            .overlay(shape.strokeBorder(selected ? theme.primary : theme.border, lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(strings.t(category.detailKey))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

struct NativeOnboardingBankView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.adaptersLoading {
                ProgressView().frame(maxWidth: .infinity).padding(30)
            } else {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible()), .init(.flexible())], spacing: 12) {
                    ForEach(model.adapters, id: \.key) { adapter in
                        Button {
                            model.selectBank(adapter.key)
                        } label: {
                            VStack(spacing: 10) {
                                Text(NativeOnboardingPreset.bankMonogram(name: adapter.name, key: adapter.key)).font(
                                    .title2
                                )
                                .accessibilityHidden(true)
                                Text(adapter.name)
                                Image(
                                    systemName: model.draft.selectedBank == adapter.key
                                        ? "checkmark.circle.fill" : "circle"
                                )
                                .accessibilityHidden(true)
                            }.frame(maxWidth: .infinity, minHeight: 85).padding(10)
                        }.buttonStyle(.visionOutline).accessibilityAddTraits(
                            model.draft.selectedBank == adapter.key ? .isSelected : [])
                    }
                }
            }
            Text(strings.t("onboarding.bank.notListed")).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
    }
}

struct NativeOnboardingImportView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(
                strings.t(
                    "onboarding.import.desc",
                    [
                        "bank": model.adapters.first { $0.key == model.draft.selectedBank }?.name
                            ?? strings.t("onboarding.import.yourBank")
                    ])
            ).foregroundStyle(theme.secondaryLabel)
            if let result = model.draft.importResult {
                Label(
                    strings.t("onboarding.import.success", ["n": String(result.imported)]),
                    systemImage: "checkmark.circle")
                if result.duplicates > 0 {
                    Text(strings.t("onboarding.import.duplicates", ["n": String(result.duplicates)]))
                        .font(.footnote).foregroundStyle(theme.secondaryLabel)
                }
            } else if let review = model.draft.reviewBatch {
                Label(
                    strings.t("onboarding.import.review.title", ["n": String(review.rows)]),
                    systemImage: "doc.text.magnifyingglass")
                Text(strings.t("onboarding.import.review.desc"))
                Button(strings.t("onboarding.import.review.cta")) {
                    Task { await model.finish(path: ImportRoutes.reviewPath(review.batchId)) }
                }.buttonStyle(.visionPrimary)
                Text(strings.t("onboarding.import.review.later")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            } else {
                CSVDropzone(
                    file: model.file, compact: true, strings: strings,
                    choose: { model.setFile($0) }, unreadable: { model.unreadableFile() },
                    remove: { model.setFile(nil) })
                if model.file != nil {
                    Button {
                        Task { await model.importFile() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.importing { ProgressView().controlSize(.small) }
                            Text(
                                strings.t(model.importing ? "onboarding.import.importing" : "onboarding.import.button"))
                        }
                    }.buttonStyle(.visionPrimary).disabled(!model.canImport)
                }
            }
            if model.draft.reviewBatch == nil {
                Text(strings.t("onboarding.import.skipHint")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
}

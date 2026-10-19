import SwiftUI
import VisionNativeCore

struct NativeOnboardingCategoriesView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
    var body: some View {
        if model.draft.categoriesCreated {
            VStack(alignment: .leading, spacing: 12) {
                Label(strings.t("onboarding.categories.created"), systemImage: "checkmark.circle")
                Text(strings.t("onboarding.categories.manage")).font(.caption).foregroundStyle(.secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(columns: [.init(.flexible()), .init(.flexible()), .init(.flexible())], alignment: .leading) {
                    ForEach(NativeOnboardingPreset.categories.indices, id: \.self) { index in
                        let category = NativeOnboardingPreset.categories[index]
                        Toggle(
                            isOn: Binding(
                                get: { model.draft.selectedCategoryIndexes.contains(index) },
                                set: { _ in model.toggleCategory(index) })
                        ) {
                            VStack(alignment: .leading) {
                                Text(category.emoji + " " + strings.t(category.detailKey))
                                Text(category.general).font(.caption).foregroundStyle(.secondary)
                            }
                        }.toggleStyle(.checkbox).padding(6)
                    }
                }
                HStack {
                    Button {
                        Task { await model.createCategories() }
                    } label: {
                        HStack {
                            if model.creatingCategories { ProgressView().controlSize(.small) }
                            Text(
                                strings.t(
                                    "onboarding.categories.create",
                                    ["n": String(model.draft.selectedCategoryIndexes.count)]))
                        }
                    }.disabled(model.creatingCategories || model.draft.selectedCategoryIndexes.isEmpty)
                    Button(
                        strings.t(
                            model.draft.selectedCategoryIndexes.count == NativeOnboardingPreset.categories.count
                                ? "onboarding.categories.deselectAll" : "onboarding.categories.selectAll"),
                        action: model.toggleAllCategories)
                }
            }
        }
    }
}

struct NativeOnboardingBankView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
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
            Text(strings.t("onboarding.bank.notListed")).font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct NativeOnboardingImportView: View {
    @Bindable var model: NativeOnboardingModel
    let strings: any Localizing
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(
                strings.t(
                    "onboarding.import.desc",
                    [
                        "bank": model.adapters.first { $0.key == model.draft.selectedBank }?.name
                            ?? strings.t("onboarding.import.yourBank")
                    ])
            ).foregroundStyle(.secondary)
            if let result = model.draft.importResult {
                Label(
                    strings.t("onboarding.import.success", ["n": String(result.imported)]),
                    systemImage: "checkmark.circle")
                if result.duplicates > 0 {
                    Text(strings.t("onboarding.import.duplicates", ["n": String(result.duplicates)]))
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if let review = model.draft.reviewBatch {
                Label(
                    strings.t("onboarding.import.review.title", ["n": String(review.rows)]),
                    systemImage: "doc.text.magnifyingglass")
                Text(strings.t("onboarding.import.review.desc"))
                Button(strings.t("onboarding.import.review.cta")) {
                    Task { await model.finish(path: ImportRoutes.reviewPath(review.batchId)) }
                }.buttonStyle(.visionPrimary)
                Text(strings.t("onboarding.import.review.later")).font(.caption).foregroundStyle(.secondary)
            } else {
                CSVDropzone(
                    file: model.file, compact: true, strings: strings,
                    choose: { model.setFile($0) }, unreadable: { model.unreadableFile() },
                    remove: { model.setFile(nil) })
                if model.file != nil {
                    Button {
                        Task { await model.importFile() }
                    } label: {
                        HStack {
                            if model.importing { ProgressView().controlSize(.small) }
                            Text(
                                strings.t(model.importing ? "onboarding.import.importing" : "onboarding.import.button"))
                        }
                    }.disabled(!model.canImport)
                }
            }
            if model.draft.reviewBatch == nil {
                Text(strings.t("onboarding.import.skipHint")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

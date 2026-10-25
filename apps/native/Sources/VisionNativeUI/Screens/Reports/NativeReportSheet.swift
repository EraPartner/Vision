import SwiftUI
import VisionNativeCore

/// Shared native equivalent of features/reports/ExportDialog.tsx.
public struct NativeReportSheet: View {
    @Bindable private var model: NativeReportModel
    private let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    public init(model: NativeReportModel, strings: any Localizing) {
        self.model = model
        self.strings = strings
    }
    /// `ExportDialog.tsx`: `DialogContent max-w-lg` with stacked `gap-5` sections, each led
    /// by a `type-headline` label, option rows on a list surface, and a right-aligned footer.
    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VisionDialogHeader(
                title: strings.t("export.title"), description: strings.t("export.description"),
                closeLabel: strings.t("common.close"), onClose: { if !model.isSubmitting { model.close() } }
            )
            .padding([.horizontal, .top], 24).padding(.bottom, 20)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionLabel(strings.t("export.reportType"))
                        Picker(
                            strings.t("export.reportType"),
                            selection: Binding(get: { model.type }, set: { value in model.setType(value) })
                        ) {
                            ForEach(NativeReportType.allCases) { type in Text(strings.t(type.labelKey)).tag(type) }
                        }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: .infinity)
                    }
                    periodSection
                    sectionsSection
                    HStack(spacing: 12) {
                        sectionLabel(strings.t("export.currency"))
                        Spacer(minLength: 0)
                        Picker(strings.t("export.currency"), selection: $model.currency) {
                            ForEach(NativeReportForm.currencies, id: \.self) { currency in
                                Text(currency).tag(currency)
                            }
                        }.labelsHidden().frame(width: 128)
                    }
                    if let exclusions = model.exclusions,
                        !exclusions.excludedCategoryIds.isEmpty || !exclusions.excludedRecipientIds.isEmpty
                    {
                        Text(
                            strings.t(
                                "export.exclusionsSummary",
                                [
                                    "categories": String(exclusions.excludedCategoryIds.count),
                                    "recipients": String(exclusions.excludedRecipientIds.count),
                                ])
                        ).font(.footnote).foregroundStyle(theme.secondaryLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(.horizontal, 24).padding(.bottom, 4).frame(maxWidth: .infinity, alignment: .leading)
            }
            VisionDialogFooter {
                Button(strings.t("common.cancel")) { model.close() }
                    .buttonStyle(.visionOutline).keyboardShortcut(.cancelAction).disabled(model.isSubmitting)
                Button {
                    Task { await model.submit() }
                } label: {
                    HStack(spacing: 6) {
                        if model.isSubmitting {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.down.doc").accessibilityHidden(true)
                        }
                        Text(model.isSubmitting ? strings.t("export.downloading") : strings.t("export.download"))
                    }
                }.buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction).disabled(!model.canSubmit)
            }.padding(24)
        }.frame(width: 512, height: 660)
            .onDisappear { model.didDisappear() }
    }
    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.headline).foregroundStyle(theme.foreground).accessibilityAddTraits(.isHeader)
    }
    /// The web `List` surface the radio and checkbox rows sit on.
    private func optionList<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground()
    }
    private var periodSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel(strings.t("export.period"))
            optionList {
                Picker(strings.t("export.period"), selection: $model.periodPreset) {
                    ForEach(NativeReportPeriodPreset.allCases) { preset in
                        Text(strings.t(preset.labelKey)).tag(preset)
                    }
                }.pickerStyle(.radioGroup).labelsHidden().padding(.horizontal, 16).padding(.vertical, 12)
            }
            if model.periodPreset == .year {
                HStack(spacing: 12) {
                    Text(strings.t("export.period.year.label")).font(.callout.weight(.medium))
                    TextField(strings.t("export.period.year.label"), text: $model.customYear)
                        .textFieldStyle(.vision).frame(width: 112)
                        .accessibilityLabel(strings.t("export.period.year.label"))
                        .onSubmit { Task { await model.submit() } }
                }.padding(.top, 4)
                if model.customYearInvalid {
                    Text(strings.t("export.period.year.invalid", ["max": String(model.maxYear)]))
                        .font(.footnote).foregroundStyle(theme.destructive)
                }
            }
            if model.periodPreset == .custom {
                HStack(alignment: .top, spacing: 12) {
                    NativeReportDateField(title: strings.t("export.period.from"), value: $model.customFrom)
                    NativeReportDateField(title: strings.t("export.period.to"), value: $model.customTo)
                }.padding(.top, 4)
                if model.customRangeInvalid {
                    Text(strings.t("export.period.invalidRange")).font(.footnote).foregroundStyle(theme.destructive)
                }
            }
        }
    }
    private var sectionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                sectionLabel(strings.t("export.sections"))
                Spacer(minLength: 0)
                NativeReportAllSectionsCheckbox(
                    title: strings.t("export.sections.all"), all: model.allSectionsSelected,
                    some: model.someSectionsSelected,
                    change: { model.setAllSections(!model.allSectionsSelected) }
                ).fixedSize()
            }
            optionList {
                ForEach(Array(model.sections.enumerated()), id: \.element.id) { index, section in
                    if index > 0 { Divider() }
                    Toggle(
                        strings.t(section.labelKey),
                        isOn: Binding(
                            get: { model.selectedSections.contains(section.id) },
                            set: { model.setSection(section.id, selected: $0) })
                    )
                    .toggleStyle(.checkbox).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
            }
        }
    }
}

private struct NativeReportDateField: View {
    let title: String
    @Binding var value: String
    private var selection: Binding<Date> {
        Binding(
            get: {
                let pieces = value.split(separator: "-").compactMap { Int($0) }
                guard pieces.count == 3 else { return Date() }
                return Calendar.current.date(from: DateComponents(year: pieces[0], month: pieces[1], day: pieces[2]))
                    ?? Date()
            }, set: { value = NativeReportForm.day($0, calendar: .current) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout.weight(.medium))
            DatePicker(title, selection: selection, displayedComponents: .date).datePickerStyle(.compact)
                .labelsHidden()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

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
    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t("export.title")).font(.visionCardTitle).accessibilityAddTraits(.isHeader)
                Text(strings.t("export.description")).font(.body).foregroundStyle(theme.secondaryLabel)
            }.padding(24)
            Form {
                Section(strings.t("export.reportType")) {
                    Picker(
                        strings.t("export.reportType"),
                        selection: Binding(get: { model.type }, set: { value in model.setType(value) })
                    ) {
                        ForEach(NativeReportType.allCases) { type in Text(strings.t(type.labelKey)).tag(type) }
                    }.pickerStyle(.segmented).labelsHidden()
                }
                periodSection
                sectionsSection
                Section(strings.t("export.currency")) {
                    Picker(strings.t("export.currency"), selection: $model.currency) {
                        ForEach(NativeReportForm.currencies, id: \.self) { currency in Text(currency).tag(currency) }
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
                        ).font(.caption).foregroundStyle(theme.secondaryLabel)
                    }
                }
            }.formStyle(.grouped)
            Divider()
            HStack {
                Button(strings.t("common.cancel")) { model.close() }.keyboardShortcut(.cancelAction).disabled(
                    model.isSubmitting)
                Spacer()
                if model.isSubmitting { ProgressView().controlSize(.small) }
                Button(model.isSubmitting ? strings.t("export.downloading") : strings.t("export.download")) {
                    Task { await model.submit() }
                }.buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction).disabled(!model.canSubmit)
            }.padding(20)
        }.frame(width: 560, height: 660)
            .onDisappear { model.didDisappear() }
    }
    private var periodSection: some View {
        Section(strings.t("export.period")) {
            Picker(strings.t("export.period"), selection: $model.periodPreset) {
                ForEach(NativeReportPeriodPreset.allCases) { preset in Text(strings.t(preset.labelKey)).tag(preset) }
            }.pickerStyle(.radioGroup)
            if model.periodPreset == .year {
                TextField(strings.t("export.period.year.label"), text: $model.customYear)
                    .textFieldStyle(.vision).onSubmit { Task { await model.submit() } }
                if model.customYearInvalid {
                    Text(strings.t("export.period.year.invalid", ["max": String(model.maxYear)]))
                        .font(.caption).foregroundStyle(theme.destructive)
                }
            }
            if model.periodPreset == .custom {
                NativeReportDateField(title: strings.t("export.period.from"), value: $model.customFrom)
                NativeReportDateField(title: strings.t("export.period.to"), value: $model.customTo)
                if model.customRangeInvalid {
                    Text(strings.t("export.period.invalidRange")).font(.caption).foregroundStyle(theme.destructive)
                }
            }
        }
    }
    private var sectionsSection: some View {
        Section {
            NativeReportAllSectionsCheckbox(
                title: strings.t("export.sections.all"), all: model.allSectionsSelected,
                some: model.someSectionsSelected,
                change: { model.setAllSections(!model.allSectionsSelected) })
            ForEach(model.sections) { section in
                Toggle(
                    strings.t(section.labelKey),
                    isOn: Binding(
                        get: { model.selectedSections.contains(section.id) },
                        set: { model.setSection(section.id, selected: $0) })
                )
                .toggleStyle(.checkbox)
            }
        } header: {
            Text(strings.t("export.sections"))
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
        DatePicker(title, selection: selection, displayedComponents: .date).datePickerStyle(.compact)
    }
}

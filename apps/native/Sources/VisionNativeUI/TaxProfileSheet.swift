import SwiftUI
import VisionNativeCore

/// The web profile's six-step, write-through editor. Closing flushes pending edits.
struct TaxProfileSheet: View {
    @Bindable var model: TaxProfileModel
    let shell: NativeShellModel
    var onUnfile: (@MainActor () async -> Bool)? = nil
    @Environment(\.visionTheme) var theme
    var strings: any Localizing { shell.strings }
    var settings: NativeAppSettings { shell.settings }
    var draft: TaxProfileDraft { model.draft }
    var partnerPath: [String] { draft.partnerPath(model.partner) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(strings.t("tax.profile.title")).font(.title2.weight(.semibold))
                Spacer()
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless).accessibilityLabel(strings.t("common.close"))
                .keyboardShortcut(.cancelAction)
            }.padding(.horizontal, 24).padding(.top, 20)
            Text(strings.t("tax.profile.description"))
                .foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24).padding(.top, 8)
            HStack(spacing: 3) {
                ForEach(TaxProfileStep.allCases, id: \.self) { step in
                    Button {
                        model.go(to: step)
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: step.index < model.step.index ? "checkmark" : icon(step))
                            Text(strings.t(step.titleKey)).font(.caption).lineLimit(1)
                        }.frame(maxWidth: .infinity).padding(.vertical, 7)
                    }.buttonStyle(.plain)
                        .background(
                            model.step == step ? theme.primary.opacity(0.15) : .clear,
                            in: RoundedRectangle(cornerRadius: 6)
                        )
                        .accessibilityAddTraits(model.step == step ? .isSelected : [])
                }
            }.padding(.horizontal, 24).padding(.top, 16)
            Text(strings.t("tax.profile.stepProgress", ["current": String(model.step.index + 1), "total": "6"]))
                .font(.footnote).foregroundStyle(theme.secondaryLabel).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24).padding(.vertical, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    notices
                    if let key = model.validationErrorKey { Text(strings.t(key)).foregroundStyle(theme.destructive) }
                    if let error = model.error {
                        Text(verbatim: error).foregroundStyle(theme.destructive)
                        Button(strings.t("common.retry")) { Task { await model.flush() } }
                    }
                    Group {
                        switch model.step {
                        case .household: householdStep
                        case .income: incomeStep
                        case .home: homeStep
                        case .incomeSources: sourcesStep
                        case .exemptions: exemptionsStep
                        case .region: regionStep
                        }
                    }.disabled(model.isLocked)
                }.padding(24)
            }
            Divider()
            HStack {
                Button(strings.t("common.back")) { model.back() }.disabled(model.step == .household)
                Spacer()
                if model.isSaving { ProgressView().controlSize(.small) }
                Button(strings.t(model.step == .region ? "tax.profile.save" : "common.next")) {
                    Task { _ = await model.next() }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(model.isSaving)
            }.padding(.horizontal, 24).padding(.vertical, 14)
        }.frame(minWidth: 560, idealWidth: 620, minHeight: 620, idealHeight: 780)
            .foregroundStyle(theme.foreground).interactiveDismissDisabled(true)
            .task { await model.loadCategories() }
    }

    @ViewBuilder var notices: some View {
        if model.editingHistorical && !model.isFiled {
            note("tax.historical.editWarning.title", "tax.historical.editWarning.desc", year: model.year)
        }
        if model.isFiled {
            note("tax.historical.filedLock.title", "tax.historical.filedLock.desc", year: model.year)
            HStack {
                if model.isLocked {
                    Button(strings.t("tax.historical.filedLock.amendCta")) { model.amendFiledYear() }
                } else {
                    Text(strings.t("tax.historical.filedLock.amendActive")).font(.footnote)
                }
                if let onUnfile {
                    Button(strings.t("tax.historical.filedLock.unfileCta", ["year": String(model.year)])) {
                        Task { if await model.flush(), await onUnfile() { model.didUnfile() } }
                    }.disabled(model.isSaving)
                }
            }
        }
    }
    func close() { Task { _ = await model.close() } }
    func icon(_ step: TaxProfileStep) -> String {
        switch step {
        case .household: "person.2"
        case .income: "briefcase"
        case .home: "building.2"
        case .incomeSources: "list.bullet.rectangle"
        case .exemptions: "receipt"
        case .region: "mappin"
        }
    }
    func label(_ id: String) -> String {
        draft.partners.first { $0["id"]?.stringValue == id }?["displayName"]?.stringValue
            .flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
            ?? strings.t("tax.household.partner.\(id)")
    }
    @ViewBuilder var partnerPicker: some View {
        if draft.partners.count > 1 {
            Picker(strings.t("tax.household.partnerPicker"), selection: $model.selectedPartner) {
                ForEach(draft.partners.compactMap { $0["id"]?.stringValue }, id: \.self) { id in Text(label(id)).tag(id)
                }
            }.pickerStyle(.segmented)
        }
    }
    func number(
        _ key: String, path: [String], integer: Bool = false, optional: Bool = false,
        bounds: ClosedRange<Decimal>? = nil, clampMinimum: Decimal? = nil
    ) -> some View {
        field(key) {
            TaxProfileNumberField(
                value: draft.get(path)?.decimalValue, format: settings.numberFormat,
                integer: integer, optional: optional, label: strings.t(key)
            ) { value in
                var value = value
                if let bounds, let numeric = value, !bounds.contains(numeric) { value = nil }
                if let minimum = clampMinimum, let numeric = value { value = max(minimum, numeric) }
                model.edit {
                    $0.set(path, value.map(TaxValue.number))
                    if path.first == "home" { $0.set(["home", "mortgageRegion"], nil) }
                }
            }
        }
    }
    func toggle(_ key: String, path: [String], fallback: Bool = false, variables: [String: String] = [:]) -> some View {
        Toggle(
            strings.t(key, variables),
            isOn: Binding(
                get: { draft.get(path)?.boolValue ?? fallback },
                set: { value in
                    model.edit {
                        $0.set(path, .bool(value))
                        if path.first == "home" { $0.set(["home", "mortgageRegion"], nil) }
                    }
                })
        ).toggleStyle(.switch)
    }
    func choice(
        _ key: String, path: [String], values: [String], prefix: String, suffix: String = "", fallback: String = "",
        labels: [String: String] = [:]
    ) -> some View {
        field(key) {
            Picker(
                strings.t(key),
                selection: Binding(
                    get: { draft.get(path)?.stringValue ?? fallback },
                    set: { value in
                        model.edit {
                            $0.set(path, value.isEmpty ? nil : .string(value))
                            if path.first == "home" { $0.set(["home", "mortgageRegion"], nil) }
                        }
                    })
            ) {
                if fallback.isEmpty { Text(strings.t(labels[""] ?? "common.none")).tag("") }
                ForEach(values, id: \.self) { value in
                    Text(strings.t(labels[value] ?? (prefix + value + suffix))).tag(value)
                }
            }.labelsHidden()
        }
    }
    func date(_ key: String, path: [String], optional: Bool = true) -> some View {
        field(key) {
            VisionDateField(
                day: day(draft.get(path)?.stringValue), placeholder: strings.t("tax.household.activity.wholeYear"),
                allowClear: optional, clearLabel: strings.t("common.clear"), settings: settings, strings: strings,
                calendar: Calendar(identifier: .gregorian)
            ) { day in
                model.edit { $0.set(path, day.map { .string($0.text(format: .isoDate)) }) }
            }
        }
    }
    func field<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(key)).font(.callout.weight(.medium))
            content()
            if strings.t(key + ".desc") != key + ".desc" {
                Text(strings.t(key + ".desc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
            }
        }
    }
    func intro(_ section: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t("tax.profile.section.\(section).title")).font(.headline)
            Text(strings.t("tax.profile.section.\(section).desc")).font(.footnote).foregroundStyle(theme.secondaryLabel)
        }
    }
    func note(_ title: String, _ body: String, year: Int) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(title)).font(.callout.weight(.medium))
            Text(strings.t(body, ["year": String(year)])).font(.footnote)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
    func day(_ text: String?) -> PlannedDay? {
        guard let text else { return nil }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return PlannedDay(year: parts[0], month: parts[1], day: parts[2])
    }
}

struct TaxProfileRow: Identifiable {
    let index: Int
    let value: TaxValue
    var id: String { value["id"]?.stringValue ?? String(index) }
    static func rows(_ values: [TaxValue]) -> [Self] {
        values.enumerated().map { Self(index: $0.offset, value: $0.element) }
    }
}

struct TaxProfileNumberField: View {
    let value: Decimal?
    let format: NumberFormat
    let integer: Bool
    let optional: Bool
    let label: String
    let onChange: (Decimal?) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool
    var body: some View {
        TextField(
            label,
            text: Binding(
                get: { text },
                set: { incoming in
                    if integer, incoming.range(of: "^-?[0-9]*$", options: .regularExpression) == nil { return }
                    text = incoming
                    if incoming.isEmpty {
                        onChange(optional ? nil : 0)
                    } else if let parsed = LocaleNumber.parse(incoming, format: format) {
                        onChange(parsed)
                    }
                })
        ).textFieldStyle(.roundedBorder).focused($focused)
            .onAppear { text = LocaleNumber.editable(value, format: format) }
            .onChange(of: value) { if !focused { text = LocaleNumber.editable(value, format: format) } }
            .onChange(of: format) { if !focused { text = LocaleNumber.editable(value, format: format) } }
            .onChange(of: focused) { if !focused { text = LocaleNumber.editable(value, format: format) } }
            .accessibilityLabel(label)
    }
}

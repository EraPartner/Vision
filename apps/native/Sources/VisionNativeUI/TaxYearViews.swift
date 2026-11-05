import SwiftUI
import VisionNativeCore

enum TaxYearPresentation {
    static func metadata(_ overview: OpenAPI.BelgianTaxOverview) -> TaxValue {
        (try? TaxValue(encoding: overview.metadata)) ?? .object([:])
    }
    static func status(_ overview: OpenAPI.BelgianTaxOverview) -> String {
        // TaxFilingMasthead: the current profile year also shows its filed status.
        if metadata(overview)["filing"]?.objectValue != nil { return "filed" }
        guard overview.isHistorical else { return "live" }
        if overview.calculationSource == .frozen { return "frozen" }
        return overview.hasSnapshot ? "snapshot" : "estimate"
    }
    static func partner(_ id: String, overview: OpenAPI.BelgianTaxOverview, strings: any Localizing) -> String {
        if let name = overview.household.partners.first(where: { $0.id.rawValue == id })?.displayName,
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return name
        }
        return strings.t("tax.household.partner." + id)
    }
}

struct TaxYearSwitcherView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let availableYears: [Int]
    let actions: TaxActionsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var years: [Int] {
        Array(
            Set(
                availableYears + [overview.year, overview.liveYear]
                    + overview.householdSnapshots.keys.compactMap(Int.init))
        ).sorted(by: >)
    }
    var body: some View {
        Menu {
            Text(strings.t("tax.yearSwitcher.menuLabel"))
            ForEach(years, id: \.self) { year in
                Button {
                    shell.replaceQuery("year", with: String(year))
                } label: {
                    Label(String(year) + " · " + strings.t(badge(year)), systemImage: symbol(year))
                }
            }
            if overview.isHistorical && !overview.hasSnapshot {
                Divider()
                Button(
                    strings.t("tax.yearSwitcher.createSnapshot", ["year": String(overview.year)]), systemImage: "plus"
                ) {
                    Task { await actions.perform(.createSnapshot) }
                }
            }
        } label: {
            // `Button variant="outline" className="tabular-nums"` with a trailing `ChevronDown`.
            HStack(spacing: 8) {
                Text(strings.t("tax.yearSwitcher.label", ["year": String(overview.year)])).monospacedDigit()
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabel)
                    .accessibilityHidden(true)
            }
        }
        .menuStyle(.button)
        .buttonStyle(.vision(.outline))
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(strings.t("tax.yearSwitcher.trigger"))
        .disabled(actions.isSaving)
    }
    private func meta(_ year: Int) -> TaxValue {
        overview.snapshotMetas[String(year)].flatMap { try? TaxValue(encoding: $0) } ?? .object([:])
    }
    private func badge(_ year: Int) -> String {
        if year == overview.liveYear { return "tax.yearSwitcher.currentBadge" }
        if meta(year)["filing"]?.objectValue != nil { return "tax.yearSwitcher.filedBadge" }
        if meta(year)["frozenCalculation"]?.objectValue != nil { return "tax.yearSwitcher.frozenBadge" }
        if overview.householdSnapshots[String(year)] != nil { return "tax.yearSwitcher.snapshotBadge" }
        return "tax.yearSwitcher.transactionsBadge"
    }
    private func symbol(_ year: Int) -> String {
        if meta(year)["filing"]?.objectValue != nil { return "lock" }
        if meta(year)["frozenCalculation"]?.objectValue != nil { return "snowflake" }
        return year == overview.year ? "checkmark" : "calendar"
    }
}

struct TaxMastheadView: View {
    let overview: OpenAPI.BelgianTaxOverview
    let actions: TaxActionsModel
    let shell: NativeShellModel
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var status: String { TaxYearPresentation.status(overview) }
    var body: some View {
        TaxCard {
            Text(strings.t("tax.masthead.eyebrow")).font(.caption2.weight(.medium)).tracking(1.3).textCase(.uppercase)
                .foregroundStyle(Color(token: theme.palette.mutedForeground).opacity(0.8))
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .bottom) {
                    identity
                    Spacer()
                    rates
                }
                VStack(alignment: .leading, spacing: 16) {
                    identity
                    rates
                }
            }
            if overview.isHistorical {
                Divider()
                Text(strings.t("tax.historical.banner." + status + "Title", ["year": String(overview.year)]))
                    .font(.headline)
                Text(strings.t("tax.historical.banner." + status + "Desc", ["year": String(overview.year)]))
                    .foregroundStyle(theme.secondaryLabel)
                if let reference = TaxYearPresentation.metadata(overview)["filing"]?["reference"]?.stringValue {
                    Text(strings.t("tax.historical.banner.filedReferencePrefix") + " " + reference).font(.caption)
                }
                HStack {
                    if !overview.hasSnapshot && overview.calculationSource != .frozen {
                        Button(strings.t("tax.yearSwitcher.createSnapshot", ["year": String(overview.year)])) {
                            Task { await actions.perform(.createSnapshot) }
                        }.disabled(actions.isSaving)
                    }
                    Button(strings.t("tax.historical.banner.returnCta", ["year": String(overview.liveYear)])) {
                        shell.replaceQuery("year", with: String(overview.liveYear))
                    }
                }.buttonStyle(.visionOutline)
            }
        }
    }
    /// `STATUS_ICON`: Sparkles, History, History, Snowflake, Lock.
    static func statusSymbol(_ status: String) -> String {
        statusSymbols[status] ?? "clock.arrow.circlepath"
    }
    /// Sparkles, snowflake and lock mark live, frozen and filed years.
    private static let statusSymbols = ["live": "sparkles", "frozen": "snowflake", "filed": "lock"]
    private var identity: some View {
        HStack(spacing: 12) {
            Text(String(overview.year)).font(.visionLargeTitle).monospacedDigit()
                .accessibilityAddTraits(.isHeader)
            VisionBadge(
                text: strings.t("tax.masthead.status." + status),
                tone: status == "filed" ? .warning : status == "live" ? .primary : .secondary,
                symbol: Self.statusSymbol(status))
        }
    }
    /// The web masthead meta: Region and Marginal rate as small labelled figures, then a
    /// hairline and the Effective burden in large primary type.
    private var rates: some View {
        HStack(alignment: .bottom, spacing: 24) {
            meta(
                strings.t("tax.masthead.meta.region"),
                value: strings.t("tax.profile.region." + overview.household.region.rawValue + ".label"))
            meta(
                strings.t("tax.masthead.meta.marginalRate"),
                value: overview.calculation.marginalRate.map {
                    VisionFormat.percent($0, digits: 0, locale: shell.settings.numberFormat.locale)
                } ?? "—")
            Rectangle().fill(theme.border).frame(width: 1, height: 40).accessibilityHidden(true)
            VStack(alignment: .trailing, spacing: 2) {
                Text(strings.t("tax.masthead.meta.effectiveBurden")).font(.caption).foregroundStyle(theme.tertiaryLabel)
                Text(
                    overview.calculation.effectiveRate.map {
                        VisionFormat.percent($0, digits: 1, locale: shell.settings.numberFormat.locale)
                    } ?? "—"
                ).font(.visionLargeTitle).monospacedDigit().foregroundStyle(theme.primary)
            }
            .accessibilityElement(children: .combine)
        }
    }
    private func meta(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(theme.tertiaryLabel)
            Text(value).font(.visionDisplayHeadline).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }
}

struct TaxMarkFiledSheet: View {
    let overview: OpenAPI.BelgianTaxOverview
    let actions: TaxActionsModel
    let shell: NativeShellModel
    @State private var reference = ""
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.visionDismissDialog) private var dialogDismiss
    @Environment(\.visionTheme) private var theme
    @FocusState private var referenceFocused: Bool
    /// Inside a `visionDialog` only the dialog dismissal acts; under a system sheet only the other.
    private func close() {
        dialogDismiss()
        systemDismiss()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: shell.strings.t("tax.markFiled.title", ["year": String(overview.year)]),
                description: shell.strings.t("tax.markFiled.description"),
                closeLabel: shell.strings.t("common.close"), onClose: { close() })
            if !TaxYearMutation.canFile(overview) {
                Text(shell.strings.t("tax.markFiled.prerequisite")).font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(shell.strings.t("tax.markFiled.referenceLabel")).font(.subheadline.weight(.medium))
                    .foregroundStyle(theme.foreground)
                TextField(
                    shell.strings.t("tax.markFiled.referenceLabel"), text: $reference,
                    prompt: Text(shell.strings.t("tax.markFiled.referencePlaceholder"))
                )
                .labelsHidden().textFieldStyle(.vision)
                .focused($referenceFocused).onSubmit { confirm() }
                Text(shell.strings.t("tax.markFiled.referenceHelp")).font(.footnote).foregroundStyle(
                    theme.secondaryLabel)
            }
            if let error = actions.error { Text(error).foregroundStyle(theme.destructive) }
            VisionDialogFooter {
                Button(shell.strings.t("common.cancel")) { close() }
                    .buttonStyle(.visionOutline).keyboardShortcut(.cancelAction)
                Button(shell.strings.t("tax.markFiled.confirm")) { confirm() }
                    .buttonStyle(.visionPrimary).keyboardShortcut(.defaultAction)
                    .disabled(!TaxYearMutation.canFile(overview))
            }
        }.visionDialogPadding().frame(width: 448).disabled(actions.isSaving)
            .task { referenceFocused = true }
    }
    private func confirm() {
        guard TaxYearMutation.canFile(overview) else { return }
        let value = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { if await actions.perform(.file(reference: value.isEmpty ? nil : value)) { close() } }
    }
}

struct TaxHistorySheet: View {
    let overview: OpenAPI.BelgianTaxOverview
    let shell: NativeShellModel
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.visionDismissDialog) private var dialogDismiss
    @Environment(\.visionTheme) private var theme
    /// Inside a `visionDialog` only the dialog dismissal acts; under a system sheet only the other.
    private func close() {
        dialogDismiss()
        systemDismiss()
    }
    private var entries: [TaxValue] { (TaxYearPresentation.metadata(overview)["history"]?.arrayValue ?? []).reversed() }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VisionDialogHeader(
                title: shell.strings.t("tax.history.title", ["year": String(overview.year)]),
                description: shell.strings.t("tax.history.description"),
                closeLabel: shell.strings.t("common.close"), onClose: { close() }
            )
            .keyboardShortcut(.cancelAction)
            if entries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath").font(.title2).foregroundStyle(theme.tertiaryLabel)
                    Text(shell.strings.t("tax.history.empty")).font(.headline).foregroundStyle(theme.foreground)
                }.frame(maxWidth: .infinity).padding(.vertical, 32)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(entries.indices, id: \.self) { index in
                            let entry = entries[index]
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 8) {
                                    VisionBadge(
                                        text: historyKind(entry["kind"]?.stringValue ?? "patched"), small: true)
                                    Text(timestamp(entry["at"]?.stringValue ?? "")).font(.footnote).monospacedDigit()
                                        .foregroundStyle(theme.secondaryLabel)
                                    if let reference = entry["reference"]?.stringValue {
                                        Text("(" + reference + ")").font(.footnote.weight(.medium))
                                            .foregroundStyle(theme.warning)
                                    }
                                }
                                ForEach(summary(entry), id: \.self) { line in
                                    Text(line).font(.footnote).foregroundStyle(theme.secondaryLabel)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            if index < entries.count - 1 { Divider().padding(.leading, 16) }
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                            .fill(theme.card))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous)
                            .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
                }.frame(maxHeight: 460)
            }
        }.visionDialogPadding().frame(width: 672)
    }
    /// `tax.history.kind.*`, or the raw kind for one this build has no label for.
    private func historyKind(_ kind: String) -> String {
        let key = "tax.history.kind." + kind
        let text = shell.strings.t(key)
        return text == key ? kind : text
    }
    private func timestamp(_ value: String) -> String {
        guard let date = VisionFormat.parseTimestamp(value) else { return value }
        return date.formatted(
            Date.FormatStyle(
                date: .abbreviated, time: .shortened, locale: LanguageLocale.locale(shell.strings.language)))
    }
    private func summary(_ entry: TaxValue) -> [String] {
        guard let changes = entry["householdChanges"]?.objectValue else {
            guard let fields = entry["changes"]?.objectValue, !fields.isEmpty else { return [] }
            return [fields.keys.sorted().map { $0 + ": " + describe(fields[$0] ?? .null) }.joined(separator: ", ")]
        }
        let sections = [
            "partners", "relationship", "dependents", "home", "region", "communalSurchargePercent",
            "taxIncomeCategoryIds", "profileConfigured",
        ]
        var lines = sections.compactMap { key -> String? in
            guard let value = changes[key] else { return nil }
            return shell.strings.t("tax.history.household.section." + key) + ": " + householdSection(key, value)
        }
        let rest = changes.keys.filter { !sections.contains($0) }.sorted()
        if !rest.isEmpty {
            lines.append(rest.map { $0 + ": " + describe(changes[$0] ?? .null) }.joined(separator: ", "))
        }
        return lines
    }
    private func householdSection(_ key: String, _ value: TaxValue) -> String {
        let strings = shell.strings
        switch key {
        case "partners":
            return (value.arrayValue ?? []).map { partner in
                let activities = partner["activities"]?.arrayValue ?? []
                let gross = activities.reduce(Decimal.zero) { total, activity in
                    total
                        + (activity[
                            activity["kind"]?.stringValue == "net_professional_amount"
                                ? "netProfessionalIncome" : "grossIncome"]?.decimalValue ?? 0)
                }
                let id = partner["id"]?.stringValue ?? "A"
                let name = partner["displayName"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                return strings.t(
                    "tax.history.household.partnerSummary",
                    [
                        "partner": name.flatMap { $0.isEmpty ? nil : $0 } ?? strings.t("tax.household.partner." + id),
                        "count": String(activities.count), "gross": money(gross),
                    ])
            }.joined(separator: "; ")
        case "relationship":
            return strings.t(
                "tax.history.household.eventsSummary", ["count": String(value["events"]?.arrayValue?.count ?? 0)])
        case "dependents":
            return strings.t(
                "tax.history.household.dependentsSummary",
                [
                    "children": VisionFormat.plain(value["children"]?.decimalValue ?? 0),
                    "others": VisionFormat.plain(value["otherPersons"]?.decimalValue ?? 0),
                ])
        case "home":
            return strings.t(
                "tax.history.household.homeSummary",
                [
                    "cadastral": money(value["cadastralIncome"]?.decimalValue ?? 0),
                    "interest": money(value["mortgageInterestPaid"]?.decimalValue ?? 0),
                ])
        case "region": return strings.t("tax.profile.region." + (value.stringValue ?? "") + ".label")
        case "communalSurchargePercent":
            return VisionFormat.percent(value.decimalValue ?? 0, locale: shell.settings.numberFormat.locale)
        case "taxIncomeCategoryIds":
            return strings.t("tax.history.household.categoriesSummary", ["count": String(value.arrayValue?.count ?? 0)])
        case "profileConfigured": return strings.t(value.boolValue == true ? "common.yes" : "common.no")
        default: return describe(value)
        }
    }
    private func money(_ value: Decimal) -> String {
        MoneyText.text(value, currency: shell.settings.portfolioCurrency, settings: shell.settings, signed: false)
    }
    private func describe(_ value: TaxValue) -> String {
        switch value {
        case .null: return "—"
        case .string(let text): return text
        case .bool(let flag): return shell.strings.t(flag ? "common.yes" : "common.no")
        case .number(let number):
            return VisionFormat.decimal(number, fractionDigits: 2, locale: shell.settings.numberFormat.locale)
        case .array(let list): return list.map(describe).joined(separator: "; ")
        case .object(let fields):
            return fields.keys.sorted().map { $0 + ": " + describe(fields[$0] ?? .null) }.joined(separator: ", ")
        }
    }
}

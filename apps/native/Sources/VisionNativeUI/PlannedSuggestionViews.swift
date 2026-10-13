import SwiftUI
import VisionNativeCore

/// `MatchSuggestionsBanner` (apps/frontend/src/features/planned/MatchSuggestionsBanner.tsx):
/// planned payments with a likely matching transaction that was not auto-cleared. Hidden
/// without suggestions; Review opens Mark as paid for the first one.
struct PlannedMatchSuggestionsBanner: View {
    let model: PlannedPaymentsModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        if !model.suggestions.isEmpty {
            AdminCard(padding: 14) {
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Image(systemName: "sparkles")
                                .foregroundStyle(theme.primary)
                                .accessibilityHidden(true)
                            Text(strings.tc("plannedPage.suggestions.title", model.suggestions.count))
                                .fontWeight(.medium)
                        }
                        Text(strings.t("plannedPage.suggestions.subtitle"))
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(strings.t("plannedPage.suggestions.review")) {
                        model.reviewSuggestion()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }
}

/// `RecurringDetectionPanel` (apps/frontend/src/features/planned/RecurringDetectionPanel.tsx):
/// the amount-change card and the detected-pattern card, both collapsed until Review; Track
/// creates a planned payment from a pattern and Dismiss hides a payee's patterns for good.
struct PlannedRecurringPanel: View {
    let model: PlannedPaymentsModel
    let strings: any Localizing
    let settings: NativeAppSettings
    @Environment(\.visionTheme) var theme

    private var recurring: PlannedRecurringModel { model.recurring }

    var body: some View {
        switch recurring.display {
        case .hidden:
            EmptyView()
        case .loading:
            AdminCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label {
                        Text(strings.t("recurring.loading"))
                            .font(.callout.weight(.semibold))
                    } icon: {
                        Image(systemName: "sparkles")
                            .foregroundStyle(theme.primary)
                    }
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                }
            }
        case .caughtUp:
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle")
                    .accessibilityHidden(true)
                Text(strings.t("recurring.allCaughtUp"))
                Text(strings.t("recurring.noPatterns"))
                    .font(.footnote)
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.secondaryLabel)
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        case .cards:
            VStack(alignment: .leading, spacing: 16) {
                let alerts = recurring.amountAlerts
                if !alerts.isEmpty { alertsCard(alerts) }
                let patterns = recurring.visiblePatterns
                if !patterns.isEmpty { patternsCard(patterns) }
            }
        }
    }

    // MARK: Amount changes

    private func alertsCard(_ alerts: [PlannedRecurringPattern]) -> some View {
        AdminCard(padding: 16, ring: theme.warning.opacity(0.4)) {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader(
                    titleKey: "recurring.amountChanges", symbol: "exclamationmark.triangle", tint: theme.warning,
                    titleColor: theme.warning, count: alerts.count, countTone: .warning, expanded: recurring.alertsExpanded
                ) {
                    recurring.alertsExpanded.toggle()
                }
                if recurring.alertsExpanded {
                    Text(strings.t("recurring.amountChangesDesc"))
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                    rows(Array(alerts.prefix(PlannedRecurringModel.maxAlertRows))) { pattern in
                        alertRow(pattern)
                    }
                }
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.warning.opacity(0.05))
                .allowsHitTesting(false))
    }

    @ViewBuilder
    private func alertRow(_ pattern: PlannedRecurringPattern) -> some View {
        if let change = pattern.lastChange {
            let increased = change.direction == "increased"
            let tint = increased ? theme.loss : theme.gain
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(pattern.recipientName)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    HStack(spacing: 8) {
                        Text(money(change.previousAmount, pattern.currency))
                            .strikethrough()
                            .foregroundStyle(theme.secondaryLabel)
                        Text(verbatim: "→")
                            .foregroundStyle(theme.tertiaryLabel)
                            .accessibilityHidden(true)
                        Text(money(change.newAmount, pattern.currency))
                            .fontWeight(.medium)
                            .foregroundStyle(tint)
                        Label(
                            PlannedRecurringPanel.signedPercent(change.percentChange, settings: settings),
                            systemImage: increased ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis"
                        )
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 1))
                    }
                    .font(.footnote)
                    Text(strings.t("recurring.changedOn", ["date": dateLabel(change.date)]))
                        .font(.footnote)
                        .foregroundStyle(theme.secondaryLabel)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    recurring.dismiss(pattern.recipientId)
                } label: {
                    Image(systemName: "xmark")
                        .imageScale(.small)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.secondaryLabel)
                .accessibilityLabel(strings.t("aria.dismiss"))
                .help(strings.t("aria.dismiss"))
            }
        }
    }

    // MARK: Patterns

    private func patternsCard(_ patterns: [PlannedRecurringPattern]) -> some View {
        AdminCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader(
                    titleKey: "recurring.patterns", symbol: "sparkles", tint: theme.primary, titleColor: theme.foreground,
                    count: patterns.count, countTone: .secondary, expanded: recurring.patternsExpanded
                ) {
                    recurring.patternsExpanded.toggle()
                }
                if recurring.patternsExpanded {
                    Text(strings.t("recurring.patternsDesc"))
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                    rows(patterns) { pattern in
                        patternRow(pattern)
                    }
                }
            }
        }
    }

    private func patternRow(_ pattern: PlannedRecurringPattern) -> some View {
        HStack(spacing: 12) {
            AdminIconBadge(symbol: "repeat")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(pattern.recipientName)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    VisionBadge(
                        text: "\(VisionFormat.plain(pattern.confidence))% \(strings.t(pattern.confidenceLevel.labelKey))",
                        tone: confidenceTone(pattern.confidenceLevel), small: true)
                }
                HStack(spacing: 8) {
                    VisionBadge(text: pattern.patternLabel(strings), tone: .outline, small: true)
                    if let category = categoryName(pattern) {
                        Text(category)
                    }
                    Text(verbatim: "· \(pattern.occurrences) \(strings.t("recurring.seen"))")
                }
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
                Label(
                    strings.t("recurring.nextExpected", ["date": dateLabel(pattern.predictedNext)]),
                    systemImage: "calendar"
                )
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 6) {
                Text(money(pattern.latestAmount, pattern.currency))
                    .font(.headline)
                    .monospacedDigit()
                HStack(spacing: 4) {
                    Button {
                        Task { await model.track(pattern, strings: strings) }
                    } label: {
                        Label(strings.t("recurring.track"), systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    Button(strings.t("recurring.dismissBtn")) {
                        recurring.dismiss(pattern.recipientId)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .foregroundStyle(theme.secondaryLabel)
                }
            }
        }
    }

    // MARK: Pieces

    /// The card title with its count badge and the Review / Hide toggle, labelled
    /// "{Review or Hide}: {title}".
    private func cardHeader(
        titleKey: String, symbol: String, tint: Color, titleColor: Color, count: Int, countTone: BadgeTone, expanded: Bool,
        toggle: @escaping () -> Void
    ) -> some View {
        let action = strings.t(expanded ? "recurring.hide" : "recurring.review")
        let title = strings.t(titleKey)
        return HStack(alignment: .center, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(titleColor)
                    .accessibilityAddTraits(.isHeader)
                VisionBadge(text: String(count), tone: countTone)
            }
            Spacer(minLength: 0)
            Button(action: toggle) {
                HStack(spacing: 4) {
                    Text(action)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .imageScale(.small)
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("\(action): \(title)")
        }
    }

    /// The separated rows of a card (`List`).
    private func rows<Row: View>(
        _ patterns: [PlannedRecurringPattern], @ViewBuilder row: @escaping (PlannedRecurringPattern) -> Row
    ) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(patterns.enumerated()), id: \.element.id) { index, pattern in
                if index > 0 { Divider() }
                row(pattern)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .fill(theme.card))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
    }

    private func confidenceTone(_ level: PlannedRecurringPattern.ConfidenceLevel) -> BadgeTone {
        switch level {
        case .high: return .success
        case .medium: return .warning
        case .low: return .outline
        }
    }

    /// The category tree's name for the pattern's category, else the pattern's own name;
    /// nothing when the pattern has no category name.
    private func categoryName(_ pattern: PlannedRecurringPattern) -> String? {
        guard let own = pattern.categoryName, !own.isEmpty else { return nil }
        return model.pickers.categoryName(pattern.categoryId) ?? own
    }

    private func money(_ amount: Decimal, _ currency: String) -> String {
        MoneyText.text(amount, currency: currency, settings: settings, signed: false)
    }

    /// `safeDateLabel`: the app date, or `common.unknownDate` without one.
    private func dateLabel(_ text: String) -> String {
        text.isEmpty ? strings.t("common.unknownDate") : VisionFormat.appDate(text, format: settings.dateFormat)
    }

    /// `formatPercent(value, { digits: 1, signed: true })`: one decimal, a `+` before a
    /// positive change and no sign on zero.
    static func signedPercent(_ value: Decimal, settings: NativeAppSettings) -> String {
        let text = VisionFormat.percent(value, digits: 1, locale: settings.numberFormat.locale)
        return value > 0 ? "+\(text)" : text
    }
}

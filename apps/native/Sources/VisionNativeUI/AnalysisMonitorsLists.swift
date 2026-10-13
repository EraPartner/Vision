import SwiftUI
import VisionNativeCore

struct AnalysisMonitorsRulesView: View {
    let model: AnalysisMonitorsModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if model.rulesLoading || model.rulesError != nil || model.rules?.items.isEmpty == false || model.rulesOffset > 0
        {
            AdminCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(strings.t("monitors.rules")).font(.headline)
                    if model.rulesLoading && model.rules == nil { ProgressView(strings.t("common.loading")) }
                    if model.rulesError != nil {
                        AnalysisMonitorsRetry(
                            message: strings.t("monitors.loadFailed"), loading: model.rulesLoading, strings: strings
                        ) { await model.loadRules() }
                    }
                    if let page = model.rules {
                        if page.items.isEmpty && model.rulesError == nil {
                            Text(strings.t("monitors.empty")).foregroundStyle(.secondary)
                        }
                        ForEach(page.items) { rule in
                            HStack(alignment: .top, spacing: 8) {
                                Button {
                                    Task { await model.select(rule.id) }
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(rule.title).font(.headline).multilineTextAlignment(.leading)
                                        Text(
                                            rule.targetLabel + " · "
                                                + strings.t("monitors.status." + (rule.lastStatus ?? "never")) + " · "
                                                + strings.t(rule.enabled ? "monitors.enabled" : "monitors.disabled")
                                        )
                                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain).foregroundStyle(
                                    rule.id == model.selectedId ? theme.primary : theme.foreground)
                                Menu {
                                    Button(strings.t("monitors.checkNow"), systemImage: "checklist") {
                                        Task { await model.check(rule) }
                                    }.disabled(!rule.enabled)
                                    Button(
                                        strings.t(rule.enabled ? "monitors.disable" : "monitors.enable"),
                                        systemImage: rule.enabled ? "pause" : "play"
                                    ) { Task { await model.toggle(rule) } }
                                    Divider()
                                    Button(strings.t("monitors.delete"), role: .destructive) {
                                        model.deletingRule = rule
                                    }
                                } label: {
                                    Image(systemName: "ellipsis")
                                }
                                .menuStyle(.borderlessButton).frame(width: 24).disabled(model.isBusy)
                                .accessibilityLabel(strings.t("monitors.rowMenu", ["name": rule.title]))
                            }.padding(.vertical, 8)
                            Divider()
                        }
                        if model.rulesError == nil && (page.total > 200 || model.rulesOffset > 0) {
                            AnalysisMonitorsPager(
                                offset: model.rulesOffset, total: page.total, pageSize: 200, strings: strings,
                                change: model.changeRulesPage)
                        }
                    }
                }
            }
        }
    }
}
struct AnalysisMonitorsHistoryView: View {
    let model: AnalysisMonitorsModel
    let strings: any Localizing
    var body: some View {
        if model.selectedId != nil {
            AdminCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(strings.t("monitors.observations")).font(.headline)
                    if model.observationsLoading && model.observations == nil {
                        ProgressView(strings.t("common.loading"))
                    }
                    if model.observationsError != nil {
                        AnalysisMonitorsRetry(
                            message: strings.t("monitors.observationsFailed"), loading: model.observationsLoading,
                            strings: strings
                        ) { await model.loadObservations() }
                    }
                    if let page = model.observations {
                        if page.items.isEmpty && model.observationsError == nil {
                            Text(strings.t("monitors.noObservations")).foregroundStyle(.secondary)
                        }
                        ForEach(page.items) { item in
                            AnalysisMonitorsObservationView(item: item, strings: strings)
                            Divider()
                        }
                        if model.observationsError == nil && (page.total > 200 || model.observationOffset > 0) {
                            AnalysisMonitorsPager(
                                offset: model.observationOffset, total: page.total, pageSize: 200, showRange: false,
                                strings: strings, change: model.changeObservationPage)
                        }
                    }
                }
            }
        }
    }
}
struct AnalysisMonitorsNotificationsView: View {
    let model: AnalysisMonitorsModel
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        if model.notificationsLoading || model.notificationsError != nil || model.notifications?.items.isEmpty == false
            || model.notificationOffset > 0
        {
            AdminCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(strings.t("monitors.inbox")).font(.headline)
                    if model.notificationsLoading && model.notifications == nil {
                        ProgressView(strings.t("common.loading"))
                    }
                    if model.notificationsError != nil {
                        AnalysisMonitorsRetry(
                            message: strings.t("monitors.inboxFailed"), loading: model.notificationsLoading,
                            strings: strings
                        ) { await model.loadNotifications() }
                    }
                    if let page = model.notifications {
                        if page.items.isEmpty && model.notificationsError == nil {
                            Text(strings.t("monitors.noNotifications")).foregroundStyle(.secondary)
                        }
                        ForEach(page.items) { item in
                            notification(item)
                            Divider()
                        }
                        if model.notificationsError == nil && (page.total > 200 || model.notificationOffset > 0) {
                            AnalysisMonitorsPager(
                                offset: model.notificationOffset, total: page.total, pageSize: 200, showRange: false,
                                strings: strings, change: model.changeNotificationPage)
                        }
                    }
                }
            }
        }
    }
    private func notification(_ item: AnalysisMonitorNotification) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                if item.readAt == nil {
                    Circle().fill(theme.primary).frame(width: 6, height: 6).padding(.top, 6).accessibilityLabel(
                        strings.t("monitors.unread"))
                }
                Text(item.title).fontWeight(item.readAt == nil ? .semibold : .regular)
                Spacer(minLength: 8)
                Text(AnalysisMonitorPresentation.dateTime(item.createdAt)).font(.caption).foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            let reason = AnalysisMonitorPresentation.reason(item.reasonCode, fallback: item.reason, strings: strings)
            Text(reason.isEmpty ? strings.t("monitors.notificationReasonUnknown") : reason).font(.callout)
            if item.previousValue != nil || item.currentValue != nil {
                Text(
                    strings.t(
                        "monitors.valueChange",
                        ["previous": item.previousValue ?? "—", "current": item.currentValue ?? "—"])
                )
                .font(.caption).foregroundStyle(.secondary).monospacedDigit().textSelection(.enabled)
            }
            if item.readAt == nil {
                Button(strings.t("monitors.markRead")) { Task { await model.markRead(item) } }.buttonStyle(.bordered)
                    .controlSize(.small).disabled(model.isBusy)
            }
        }.padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
    }
}

import SwiftUI
import VisionNativeCore

struct AnalysisMonitorsScheduleView: View {
    let draft: AnalysisMonitorDraft
    let strings: any Localizing
    let update: ((inout AnalysisMonitorDraft) -> Void) -> Void
    let focus: FocusState<AnalysisMonitorInput?>.Binding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(
                strings.t("monitors.schedule"),
                isExpanded: Binding(
                    get: { draft.scheduleExpanded }, set: { value in update { $0.scheduleExpanded = value } })
            ) {
                HStack(alignment: .top, spacing: 12) {
                    field("monitors.interval", value: draft.intervalMinutes, input: .interval, range: "15–10080") {
                        value in update { $0.intervalMinutes = value }
                    }
                    field("monitors.cooldown", value: draft.cooldownMinutes, input: .cooldown, range: "0–10080") {
                        value in update { $0.cooldownMinutes = value }
                    }
                }.padding(.top, 8)
            }
            Text(
                strings.t(
                    "monitors.scheduleSummary",
                    ["interval": duration(draft.intervalMinutes), "cooldown": duration(draft.cooldownMinutes)])
            )
            .font(.caption).foregroundStyle(.secondary)
        }
    }
    private func field(
        _ key: String, value: String, input: AnalysisMonitorInput, range: String, set: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(strings.t(key)).font(.caption)
            TextField(strings.t(key), text: Binding(get: { value }, set: set))
                .textFieldStyle(.roundedBorder).focused(focus, equals: input)
                .accessibilityHint(range)
            Text(range).font(.caption2).foregroundStyle(.secondary)
        }
    }
    private func duration(_ raw: String) -> String {
        let normalized = raw.isEmpty ? "0" : JSInteger.number(raw).map(VisionFormat.plain) ?? raw
        guard let minutes = Int(normalized) else { return raw }
        if minutes > 0, minutes % 1440 == 0 {
            return strings.t("monitors.durationDays", ["count": String(minutes / 1440)])
        }
        if minutes > 0, minutes % 60 == 0 {
            return strings.t("monitors.durationHours", ["count": String(minutes / 60)])
        }
        return strings.t("monitors.durationMinutes", ["count": String(minutes)])
    }
}

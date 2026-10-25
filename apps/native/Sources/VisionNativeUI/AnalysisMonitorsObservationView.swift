import SwiftUI
import VisionNativeCore

struct AnalysisMonitorsStatus: View {
    let status: String?
    let strings: any Localizing
    var body: some View {
        VisionBadge(text: strings.t("monitors.status." + (status ?? "never")), tone: tone, small: true)
    }
    private var tone: BadgeTone {
        switch status {
        case "triggered", "partial", "stale": .warning
        case "failed": .destructive
        case "baseline", "cooldown-pending": .secondary
        default: .muted
        }
    }
}
struct AnalysisMonitorsObservationView: View {
    let item: AnalysisMonitorObservation
    let strings: any Localizing
    @Environment(\.visionTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                AnalysisMonitorsStatus(status: item.status.rawValue, strings: strings)
                Text(AnalysisMonitorPresentation.dateTime(item.checkedAt)).font(.caption).foregroundStyle(theme.secondaryLabel)
                    .monospacedDigit()
            }
            let reason = AnalysisMonitorPresentation.reason(item.reasonCode, fallback: item.reason, strings: strings)
            if !reason.isEmpty { Text(reason).font(.callout) }
            if item.previousValue != nil || item.currentValue != nil {
                Text(
                    strings.t(
                        "monitors.valueChange",
                        ["previous": item.previousValue ?? "—", "current": item.currentValue ?? "—"])
                )
                .font(.callout).monospacedDigit().textSelection(.enabled)
            }
            if item.previousEvidenceVersion != nil || item.currentEvidenceVersion != nil {
                Text(
                    strings.t(
                        "monitors.evidenceChange",
                        [
                            "previous": item.previousEvidenceVersion.map(String.init) ?? "—",
                            "current": item.currentEvidenceVersion.map(String.init) ?? "—",
                        ])
                )
                .font(.callout).monospacedDigit()
            }
            if item.coverage["status"]?.stringValue == "unknown" {
                Text(strings.t("monitors.coverage")).font(.caption).foregroundStyle(theme.secondaryLabel)
            }
        }.padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
    }
}

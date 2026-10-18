import SwiftUI
import VisionNativeCore

struct AIInvestigationPrivacyView: View {
    let route: String
    let disclosureMode: String
    let researchMode: String
    let depth: String
    let shell: NativeShellModel
    @State private var isExpanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var local: Bool { route == "local" }
    private var modelCopy: [String] {
        switch local ? "local" : disclosureMode {
        case "local":
            return ["aiResearch.summary.localTitle", "aiResearch.summary.localBody", "aiResearch.modeLocalProfile"]
        case "selected-summary":
            return [
                "aiResearch.summary.summaryTitle", "aiResearch.summary.summaryBody",
                "aiResearch.modeSelectedSummaryProfile",
            ]
        case "cloud-synthesis-selected":
            return [
                "aiResearch.summary.evidenceTitle", "aiResearch.summary.evidenceBody",
                "aiResearch.modeCloudSynthesisProfile",
            ]
        default:
            return [
                "aiResearch.summary.publicTitle", "aiResearch.summary.publicBody", "aiResearch.modeCloudPublicProfile",
            ]
        }
    }
    private var researchCopy: [String] {
        if !local && disclosureMode == "cloud-synthesis-selected" {
            return [
                "aiResearch.summary.selectedOnlyTitle", "aiResearch.summary.selectedOnlyBody",
                "aiResearch.modeCloudSynthesisProfile",
            ]
        }
        switch researchMode {
        case "public-providers":
            return [
                "aiResearch.publicProviders", "aiResearch.summary.researchProviders",
                "aiResearch.researchProvidersProfile",
            ]
        case "public-web":
            return ["aiResearch.publicWeb", "aiResearch.summary.researchWeb", "aiResearch.researchWebProfile"]
        default:
            return ["aiResearch.localOnly", "aiResearch.summary.researchLocal", "aiResearch.researchLocalProfile"]
        }
    }
    var body: some View {
        ResearchCard {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 20) { summaries }
                VStack(alignment: .leading, spacing: 16) { summaries }
            }
            Divider()
            DisclosureGroup(strings.t("aiResearch.modeGuideTitle"), isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 14) {
                    profile("aiResearch.route", body: modelCopy[2])
                    if local || disclosureMode != "cloud-synthesis-selected" {
                        profile("aiResearch.researchProfilesTitle", body: researchCopy[2])
                    }
                    profile(
                        "aiResearch.depthProfilesTitle",
                        body: depth == "quick" ? "aiResearch.quickProfile" : "aiResearch.detailedProfile")
                    if !local {
                        profile(
                            "aiResearch.summary.savedTitle",
                            body: disclosureMode == "cloud-synthesis-selected"
                                ? "aiResearch.cloudSynthesisWarning" : "aiResearch.cloudRetention")
                    }
                }.padding(.top, 10)
            }.font(.callout)
        }.accessibilityLabel(strings.t("aiResearch.summary.title"))
    }
    @ViewBuilder private var summaries: some View {
        summary(icon: local ? "checkmark.shield" : "cloud", title: modelCopy[0], body: modelCopy[1])
        summary(icon: "magnifyingglass", title: researchCopy[0], body: researchCopy[1])
        summary(
            icon: "externaldrive", title: "aiResearch.summary.savedTitle",
            body: local ? "aiResearch.summary.savedLocal" : "aiResearch.summary.savedCloud")
    }
    private func summary(icon: String, title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(theme.primary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(strings.t(title)).font(.callout.weight(.semibold))
                Text(strings.t(body)).font(.caption).foregroundStyle(theme.secondaryLabel).fixedSize(
                    horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func profile(_ title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(strings.t(title)).font(.callout.weight(.medium))
            Text(strings.t(body)).font(.callout).foregroundStyle(theme.secondaryLabel)
        }
    }
}

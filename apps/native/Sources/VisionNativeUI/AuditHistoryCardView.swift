import SwiftUI
import VisionNativeCore

/// `AuditHistoryCard` (apps/frontend/src/pages/admin/AuditHistoryCard.tsx) over the native
/// audit channels. The confirmations, save and open panels come from `AuditChannels`.
struct AuditHistoryCardView: View {
    let model: AuditHistoryModel
    let strings: any Localizing
    @Environment(\.visionTheme) var theme

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 16) {
                header
                if model.showsLoading { loading }
                if let key = model.statusKey {
                    let text = strings.t(key)
                    Text(text)
                        .foregroundStyle(model.status == .failed ? theme.destructive : theme.secondaryLabel)
                        // `role="alert"` / `role="status"`: announced when it appears or changes.
                        .task(id: key) { AccessibilityNotification.Announcement(text).post() }
                }
                if model.showsEnroll { enrollBlock }
                if model.changed {
                    Text(strings.t("admin.audit.changed"))
                        .foregroundStyle(theme.warning)
                }
                if let page = model.page {
                    pageContent(page)
                }
                Divider()
                transferBlock
                if model.page != nil {
                    Divider()
                    rotateBlock
                }
            }
        }
        .onDisappear { model.disappear() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            AdminIconBadge(symbol: "clock.badge.checkmark")
            VStack(alignment: .leading, spacing: 4) {
                Text(strings.t("admin.audit.title"))
                    .font(Font.visionTitle3)
                    .accessibilityAddTraits(.isHeader)
                Text(strings.t("admin.audit.description"))
                    .font(.body)
                    .foregroundStyle(theme.secondaryLabel)
            }
            Spacer(minLength: 8)
            Button(strings.t("admin.audit.refresh")) {
                Task { await model.load() }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(model.busy)
        }
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: 8) {
            SkeletonBar(width: 224, height: 16)
            SkeletonBar(width: nil, height: 44)
            SkeletonBar(width: nil, height: 44)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(strings.t("admin.audit.loading")))
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var enrollBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("admin.audit.enrollExplanation"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            Button(strings.t("admin.audit.enroll")) {
                Task { await model.enroll() }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(model.busy || model.enrollBusy)
            if model.enrollFailed {
                Text(strings.t("admin.audit.enrollFailed"))
                    .foregroundStyle(theme.destructive)
            }
        }
    }

    private func summaryColor(_ line: AuditSummaryLine) -> Color {
        switch line.key {
        case "admin.audit.verified", "admin.audit.partial": return theme.success
        case "admin.audit.pending": return theme.warning
        default: return theme.secondaryLabel
        }
    }

    private func pageContent(_ page: AuditPage) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(model.summaryLines().enumerated()), id: \.offset) { index, line in
                    Text(strings.t(line.key, line.variables))
                        .fontWeight(index == 0 ? .medium : .regular)
                        .foregroundStyle(summaryColor(line))
                }
            }
            if page.entries.isEmpty {
                Text(strings.t("admin.audit.empty"))
                    .foregroundStyle(theme.secondaryLabel)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(page.entries) { entry in
                        if entry.sequence != page.entries.first?.sequence { Divider() }
                        entryRow(entry)
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .strokeBorder(theme.border.opacity(0.6), lineWidth: 1))
            }
            if page.hasMore {
                Button(strings.t("admin.audit.loadMore")) {
                    Task { await model.loadMore() }
                }
                .buttonStyle(.visionOutline)
                .controlSize(.small)
                .disabled(model.busy)
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("admin.audit.exportLimit"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
                if model.exportTooLarge {
                    Text(strings.t("admin.audit.exportUnavailable"))
                        .font(.footnote)
                        .foregroundStyle(theme.warning)
                }
                Button(strings.t("admin.audit.export")) {
                    Task { await model.exportSnapshot() }
                }
                .buttonStyle(.visionOutline)
                .controlSize(.small)
                .disabled(model.isExportDisabled)
                outcome(model.exportMessage, success: "admin.audit.exportSuccess", failed: "admin.audit.exportFailed")
            }
        }
    }

    private func badgeColor(_ badge: AuditHistoryModel.EntryBadge) -> Color {
        switch badge {
        case .enrollmentBaseline: return theme.secondaryLabel
        case .anchored: return theme.success
        case .pending: return theme.warning
        }
    }

    private func entryRow(_ entry: AuditEntryRow) -> some View {
        let badge = model.badge(for: entry)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: "#\(entry.sequence) \(entry.label)")
                    .fontWeight(.medium)
                Spacer(minLength: 8)
                Text(strings.t(badge.key))
                    .font(.footnote)
                    .foregroundStyle(badgeColor(badge))
            }
            Text(entry.createdAt)
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            DisclosureGroup {
                ScrollView {
                    Text(entry.detailsJSON)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(maxHeight: 256)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.card)
                        .fill(theme.foreground.opacity(0.04)))
                .padding(.top, 8)
            } label: {
                Text(strings.t("admin.audit.details"))
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryLabel)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var transferPassword: Binding<String> {
        Binding(get: { model.transferPassword }, set: { model.setTransferPassword($0) })
    }

    private var transferBlock: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strings.t("admin.audit.transferExplanation"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            VStack(alignment: .leading, spacing: 6) {
                Text(strings.t("admin.audit.transferPassword"))
                    .font(.subheadline.weight(.medium))
                SecureField("", text: transferPassword)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 384)
                    .accessibilityLabel(strings.t("admin.audit.transferPassword"))
            }
            HStack(spacing: 8) {
                Button(strings.t("admin.audit.transferExport")) {
                    Task { await model.transfer(.exportTransfer) }
                }
                .disabled(model.isTransferExportDisabled)
                Button(strings.t("admin.audit.transferImport")) {
                    Task { await model.transfer(.importTransfer) }
                }
                .disabled(model.isTransferImportDisabled)
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            outcome(model.transferMessage, success: "admin.audit.transferSuccess", failed: "admin.audit.transferFailed")
        }
    }

    private var rotateBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(strings.t("admin.audit.rotateExplanation"))
                .font(.footnote)
                .foregroundStyle(theme.secondaryLabel)
            Button(strings.t("admin.audit.rotate")) {
                Task { await model.rotateKey() }
            }
            .buttonStyle(.visionOutline)
            .controlSize(.small)
            .disabled(model.isRotateDisabled)
            outcome(model.rotationMessage, success: "admin.audit.rotateSuccess", failed: "admin.audit.rotateFailed")
        }
    }

    /// `OutcomeNote`: polite on success, announced on failure.
    @ViewBuilder
    private func outcome(_ outcome: AuditHistoryModel.Outcome?, success: String, failed: String) -> some View {
        if let outcome {
            let text = strings.t(outcome == .success ? success : failed)
            Text(text)
                .font(.footnote)
                .foregroundStyle(outcome == .failed ? theme.destructive : theme.secondaryLabel)
                .onAppear {
                    if outcome == .failed { AccessibilityNotification.Announcement(text).post() }
                }
        }
    }
}
